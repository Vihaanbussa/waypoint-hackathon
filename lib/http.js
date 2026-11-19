// Small response and request helpers used by every route.

import { TYPES } from './config.js';

// ---- http helpers ----

export function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

export function redirect(res, location) {
  res.writeHead(302, { Location: location, 'Cache-Control': 'no-store' });
  res.end();
}

export function send(res, status, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

export const sendJson = (res, status, value) => send(res, status, JSON.stringify(value), TYPES['.json']);
export const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 100_000) throw httpError(413, 'That is too much data for one request.');
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  const type = String(req.headers['content-type'] || '');
  if (type.includes('application/x-www-form-urlencoded')) {
    return { form: true, data: Object.fromEntries(new URLSearchParams(text)) };
  }
  if (!text.trim()) return { form: false, data: {} };
  try {
    return { form: false, data: JSON.parse(text) };
  } catch {
    throw httpError(400, 'The request body is not valid JSON.');
  }
}

export function resultPage(title, message, ok) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title><link rel="stylesheet" href="/css/portal.css"></head><body><header class="portal-bar"><p class="portal-name">Waypoint Bot report</p></header><main><h1 id="report-result">${escapeHtml(title)}</h1><p id="report-message" data-ok="${ok ? 'yes' : 'no'}">${escapeHtml(message)}</p><p><a href="/report/">Report another row</a></p></main></body></html>`;
}
