// The server end to end, against a throwaway copy of the store.

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildClocks } from '../public/js/clocks.js';

let server;
let base;
let dataDir;

before(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), 'waypoint-test-'));
  process.env.WAYPOINT_DATA_DIR = dataDir;
  const { start } = await import('../server.js');
  server = await start({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${server.address().port}`;
  demoCookie = cookieFrom(await as('').postJson('/api/auth/demo', {}));
  assert.match(demoCookie, /^wp_session=/);
  sampleKey = (await readFile(path.join(dataDir, 'bot-key.txt'), 'utf8')).trim();
});

// Talk to the Bot connector the way a Bot does: JSON-RPC over POST with a key.
let sampleKey = '';
let rpcId = 0;
async function rpc(key, method, params) {
  const res = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: (rpcId += 1), method, params }),
  });
  return { status: res.status, body: res.status === 202 ? null : await res.json() };
}
async function callTool(key, name, args = {}) {
  const { body } = await rpc(key, 'tools/call', { name, arguments: args });
  const text = body.result.content[0].text;
  return { isError: body.result.isError, value: body.result.isError ? text : JSON.parse(text) };
}

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await rm(dataDir, { recursive: true, force: true });
});

// A tiny cookie jar: `as(cookie)` makes requests as whoever holds that cookie.
// The default helpers act as the demo, which sees the two sample people.
let demoCookie = '';
const cookieFrom = (res) => (res.headers.get('set-cookie') || '').split(';')[0];
const as = (cookie) => ({
  getJson: async (p) => (await fetch(base + p, { headers: { Cookie: cookie } })).json(),
  get: (p) => fetch(base + p, { headers: { Cookie: cookie }, redirect: 'manual' }),
  postJson: (p, body) =>
    fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify(body) }),
});
const getJson = (p) => as(demoCookie).getJson(p);
const postJson = (p, body) => as(demoCookie).postJson(p, body);

async function signUp(name, email) {
  const res = await as('').postJson('/api/auth/signup', { name, email, password: `pw-${email}-long-enough` });
  assert.equal(res.status, 200, email);
  return cookieFrom(res);
}

test('serves the three places, the portal and the report form', async () => {
  for (const page of ['/', '/activity/', '/settings/', '/portal/', '/portal/admin/', '/report/']) {
    const res = await as(demoCookie).get(page);
    assert.equal(res.status, 200, page);
    assert.match(res.headers.get('content-type'), /text\/html/);
  }
  assert.equal((await fetch(`${base}/nope`)).status, 404);
});

test('signed out: the app pages send you to sign in, and the store says no', async () => {
  for (const page of ['/', '/activity/', '/settings/', '/setup/']) {
    const res = await as('').get(page);
    assert.equal(res.status, 302, page);
    assert.equal(res.headers.get('location'), '/login/');
  }
  assert.equal((await as('').get('/login/')).status, 200);
  assert.equal((await as(demoCookie).get('/login/')).status, 302);
  assert.equal((await as('').get('/api/store')).status, 401);
  assert.equal((await as('wp_session=forged.cookie').get('/api/store')).status, 401);
});

test('an account: sign up, sign in, and the rules about passwords', async () => {
  const anon = as('');
  assert.equal((await anon.postJson('/api/auth/signup', { name: 'Ada', email: 'not-an-email', password: 'long-enough-1' })).status, 400);
  assert.equal((await anon.postJson('/api/auth/signup', { name: 'Ada', email: 'ada@example.com', password: 'short' })).status, 400);
  const cookie = await signUp('Ada Okafor', 'ada@example.com');
  assert.equal((await anon.postJson('/api/auth/signup', { name: 'Ada', email: 'ADA@example.com', password: 'long-enough-1' })).status, 409);

  const me = await as(cookie).getJson('/api/me');
  assert.equal(me.me.name, 'Ada Okafor');
  assert.equal(me.me.demo, false);

  assert.equal((await anon.postJson('/api/auth/login', { email: 'ada@example.com', password: 'wrong-password' })).status, 401);
  const good = await anon.postJson('/api/auth/login', { email: 'Ada@Example.com', password: 'pw-ada@example.com-long-enough' });
  assert.equal(good.status, 200);
  assert.match(cookieFrom(good), /^wp_session=/);

  // The password is stored hashed, never as typed, and never reaches a browser.
  const saved = await readFile(path.join(dataDir, 'accounts.json'), 'utf8');
  assert.ok(!saved.includes('pw-ada@example.com-long-enough'));
  assert.ok(!JSON.stringify(await as(cookie).getJson('/api/store')).includes('hash'));

  const out = await as(cookie).postJson('/api/auth/logout', {});
  assert.match(out.headers.get('set-cookie'), /Max-Age=0/);
});

test('your own data: a profile from your dates, seen only by you', async () => {
  const cookie = await signUp('Bao Tran', 'bao@example.com');
  const bao = as(cookie);
  let store = await bao.getJson('/api/store');
  assert.equal(store.profiles.length, 0, 'a new account starts empty, not with sample people');
  assert.equal(store.runs.length, 0);

  assert.equal((await bao.postJson('/api/profile', { name: 'Bao Tran', visa_type: 'nope' })).status, 400);
  assert.equal((await bao.postJson('/api/profile', { name: 'Bao Tran', visa_type: 'h1b', employment_end: '2026-02-31' })).status, 400);
  assert.equal((await bao.postJson('/api/profile', { name: 'Bao Tran', visa_type: 'h1b', receipts: 'not a receipt' })).status, 400);
  const saved = await bao.postJson('/api/profile', {
    name: 'Bao Tran',
    visa_type: 'h1b',
    h1b_start: '2025-10-01',
    employment_end: '2026-11-08',
    passport_end: '2029-03-01',
    ead_end: '2027-01-01', // not an H-1B field: dropped
    receipts: 'ioe0912345678, EAC2412345678',
    phone: '(555) 010-0199',
    channels: { sms: true, calendar: false, gmail: true },
  });
  assert.equal(saved.status, 200);

  store = await bao.getJson('/api/store');
  const [profile] = store.profiles;
  assert.equal(profile.ead_end, undefined);
  assert.deepEqual(profile.receipts, ['IOE0912345678', 'EAC2412345678']);
  assert.equal(profile.channels.calendar, false);
  const clocks = buildClocks(profile, store, '2026-11-18');
  const grace = clocks.find((c) => c.id === 'h1b_grace');
  assert.equal(grace.due, '2027-01-07');
  assert.equal(grace.daysLeft, 50);
  assert.equal(grace.risk, 'watch');

  // The demo and other accounts cannot see or change it.
  const demo = await getJson('/api/store');
  assert.ok(!demo.profiles.some((p) => p.id === profile.id));
  assert.equal((await postJson(`/api/profiles/${profile.id}/settings`, { channels: { sms: false } })).status, 404);
  assert.equal((await postJson('/api/profile', { name: 'X', visa_type: 'h1b' })).status, 403);
  const other = as(await signUp('Cy Dee', 'cy@example.com'));
  assert.equal((await other.getJson('/api/store')).profiles.length, 0);
  assert.equal((await other.postJson('/api/own-deadlines', { person: profile.id, label: 'x', due_date: '2027-01-01' })).status, 404);
  assert.equal((await other.postJson('/api/actions/act-priya-hr', { state: 'approved' })).status, 404);

  // Editing keeps the same profile.
  await bao.postJson('/api/profile', { name: 'Bao T.', visa_type: 'h1b', h1b_start: '2025-10-01' });
  store = await bao.getJson('/api/store');
  assert.equal(store.profiles.length, 1);
  assert.equal(store.profiles[0].id, profile.id);
  assert.equal(store.profiles[0].employment_end, undefined);
  assert.equal(store.me.name, 'Bao T.');
});

test('your own deadlines, and Check now', async () => {
  const cookie = await signUp('Dee Park', 'dee@example.com');
  const dee = as(cookie);
  await dee.postJson('/api/profile', { name: 'Dee Park', visa_type: 'f1_opt', ead_end: '2027-06-01', receipts: 'IOE0912345678' });
  let store = await dee.getJson('/api/store');
  const person = store.profiles[0].id;

  assert.equal((await dee.postJson('/api/own-deadlines', { person, label: '', due_date: '2026-12-01' })).status, 400);
  assert.equal((await dee.postJson('/api/own-deadlines', { person, label: 'Lease ends', due_date: 'soon' })).status, 400);
  const added = await dee.postJson('/api/own-deadlines', { person, label: 'Biometrics appointment', due_date: '2026-11-25', note: 'Bring the notice.' });
  const { row } = await added.json();

  store = await dee.getJson('/api/store');
  let clocks = buildClocks(store.profiles[0], store, '2026-11-18');
  const own = clocks.find((c) => c.ownId === row.id);
  assert.equal(own.daysLeft, 7);
  assert.equal(own.risk, 'act');
  assert.equal(own.reason, 'Bring the notice.');

  // Check now: Case Clerk reads the mock portal, the Manager counts. Both say simulated.
  const check = await dee.postJson('/api/check', { person, today: '2026-11-18' });
  assert.equal(check.status, 200);
  store = await dee.getJson('/api/store');
  assert.deepEqual(store.runs.map((r) => r.bot), ['Case Clerk', 'Manager']);
  assert.ok(store.runs.every((r) => r.simulated === true));
  // Work permit card, the appointment, the case just read, and one rule-change notice for F-1.
  assert.match(store.runs[1].summary, /Counted 4 deadlines, 1 to act on now/);
  assert.equal(store.case_status[0].status, 'Case Was Received');

  assert.equal((await dee.postJson(`/api/own-deadlines/${row.id}/delete`, {})).status, 200);
  store = await dee.getJson('/api/store');
  assert.equal(store.own_deadlines.length, 0);

  // Resetting the demo puts the sample people back and leaves accounts alone.
  await postJson('/api/reset', {});
  store = await dee.getJson('/api/store');
  assert.equal(store.profiles.length, 1);
  assert.equal(store.runs.length, 2);
});

test('does not serve files outside public', async () => {
  const status = await new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port: server.address().port, path: '/%2e%2e/server.js' }, (res) => {
        res.resume();
        resolve(res.statusCode);
      })
      .on('error', reject);
  });
  // The address is normalized to /server.js inside public (404), or refused (403).
  assert.ok([403, 404].includes(status), `got ${status}`);
  const store = await getJson('/api/store');
  assert.equal(store.portal_users, undefined);
  assert.ok(!JSON.stringify(store).includes('password'));
});

test('the store starts from the sample data', async () => {
  const store = await getJson('/api/store');
  assert.equal(store.profiles.length, 2);
  assert.equal(store.actions.filter((a) => a.state === 'drafted').length, 2);
});

test('portal sign-in checks the username and password', async () => {
  const { users } = JSON.parse(await readFile(new URL('../data/portal-users.json', import.meta.url), 'utf8'));
  const bad = await postJson('/api/portal/login', { username: users[0].username, password: 'wrong' });
  assert.equal(bad.status, 401);
  const good = await postJson('/api/portal/login', users[0]);
  assert.equal(good.status, 200);
  assert.deepEqual((await good.json()).receipts, ['IOE0912345678']);
});

test('the demo flow: change the portal, run a check, the brief gains a stop', async () => {
  const change = await postJson('/api/portal/case', {
    receipt: 'IOE0912345678',
    status: 'Request for Evidence Was Sent',
    detail: 'We sent a request for evidence.',
    response_due: '2027-02-10',
  });
  assert.equal(change.status, 200);

  // The brief does not change until a Case Clerk run reads the portal.
  let store = await getJson('/api/store');
  let clocks = buildClocks(store.profiles[0], store, '2026-11-18');
  assert.equal(clocks.find((c) => c.id.startsWith('notice-')), undefined);

  assert.equal((await postJson('/api/simulate/case-clerk', { receipt: 'IOE0912345678' })).status, 200);
  store = await getJson('/api/store');
  clocks = buildClocks(store.profiles[0], store, '2026-11-18');
  const notice = clocks.find((c) => c.id === 'notice-ioe0912345678');
  assert.equal(notice.daysLeft, 84);
  assert.equal(notice.risk, 'watch');
  const run = store.runs.at(-1);
  assert.equal(run.bot, 'Case Clerk');
  assert.equal(run.simulated, true);
});

test('a Bot can draft an action but cannot approve one', async () => {
  const res = await postJson('/api/rows/actions', { person: 'priya', clock: 'passport_expiry', body: 'Hi', state: 'approved' });
  const { row } = await res.json();
  assert.equal(row.state, 'drafted');
  assert.equal((await postJson('/api/rows/profiles', { id: 'mallory' })).status, 400);
});

test('approval is a one-way step that only happens once', async () => {
  const edit = await postJson('/api/actions/act-priya-hr', { body: 'Edited text.' });
  assert.equal((await edit.json()).action.state, 'drafted');
  const approve = await postJson('/api/actions/act-priya-hr', { state: 'approved' });
  const { action } = await approve.json();
  assert.equal(action.state, 'approved');
  assert.equal(action.body, 'Edited text.');
  assert.ok(action.decided_at);
  assert.equal((await postJson('/api/actions/act-priya-hr', { state: 'rejected' })).status, 409);
  assert.equal((await postJson('/api/actions/act-wei-attorney', { state: 'sent' })).status, 400);
});

test('settings save and validate', async () => {
  const ok = await postJson('/api/profiles/priya/settings', {
    channels: { sms: false, calendar: true, gmail: true },
    quiet_hours: { from: '23:00', to: '06:30' },
  });
  assert.equal(ok.status, 200);
  const store = await getJson('/api/store');
  assert.equal(store.profiles[0].channels.sms, false);
  assert.equal(store.profiles[0].quiet_hours.to, '06:30');
  assert.equal((await postJson('/api/profiles/priya/settings', { quiet_hours: { from: 'late', to: '07:00' } })).status, 400);
});

test('the report form works as a plain form post, and escapes what it echoes', async () => {
  const form = (fields) =>
    fetch(`${base}/api/report`, { method: 'POST', body: new URLSearchParams({ key: sampleKey, ...fields }) });

  // No key and not signed in: nothing is written.
  const anon = await fetch(`${base}/api/report`, { method: 'POST', body: new URLSearchParams({ bot: 'Case Clerk', person: 'wei', summary: 'x' }) });
  assert.equal(anon.status, 401);
  assert.equal((await as('').postJson('/api/rows/runs', { person: 'wei', bot: 'Case Clerk', summary: 'x' })).status, 401);

  const good = await form({
    bot: 'Policy Watcher',
    person: 'wei',
    status: 'ok',
    summary: 'Found 1 relevant notice',
    table: 'alerts',
    row: '{"title": "test notice", "why": "Because.", "risk": "watch"}',
  });
  assert.equal(good.status, 200);
  assert.match(await good.text(), /Saved 2 row\(s\)/);
  const store = await getJson('/api/store');
  assert.equal(store.alerts.at(-1).person, 'wei');

  const bad = await form({ table: 'alerts', row: '{not json' });
  assert.equal(bad.status, 400);
  assert.match(await bad.text(), /not valid JSON/);

  const sneaky = await form({ table: '<script>alert(1)</script>', row: '{}' });
  const html = await sneaky.text();
  assert.ok(!html.includes('<script>alert(1)'));
});

test('reset puts the sample data back', async () => {
  assert.equal((await postJson('/api/reset', {})).status, 200);
  const store = await getJson('/api/store');
  assert.equal(store.actions.length, 2);
  assert.ok(store.actions.every((a) => a.state === 'drafted'));
  assert.equal(store.portal.IOE0912345678.status, 'Case Was Received');
});

test('the Bot connector: handshake, tool list, and no way in without a key', async () => {
  assert.equal((await rpc('', 'initialize', {})).status, 401);
  assert.equal((await rpc('wpb_not-a-real-key', 'tools/list', {})).status, 401);
  // The bare key, without the word Bearer, is accepted too.
  const bare = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: sampleKey },
    body: JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'ping' }),
  });
  assert.equal(bare.status, 200);
  assert.equal((await fetch(`${base}/mcp`)).status, 405);

  const hello = await rpc(sampleKey, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
  assert.equal(hello.status, 200);
  assert.equal(hello.body.result.protocolVersion, '2025-06-18');
  assert.equal(hello.body.result.serverInfo.name, 'waypoint');
  assert.ok(hello.body.result.capabilities.tools);

  // A notification gets no body back.
  const note = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${sampleKey}` },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
  });
  assert.equal(note.status, 202);

  const { body } = await rpc(sampleKey, 'tools/list', {});
  const names = body.result.tools.map((t) => t.name);
  for (const name of ['list_people', 'get_brief', 'report_run', 'save_case_status', 'draft_email', 'list_emails', 'mark_email_delivered']) {
    assert.ok(names.includes(name), name);
  }
  assert.ok(body.result.tools.every((t) => t.description && t.inputSchema.type === 'object'));
  assert.equal((await rpc(sampleKey, 'no/such', {})).body.error.code, -32601);
});

