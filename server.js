// Waypoint demo server. No dependencies: static files plus a small JSON store.
//
//   node server.js            http://127.0.0.1:4173
//   HOST=0.0.0.0 PORT=8080    to reach it from another machine (a Bot's computer)
//
// The store is data/store.json, created from public/data/seed.json on first run.
// Accounts (email, password hash) live apart from it in data/accounts.json and
// are never sent to a browser.

import http from 'node:http';
import { readFile, writeFile, rename, mkdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, scryptSync, timingSafeEqual, createHmac } from 'node:crypto';
import { parseCsv } from './lib/csv.js';
import { createMcp } from './lib/mcp.js';
import { createPersist } from './lib/persist.js';
import { createSms, toE164, maskNumber } from './lib/sms.js';
import { VISA_TYPES, fieldsFor } from './public/js/rules.js';
import { buildClocks, parseDay, toIso } from './public/js/clocks.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const SEED = path.join(PUBLIC, 'data', 'seed.json');
const DATA = process.env.WAYPOINT_DATA_DIR || path.join(ROOT, 'data');
const STORE = path.join(DATA, 'store.json');
const USERS = path.join(ROOT, 'data', 'portal-users.json');
const CONFIG = path.join(DATA, 'config.json');
const ACCOUNTS = path.join(DATA, 'accounts.json');
const BOT_KEY_FILE = path.join(DATA, 'bot-key.txt');
const COOKIE = 'wp_session';
const SESSION_DAYS = 30;
// Pages that need someone signed in (or in the demo). Everything else is open.
const SIGNED_IN_PAGES = ['/', '/activity/', '/settings/', '/setup/', '/connect/'];
const PORT = Number(process.env.PORT) || 4173;
// On a host that assigns the port (Render, Railway, Fly), listen on every interface.
const HOSTED = Boolean(process.env.RENDER || process.env.RAILWAY_ENVIRONMENT || process.env.FLY_APP_NAME);
const HOST = process.env.HOST || (HOSTED ? '0.0.0.0' : '127.0.0.1');

// Tables a Bot may append to. Profiles and the portal are not on this list.
const APPEND_TABLES = ['runs', 'case_status', 'alerts', 'inbox_facts', 'notifications', 'actions', 'clock_notes'];
// One Manager and four workers. The team used to be six, so a row or a report
// under an old name is filed under the Bot that took the job over.
const BOTS = ['Manager', 'Intake Clerk', 'Case Clerk', 'Scout', 'Messenger'];
const OLD_BOT_NAMES = { 'Deadline Keeper': 'Manager', 'Policy Watcher': 'Scout', 'Inbox Scout': 'Scout' };
const botName = (name) => OLD_BOT_NAMES[String(name)] ?? String(name);
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

// ---- store ----

let store;
let saving = Promise.resolve();
let counter = 0;

// A database for hosts whose disk does not last (see lib/persist.js). Without
// it, the JSON files in the data folder are the only copy.
const persist = createPersist({ url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN });
let persistError = '';

// Text messages through Twilio (see lib/sms.js). Off until its three settings are there.
const sms = createSms();
let tokenHintGiven = false;

// A refused token is nearly always a wrong paste. Say once what was pasted, by
// shape only, so it can be fixed without anyone reading the secret.
function noteDatabaseError(message) {
  persistError = message;
  if (tokenHintGiven || !/WRONGPASS|unauthori[sz]ed|auth token/i.test(message)) return;
  tokenHintGiven = true;
  console.error(`Database token check: UPSTASH_REDIS_REST_TOKEN is ${persist.tokenLooksLike}.`);
}

