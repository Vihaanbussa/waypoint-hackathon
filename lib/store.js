// The JSON store: loading, saving (to disk and, if set, the database), appending
// rows, the optional Google Sheet overlay, and what each person may see of it.

import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { parseCsv } from './csv.js';
import { createPersist } from './persist.js';
import { createSms } from './sms.js';
import { APPEND_TABLES, CONFIG, DATA, SEED, STORE, botName } from './config.js';
import { httpError } from './http.js';

// ---- store ----

export let store;
let saving = Promise.resolve();
let counter = 0;

// A database for hosts whose disk does not last (see lib/persist.js). Without
// it, the JSON files in the data folder are the only copy.
export const persist = createPersist({ url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN });
export let persistError = '';

// Text messages through Twilio (see lib/sms.js). Off until its three settings are there.
export const sms = createSms();
let tokenHintGiven = false;

// A refused token is nearly always a wrong paste. Say once what was pasted, by
// shape only, so it can be fixed without anyone reading the secret.
function noteDatabaseError(message) {
  persistError = message;
  if (tokenHintGiven || !/WRONGPASS|unauthori[sz]ed|auth token/i.test(message)) return;
  tokenHintGiven = true;
  console.error(`Database token check: UPSTASH_REDIS_REST_TOKEN is ${persist.tokenLooksLike}.`);
}

export async function fromDatabase(name) {
  if (!persist.remote) return null;
  try {
    const value = await persist.get(name);
    persistError = '';
    return value;
  } catch (err) {
    console.error(`Could not read "${name}" from the database:`, err.message);
    noteDatabaseError(err.message);
    return null;
  }
}

export async function toDatabase(name, value) {
  if (!persist.remote) return;
  try {
    await persist.set(name, value);
    persistError = '';
  } catch (err) {
    console.error(`Could not save "${name}" to the database:`, err.message);
    noteDatabaseError(err.message);
  }
}

// Logs grow for ever; keep the newest so one save stays small.
const KEEP = { runs: 400, notifications: 400, case_status: 200, alerts: 200, inbox_facts: 200, clock_notes: 200, actions: 300 };
function trimStore() {
  for (const [table, max] of Object.entries(KEEP)) {
    if (Array.isArray(store[table]) && store[table].length > max) store[table] = store[table].slice(-max);
  }
}

export async function loadStore() {
  await mkdir(DATA, { recursive: true });
  const kept = await fromDatabase('store');
  const file = existsSync(STORE) ? STORE : SEED;
  store = kept && typeof kept === 'object' ? kept : JSON.parse(await readFile(file, 'utf8'));
  for (const table of APPEND_TABLES) if (!Array.isArray(store[table])) store[table] = [];
  if (!Array.isArray(store.profiles)) store.profiles = [];
  if (!Array.isArray(store.own_deadlines)) store.own_deadlines = [];
  if (!store.portal || typeof store.portal !== 'object') store.portal = {};
  // An earlier version hid the H-1B sample person from the demo. He is back: an
  // international student's deadlines carry on after graduation.
  for (const p of store.profiles) if (p) delete p.later;
  for (const run of store.runs) if (run && run.bot) run.bot = botName(run.bot);
  for (const action of store.actions) if (action && action.drafted_by) action.drafted_by = botName(action.drafted_by);
}

// The demo sees the sample people. An account sees only its own profile.
export const visibleProfiles = (session, profiles = store.profiles) =>
  profiles.filter((p) => p && (session.demo ? !p.owner : p.owner === session.id));

export function save() {
  saving = saving
    .then(async () => {
      trimStore();
      const tmp = `${STORE}.tmp`;
      await writeFile(tmp, JSON.stringify(store, null, 2));
      await rename(tmp, STORE);
      await toDatabase('store', store);
    })
    .catch((err) => console.error('Could not save the store:', err.message));
  return saving;
}

export const nowIso = () => new Date().toISOString();
export const newId = (table) => `${table}-${Date.now().toString(36)}-${(counter += 1)}`;

