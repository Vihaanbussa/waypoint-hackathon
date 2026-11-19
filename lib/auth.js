// Who is asking: browser sessions, Bot keys, and what each may see and write.

import { randomBytes, scryptSync, timingSafeEqual, createHmac } from 'node:crypto';
import { COOKIE, SESSION_DAYS } from './config.js';
import { httpError } from './http.js';

export function sameText(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

export const hashPassword = (password, salt) => scryptSync(password, salt, 64).toString('hex');
export const newSalt = () => randomBytes(16).toString('hex');
export const newUserId = () => randomBytes(6).toString('hex');

export function createAuth({ cfg, store, accounts }) {
  const failures = new Map(); // email -> { count, until }
  const DEMO_SESSION = { id: 'demo', demo: true, name: 'Demo', email: null };
  const signValue = (value) => createHmac('sha256', accounts.secret).update(value).digest('base64url');

  // The cookie is a signed note of who is signed in and until when. No server-side
  // session table, so a restart does not sign anyone out.
  function startSession(res, userId) {
    const payload = Buffer.from(JSON.stringify({ u: userId, e: Date.now() + SESSION_DAYS * 864e5 })).toString('base64url');
    res.setHeader('Set-Cookie', `${COOKIE}=${payload}.${signValue(payload)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${cfg.HOSTED ? '; Secure' : ''}`);
  }

  function endSession(res) {
    res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
  }

  function readSession(req) {
    const raw = new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`).exec(String(req.headers.cookie || ''))?.[1];
    if (!raw) return cfg.DEMO_ONLY ? DEMO_SESSION : null;
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

  // Only the demo session (the sample people) may touch shared demo data.
  function requireDemo(session) {
    if (!session.demo) throw httpError(403, 'Only the demo can change the shared sample data.');
  }

  // The demo sees the sample people. An account sees only its own profile.
  const visibleProfiles = (session, profiles = store.profiles) =>
    profiles.filter((p) => p && (session.demo ? !p.owner : p.owner === session.id));

  function requireProfile(session, id) {
    const profile = visibleProfiles(session).find((p) => p.id === id);
    if (!profile) throw httpError(404, 'No profile with that id.');
    return profile;
  }

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
    // Never master: a person-less alert reaches every account, so only the sample people's Bot key may write one.
    return { master: false, label: session.name, persons: new Set(visibleProfiles(session).map((p) => p.id)) };
  }

  return { failures, startSession, endSession, readSession, requireSession, requireDemo, visibleProfiles, requireProfile, botScope, writerScope };
}