async function fromDatabase(name) {
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

async function toDatabase(name, value) {
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

async function loadStore() {
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

// ---- accounts and sessions ----

let accounts; // { secret, users: [{ id, email, name, salt, hash, created_at }] }
const failures = new Map(); // email -> { count, until }
const DEMO_SESSION = { id: 'demo', demo: true, name: 'Demo', email: null };
const DEMO_ONLY = process.env.WAYPOINT_DEMO_ONLY === '1';

async function saveAccounts() {
  const tmp = `${ACCOUNTS}.tmp`;
  await writeFile(tmp, JSON.stringify(accounts, null, 2), { mode: 0o600 });
  await rename(tmp, ACCOUNTS);
  await toDatabase('accounts', accounts);
}

async function loadAccounts() {
  const kept = await fromDatabase('accounts');
  try {
    accounts = kept && typeof kept === 'object' ? kept : JSON.parse(await readFile(ACCOUNTS, 'utf8'));
  } catch {
    accounts = {};
  }
  if (!Array.isArray(accounts.users)) accounts.users = [];
  let changed = false;
  // On a host whose disk is wiped on restart, set WAYPOINT_SECRET and
  // WAYPOINT_BOT_KEY so sign-ins and the Bots' key survive.
  const envSecret = String(process.env.WAYPOINT_SECRET || '');
  const envBotKey = String(process.env.WAYPOINT_BOT_KEY || '');
  if (envSecret.length >= 32 && accounts.secret !== envSecret) {
    accounts.secret = envSecret;
    changed = true;
  }
  if (envBotKey.length >= 24 && accounts.bot_key !== envBotKey) {
    accounts.bot_key = envBotKey;
    changed = true;
  }
  if (typeof accounts.secret !== 'string' || accounts.secret.length < 32) {
    accounts.secret = randomBytes(32).toString('hex');
    changed = true;
  }
  // Bot keys. One for the sample people, kept in a file for whoever runs the
  // server; one per account, shown to that account in Settings.
  if (typeof accounts.bot_key !== 'string' || accounts.bot_key.length < 24) {
    accounts.bot_key = newBotKey();
    changed = true;
  }
  for (const user of accounts.users) {
    if (typeof user.bot_key !== 'string' || user.bot_key.length < 24) {
      user.bot_key = newBotKey();
      changed = true;
    }
  }
  if (changed) await saveAccounts();
  await writeFile(BOT_KEY_FILE, `${accounts.bot_key}\n`, { mode: 0o600 });
}

const newBotKey = () => `wpb_${randomBytes(24).toString('hex')}`;

// Who a Bot key speaks for: the people it may read and write, and nothing else.
function botScope(req, data) {
  // "Authorization: Bearer <key>" is the usual form; the bare key is accepted too,
  // so it can be pasted into a connector form as it is.
  const header = /^(?:Bearer\s+)?(\S+)$/i.exec(String(req.headers.authorization || '').trim())?.[1];
  const key = header || String(req.headers['x-waypoint-key'] || '') || (data && typeof data.key === 'string' ? data.key.trim() : '');
  if (!key) return null;
  if (sameText(key, accounts.bot_key)) {
    return { master: true, label: 'the sample people', persons: new Set(store.profiles.filter((p) => p && !p.owner).map((p) => p.id)) };
  }
  const user = accounts.users.find((u) => sameText(key, u.bot_key));
  if (!user) return null;
  return { master: false, label: user.name, persons: new Set(store.profiles.filter((p) => p && p.owner === user.id).map((p) => p.id)) };
}

// A row may be written by a Bot holding a key, or by a signed-in person using
// the report form or the demo controls in a browser.
function writerScope(req, data) {
  const bot = botScope(req, data);
  if (bot) return bot;
  const session = readSession(req);
  if (!session) throw httpError(401, 'Add your Bot key, or sign in first.');
  return { master: session.demo, label: session.name, persons: new Set(visibleProfiles(session).map((p) => p.id)) };
}

// https only, and never an address inside this machine or network.
function publicHttpsUrl(text) {
  let parsed;
  try {
    parsed = new URL(String(text).trim());
  } catch {
    return null;
  }
  const host = parsed.hostname.toLowerCase();
  const inside = host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal') || /^[\d.]+$/.test(host) || host.includes(':');
  return parsed.protocol === 'https:' && !inside && parsed.href.length <= 500 ? parsed.href : null;
}

const hashPassword = (password, salt) => scryptSync(password, salt, 64).toString('hex');
const signValue = (value) => createHmac('sha256', accounts.secret).update(value).digest('base64url');

function sameText(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

// The cookie is a signed note of who is signed in and until when. No server-side
// session table, so a restart does not sign anyone out.
function startSession(res, userId) {
  const payload = Buffer.from(JSON.stringify({ u: userId, e: Date.now() + SESSION_DAYS * 864e5 })).toString('base64url');
  res.setHeader('Set-Cookie', `${COOKIE}=${payload}.${signValue(payload)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${HOSTED ? '; Secure' : ''}`);
}

function endSession(res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

function readSession(req) {
  const raw = new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`).exec(String(req.headers.cookie || ''))?.[1];
  // WAYPOINT_DEMO_ONLY=1 opens the sample people to anyone, with no sign-in:
  // for a public demo link, or for tools that scan the pages.
  if (!raw) return DEMO_ONLY ? DEMO_SESSION : null;
  const [payload, mac] = raw.split('.');
  if (!payload || !mac || !sameText(mac, signValue(payload))) return null;
  let note;
  try {
    note = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!note || typeof note.e !== 'number' || note.e < Date.now()) return null;
  if (note.u === 'demo') return DEMO_SESSION;
  const user = accounts.users.find((u) => u.id === note.u);
  return user ? { id: user.id, demo: false, name: user.name, email: user.email } : null;
}

function requireSession(req) {
  const session = readSession(req);
  if (!session) throw httpError(401, 'Sign in first.');
  return session;
}

// The demo sees the sample people. An account sees only its own profile.
const visibleProfiles = (session, profiles = store.profiles) =>
  profiles.filter((p) => p && (session.demo ? !p.owner : p.owner === session.id));

function requireProfile(session, id) {
  const profile = visibleProfiles(session).find((p) => p.id === id);
  if (!profile) throw httpError(404, 'No profile with that id.');
  return profile;
}

const strictDay = (value) => {
  const text = String(value ?? '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(text) && parseDay(text) != null && toIso(parseDay(text)) === text ? text : null;
};

// Build a profile from what the person typed. Only fields the visa type uses are kept.
function profileFromInput(data, existing, session) {
  const visa = String(data.visa_type || '');
  if (!Object.hasOwn(VISA_TYPES, visa)) throw httpError(400, 'Choose a visa type.');
  const name = String(data.name || '').trim().slice(0, 80);
  if (!name) throw httpError(400, 'Add your name.');

  const profile = { id: existing?.id ?? `u-${session.id}`, owner: session.id, name, visa_type: visa };
  for (const field of fieldsFor(visa)) {
    const value = data[field.id];
    if (field.type === 'flag') {
      profile[field.id] = value === true || value === 'true' || value === 'on';
    } else if (value == null || String(value).trim() === '') {
      continue;
    } else if (field.type === 'date') {
      const day = strictDay(value);
      if (!day) throw httpError(400, `"${field.label}" needs a real date, like 2027-02-10.`);
      profile[field.id] = day;
    } else if (field.type === 'number') {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 0 || n > (field.max ?? 1000)) {
        throw httpError(400, `"${field.label}" needs a whole number from 0 to ${field.max ?? 1000}.`);
      }
      profile[field.id] = n;
    }
  }

  const receipts = (Array.isArray(data.receipts) ? data.receipts : String(data.receipts || '').split(/[\s,;]+/))
    .map((r) => String(r).trim().toUpperCase())
    .filter(Boolean)
    .slice(0, 10);
  for (const receipt of receipts) {
    if (!/^[A-Z]{3}\d{10}$/.test(receipt)) {
      throw httpError(400, `"${receipt.slice(0, 20)}" is not a receipt number. They look like IOE0912345678.`);
    }
  }
  profile.receipts = [...new Set(receipts)];

  const phone = String(data.phone || '').trim();
  if (phone && !/^[0-9+()\-. ]{7,24}$/.test(phone)) throw httpError(400, 'The phone number has characters a phone number cannot have.');
  profile.phone = phone;

  const channels = data.channels && typeof data.channels === 'object' ? data.channels : existing?.channels;
  profile.channels = {
    sms: channels ? Boolean(channels.sms) : true,
    calendar: channels ? Boolean(channels.calendar) : true,
    gmail: channels ? Boolean(channels.gmail) : true,
  };
  profile.quiet_hours = existing?.quiet_hours ?? { from: '22:00', to: '07:00' };
  profile.accounts = existing?.accounts ?? {};
  if (existing?.bot_webhook) profile.bot_webhook = existing.bot_webhook;
  return profile;
}

function save() {
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

const nowIso = () => new Date().toISOString();
const newId = (table) => `${table}-${Date.now().toString(36)}-${(counter += 1)}`;

function localDay(now = new Date()) {
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

function appendRow(table, input, scope = null) {
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

async function publicUrlFromConfig() {
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
async function storeFor(session) {
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

// ---- http helpers ----

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function redirect(res, location) {
  res.writeHead(302, { Location: location, 'Cache-Control': 'no-store' });
  res.end();
}

function send(res, status, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

const sendJson = (res, status, value) => send(res, status, JSON.stringify(value), TYPES['.json']);
const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 100_000) throw httpError(413, 'That is too much data for one request.');
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  const type = String(req.headers['content-type'] || '');
  if (type.includes('application/x-www-form-urlencoded')) {
    return { form: true, data: Object.fromEntries(new URLSearchParams(text)) };
  }
  if (!text.trim()) return { form: false, data: {} };
  try {
    return { form: false, data: JSON.parse(text) };
  } catch {
    throw httpError(400, 'The request body is not valid JSON.');
  }
}

function resultPage(title, message, ok) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title><link rel="stylesheet" href="/css/portal.css"></head><body><header class="portal-bar"><p class="portal-name">Waypoint Bot report</p></header><main><h1 id="report-result">${escapeHtml(title)}</h1><p id="report-message" data-ok="${ok ? 'yes' : 'no'}">${escapeHtml(message)}</p><p><a href="/report/">Report another row</a></p></main></body></html>`;
}

// ---- api ----

async function api(req, res, url) {
  const route = `${req.method} ${url.pathname}`;
  const parts = url.pathname.split('/').filter(Boolean); // ['api', ...]

  if (route === 'GET /api/store') return sendJson(res, 200, await storeFor(requireSession(req)));

  // What a person pastes into Grok Bot to connect: the address and their own key.
  if (route === 'GET /api/connect') {
    const session = requireSession(req);
    const host = String(req.headers.host || '');
    const local = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host);
    // Where Bots reach this site: the public address if one is set (config.json
    // "public_url" or WAYPOINT_PUBLIC_URL), else wherever this request came in.
    const set = publicHttpsUrl(process.env.WAYPOINT_PUBLIC_URL || (await publicUrlFromConfig()) || '');
    const origin = set ? set.replace(/\/+$/, '') : `${local ? 'http' : 'https'}://${host}`;
    const reachable = Boolean(set) || !local;
    const base = { ok: true, origin, mcp_url: `${origin}/mcp`, local: !reachable };
    if (session.demo) {
      // The sample people's key is for whoever runs the server, so it is shown
      // only to a browser on the same machine.
      return sendJson(res, 200, { ...base, demo: true, ...(local ? { bot_key: accounts.bot_key } : {}) });
    }
    const user = accounts.users.find((u) => u.id === session.id);
    return sendJson(res, 200, { ...base, demo: false, bot_key: user.bot_key });
  }

  if (route === 'GET /api/me') {
    const session = requireSession(req);
    return sendJson(res, 200, { ok: true, me: { id: session.id, name: session.name, email: session.email, demo: session.demo } });
  }

  if (req.method === 'GET' && url.pathname === '/api/portal/cases') {
    const cases = Object.entries(store.portal).map(([receipt, c]) => ({ receipt, ...c }));
    return sendJson(res, 200, { cases });
  }

  if (req.method === 'GET' && url.pathname === '/api/portal/case') {
    const receipt = String(url.searchParams.get('receipt') || '');
    const found = Object.hasOwn(store.portal, receipt) ? store.portal[receipt] : null;
    if (!found) throw httpError(404, 'No case with that receipt number.');
    return sendJson(res, 200, { receipt, ...found });
  }

  if (req.method !== 'POST') throw httpError(405, 'Use GET or POST.');
  const { form, data } = await readBody(req);

  // ---- signing in ----

  if (url.pathname === '/api/auth/signup') {
    const name = String(data.name || '').trim().slice(0, 80);
    const email = String(data.email || '').trim().toLowerCase();
    const password = String(data.password || '');
    if (!name) throw httpError(400, 'Add your name.');
    if (email.length > 200 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw httpError(400, 'That email address does not look right.');
    if (password.length < 8) throw httpError(400, 'Use a password of at least 8 characters.');
    if (password.length > 200) throw httpError(400, 'That password is too long.');
    if (accounts.users.some((u) => u.email === email)) throw httpError(409, 'An account with that email already exists. Sign in instead.');
    const salt = randomBytes(16).toString('hex');
    const user = { id: randomBytes(6).toString('hex'), email, name, salt, hash: hashPassword(password, salt), bot_key: newBotKey(), created_at: nowIso() };
    accounts.users.push(user);
    await saveAccounts();
    startSession(res, user.id);
    return sendJson(res, 200, { ok: true, me: { id: user.id, name, email, demo: false } });
  }

  if (url.pathname === '/api/auth/login') {
    const email = String(data.email || '').trim().toLowerCase();
    const password = String(data.password || '');
    const failed = failures.get(email);
    if (failed && failed.count >= 5 && failed.until > Date.now()) throw httpError(429, 'Too many tries. Wait a minute and try again.');
    const user = accounts.users.find((u) => u.email === email);
    // Hash even when the email is unknown, so both answers take the same time.
    const hash = hashPassword(password.slice(0, 200), user ? user.salt : 'no-such-user');
    if (!user || !sameText(hash, user.hash)) {
      const count = failed && failed.until > Date.now() ? failed.count + 1 : 1;
      failures.set(email, { count, until: Date.now() + 60_000 });
      throw httpError(401, 'That email and password do not match.');
    }
    failures.delete(email);
    startSession(res, user.id);
    return sendJson(res, 200, { ok: true, me: { id: user.id, name: user.name, email: user.email, demo: false } });
  }

  if (url.pathname === '/api/auth/demo') {
    startSession(res, 'demo');
    return sendJson(res, 200, { ok: true, me: { id: 'demo', name: 'Demo', email: null, demo: true } });
  }

  if (url.pathname === '/api/auth/logout') {
    endSession(res);
    return sendJson(res, 200, { ok: true });
  }

  // ---- the person's own data ----

  if (url.pathname === '/api/profile') {
    const session = requireSession(req);
    if (session.demo) throw httpError(403, 'The demo uses sample people. Create an account to add your own details.');
    const existing = store.profiles.find((p) => p.owner === session.id);
    const profile = profileFromInput(data, existing, session);
    if (existing) store.profiles[store.profiles.indexOf(existing)] = profile;
    else store.profiles.push(profile);
    // Keep the account's display name in step with the profile.
    const user = accounts.users.find((u) => u.id === session.id);
    if (user && user.name !== profile.name) {
      user.name = profile.name;
      await saveAccounts();
    }
    await save();
    return sendJson(res, 200, { ok: true, profile });
  }

  if (url.pathname === '/api/own-deadlines') {
    const session = requireSession(req);
    const profile = requireProfile(session, String(data.person || ''));
    const label = String(data.label || '').trim().slice(0, 80);
    const due = strictDay(data.due_date);
    if (!label) throw httpError(400, 'Say what the deadline is.');
    if (!due) throw httpError(400, 'Pick the date it is due.');
    if (store.own_deadlines.filter((d) => d.person === profile.id).length >= 50) throw httpError(400, 'That is the most deadlines you can add yourself.');
    const row = { id: newId('own'), person: profile.id, label, due_date: due, note: String(data.note || '').trim().slice(0, 300), at: nowIso() };
    store.own_deadlines.push(row);
    await save();
    return sendJson(res, 200, { ok: true, row });
  }

  if (parts[1] === 'own-deadlines' && parts[3] === 'delete' && parts.length === 4) {
    const session = requireSession(req);
    const row = store.own_deadlines.find((d) => d.id === parts[2]);
    if (!row) throw httpError(404, 'No deadline with that id.');
    requireProfile(session, row.person);
    store.own_deadlines = store.own_deadlines.filter((d) => d !== row);
    await save();
    return sendJson(res, 200, { ok: true });
  }

  // "Check now": the two Bots that work without a connection. Case Clerk reads the
  // mock portal for the person's receipt numbers; the Manager counts deadlines.
  // Both runs are marked simulated. The other Bots are not pretended.
  if (url.pathname === '/api/check') {
    const session = requireSession(req);
    const profile = requireProfile(session, String(data.person || ''));
    const today = strictDay(data.today) || localDay();
    if (profile.bot_webhook?.url) {
      // A real Bot is connected: wake its routine and let it report back itself.
      let answer;
      try {
        answer = await fetch(profile.bot_webhook.url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(profile.bot_webhook.key ? { Authorization: `Bearer ${profile.bot_webhook.key}` } : {}) },
          body: JSON.stringify({ event: 'check_now', person: profile.id, today, receipts: profile.receipts ?? [] }),
          signal: AbortSignal.timeout(8000),
          redirect: 'error',
        });
      } catch {
        throw httpError(502, 'Your Bot did not answer. Check the webhook address in Settings.');
      }
      if (answer.status !== 200) throw httpError(502, `Your Bot's webhook answered ${answer.status}, so no run started. Check the address and key in Settings.`);
      return sendJson(res, 200, { ok: true, mode: 'bot' });
    }
    const receipts = Array.isArray(profile.receipts) ? profile.receipts.map(String) : [];
    const found = receipts.filter((r) => Object.hasOwn(store.portal, r));
    for (const receipt of found) {
      const record = store.portal[receipt];
      appendRow('case_status', {
        person: profile.id,
        receipt,
        title: record.title,
        portal: 'Mock case status portal',
        status: record.status,
        last_changed: record.last_changed,
        response_due: record.response_due,
        simulated: true,
      });
    }
    let summary = 'No receipt numbers to check';
    if (receipts.length && found.length) {
      summary = found.length === 1 ? `Read status: "${store.portal[found[0]].status}"` : `Read ${found.length} cases on the mock portal`;
    } else if (receipts.length) {
      summary = `${receipts.length === 1 ? 'Your receipt number is' : 'Your receipt numbers are'} not on the mock portal`;
    }
    const runs = [appendRow('runs', { person: profile.id, bot: 'Case Clerk', status: 'ok', summary, simulated: true })];
    const clocks = buildClocks(profile, store, today);
    const urgent = clocks.filter((c) => c.risk === 'act').length;
    runs.push(
      appendRow('runs', {
        person: profile.id,
        bot: 'Manager',
        status: 'ok',
        summary: `Counted ${clocks.length} ${clocks.length === 1 ? 'deadline' : 'deadlines'}, ${urgent} to act on now`,
        simulated: true,
      }),
    );
    await save();
    return sendJson(res, 200, { ok: true, mode: 'simulated', runs });
  }

  // ---- connecting real Bots ----

  if (url.pathname === '/api/connect/webhook') {
    const session = requireSession(req);
    if (session.demo) throw httpError(403, 'Create an account to connect your own Bots.');
    const profile = store.profiles.find((p) => p.owner === session.id);
    if (!profile) throw httpError(400, 'Add your details first.');
    const raw = String(data.url || '').trim();
    if (!raw) {
      delete profile.bot_webhook;
    } else {
      const address = publicHttpsUrl(raw);
      if (!address) throw httpError(400, 'The webhook address must be a public https:// address.');
      const key = String(data.key || '').trim().slice(0, 300);
      profile.bot_webhook = { url: address, key: key || profile.bot_webhook?.key || '' };
    }
    await save();
    return sendJson(res, 200, { ok: true, connected: Boolean(profile.bot_webhook) });
  }

  if (url.pathname === '/api/connect/rotate') {
    const session = requireSession(req);
    if (session.demo) throw httpError(403, 'Create an account to get a Bot key of your own.');
    const user = accounts.users.find((u) => u.id === session.id);
    user.bot_key = newBotKey();
    await saveAccounts();
    return sendJson(res, 200, { ok: true, bot_key: user.bot_key });
  }

  // A Bot (or a person rehearsing) reports a run and, optionally, one data row.
  if (url.pathname === '/api/report') {
    try {
      const scope = writerScope(req, data);
      const saved = [];
      const person = String(data.person || '').trim();
      if (data.bot && data.summary) {
        if (!BOTS.includes(botName(data.bot))) throw httpError(400, 'Pick one of the five Bots.');
        saved.push(
          appendRow(
            'runs',
            {
              person,
              bot: botName(data.bot),
              status: data.status === 'failed' ? 'failed' : data.status === 'running' ? 'running' : 'ok',
              summary: String(data.summary),
            },
            scope,
          ),
        );
      }
      if (data.table) {
        let row = data.row;
        if (typeof row === 'string') {
          try {
            row = JSON.parse(row);
          } catch {
            throw httpError(400, 'The row is not valid JSON. Check the quotes and commas.');
          }
        }
        if (row && typeof row === 'object' && person && !row.person) row.person = person;
        saved.push(appendRow(String(data.table), row, scope));
      }
      if (!saved.length) throw httpError(400, 'Nothing to save. Fill in a run summary, a row, or both.');
      await save();
      const ids = saved.map((r) => r.id).join(', ');
      if (form) return send(res, 200, resultPage('Saved', `Saved ${saved.length} row(s): ${ids}`, true), TYPES['.html']);
      return sendJson(res, 200, { ok: true, saved });
    } catch (err) {
      if (form) return send(res, err.status || 500, resultPage('Not saved', err.message, false), TYPES['.html']);
      throw err;
    }
  }

  if (parts[1] === 'rows' && parts.length === 3) {
    const row = appendRow(parts[2], data, writerScope(req, data));
    await save();
    return sendJson(res, 200, { ok: true, row });
  }

  // Only the UI calls this: the person approves, rejects or edits a draft.
  if (parts[1] === 'actions' && parts.length === 3) {
    const session = requireSession(req);
    const action = store.actions.find((a) => a.id === parts[2]);
    if (!action || !visibleProfiles(session).some((p) => p.id === action.person)) throw httpError(404, 'No action with that id.');
    if (action.state !== 'drafted') throw httpError(409, `This action was already ${action.state}.`);
    if (typeof data.body === 'string') {
      if (!data.body.trim()) throw httpError(400, 'The email text cannot be empty.');
      action.body = data.body.slice(0, 5000);
      action.edited_at = nowIso();
    }
    if (data.state !== undefined) {
      if (!['approved', 'rejected'].includes(data.state)) throw httpError(400, 'State must be approved or rejected.');
      action.state = data.state;
      action.decided_at = nowIso();
    }
    await save();
    return sendJson(res, 200, { ok: true, action });
  }

  if (parts[1] === 'profiles' && parts[3] === 'settings' && parts.length === 4) {
    const profile = requireProfile(requireSession(req), parts[2]);
    if (data.channels && typeof data.channels === 'object') {
      profile.channels = {
        sms: Boolean(data.channels.sms),
        calendar: Boolean(data.channels.calendar),
        gmail: Boolean(data.channels.gmail),
      };
    }
    if (data.quiet_hours && typeof data.quiet_hours === 'object') {
      const time = /^([01]\d|2[0-3]):[0-5]\d$/;
      const { from, to } = data.quiet_hours;
      if (!time.test(String(from)) || !time.test(String(to))) throw httpError(400, 'Quiet hours need two times, like 22:00.');
      profile.quiet_hours = { from, to };
    }
    await save();
    return sendJson(res, 200, { ok: true, profile });
  }

  // "Send a test text" in Settings: one line to the person's own phone.
  if (parts[1] === 'profiles' && parts[3] === 'test-text' && parts.length === 4) {
    const session = requireSession(req);
    if (session.demo) throw httpError(403, 'Create an account to send a test text to your own phone.');
    const profile = requireProfile(session, parts[2]);
    if (textsSince(60 * 1000, profile.id)) throw httpError(429, 'A text went out less than a minute ago. Give it a moment to arrive.');
    try {
      const { to } = await sendText(profile, 'Waypoint: this is a test. Your deadline alerts will arrive like this.');
      return sendJson(res, 200, { ok: true, to: maskNumber(to) });
    } catch (err) {
      throw err.status ? err : httpError(400, err.message);
    }
  }

  if (url.pathname === '/api/portal/login') {
    const { users } = JSON.parse(await readFile(USERS, 'utf8'));
    const user = users.find((u) => u.username === data.username && u.password === data.password);
    if (!user) throw httpError(401, 'That username and password do not match.');
    return sendJson(res, 200, { ok: true, receipts: user.receipts });
  }

  if (url.pathname === '/api/portal/case') {
    requireSession(req);
    const receipt = String(data.receipt || '');
    if (!Object.hasOwn(store.portal, receipt)) throw httpError(404, 'No case with that receipt number.');
    const record = store.portal[receipt];
    const status = String(data.status || '').trim().slice(0, 120);
    if (!status) throw httpError(400, 'Choose a status.');
    const due = String(data.response_due || '').trim();
    if (due && !/^\d{4}-\d{2}-\d{2}$/.test(due)) throw httpError(400, 'The response date must look like 2027-02-10.');
    if (status !== record.status) record.last_changed = localDay();
    record.status = status;
    record.detail = String(data.detail || '').trim().slice(0, 500);
    record.response_due = due || null;
    await save();
    return sendJson(res, 200, { ok: true, receipt, ...record });
  }

  // Rehearsal only: copy what the portal shows into case_status, marked simulated.
  if (url.pathname === '/api/simulate/case-clerk') {
    requireSession(req);
    const receipt = String(data.receipt || '');
    if (!Object.hasOwn(store.portal, receipt)) throw httpError(404, 'No case with that receipt number.');
    const record = store.portal[receipt];
    const row = appendRow('case_status', {
      person: record.person,
      receipt,
      title: record.title,
      portal: 'Mock case status portal',
      status: record.status,
      last_changed: record.last_changed,
      response_due: record.response_due,
      simulated: true,
    });
    appendRow('runs', {
      person: record.person,
      bot: 'Case Clerk',
      status: 'ok',
      summary: `Read status: "${record.status}"`,
      simulated: true,
    });
    await save();
    return sendJson(res, 200, { ok: true, row });
  }

  // Puts the sample people back. Profiles that accounts made, and their rows, stay.
  if (url.pathname === '/api/reset') {
    requireSession(req);
    const owned = store.profiles.filter((p) => p && p.owner);
    const ownedIds = new Set(owned.map((p) => p.id));
    const kept = Object.fromEntries(
      [...APPEND_TABLES, 'own_deadlines'].map((table) => [table, (store[table] || []).filter((r) => r && ownedIds.has(r.person))]),
    );
    store = JSON.parse(await readFile(SEED, 'utf8'));
    for (const table of [...APPEND_TABLES, 'own_deadlines']) {
      store[table] = [...(Array.isArray(store[table]) ? store[table] : []), ...kept[table]];
    }
    store.profiles = [...(store.profiles || []), ...owned];
    await save();
    return sendJson(res, 200, { ok: true });
  }

  throw httpError(404, 'No such endpoint.');
}

// ---- the Bot connector (MCP) ----
// What a Grok Bot sees when Waypoint is added as a custom connector. Every tool
// works only on the people the Bot's key speaks for.

const str = (description, extra = {}) => ({ type: 'string', description, ...extra });

// A link counts as an X post only if it really is on X.
function xPostUrl(value) {
  try {
    const url = new URL(String(value || ''));
    const host = url.hostname.replace(/^(www|mobile)\./, '');
    return url.protocol === 'https:' && (host === 'x.com' || host === 'twitter.com') ? url.href : '';
  } catch {
    return '';
  }
}
const PERSON = str('The person id, from list_people. Optional when the key speaks for one person.');
// The searches a Bot says it ran on X: a short list of short strings, no repeats.
function xSearches(value) {
  const list = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[\n;]+/) : [];
  const seen = new Set();
  for (const item of list) {
    const text = String(item ?? '').replace(/\s+/g, ' ').trim().slice(0, 100);
    if (text) seen.add(text);
  }
  return [...seen].slice(0, 8);
}

const schema = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });

