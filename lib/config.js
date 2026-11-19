// Fixed names and the settings read from the environment when the server starts.
// Read at start, not at import, so a test can boot several servers in one process.

import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const COOKIE = 'wp_session';
export const SESSION_DAYS = 30;
// Pages that need someone signed in (or in the demo). Everything else is open.
export const SIGNED_IN_PAGES = ['/', '/activity/', '/settings/', '/setup/', '/connect/'];

// Tables a Bot may append to. Profiles and the portal are not on this list.
export const APPEND_TABLES = ['runs', 'case_status', 'alerts', 'inbox_facts', 'notifications', 'actions', 'clock_notes'];
export const BOTS = ['Intake Clerk', 'Case Clerk', 'Policy Watcher', 'Inbox Scout', 'Deadline Keeper', 'Messenger'];
// Logs grow for ever; keep the newest so one save stays small.
export const KEEP = { runs: 400, notifications: 400, case_status: 200, alerts: 200, inbox_facts: 200, clock_notes: 200, actions: 300 };

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

export function loadConfig(env = process.env) {
  const PUBLIC = path.join(ROOT, 'public');
  const DATA = env.WAYPOINT_DATA_DIR || path.join(ROOT, 'data');
  // On a host that assigns the port (Render, Railway, Fly), listen on every interface.
  const HOSTED = Boolean(env.RENDER || env.RAILWAY_ENVIRONMENT || env.FLY_APP_NAME);
  return {
    PUBLIC,
    SEED: path.join(PUBLIC, 'data', 'seed.json'),
    DATA,
    STORE: path.join(DATA, 'store.json'),
    USERS: path.join(ROOT, 'data', 'portal-users.json'),
    CONFIG: path.join(DATA, 'config.json'),
    ACCOUNTS: path.join(DATA, 'accounts.json'),
    BOT_KEY_FILE: path.join(DATA, 'bot-key.txt'),
    PORT: Number(env.PORT) || 4173,
    HOSTED,
    HOST: env.HOST || (HOSTED ? '0.0.0.0' : '127.0.0.1'),
    // WAYPOINT_DEMO_ONLY=1 opens the sample people to anyone, with no sign-in:
    // for a public demo link, or for tools that scan the pages.
    DEMO_ONLY: env.WAYPOINT_DEMO_ONLY === '1',
  };
}
