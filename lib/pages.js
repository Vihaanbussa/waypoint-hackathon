// The pages: static files, and the mock portal's plain-form sign-in.

import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { TYPES } from './config.js';
import { httpError, send, readBody, escapeHtml } from './http.js';

export function createPages({ cfg, store }) {
  // The mock portal also works as a plain form post, for a reader that runs no
  // scripts: sign in, and the answer is the case-status page itself.
  async function servePortalSignIn(req, res) {
    const { data } = await readBody(req);
    const { users } = JSON.parse(await readFile(cfg.USERS, 'utf8'));
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

  async function serveStatic(req, res, url) {
    if (req.method !== 'GET' && req.method !== 'HEAD') throw httpError(405, 'Use GET.');
    let rel;
    try {
      rel = decodeURIComponent(url.pathname);
    } catch {
      throw httpError(400, 'Bad address.');
    }
    let file = path.join(cfg.PUBLIC, path.normalize(rel));
    if (file !== cfg.PUBLIC && !file.startsWith(cfg.PUBLIC + path.sep)) throw httpError(403, 'Not allowed.');
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
      if (file === path.join(cfg.PUBLIC, 'portal', 'index.html')) {
        // The mock portal prints its own demo sign-in, so a Bot or a judge can get in
        // without anyone passing a password around. A fake account on a fake portal.
        const { users } = JSON.parse(await readFile(cfg.USERS, 'utf8'));
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

  return { servePortalSignIn, serveStatic };
}