// ---- text messages ----

const DAY_MS = 24 * 60 * 60 * 1000;
// A Bot stuck in a loop must not flood a phone or spend the Twilio balance.
const TEXTS_A_DAY = 6;
const TEXTS_A_DAY_ALL = Math.max(1, Number(process.env.SMS_DAILY_CAP) || 60);

const textsSince = (ms, person = null) =>
  (store.notifications ?? []).filter(
    (n) => n && n.via === 'twilio' && n.state === 'sent' && (!person || n.person === person) && Date.now() - Date.parse(n.at) < ms,
  ).length;

// Sends one text to a person's own phone and records it, sent or failed, where
// Activity shows it. The sample people have made-up numbers: their texts go to
// SMS_DEMO_TO when the host sets it (the presenter's phone) and nowhere otherwise.
async function sendText(profile, input) {
  const text = String(input ?? '').replace(/\s+/g, ' ').trim();
  if (!text) throw new Error('The text is empty.');
  if (text.length > 300) throw new Error('Keep a text to one line, 300 characters at most.');
  if (/\b[A-Z]{3}\d{10}\b/.test(text)) throw new Error('Leave receipt numbers out of a text.');
  if (profile.channels?.sms === false) throw new Error(`${profile.name} has text messages turned off in Settings.`);
  if (!sms.ready) throw new Error(`Texting is not switched on for this site yet (${sms.missing.join(', ')} missing on the host).`);
  const to = toE164(profile.owner ? profile.phone : process.env.SMS_DEMO_TO);
  if (!to) {
    throw new Error(
      profile.owner
        ? `${profile.name} has no mobile number Waypoint can text. Add one under "Edit your details" in Settings.`
        : 'The sample people have made-up phone numbers, so nothing was sent. Set SMS_DEMO_TO on the host to get their texts on a real phone.',
    );
  }
  if (textsSince(DAY_MS, profile.id) >= TEXTS_A_DAY) throw new Error(`${profile.name} has already had ${TEXTS_A_DAY} texts in the last day. That is the limit.`);
  if (textsSince(DAY_MS) >= TEXTS_A_DAY_ALL) throw new Error('This site has sent its limit of texts for today.');
  const row = { person: profile.id, channel: 'sms', text, via: 'twilio' };
  try {
    const sent = await sms.send(to, text);
    const saved = appendRow('notifications', { ...row, state: 'sent', twilio_id: sent.id });
    await save();
    return { row: saved, to };
  } catch (err) {
    appendRow('notifications', { ...row, state: 'failed', error: String(err.message).slice(0, 300) });
    await save();
    throw err;
  }
}