test('a Bot with its own key: reads the brief, reports, drafts, and cannot approve or reach anyone else', async () => {
  const cookie = await signUp('Eli Novak', 'eli@example.com');
  const eli = as(cookie);
  await eli.postJson('/api/profile', { name: 'Eli Novak', visa_type: 'f1_opt', ead_end: '2026-12-10', receipts: 'IOE0912345678' });
  const connect = await eli.getJson('/api/connect');
  assert.match(connect.mcp_url, /\/mcp$/);
  const key = connect.bot_key;
  assert.match(key, /^wpb_/);
  // The sample people's key is shown to the demo only on the machine running the server.
  assert.equal((await getJson('/api/connect')).bot_key, sampleKey);
  const fromOutside = await new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port: server.address().port, path: '/api/connect', headers: { Host: 'waypoint.example.com', Cookie: demoCookie } }, (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => resolve(JSON.parse(body)));
      })
      .on('error', reject);
  });
  assert.equal(fromOutside.bot_key, undefined, 'the demo is not handed a key over the internet');
  assert.equal(fromOutside.mcp_url, 'https://waypoint.example.com/mcp');

  const people = await callTool(key, 'list_people');
  assert.equal(people.value.people.length, 1);
  const person = people.value.people[0].person;

  // Days and risk come from Waypoint's code, not from the Bot.
  let brief = await callTool(key, 'get_brief', { today: '2026-11-18' });
  const card = brief.value.deadlines.find((d) => d.deadline_id === 'work_permit_expiry');
  assert.equal(card.days_left, 22);
  assert.equal(card.risk, 'watch');

  // Case Clerk reports an evidence request; Waypoint adds the deadline itself.
  const saved = await callTool(key, 'save_case_status', {
    receipt: 'ioe0912345678',
    title: 'OPT case',
    portal: 'USCIS Case Status Online',
    status: 'Request for Evidence Was Sent',
    response_due: '2027-02-10',
  });
  assert.equal(saved.isError, false);
  assert.equal((await callTool(key, 'save_case_status', { receipt: 'X', status: 'ok', response_due: 'next week' })).isError, true);
  await callTool(key, 'report_run', { bot: 'Case Clerk', summary: 'Read status: "Request for Evidence Was Sent"' });

  // Scout can say it first saw something on X. Only a real X link is kept.
  await callTool(key, 'save_policy_alert', { title: 'Fee change', why: 'The filing fee goes up in January.', source_label: 'USCIS', source_url: 'https://www.uscis.gov/', x_url: 'https://x.com/USCIS/status/1' });
  await callTool(key, 'save_policy_alert', { title: 'Rumour', why: 'Unconfirmed.', x_url: 'https://example.com/not-x' });
  const notices = (await eli.getJson('/api/store')).alerts.filter((a) => ['Fee change', 'Rumour'].includes(a.title));
  assert.equal(notices.find((a) => a.title === 'Fee change').x_url, 'https://x.com/USCIS/status/1');
  assert.equal(notices.find((a) => a.title === 'Fee change').seen_on_x, true);
  assert.equal(notices.find((a) => a.title === 'Rumour').x_url, '');
  assert.equal(notices.find((a) => a.title === 'Rumour').seen_on_x, false);
  assert.equal((await callTool(key, 'report_run', { bot: 'Mystery Bot', summary: 'x' })).isError, true);

  // Scout cannot report a finished run without saying what it searched on X. A Bot
  // still reporting under an old name is filed under the Bot that took the job over.
  const silent = await callTool(key, 'report_run', { bot: 'Scout', summary: 'No relevant changes' });
  assert.equal((await callTool(key, 'report_run', { bot: 'Policy Watcher', summary: 'No relevant changes' })).isError, true);
  assert.equal(silent.isError, true);
  assert.match(silent.value, /search X/);
  assert.ok(!(await callTool(key, 'report_run', { bot: 'Scout', status: 'failed', summary: 'X search was not available' })).isError);
  assert.ok(
    !(await callTool(key, 'report_run', {
      bot: 'Policy Watcher',
      summary: 'No relevant changes',
      x_searches: ['from:USCIS OPT', ' STEM  OPT rule ', 'from:USCIS OPT', ''],
      x_posts_read: 14.7,
    })).isError,
  );
  // The Manager can see where the run stands: who has reported, and what waits for approval.
  const standing = await callTool(key, 'workflow_status', {});
  assert.deepEqual(standing.value.bots.map((b) => b.bot), ['Manager', 'Intake Clerk', 'Case Clerk', 'Scout', 'Messenger']);
  assert.equal(standing.value.bots.find((b) => b.bot === 'Scout').status, 'ok');
  assert.equal(standing.value.bots.find((b) => b.bot === 'Messenger').status, 'no run yet');
  assert.equal(standing.value.emails_waiting_for_approval, 0);
  const watched = (await eli.getJson('/api/store')).runs.filter((r) => r.bot === 'Scout');
  assert.equal(watched.length, 2);
  assert.deepEqual(watched.find((r) => r.status === 'ok').x_searches, ['from:USCIS OPT', 'STEM OPT rule']);
  assert.equal(watched.find((r) => r.status === 'ok').x_posts_read, 14);
  assert.equal(watched.find((r) => r.status === 'failed').x_searches, undefined);

  brief = await callTool(key, 'get_brief', { today: '2026-11-18' });
  const notice = brief.value.deadlines.find((d) => d.deadline_id === 'notice-ioe0912345678');
  assert.equal(notice.days_left, 84);
  assert.equal(notice.risk, 'watch');

  // The Manager drafts. It stays a draft whatever the Bot says.
  const draft = await callTool(key, 'draft_email', {
    deadline_id: 'notice-ioe0912345678',
    recipient_label: 'your international office',
    to: 'iso@example.edu',
    subject: 'Help with an evidence request',
    body: 'Hello, ...',
    state: 'approved',
  });
  assert.equal(draft.value.state, 'drafted');
  const emailId = draft.value.email_id;
  // Messenger may not deliver it until the person approves in the browser.
  assert.equal((await callTool(key, 'mark_email_delivered', { email_id: emailId, sent: true })).isError, true);
  assert.equal((await eli.postJson(`/api/actions/${emailId}`, { state: 'approved' })).status, 200);
  const approved = await callTool(key, 'list_emails', { state: 'approved' });
  assert.equal(approved.value.emails[0].email_id, emailId);
  const delivered = await callTool(key, 'mark_email_delivered', { email_id: emailId, gmail_draft_id: 'r-123' });
  assert.equal(delivered.value.gmail_draft_id, 'r-123');
  assert.equal(delivered.value.state, 'approved');

  // What the Bot wrote is what the person sees, not marked simulated.
  const store = await eli.getJson('/api/store');
  assert.equal(store.runs.at(-1).bot, 'Scout');
  assert.ok(store.runs.some((r) => r.bot === 'Case Clerk'));
  assert.equal(store.runs.at(-1).simulated, undefined);
  assert.equal(store.case_status.at(-1).receipt, 'IOE0912345678');

  // The key speaks for Eli only: not the sample people, not through any door.
  assert.equal((await callTool(key, 'get_brief', { person: 'priya' })).isError, true);
  assert.equal((await callTool(key, 'mark_email_delivered', { email_id: 'act-priya-hr', sent: true })).isError, true);
  const sneak = await fetch(`${base}/api/rows/runs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ person: 'priya', bot: 'Case Clerk', summary: 'x' }),
  });
  assert.equal(sneak.status, 403);
  // And the sample key cannot reach Eli.
  assert.equal((await callTool(sampleKey, 'get_brief', { person })).isError, true);
  assert.equal((await callTool(sampleKey, 'list_people')).value.people.length, 2);

  // A new key replaces the old one.
  const rotated = await (await eli.postJson('/api/connect/rotate', {})).json();
  assert.notEqual(rotated.bot_key, key);
  assert.equal((await rpc(key, 'tools/list', {})).status, 401);
  assert.equal((await rpc(rotated.bot_key, 'tools/list', {})).status, 200);
});

test('Check now wakes a real Bot when a webhook is set, and the key never reaches the browser', async () => {
  const cookie = await signUp('Fay Odum', 'fay@example.com');
  const fay = as(cookie);
  await fay.postJson('/api/profile', { name: 'Fay Odum', visa_type: 'j1', program_end: '2027-05-01' });
  const person = (await fay.getJson('/api/store')).profiles[0].id;

  assert.equal((await fay.postJson('/api/connect/webhook', { url: 'http://example.com/hook', key: 'k' })).status, 400);
  assert.equal((await fay.postJson('/api/connect/webhook', { url: 'https://localhost/hook', key: 'k' })).status, 400);
  assert.equal((await fay.postJson('/api/connect/webhook', { url: 'https://10.0.0.5/hook', key: 'k' })).status, 400);
  assert.equal((await postJson('/api/connect/webhook', { url: 'https://example.com/hook' })).status, 403);
  // An address that resolves nowhere: saved, and Check now says the Bot did not answer.
  assert.equal((await fay.postJson('/api/connect/webhook', { url: 'https://waypoint-test.invalid/hook', key: 'routine-secret' })).status, 200);

  let store = await fay.getJson('/api/store');
  assert.deepEqual(store.profiles[0].bot_webhook, { url: 'https://waypoint-test.invalid/hook', has_key: true });
  assert.ok(!JSON.stringify(store).includes('routine-secret'));

  const check = await fay.postJson('/api/check', { person });
  assert.equal(check.status, 502);
  assert.equal((await fay.getJson('/api/store')).runs.length, 0, 'no simulated run is written when a real Bot is connected');

  // Editing your details keeps the connection; clearing the address removes it.
  await fay.postJson('/api/profile', { name: 'Fay Odum', visa_type: 'j1', program_end: '2027-06-01' });
  store = await fay.getJson('/api/store');
  assert.equal(store.profiles[0].bot_webhook.url, 'https://waypoint-test.invalid/hook');
  await fay.postJson('/api/connect/webhook', { url: '' });
  assert.equal((await fay.getJson('/api/store')).profiles[0].bot_webhook, undefined);
  assert.equal((await (await fay.postJson('/api/check', { person })).json()).mode, 'simulated');
});

test('texts: off until Twilio is set, then sent to your own phone, recorded, and limited', async () => {
  const cookie = await signUp('Gia Rossi', 'gia@example.com');
  const gia = as(cookie);
  await gia.postJson('/api/profile', { name: 'Gia Rossi', visa_type: 'h1b', h1b_start: '2025-10-01', phone: '(415) 555-0142' });
  const person = (await gia.getJson('/api/store')).profiles[0].id;
  const key = (await gia.getJson('/api/connect')).bot_key;

  // Nothing is set: the page is told, the button's route and the Bot's tool both say why.
  assert.equal((await gia.getJson('/api/store')).features.sms, false);
  const off = await gia.postJson(`/api/profiles/${person}/test-text`, {});
  assert.equal(off.status, 400);
  assert.match((await off.json()).error, /not switched on/);
  assert.match((await callTool(key, 'send_text', { text: 'Waypoint: hello' })).value, /not switched on/);

  // A stand-in for Twilio that keeps what it is sent.
  const got = [];
  const twilio = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      got.push({ url: req.url, auth: req.headers.authorization, form: new URLSearchParams(body) });
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ sid: `SM${got.length}`, status: 'queued' }));
    });
  });
  await new Promise((resolve) => twilio.listen(0, '127.0.0.1', resolve));
  Object.assign(process.env, {
    TWILIO_ACCOUNT_SID: 'ACtest',
    TWILIO_AUTH_TOKEN: 'test-token',
    TWILIO_FROM_NUMBER: '+15550100100',
    TWILIO_API_BASE: `http://127.0.0.1:${twilio.address().port}`,
  });
  try {
    assert.equal((await gia.getJson('/api/store')).features.sms, true);
    assert.match(await (await fetch(`${base}/healthz`)).text(), /texts on/);

    // The demo cannot send, and nobody can send for someone else's person.
    assert.equal((await postJson('/api/profiles/priya/test-text', {})).status, 403);
    assert.equal((await gia.postJson('/api/profiles/priya/test-text', {})).status, 404);

    const sent = await gia.postJson(`/api/profiles/${person}/test-text`, {});
    assert.equal(sent.status, 200);
    assert.equal((await sent.json()).to, 'the number ending 42');
    assert.equal(got.length, 1);
    assert.equal(got[0].url, '/2010-04-01/Accounts/ACtest/Messages.json');
    assert.equal(got[0].form.get('To'), '+14155550142');
    assert.equal(got[0].form.get('From'), '+15550100100');
    assert.match(got[0].form.get('Body'), /^Waypoint: this is a test/);
    // Straight after, a second press is held back.
    assert.equal((await gia.postJson(`/api/profiles/${person}/test-text`, {})).status, 429);

    // A Bot sends through the same door. The number is not echoed back to it.
    const byBot = await callTool(key, 'send_text', { text: 'Waypoint: your H-1B has 84 days left. See your brief.' });
    assert.ok(!byBot.isError);
    assert.equal(byBot.value.to, 'the number ending 42');
    assert.equal(got.length, 2);
    // Better: the Bot names the kind and the deadline, and Waypoint writes the words
    // with its own day count. The same news is not texted twice in a day.
    const brief = await callTool(key, 'get_brief', {});
    const first = brief.value.deadlines.find((d) => d.days_left != null);
    const written = await callTool(key, 'send_text', { kind: 'reminder', deadline_id: first.deadline_id });
    assert.ok(!written.isError, JSON.stringify(written));
    assert.match(written.value.text, /^Waypoint reminder\. /);
    assert.ok(written.value.text.includes(first.name));
    assert.equal(got.at(-1).form.get('Body'), written.value.text);
    assert.equal(got.length, 3);
    assert.match((await callTool(key, 'send_text', { kind: 'reminder', deadline_id: first.deadline_id })).value, /already texted/);
    assert.match((await callTool(key, 'send_text', { kind: 'act_now', deadline_id: 'no-such-deadline' })).value, /no deadline/);
    assert.match((await callTool(key, 'send_text', { kind: 'approval' })).value, /No emails are waiting/);
    assert.match((await callTool(key, 'send_text', {})).value, /Pass "kind"/);
    assert.equal(got.length, 3, 'a refused text never reaches Twilio');
    assert.match((await callTool(key, 'send_text', { text: 'Your receipt IOE0912345678 changed' })).value, /receipt numbers/);
    assert.match((await callTool(key, 'send_text', { text: 'x'.repeat(301) })).value, /300 characters/);
    assert.equal(got.length, 3, 'refused texts never reach Twilio');

    const store = await gia.getJson('/api/store');
    const texts = store.notifications.filter((n) => n.via === 'twilio');
    assert.equal(texts.length, 3);
    assert.equal(texts.at(-1).kind, 'reminder');
    assert.ok(texts.every((n) => n.channel === 'sms' && n.state === 'sent' && n.person === person));
    assert.ok(!JSON.stringify(store).includes('test-token'));

    // Texts turned off in Settings are respected.
    await gia.postJson(`/api/profiles/${person}/settings`, { channels: { sms: false, calendar: true, gmail: true } });
    assert.match((await callTool(key, 'send_text', { text: 'Waypoint: hello' })).value, /turned off/);
    await gia.postJson(`/api/profiles/${person}/settings`, { channels: { sms: true, calendar: true, gmail: true } });

    // The daily limit: six texts a person, then no more.
    for (let n = 0; n < 3; n += 1) assert.equal((await callTool(key, 'send_text', { text: `Waypoint: note ${n}` })).value.sent, true);
    assert.match((await callTool(key, 'send_text', { text: 'Waypoint: one too many' })).value, /limit/);
    assert.equal(got.length, 6);

    // The sample people have made-up numbers: nothing goes out unless the host
    // names a real phone for the demo, and then it goes there.
    assert.match((await callTool(sampleKey, 'send_text', { person: 'priya', text: 'Waypoint: hello' })).value, /made-up/);
    process.env.SMS_DEMO_TO = '+14155550199';
    assert.equal((await callTool(sampleKey, 'send_text', { person: 'priya', text: 'Waypoint: hello' })).value.sent, true);
    assert.equal(got.at(-1).form.get('To'), '+14155550199');
  } finally {
    for (const name of ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_FROM_NUMBER', 'TWILIO_API_BASE', 'SMS_DEMO_TO']) delete process.env[name];
    await new Promise((resolve) => twilio.close(resolve));
  }
});

test('the mock portal works without scripts: the sign-in is printed, and a plain form post shows the case', async () => {
  const { users } = JSON.parse(await readFile(new URL('../data/portal-users.json', import.meta.url), 'utf8'));
  const page = await (await fetch(`${base}/portal/`)).text();
  assert.ok(page.includes(users[0].username) && !page.includes('%DEMO_'));

  const form = (fields) => fetch(`${base}/portal/`, { method: 'POST', body: new URLSearchParams(fields) });
  assert.equal((await form({ username: users[0].username, password: 'nope' })).status, 401);
  const ok = await form({ username: users[0].username, password: users[0].password });
  assert.equal(ok.status, 200);
  const html = await ok.text();
  assert.match(html, /id="case-receipt">IOE0912345678</);
  assert.match(html, /id="case-status">Case Was Received</);
});
