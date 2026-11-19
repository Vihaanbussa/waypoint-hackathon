// Waypoint demo server. No dependencies: static files plus a small JSON store.
//
//   node server.js            http://127.0.0.1:4173
//   HOST=0.0.0.0 PORT=8080    to reach it from another machine (a Bot's computer)
//
// The store is data/store.json, created from public/data/seed.json on first run.
// Accounts (email, password hash) live apart from it in data/accounts.json and
// are never sent to a browser.

import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOST, PORT, PUBLIC, SIGNED_IN_PAGES, TYPES, USERS } from './lib/config.js';
import { loadStore, persist, persistError, sms, store } from './lib/store.js';
import { loadAccounts, readSession } from './lib/accounts.js';
import { escapeHtml, httpError, readBody, redirect, send, sendJson } from './lib/http.js';
import { api } from './lib/api.js';
import { logBot, serveMcp } from './lib/bot.js';

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
      '<!doctype html><html lang="en"><meta charset="utf-8"><title>Not found</title><link rel="stylesheet" href="/css/app/base.css"><main><h1>Page not found</h1><p>That address does not exist. <a href="/">Go to your brief</a>.</p></main></html>',
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