function personFor(args, scope) {
  const asked = String(args.person || '').trim();
  if (asked) {
    if (!scope.persons.has(asked)) throw new Error(`This key cannot act for person "${asked.slice(0, 40)}". Call list_people to see who it can act for.`);
    return store.profiles.find((p) => p.id === asked);
  }
  if (scope.persons.size === 1) return store.profiles.find((p) => p.id === [...scope.persons][0]);
  throw new Error(scope.persons.size ? 'Say which person: pass "person" with an id from list_people.' : 'This account has not added its details yet, so there is no one to act for.');
}

async function siteLinks() {
  const origin = (publicHttpsUrl(process.env.WAYPOINT_PUBLIC_URL || (await publicUrlFromConfig()) || '') || '').replace(/\/+$/, '');
  if (!origin) return { note: 'Waypoint has no public address set, so its pages cannot be opened from outside.' };
  return { brief: `${origin}/`, mock_case_portal: `${origin}/portal/`, edit_details: `${origin}/setup/?edit=1` };
}

const emailView = (a) => ({
  email_id: a.id,
  state: a.state,
  deadline_id: a.clock ?? null,
  to: a.to ?? '',
  subject: a.subject ?? '',
  body: a.body ?? '',
  approved_at: a.state === 'approved' || a.state === 'sent' ? a.decided_at ?? null : null,
  gmail_draft_id: a.gmail_draft_id ?? null,
});

