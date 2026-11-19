// Accounts, Bot keys and sessions. The session cookie is a signed note, so no
// server-side session table. Passwords and keys never leave this file's callers.

import { readFile, writeFile, rename } from 'node:fs/promises';
import { randomBytes, scryptSync, timingSafeEqual, createHmac } from 'node:crypto';
import { ACCOUNTS, BOT_KEY_FILE, COOKIE, HOSTED, SESSION_DAYS } from './config.js';
import { fromDatabase, store, toDatabase, visibleProfiles } from './store.js';
import { httpError } from './http.js';

// ---- accounts and sessions ----

export let accounts; // { secret, users: [{ id, email, name, salt, hash, created_at }] }
export const failures = new Map(); // email -> { count, until }
const DEMO_SESSION = { id: 'demo', demo: true, name: 'Demo', email: null };
const DEMO_ONLY = process.env.WAYPOINT_DEMO_ONLY === '1';

export async function saveAccounts() {
  const tmp = `${ACCOUNTS}.tmp`;
  await writeFile(tmp, JSON.stringify(accounts, null, 2), { mode: 0o600 });
  await rename(tmp, ACCOUNTS);
  await toDatabase('accounts', accounts);
}

export async function loadAccounts() {
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

export const newBotKey = () => `wpb_${randomBytes(24).toString('hex')}`;

// Who a Bot key speaks for: the people it may read and write, and nothing else.
export function botScope(req, data) {
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
export function writerScope(req, data) {
  const bot = botScope(req, data);
  if (bot) return bot;
  const session = readSession(req);
  if (!session) throw httpError(401, 'Add your Bot key, or sign in first.');
  return { master: session.demo, label: session.name, persons: new Set(visibleProfiles(session).map((p) => p.id)) };
}

// https only, and never an address inside this machine or network.
export function publicHttpsUrl(text) {
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

export const hashPassword = (password, salt) => scryptSync(password, salt, 64).toString('hex');
const signValue = (value) => createHmac('sha256', accounts.secret).update(value).digest('base64url');

export function sameText(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

// The cookie is a signed note of who is signed in and until when. No server-side
// session table, so a restart does not sign anyone out.
export function startSession(res, userId) {
  const payload = Buffer.from(JSON.stringify({ u: userId, e: Date.now() + SESSION_DAYS * 864e5 })).toString('base64url');
  res.setHeader('Set-Cookie', `${COOKIE}=${payload}.${signValue(payload)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${HOSTED ? '; Secure' : ''}`);
}

export function endSession(res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

export function readSession(req) {
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

export function requireSession(req) {
  const session = readSession(req);
  if (!session) throw httpError(401, 'Sign in first.');
  return session;
}

export function requireProfile(session, id) {
  const profile = visibleProfiles(session).find((p) => p.id === id);
  if (!profile) throw httpError(404, 'No profile with that id.');
  return profile;
}
