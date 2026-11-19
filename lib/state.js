// What the server remembers: the store (Bots' rows and the people's profiles),
// the accounts, and saving both to disk and to the optional database.
//
// `store` and `accounts` are fixed objects changed in place, so every module that
// holds one sees the current data. One of these is made per server, so nothing
// is shared between two servers started in the same process.

import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { parseCsv } from './csv.js';
import { createPersist } from './persist.js';
import { createSms } from './sms.js';
import { httpError } from './http.js';
import { prepareRow } from './validate.js';
import { APPEND_TABLES, KEEP, botName } from './config.js';

const replaceContents = (target, next) => {
  for (const key of Object.keys(target)) delete target[key];
  Object.assign(target, next);
};

export function createState({ cfg }) {
  const store = {};
  const accounts = {}; // { secret, bot_key, users: [{ id, email, name, salt, hash, bot_key, created_at }] }
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

  // Keep the newest `max` rows for each person, so one account's flood cannot push
  // another's history out. A hard ceiling per table covers many accounts at once.
  function trimStore() {
    for (const [table, max] of Object.entries(KEEP)) {
      const rows = store[table];
      if (!Array.isArray(rows)) continue;
      const seen = new Map();
      const kept = [];
      for (let i = rows.length - 1; i >= 0; i -= 1) {
        const who = rows[i]?.person ?? '';
        const n = (seen.get(who) ?? 0) + 1;
        seen.set(who, n);
        if (n <= max) kept.push(rows[i]);
      }
      kept.reverse();
      store[table] = kept.length > max * 10 ? kept.slice(-max * 10) : kept;
    }
  }

  function normalizeStore() {
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

  async function loadStore() {
    await mkdir(cfg.DATA, { recursive: true });
    const kept = await fromDatabase('store');
    const file = existsSync(cfg.STORE) ? cfg.STORE : cfg.SEED;
    replaceContents(store, kept && typeof kept === 'object' ? kept : JSON.parse(await readFile(file, 'utf8')));
    normalizeStore();
  }

  // Put the sample people back. `next` is the fresh seed; the caller merges what to keep.
  function replaceStore(next) {
    replaceContents(store, next);
    normalizeStore();
  }

  const newBotKey = () => `wpb_${randomBytes(24).toString('hex')}`;

  let savingAccounts = Promise.resolve();
  function saveAccounts() {
    const run = savingAccounts.then(async () => {
      const tmp = `${cfg.ACCOUNTS}.tmp`;
      await writeFile(tmp, JSON.stringify(accounts, null, 2), { mode: 0o600 });
      await rename(tmp, cfg.ACCOUNTS);
      await toDatabase('accounts', accounts);
    });
    savingAccounts = run.catch(() => {});
    return run;
  }

  async function loadAccounts() {
    const kept = await fromDatabase('accounts');
    let loaded;
    try {
      loaded = kept && typeof kept === 'object' ? kept : JSON.parse(await readFile(cfg.ACCOUNTS, 'utf8'));
    } catch {
      loaded = {};
    }
    replaceContents(accounts, loaded);
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
    await writeFile(cfg.BOT_KEY_FILE, `${accounts.bot_key}\n`, { mode: 0o600 });
  }

  function save() {
    saving = saving
      .then(async () => {
        trimStore();
        const tmp = `${cfg.STORE}.tmp`;
        await writeFile(tmp, JSON.stringify(store, null, 2));
        await rename(tmp, cfg.STORE);
        await toDatabase('store', store);
      })
      .catch((err) => console.error('Could not save the store:', err.message));
    return saving;
  }

  const nowIso = () => new Date().toISOString();
  const newId = (table) => `${table}-${Date.now().toString(36)}-${(counter += 1)}`;

  // Today's date for a person: in their time zone if we know it, else the server's.
  function localDay(now = new Date(), timeZone = '') {
    if (timeZone) {
      try {
        return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
      } catch {
        // An unknown zone: fall through to the server's own day.
      }
    }
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
      // Set only by sendText: they count against the text caps, so a caller cannot forge them.
      delete row.via;
      delete row.twilio_id;
      // A rule-change notice for a whole visa type is the only row with no person,
      // and only the key for the sample people may write one.
      const forEveryone = table === 'alerts' && !row.person;
      if (forEveryone ? !scope.master : !scope.persons.has(String(row.person))) {
        throw httpError(403, row.person ? `This key cannot write for person "${String(row.person).slice(0, 40)}".` : 'Say which person this row is for.');
      }
    }
    prepareRow(table, row, store);
    row.id = newId(table); // never the caller's: a chosen id could shadow someone else's row
    row.at = row.at || nowIso();
    delete row.sample;
    // Only the person approves or rejects. A Bot can only draft.
    if (table === 'actions') {
      row.state = 'drafted';
      delete row.decided_at;
    }
    if (table === 'case_status' && !row.checked_at) row.checked_at = row.at;
    store[table].push(row);
    return row;
  }

  // ---- optional: read tables from a published Google Sheet ----

  const sheetCache = new Map();
  const sheetErrors = {};

  async function readConfig() {
    try {
      return JSON.parse(await readFile(cfg.CONFIG, 'utf8'));
    } catch {
      return {};
    }
  }

  async function sheetConfig() {
    const config = await readConfig();
    return config.sheet_csv && typeof config.sheet_csv === 'object' ? config.sheet_csv : {};
  }

  async function publicUrlFromConfig() {
    // Hosts announce their own address: Render as a URL, Railway as a bare domain.
    const hosted = process.env.RENDER_EXTERNAL_URL || (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : '');
    return String((await readConfig()).public_url || hosted || '');
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

  return {
    store,
    accounts,
    persist,
    sms,
    persistError: () => persistError,
    loadStore,
    replaceStore,
    loadAccounts,
    saveAccounts,
    save,
    newBotKey,
    nowIso,
    newId,
    localDay,
    appendRow,
    publicUrlFromConfig,
    fullStore,
  };
}