const BOT_TOOLS = [
  {
    name: 'list_people',
    description:
      'Who this key can act for: each person\'s id, name, visa type, case receipt numbers and how they want to be told, plus the current links to Waypoint\'s pages. Call this first.',
    inputSchema: schema({}),
    run: async (args, { scope }) => ({
      // Where Waypoint's pages are right now. The address can change, so use these
      // links rather than one remembered from an earlier run.
      links: await siteLinks(),
      people: store.profiles
        .filter((p) => scope.persons.has(p.id))
        .map((p) => ({
          person: p.id,
          name: p.name,
          visa_type: VISA_TYPES[p.visa_type]?.label ?? p.visa_type,
          receipts: p.receipts ?? [],
          phone: p.phone ?? '',
          channels: p.channels ?? {},
          quiet_hours: p.quiet_hours ?? null,
        })),
    }),
  },
  {
    name: 'get_brief',
    description:
      'The person\'s deadlines as Waypoint counts them (days left and risk are computed by code, never by a Bot), plus drafted emails waiting for the person. Read this before drafting or notifying.',
    inputSchema: schema({ person: PERSON, today: str('Optional date to count from, YYYY-MM-DD. Defaults to today.') }),
    run: (args, { scope }) => {
      const profile = personFor(args, scope);
      const today = strictDay(args.today) || localDay();
      return {
        person: profile.id,
        today,
        deadlines: buildClocks(profile, store, today).map((c) => ({
          deadline_id: c.id,
          name: c.name,
          due: c.due ?? null,
          days_left: c.daysLeft ?? null,
          risk: c.risk,
          reason: c.reason,
        })),
        emails_waiting_for_approval: store.actions.filter((a) => a.person === profile.id && a.state === 'drafted').map(emailView),
      };
    },
  },
  {
    name: 'report_run',
    description: 'Record that a Bot ran, in one line the person will read. Call it at the end of every run, including failed ones.',
    inputSchema: schema(
      {
        person: PERSON,
        bot: str('Which Bot ran.', { enum: BOTS }),
        status: str('How it went.', { enum: ['ok', 'failed', 'running'] }),
        summary: str('One plain line, for example: Read status: "Case Was Received".'),
        x_searches: {
          type: 'array',
          items: { type: 'string' },
          description: 'Scout only, and required when its run went ok: the searches you ran on X this run, exactly as you typed them.',
        },
        x_posts_read: { type: 'integer', description: 'Scout only: how many X posts you read this run.' },
      },
      ['bot', 'summary'],
    ),
    run: async (args, { scope }) => {
      const profile = personFor(args, scope);
      const bot = botName(args.bot);
      if (!BOTS.includes(bot)) throw new Error(`"bot" must be one of: ${BOTS.join(', ')}.`);
      if (!String(args.summary || '').trim()) throw new Error('Add a one-line summary.');
      const status = ['failed', 'running'].includes(args.status) ? args.status : 'ok';
      // Scout's job includes watching X, so a run that went ok has to say what it
      // searched there. Otherwise "No relevant changes" could mean it never looked.
      // (A Bot still reporting as the old Inbox Scout never searched X, so it is let be.)
      const watcher = ['Scout', 'Policy Watcher'].includes(String(args.bot));
      const searches = watcher ? xSearches(args.x_searches) : [];
      if (watcher && status === 'ok' && !searches.length) {
        throw new Error(
          'Scout has to search X before it reports. Run your X searches for this person\'s visa type, then call report_run again with x_searches (the searches you ran) and x_posts_read (how many posts you read). If you cannot search X right now, report status "failed" and say so in the summary.',
        );
      }
      const onX = searches.length ? { x_searches: searches, x_posts_read: Math.max(0, Math.min(9999, Math.floor(Number(args.x_posts_read)) || 0)) } : {};
      const row = appendRow('runs', { person: profile.id, bot, status, summary: String(args.summary), ...onX }, scope);
      await save();
      return { saved: row.id };
    },
  },
  {
    name: 'save_case_status',
    description: 'Case Clerk: record what a case-status portal shows for one receipt number. If the portal gives a date to respond by, pass it and Waypoint adds the deadline.',
    inputSchema: schema(
      {
        person: PERSON,
        receipt: str('The receipt number, like IOE0912345678.'),
        title: str('A short name for the case, like "STEM OPT case".'),
        portal: str('Where it was read, like "USCIS Case Status Online".'),
        status: str('The status exactly as the portal words it.'),
        last_changed: str('Date the status last changed, YYYY-MM-DD, if shown.'),
        response_due: str('Date a response is due, YYYY-MM-DD, if the portal or notice gives one.'),
      },
      ['receipt', 'status'],
    ),
    run: async (args, { scope }) => {
      const profile = personFor(args, scope);
      if (!String(args.status || '').trim()) throw new Error('Pass the status as the portal words it.');
      for (const field of ['last_changed', 'response_due']) {
        if (args[field] && !strictDay(args[field])) throw new Error(`"${field}" must be a real date like 2027-02-10.`);
      }
      const row = appendRow(
        'case_status',
        {
          person: profile.id,
          receipt: String(args.receipt || '').toUpperCase(),
          title: args.title || 'Case',
          portal: args.portal || 'Case status portal',
          status: String(args.status),
          last_changed: args.last_changed || null,
          response_due: args.response_due || null,
        },
        scope,
      );
      await save();
      return { saved: row.id };
    },
  },
  {
    name: 'save_policy_alert',
    description: 'Scout: record a rule change or official notice that matters to this person, with why it matters to them and a link to the official source. If you first saw it on X, say so with x_url.',
    inputSchema: schema(
      {
        person: PERSON,
        title: str('What changed, in a few words.'),
        why: str('Why it matters to this person, in plain language. Not legal advice.'),
        risk: str('How urgent it is for them.', { enum: ['act', 'watch', 'clear'] }),
        source_label: str('Who published it, like "USCIS" or "Federal Register".'),
        source_url: str('Link to the official page.'),
        x_url: str('If you first saw this on X: the link to that post (https://x.com/...). A post alone is not enough; the official source is still needed.'),
        seen_on_x: { type: 'boolean', description: 'True if you first saw this on X but have no single post to link.' },
      },
      ['title', 'why'],
    ),
    run: async (args, { scope }) => {
      const profile = personFor(args, scope);
      if (!String(args.title || '').trim() || !String(args.why || '').trim()) throw new Error('A title and a "why" are both needed.');
      const row = appendRow(
        'alerts',
        {
          person: profile.id,
          title: String(args.title),
          why: String(args.why),
          risk: ['act', 'watch', 'clear'].includes(args.risk) ? args.risk : 'clear',
          source_label: args.source_label || '',
          source_url: args.source_url || '',
          x_url: xPostUrl(args.x_url),
          seen_on_x: Boolean(xPostUrl(args.x_url)) || args.seen_on_x === true,
        },
        scope,
      );
      await save();
      return { saved: row.id };
    },
  },
  {
    name: 'save_inbox_date',
    description: 'Scout: record a dated item found in the person\'s email (an appointment, a response deadline). Waypoint turns it into a deadline. Never pass ID numbers or the email\'s full text.',
    inputSchema: schema(
      {
        person: PERSON,
        label: str('What the date is, like "Biometrics appointment".'),
        due_date: str('The date, YYYY-MM-DD.'),
        sender: str('Who sent the email, like "USCIS".'),
        subject: str('The email\'s subject line.'),
      },
      ['label', 'due_date'],
    ),
    run: async (args, { scope }) => {
      const profile = personFor(args, scope);
      if (!strictDay(args.due_date)) throw new Error('"due_date" must be a real date like 2026-12-09.');
      const row = appendRow(
        'inbox_facts',
        { person: profile.id, label: String(args.label || 'Date from your inbox'), due_date: args.due_date, sender: args.sender || '', subject: args.subject || '' },
        scope,
      );
      await save();
      return { saved: row.id };
    },
  },
  {
    name: 'set_deadline_note',
    description: 'Manager: replace the default one-line reason under a deadline with wording that fits this person. Do not restate day counts; Waypoint shows those.',
    inputSchema: schema({ person: PERSON, deadline_id: str('From get_brief.'), reason: str('One or two plain sentences.') }, ['deadline_id', 'reason']),
    run: async (args, { scope }) => {
      const profile = personFor(args, scope);
      if (!String(args.reason || '').trim()) throw new Error('Add the reason text.');
      const row = appendRow('clock_notes', { person: profile.id, clock: String(args.deadline_id), reason: String(args.reason) }, scope);
      await save();
      return { saved: row.id };
    },
  },
  {
    name: 'draft_email',
    description:
      'Manager: draft an email from the person to someone else (HR, a school official, an attorney). It is only a draft: the person must approve it in Waypoint before anything is sent. Never send it yourself.',
    inputSchema: schema(
      {
        person: PERSON,
        deadline_id: str('The deadline this email helps with, from get_brief.'),
        recipient_label: str('Who it goes to, in words, like "HR at your employer".'),
        to: str('The recipient\'s email address.'),
        subject: str('Subject line.'),
        body: str('The email, written as the person, plain and short.'),
      },
      ['recipient_label', 'subject', 'body'],
    ),
    run: async (args, { scope }) => {
      const profile = personFor(args, scope);
      if (!String(args.body || '').trim()) throw new Error('The email needs a body.');
      const row = appendRow(
        'actions',
        {
          person: profile.id,
          clock: args.deadline_id || '',
          recipient_label: String(args.recipient_label || 'someone else'),
          to: args.to || '',
          subject: String(args.subject || ''),
          body: String(args.body),
          drafted_by: 'Manager',
        },
        scope,
      );
      await save();
      return { email_id: row.id, state: row.state, next: 'Wait. The person approves or rejects it in Waypoint.' };
    },
  },
  {
    name: 'workflow_status',
    description:
      'Manager: where this run stands. Each Bot\'s latest run (who has reported and when, who failed), how many drafted emails are waiting for the person\'s approval, and which approved emails are not in their Gmail yet. Call it after starting the workers and before handing off to Messenger.',
    inputSchema: schema({ person: PERSON }),
    run: (args, { scope }) => {
      const profile = personFor(args, scope);
      const latest = new Map();
      for (const run of store.runs) {
        if (!run || run.person !== profile.id) continue;
        const prev = latest.get(run.bot);
        if (!prev || String(run.at) >= String(prev.at)) latest.set(run.bot, run);
      }
      const emails = store.actions.filter((a) => a && a.person === profile.id);
      return {
        now: nowIso(),
        bots: BOTS.map((name) => {
          const run = latest.get(name);
          return run
            ? { bot: name, status: run.status || 'ok', at: run.at, summary: run.summary ?? '', simulated: run.simulated === true, sample: run.sample === true }
            : { bot: name, status: 'no run yet' };
        }),
        emails_waiting_for_approval: emails.filter((a) => !a.state || a.state === 'drafted').length,
        approved_emails_not_delivered: emails.filter((a) => a.state === 'approved' && !a.gmail_draft_id).map((a) => a.id),
      };
    },
  },
  {
    name: 'list_emails',
    description: 'Manager and Messenger: the person\'s drafted emails and what they decided. Only an email whose state is "approved" may be put in their Gmail.',
    inputSchema: schema({ person: PERSON, state: str('Only this state.', { enum: ['drafted', 'approved', 'rejected', 'sent'] }) }),
    run: (args, { scope }) => {
      const profile = personFor(args, scope);
      return { emails: store.actions.filter((a) => a.person === profile.id && (!args.state || a.state === args.state)).map(emailView) };
    },
  },
  {
    name: 'mark_email_delivered',
    description: 'Messenger: after putting an APPROVED email in the person\'s Gmail, record it. Pass the Gmail draft id if it was saved as a draft, or sent=true if it was sent.',
    inputSchema: schema(
      { email_id: str('From list_emails.'), gmail_draft_id: str('The Gmail draft id.'), sent: { type: 'boolean', description: 'True if the email was actually sent.' } },
      ['email_id'],
    ),
    run: async (args, { scope }) => {
      const action = store.actions.find((a) => a.id === String(args.email_id));
      if (!action || !scope.persons.has(action.person)) throw new Error('No email with that id for the people this key acts for.');
      if (!['approved', 'sent'].includes(action.state)) throw new Error(`This email is "${action.state}". Only an approved email may be delivered.`);
      if (args.gmail_draft_id) action.gmail_draft_id = String(args.gmail_draft_id).slice(0, 200);
      if (args.sent === true) action.state = 'sent';
      await save();
      return emailView(action);
    },
  },
  {
    name: 'log_message',
    description: 'Messenger: record a message that went to the person themselves (a text, a calendar event). No receipt numbers or ID numbers in the text.',
    inputSchema: schema(
      {
        person: PERSON,
        channel: str('How it was delivered. Use "chat" for a message sent to the person in Grok Bot.', { enum: ['sms', 'calendar', 'gmail', 'slack', 'chat'] }),
        text: str('What it said, in one line.'),
        state: str('What happened.', { enum: ['sent', 'synced', 'held', 'failed'] }),
      },
      ['channel', 'text'],
    ),
    run: async (args, { scope }) => {
      const profile = personFor(args, scope);
      const row = appendRow('notifications', { person: profile.id, channel: String(args.channel), text: String(args.text || ''), state: args.state || 'sent' }, scope);
      await save();
      return { saved: row.id };
    },
  },
  {
    name: 'send_text',
    description:
      'Messenger: send one text message to the person\'s own phone, through Waypoint. Waypoint records it, so do not also call log_message for it. One line: what it is, the days left and the brief link. No receipt numbers or ID numbers. If this fails, the error says why (texting not switched on, no number, texts turned off, daily limit); do not retry more than once.',
    inputSchema: schema({ person: PERSON, text: str('The text, in one line, 300 characters at most.') }, ['text']),
    run: async (args, { scope }) => {
      const profile = personFor(args, scope);
      const { row, to } = await sendText(profile, args.text);
      return { sent: true, to: maskNumber(to), saved: row.id };
    },
  },
];

