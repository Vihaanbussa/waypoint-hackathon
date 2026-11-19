// The JSON api: sign-in, the person's own data, "Check now", connecting Bots, the
// report form, and the demo controls.

import { readFile } from 'node:fs/promises';
import { maskNumber } from './sms.js';
import { APPEND_TABLES, BOTS, TYPES } from './config.js';
import { httpError, send, sendJson, readBody, resultPage } from './http.js';
import { strictDay, publicHttpsUrl, resolvesPublic, profileFromInput } from './validate.js';
import { hashPassword, newSalt, newUserId, sameText } from './auth.js';
import { buildClocks } from '../public/js/clocks.js';

export function createApi(ctx) {
  const {
    cfg, store, accounts, sms, auth, save, saveAccounts, appendRow, newId, nowIso, localDay, newBotKey,
    fullStore, publicUrlFromConfig, replaceStore, textsSince, sendText,
  } = ctx;
  const { failures, startSession, endSession, readSession, requireSession, requireDemo, visibleProfiles, requireProfile, writerScope } = auth;

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
        // only to a browser on the same machine. The Host header is client-controlled,
        // so also require a loopback socket and no proxy in front.
        const onThisMachine = /^(::1|127\.|::ffff:127\.)/.test(req.socket.remoteAddress || '') && !req.headers['x-forwarded-for'];
        return sendJson(res, 200, { ...base, demo: true, ...(local && onThisMachine ? { bot_key: accounts.bot_key } : {}) });
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
      const salt = newSalt();
      const user = { id: newUserId(), email, name, salt, hash: hashPassword(password, salt), bot_key: newBotKey(), created_at: nowIso() };
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
    // mock portal for the person's receipt numbers; Deadline Keeper counts deadlines.
    // Both runs are marked simulated. The other Bots are not pretended.
    if (url.pathname === '/api/check') {
      const session = requireSession(req);
      const profile = requireProfile(session, String(data.person || ''));
      const today = strictDay(data.today) || localDay();
      if (profile.bot_webhook?.url) {
        // A real Bot is connected: wake its routine and let it report back itself.
        let answer;
        // Checked again now: the name may have been repointed since it was saved.
        if (!(await resolvesPublic(profile.bot_webhook.url))) throw httpError(502, 'Your Bot webhook does not point to a public address. Check it in Settings.');
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
          bot: 'Deadline Keeper',
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
        if (!address || !(await resolvesPublic(address))) throw httpError(400, 'The webhook address must be a public https:// address.');
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
          if (!BOTS.includes(String(data.bot))) throw httpError(400, 'Pick one of the six Bots.');
          saved.push(
            appendRow(
              'runs',
              {
                person,
                bot: String(data.bot),
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
      const { users } = JSON.parse(await readFile(cfg.USERS, 'utf8'));
      const user = users.find((u) => u.username === data.username && u.password === data.password);
      if (!user) throw httpError(401, 'That username and password do not match.');
      return sendJson(res, 200, { ok: true, receipts: user.receipts });
    }

    if (url.pathname === '/api/portal/case') {
      requireDemo(requireSession(req));
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
      requireDemo(requireSession(req));
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
      requireDemo(requireSession(req));
      const owned = store.profiles.filter((p) => p && p.owner);
      const ownedIds = new Set(owned.map((p) => p.id));
      const kept = Object.fromEntries(
        [...APPEND_TABLES, 'own_deadlines'].map((table) => [table, (store[table] || []).filter((r) => r && ownedIds.has(r.person))]),
      );
      const next = JSON.parse(await readFile(cfg.SEED, 'utf8'));
      for (const table of [...APPEND_TABLES, 'own_deadlines']) {
        next[table] = [...(Array.isArray(next[table]) ? next[table] : []), ...kept[table]];
      }
      next.profiles = [...(next.profiles || []), ...owned];
      replaceStore(next);
      await save();
      return sendJson(res, 200, { ok: true });
    }

    throw httpError(404, 'No such endpoint.');
  }

  return { api };
}
