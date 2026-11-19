// Waypoint demo server. No dependencies: static files plus a small JSON store.
//
//   node server.js            http://127.0.0.1:4173
//   HOST=0.0.0.0 PORT=8080    to reach it from another machine (a Bot's computer)
//
// The store is data/store.json, created from public/data/seed.json on first run.
// Accounts (email, password hash) live apart from it in data/accounts.json and
// are never sent to a browser. The pieces live in lib/:
//
//   config.js     fixed names and the settings read at start
//   state.js      the store and accounts, and saving them
//   auth.js       sessions, Bot keys, who may see and write what
//   validate.js   checks on what people and Bots send
//   api.js        the JSON api          bot-tools.js  the Bot connector (MCP)
//   texts.js      sending a text        pages.js      static files and the mock portal

import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, SIGNED_IN_PAGES } from './lib/config.js';
import { createState } from './lib/state.js';
import { createAuth } from './lib/auth.js';
import { createTexts } from './lib/texts.js';
import { createBotTools } from './lib/bot-tools.js';
import { createApi } from './lib/api.js';
import { createPages } from './lib/pages.js';
import { redirect, send, sendJson } from './lib/http.js';

export async function start({ port, host } = {}) {
  // One of everything per server, so two servers in one process share nothing.
  const cfg = loadConfig();
  const state = createState({ cfg });
  await state.loadStore();
  await state.loadAccounts();
  const auth = createAuth({ cfg, store: state.store, accounts: state.accounts });
  const texts = createTexts(state);
  const ctx = { cfg, ...state, ...texts, auth };
  const bot = createBotTools({ ...state, ...texts, botScope: auth.botScope });
  const { api } = createApi(ctx);
  const { servePortalSignIn, serveStatic } = createPages({ cfg, store: state.store });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (url.pathname === '/healthz') {
        const kept = state.persist.remote
          ? state.persistError() ? 'database error, data may not be kept' : 'database on, data is kept'
          : 'no database, data lasts until the next restart';
        return send(res, 200, `ok (${kept}${state.sms.ready ? ', texts on' : ''})`);
      }
      if (/^\/(\.well-known|register|authorize|token|sse)\b/.test(url.pathname)) bot.logBot(req, 'probe');
      if (url.pathname === '/mcp' || url.pathname === '/mcp/') await bot.serveMcp(req, res);
      else if (req.method === 'POST' && url.pathname === '/portal/') await servePortalSignIn(req, res);
      else if (url.pathname.startsWith('/api/')) await api(req, res, url);
      else if (req.method === 'GET' && SIGNED_IN_PAGES.includes(url.pathname) && !auth.readSession(req)) redirect(res, '/login/');
      else if (req.method === 'GET' && url.pathname === '/login/' && auth.readSession(req)) redirect(res, '/');
      else await serveStatic(req, res, url);
    } catch (err) {
      const status = err.status || 500;
      if (status === 500) console.error(err);
      sendJson(res, status, { ok: false, error: status === 500 ? 'Something went wrong on the server.' : err.message });
    }
  });
  await new Promise((resolve) => server.listen(port ?? cfg.PORT, host ?? cfg.HOST, resolve));
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = await start();
  const { port } = server.address();
  const { HOST } = loadConfig();
  console.log(`Waypoint is running at http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${port}`);
  console.log(`  Sign in        /login/`);
  console.log(`  Brief          /`);
  console.log(`  Mock portal    /portal/        (change its status at /portal/admin/)`);
  console.log(`  Bot report     /report/`);
  console.log(`  Bot connector  /mcp            (key for the sample people: data/bot-key.txt)`);
}
