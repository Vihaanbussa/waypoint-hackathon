// The database path: with a database configured, accounts and data survive a
// restart that wipes the disk. A tiny stand-in speaks the same REST shape.

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createPersist, cleanSetting, describeSecret } from '../lib/persist.js';

let db;
let dbUrl;
const kept = new Map();
const TOKEN = 'test-database-token';

before(async () => {
  db = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      if (req.headers.authorization !== `Bearer ${TOKEN}`) {
        res.statusCode = 401;
        return res.end(JSON.stringify({ error: 'WRONGPASS invalid token' }));
      }
      const [command, key, value] = JSON.parse(body);
      if (command === 'SET') {
        kept.set(key, value);
        return res.end(JSON.stringify({ result: 'OK' }));
      }
      if (command === 'GET') return res.end(JSON.stringify({ result: kept.has(key) ? kept.get(key) : null }));
      res.statusCode = 400;
      res.end(JSON.stringify({ error: 'ERR unknown command' }));
    });
  });
  await new Promise((resolve) => db.listen(0, '127.0.0.1', resolve));
  dbUrl = `http://127.0.0.1:${db.address().port}`;
});

after(() => new Promise((resolve) => db.close(resolve)));

test('persist: nothing saved reads as null, then a value round-trips', async () => {
  const persist = createPersist({ url: dbUrl, token: TOKEN, prefix: 'unit' });
  assert.equal(persist.remote, true);
  assert.equal(await persist.get('store'), null);
  await persist.set('store', { runs: [{ id: 1 }], note: 'héllo "quoted"' });
  assert.deepEqual(await persist.get('store'), { runs: [{ id: 1 }], note: 'héllo "quoted"' });
  await assert.rejects(createPersist({ url: dbUrl, token: 'wrong' }).get('store'), /WRONGPASS/);
  assert.equal(createPersist({}).remote, false);
  assert.equal(await createPersist({}).get('store'), null);
});

test('with a database, an account and what a Bot wrote survive a restart on an empty disk', async () => {
  process.env.UPSTASH_REDIS_REST_URL = dbUrl;
  process.env.UPSTASH_REDIS_REST_TOKEN = TOKEN;
  const boot = async (tag) => {
    const dir = await mkdtemp(path.join(tmpdir(), 'waypoint-persist-'));
    process.env.WAYPOINT_DATA_DIR = dir;
    const { start } = await import(`../server.js?${tag}`);
    const server = await start({ port: 0, host: '127.0.0.1' });
    return { dir, server, base: `http://127.0.0.1:${server.address().port}` };
  };
  const stop = async ({ server, dir }) => {
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  };
  const json = (base, p, body, cookie = '') =>
    fetch(base + p, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: body && JSON.stringify(body) });
  const cookieFrom = (res) => (res.headers.get('set-cookie') || '').split(';')[0];

  // First life: sign up, add details, and a Bot reports a run with the account's key.
  const first = await boot('first');
  assert.match(await (await fetch(`${first.base}/healthz`)).text(), /database on/);
  const signup = await json(first.base, '/api/auth/signup', { name: 'Gia Reyes', email: 'gia@example.com', password: 'a-long-enough-password' });
  const cookie = cookieFrom(signup);
  await json(first.base, '/api/profile', { name: 'Gia Reyes', visa_type: 'j1', program_end: '2027-05-01' }, cookie);
  const { bot_key: key } = await (await json(first.base, '/api/connect', null, cookie)).json();
  const person = (await (await json(first.base, '/api/store', null, cookie)).json()).profiles[0].id;
  const wrote = await fetch(`${first.base}/api/rows/runs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ person, bot: 'Policy Watcher', status: 'ok', summary: 'No relevant changes', x_searches: ['from:USCIS'], x_posts_read: 1 }),
  });
  assert.equal(wrote.status, 200);
  await stop(first);

  // Second life: a brand-new empty disk, as after a free host sleeps.
  const second = await boot('second');
  const login = await json(second.base, '/api/auth/login', { email: 'gia@example.com', password: 'a-long-enough-password' });
  assert.equal(login.status, 200, 'the account is still there');
  const store = await (await json(second.base, '/api/store', null, cookieFrom(login))).json();
  assert.equal(store.profiles[0].program_end, '2027-05-01');
  assert.equal(store.runs.at(-1).summary, 'No relevant changes');
  assert.equal(store.meta.database, 'on');
  // The old sign-in cookie and the Bot's key still work, because both were kept.
  assert.equal((await json(second.base, '/api/store', null, cookie)).status, 200);
  const again = await fetch(`${second.base}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
  });
  assert.equal(again.status, 200);
  await stop(second);
});

test('settings pasted with quotes, a NAME= prefix or as a whole .env block still work', async () => {
  const block = `UPSTASH_REDIS_REST_URL="${dbUrl}"\nUPSTASH_REDIS_REST_TOKEN="${TOKEN}"`;
  assert.equal(cleanSetting(`"${TOKEN}"`, 'UPSTASH_REDIS_REST_TOKEN'), TOKEN);
  assert.equal(cleanSetting(`  UPSTASH_REDIS_REST_TOKEN="${TOKEN}" `, 'UPSTASH_REDIS_REST_TOKEN'), TOKEN);
  assert.equal(cleanSetting(block, 'UPSTASH_REDIS_REST_TOKEN'), TOKEN);
  assert.equal(cleanSetting(block, 'UPSTASH_REDIS_REST_URL'), dbUrl);
  const persist = createPersist({ url: `"${dbUrl}/"`, token: block, prefix: 'messy' });
  await persist.set('store', { ok: true });
  assert.deepEqual(await persist.get('store'), { ok: true });
});

test('a refused token can be described without giving it away', () => {
  const real = 'AZ0BAAIncDE5ZmQ4YjYxNzk0YzQ0ZjE5YjYxNzk0YzQ0ZjE5cDEzOTkzNw';
  assert.match(describeSecret(real), /^58 characters, the right shape/);
  assert.ok(!describeSecret(real).includes(real.slice(0, 6)));
  assert.match(describeSecret('********'), /dots or stars/);
  assert.match(describeSecret('https://expert-wren-1.upstash.io'), /web address/);
  assert.match(describeSecret('redis://default:abc@expert-wren-1.upstash.io:6379'), /redis:\/\//);
  assert.match(describeSecret('32e8b205-5229-4e3b-b754-04a60e40d49a'), /UUID/);
  assert.match(describeSecret('abc123'), /shorter than/);
  assert.equal(describeSecret(''), 'empty');
});