const mcp = createMcp({
  name: 'waypoint',
  version: '1.0.0',
  instructions:
    'Waypoint tracks one person\'s visa deadlines. Bots bring it facts (a case status, a rule change, a date from an email) and Waypoint\'s own code counts the days and sets the risk. Never do date math yourself. Never send anything to another person: draft it with draft_email and wait for the person to approve it in Waypoint. End every run with report_run. Waypoint is not legal advice.',
  tools: BOT_TOOLS,
});

// One line per connector call, so a failed connection can be diagnosed. Never the key.
function logBot(req, status, what = '') {
  const agent = String(req.headers['user-agent'] || '-').slice(0, 60);
  const key = req.headers.authorization ? 'key sent' : 'no key';
  console.log(`[bot] ${new Date().toISOString().slice(11, 19)} ${req.method} ${req.url} -> ${status} ${what} (${key}; ${agent})`);
}

async function serveMcp(req, res) {
  if (req.method !== 'POST') {
    logBot(req, 405);
    res.setHeader('Allow', 'POST');
    return sendJson(res, 405, { jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Send JSON-RPC by POST.' } });
  }
  const scope = botScope(req, null);
  if (!scope) {
    logBot(req, 401, req.headers.authorization ? 'key not recognised' : '');
    res.setHeader('WWW-Authenticate', 'Bearer realm="waypoint"');
    return sendJson(res, 401, { jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Add the header "Authorization: Bearer <your Waypoint Bot key>". The key is in Waypoint, under Settings, Connect your Bots.' } });
  }
  let message;
  try {
    ({ data: message } = await readBody(req));
  } catch {
    return sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'The body is not valid JSON.' } });
  }
  const { status, body } = await mcp.handle(message, { scope });
  const called = (Array.isArray(message) ? message : [message])
    .map((m) => (m?.method === 'tools/call' ? `tools/call ${m.params?.name}` : m?.method))
    .join(', ');
  logBot(req, status, String(called).slice(0, 120));
  if (body == null) {
    res.writeHead(status, { 'Cache-Control': 'no-store' });
    return res.end();
  }
  return sendJson(res, status, body);
}

// The mock portal also works as a plain form post, for a reader that runs no
// scripts: sign in, and the answer is the case-status page itself.
async function servePortalSignIn(req, res) {
  const { data } = await readBody(req);
  const { users } = JSON.parse(await readFile(USERS, 'utf8'));
  const user = users.find((u) => u.username === data.username && u.password === data.password);
  const page = (title, inner) =>
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)} · Mock Case Status Portal</title><meta name="robots" content="noindex"><link rel="stylesheet" href="/css/portal.css"></head><body><p class="demo-banner">Demo portal for a hackathon. Not a government website. All data is fake.</p><header class="portal-bar"><p class="portal-name">Mock Case Status Portal</p></header><main>${inner}<p><a href="/portal/">Back to sign in</a></p></main></body></html>`;
  if (!user) {
    return send(res, 401, page('Sign in failed', '<h1>Sign in failed</h1><p id="login-message">That username and password do not match.</p>'), TYPES['.html']);
  }
  const cases = (user.receipts ?? [])
    .filter((receipt) => Object.hasOwn(store.portal, receipt))
    .map((receipt) => {
      const c = store.portal[receipt];
      const row = (label, id, value) => `<div><dt>${label}</dt><dd id="${id}">${escapeHtml(value ?? '') || 'None'}</dd></div>`;
      return `<dl class="case">${row('Receipt number', 'case-receipt', receipt)}${row('Form', 'case-form', c.form)}${row('Status', 'case-status', c.status)}${row('Details', 'case-detail', c.detail)}${row('Last updated', 'case-last-updated', c.last_changed)}${row('Response due', 'case-response-due', c.response_due)}</dl>`;
    })
    .join('');
  return send(res, 200, page('Case status', `<h1>Case status</h1>${cases || '<p>No cases on this account.</p>'}`), TYPES['.html']);
}

// ---- static files ----

async function serveStatic(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') throw httpError(405, 'Use GET.');
  let rel;
  try {
    rel = decodeURIComponent(url.pathname);
  } catch {
    throw httpError(400, 'Bad address.');
  }
  let file = path.join(PUBLIC, path.normalize(rel));
  if (file !== PUBLIC && !file.startsWith(PUBLIC + path.sep)) throw httpError(403, 'Not allowed.');
  try {
    const info = await stat(file);
    if (info.isDirectory()) {
      if (!url.pathname.endsWith('/')) {
        res.writeHead(308, { Location: `${url.pathname}/${url.search}` });
        return res.end();
      }
      file = path.join(file, 'index.html');
    }
    let body = await readFile(file);
    if (file === path.join(PUBLIC, 'portal', 'index.html')) {
      // The mock portal prints its own demo sign-in, so a Bot or a judge can get in
      // without anyone passing a password around. A fake account on a fake portal.
      const { users } = JSON.parse(await readFile(USERS, 'utf8'));
      body = body
        .toString('utf8')
        .replace('%DEMO_USERNAME%', escapeHtml(users[0]?.username ?? ''))
        .replace('%DEMO_PASSWORD%', escapeHtml(users[0]?.password ?? ''));
    }
    send(res, 200, req.method === 'HEAD' ? '' : body, TYPES[path.extname(file)] || 'application/octet-stream');
  } catch {
    send(
      res,
      404,
      '<!doctype html><html lang="en"><meta charset="utf-8"><title>Not found</title><link rel="stylesheet" href="/css/app.css"><main><h1>Page not found</h1><p>That address does not exist. <a href="/">Go to your brief</a>.</p></main></html>',
      TYPES['.html'],
    );
  }
}

// ---- server ----

export async function start({ port = PORT, host = HOST } = {}) {
  await loadStore();
  await loadAccounts();
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (url.pathname === '/healthz') {
        const kept = persist.remote ? (persistError ? 'database error, data may not be kept' : 'database on, data is kept') : 'no database, data lasts until the next restart';
        return send(res, 200, `ok (${kept}${sms.ready ? ', texts on' : ''})`);
      }
      if (/^\/(\.well-known|register|authorize|token|sse)\b/.test(url.pathname)) logBot(req, 'probe');
      if (url.pathname === '/mcp' || url.pathname === '/mcp/') await serveMcp(req, res);
      else if (req.method === 'POST' && url.pathname === '/portal/') await servePortalSignIn(req, res);
      else if (url.pathname.startsWith('/api/')) await api(req, res, url);
      else if (req.method === 'GET' && SIGNED_IN_PAGES.includes(url.pathname) && !readSession(req)) redirect(res, '/login/');
      else if (req.method === 'GET' && url.pathname === '/login/' && readSession(req)) redirect(res, '/');
      else await serveStatic(req, res, url);
    } catch (err) {
      const status = err.status || 500;
      if (status === 500) console.error(err);
      sendJson(res, status, { ok: false, error: status === 500 ? 'Something went wrong on the server.' : err.message });
    }
  });
  await new Promise((resolve) => server.listen(port, host, resolve));
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = await start();
  const { port } = server.address();
  console.log(`Waypoint is running at http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${port}`);
  console.log(`  Sign in        /login/`);
  console.log(`  Brief          /`);
  console.log(`  Mock portal    /portal/        (change its status at /portal/admin/)`);
  console.log(`  Bot report     /report/`);
  console.log(`  Bot connector  /mcp            (key for the sample people: data/bot-key.txt)`);
}