export function localDay(now = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

// Copy a row from outside into a plain object: bounded, no prototype keys.
function cleanRow(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const out = {};
  for (const [key, value] of Object.entries(input).slice(0, 40)) {
    if (['__proto__', 'constructor', 'prototype'].includes(key)) continue;
    if (typeof value === 'string') out[key] = value.slice(0, 5000);
    else if (typeof value === 'number' || typeof value === 'boolean' || value === null) out[key] = value;
    else if (Array.isArray(value)) out[key] = value.slice(0, 20).map((v) => String(v).slice(0, 200));
  }
  return out;
}

export function appendRow(table, input, scope = null) {
  if (!APPEND_TABLES.includes(table)) throw httpError(400, `Unknown table "${table}".`);
  const row = cleanRow(input);
  if (!row) throw httpError(400, 'The row must be a JSON object.');
  delete row.key;
  if (scope) {
    // A rule-change notice for a whole visa type is the only row with no person,
    // and only the key for the sample people may write one.
    const forEveryone = table === 'alerts' && !row.person;
    if (forEveryone ? !scope.master : !scope.persons.has(String(row.person))) {
      throw httpError(403, row.person ? `This key cannot write for person "${String(row.person).slice(0, 40)}".` : 'Say which person this row is for.');
    }
  }
  row.id = row.id ? String(row.id) : newId(table);
  row.at = row.at || nowIso();
  delete row.sample;
  // Only the person approves or rejects. A Bot can only draft.
  if (table === 'actions') {
    row.state = 'drafted';
    delete row.decided_at;
  }
  if (table === 'case_status' && !row.checked_at) row.checked_at = row.at;
  if (table === 'runs' && row.bot) row.bot = botName(row.bot);
  store[table].push(row);
  return row;
}

// ---- optional: read tables from a published Google Sheet ----

const sheetCache = new Map();
let sheetErrors = {};

async function sheetConfig() {
  try {
    const config = JSON.parse(await readFile(CONFIG, 'utf8'));
    return config.sheet_csv && typeof config.sheet_csv === 'object' ? config.sheet_csv : {};
  } catch {
    return {};
  }
}

export async function publicUrlFromConfig() {
  // Hosts announce their own address: Render as a URL, Railway as a bare domain.
  const hosted = process.env.RENDER_EXTERNAL_URL || (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : '');
  try {
    return String(JSON.parse(await readFile(CONFIG, 'utf8')).public_url || hosted || '');
  } catch {
    return hosted;
  }
}

async function sheetRows(table, url) {
  const cached = sheetCache.get(table);
  if (cached && Date.now() - cached.at < 5000) return cached.rows;
  try {
    if (!/^https:\/\//.test(String(url))) throw new Error('The sheet link must start with https://');
    const res = await fetch(url, { signal: AbortSignal.timeout(4000), redirect: 'follow' });
    if (!res.ok) throw new Error(`The sheet answered ${res.status}`);
    const rows = parseCsv(await res.text());
    sheetCache.set(table, { at: Date.now(), rows });
    delete sheetErrors[table];
    return rows;
  } catch (err) {
    sheetErrors[table] = err.message;
    return cached ? cached.rows : null; // keep the last good rows
  }
}

async function fullStore() {
  const view = { ...store };
  const sheets = await sheetConfig();
  for (const [table, url] of Object.entries(sheets)) {
    if (!APPEND_TABLES.includes(table)) continue;
    const rows = await sheetRows(table, url);
    if (rows) view[table] = rows;
  }
  view.meta = { sheet_tables: Object.keys(sheets), sheet_errors: sheetErrors, database: persist.remote ? (persistError ? 'error' : 'on') : 'off' };
  return view;
}

// What one signed-in person may see: their profiles and the rows about them.
export async function storeFor(session) {
  const full = await fullStore();
  // The webhook key stays on the server; the browser only learns that one is set.
  const profiles = visibleProfiles(session, full.profiles).map((p) =>
    p.bot_webhook ? { ...p, bot_webhook: { url: p.bot_webhook.url, has_key: Boolean(p.bot_webhook.key) } } : p,
  );
  const ids = new Set(profiles.map((p) => p.id));
  const view = { profiles, meta: full.meta, me: { id: session.id, name: session.name, email: session.email, demo: session.demo } };
  for (const table of [...APPEND_TABLES, 'own_deadlines']) {
    const rows = Array.isArray(full[table]) ? full[table] : [];
    // A rule-change alert with no person on it is for everyone on that visa type.
    view[table] = rows.filter((r) => r && typeof r === 'object' && (ids.has(r.person) || (table === 'alerts' && !r.person)));
  }
  if (session.demo) view.portal = full.portal;
  // What this site can do right now, so a page does not offer what would fail.
  view.features = { sms: sms.ready };
  return view;
}


// The reset route swaps in a whole new store; other modules cannot assign to an imported binding.
export function replaceStore(value) {
  store = value;
}
