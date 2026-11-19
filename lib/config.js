// Paths, names and limits shared by the whole server. Nothing here changes while it runs.

import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The project folder (this file lives in lib/).
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PUBLIC = path.join(ROOT, 'public');
export const SEED = path.join(PUBLIC, 'data', 'seed.json');
export const DATA = process.env.WAYPOINT_DATA_DIR || path.join(ROOT, 'data');
export const STORE = path.join(DATA, 'store.json');
export const USERS = path.join(ROOT, 'data', 'portal-users.json');
export const CONFIG = path.join(DATA, 'config.json');
export const ACCOUNTS = path.join(DATA, 'accounts.json');
export const BOT_KEY_FILE = path.join(DATA, 'bot-key.txt');
export const COOKIE = 'wp_session';
export const SESSION_DAYS = 30;
// Pages that need someone signed in (or in the demo). Everything else is open.
export const SIGNED_IN_PAGES = ['/', '/activity/', '/settings/', '/setup/', '/connect/'];
export const PORT = Number(process.env.PORT) || 4173;
// On a host that assigns the port (Render, Railway, Fly), listen on every interface.
export const HOSTED = Boolean(process.env.RENDER || process.env.RAILWAY_ENVIRONMENT || process.env.FLY_APP_NAME);
export const HOST = process.env.HOST || (HOSTED ? '0.0.0.0' : '127.0.0.1');

// Tables a Bot may append to. Profiles and the portal are not on this list.
export const APPEND_TABLES = ['runs', 'case_status', 'alerts', 'inbox_facts', 'notifications', 'actions', 'clock_notes'];
// One Manager and four workers. The team used to be six, so a row or a report
// under an old name is filed under the Bot that took the job over.
export const BOTS = ['Manager', 'Intake Clerk', 'Case Clerk', 'Scout', 'Messenger'];
const OLD_BOT_NAMES = { 'Deadline Keeper': 'Manager', 'Policy Watcher': 'Scout', 'Inbox Scout': 'Scout' };
export const botName = (name) => OLD_BOT_NAMES[String(name)] ?? String(name);
export const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};
