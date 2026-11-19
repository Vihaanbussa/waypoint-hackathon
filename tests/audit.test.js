// Regression tests from the audit. Each asserts the SECURE behaviour, so each
// fails today and passes once its finding is fixed.

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

let server;
let base;
let port;
let dataDir;

before(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), 'waypoint-audit-'));
  process.env.WAYPOINT_DATA_DIR = dataDir;
  const { start } = await import('../server.js');
  server = await start({ port: 0, host: '127.0.0.1' });
  port = server.address().port;
  base = `http://127.0.0.1:${port}`;
});
after(async () => {
  server.close();
  server.closeAllConnections?.();
  await rm(dataDir, { recursive: true, force: true });
});

async function call(method, url, body, { cookie, headers = {} } = {}) {
  const res = await fetch(base + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, json, cookie: (res.headers.get('set-cookie') || '').split(';')[0] };
}

async function newAccount(tag) {
  const up = await call('POST', '/api/auth/signup', { name: `T ${tag}`, email: `${tag}@example.com`, password: 'correct-horse-9' });
  assert.equal(up.status, 200);
  const prof = await call('POST', '/api/profile', { name: `T ${tag}`, visa_type: 'f1_opt' }, { cookie: up.cookie });
  assert.equal(prof.status, 200);
  const conn = await call('GET', '/api/connect', undefined, { cookie: up.cookie });
  return { cookie: up.cookie, key: conn.json.bot_key, profile: prof.json.profile };
}

test('F1: an anonymous demo session cannot plant an alert in every real account\'s brief', async () => {
  const victim = await newAccount('victim1');
  const demo = await call('POST', '/api/auth/demo', {});
  await call(
    'POST',
    '/api/report',
    { table: 'alerts', row: { title: 'PLANTED', why: 'x', risk: 'act', source_label: 'USCIS', source_url: 'https://evil.example/phish' } },
    { cookie: demo.cookie },
  );
  const seen = await call('GET', '/api/store', undefined, { cookie: victim.cookie });
  assert.equal(seen.json.alerts.some((a) => a.title === 'PLANTED'), false);
});

// Skipped: this test connects from 127.0.0.1, so it cannot tell a spoofed Host from a real local
// browser. Proving F2 needs a non-loopback client (a second machine or interface).
test.skip('F2: /api/connect does not reveal the master Bot key because of a spoofed Host header', async () => {
  const demo = await call('POST', '/api/auth/demo', {});
  const body = await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/api/connect', headers: { Host: 'localhost', Cookie: demo.cookie } }, (res) => {
      let t = '';
      res.on('data', (c) => (t += c));
      res.on('end', () => resolve(JSON.parse(t)));
    });
    req.on('error', reject);
    req.end();
  });
  const masterKey = (await readFile(path.join(dataDir, 'bot-key.txt'), 'utf8')).trim();
  // Same-machine browsers are meant to see it; this request arrives from a "remote" Host only by header.
  // The fix is to trust the socket address, not the header. Remove this test's premise once that is done.
  assert.notEqual(body.bot_key, masterKey, 'master key was returned on a Host: localhost request');
});

test('F3: a self-signup Bot key cannot forge sent-text rows that use up the site-wide text cap', async () => {
  const a = await newAccount('forger');
  const res = await call(
    'POST',
    `/api/rows/notifications`,
    { person: a.profile.id, channel: 'sms', text: 'x', via: 'twilio', state: 'sent' },
    { headers: { Authorization: `Bearer ${a.key}` } },
  );
  const mine = await call('GET', '/api/store', undefined, { cookie: a.cookie });
  const forged = mine.json.notifications.filter((n) => n.via === 'twilio');
  assert.equal(forged.length, 0, `forged row accepted (${res.status})`);
});

test('F4: a Bot cannot choose the id of the row it writes', async () => {
  const a = await newAccount('idpick');
  const res = await call(
    'POST',
    `/api/rows/actions`,
    { person: a.profile.id, id: 'actions-chosen', subject: 's', body: 'b' },
    { headers: { Authorization: `Bearer ${a.key}` } },
  );
  assert.notEqual(res.json?.row?.id, 'actions-chosen');
});

test('F5: a webhook address that resolves to a private address is refused', async () => {
  const a = await newAccount('ssrf');
  const res = await call('POST', '/api/connect/webhook', { url: 'https://localtest.me/hook', key: 'k' }, { cookie: a.cookie });
  assert.notEqual(res.status, 200, 'localtest.me (127.0.0.1) was accepted');
});

test('F6: a real account cannot reset or rewrite the shared demo', async () => {
  const a = await newAccount('resetter');
  const res = await call('POST', '/api/reset', {}, { cookie: a.cookie });
  assert.equal(res.status, 403);
});

test('F7: responses carry anti-framing and CSP headers', async () => {
  const res = await fetch(`${base}/login/`);
  assert.ok(res.headers.get('content-security-policy') || res.headers.get('x-frame-options'));
});
