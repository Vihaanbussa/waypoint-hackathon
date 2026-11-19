// Reads and writes the shared store. With the server running, everything goes
// through /api. On a plain static host the pages still render from the sample
// data, and changes stay in this browser (fail soft: the brief always renders).

const OVERLAY_KEY = 'waypoint.overlay';
let everLive = false;

function readOverlay() {
  try {
    return JSON.parse(localStorage.getItem(OVERLAY_KEY)) || { actions: {}, profiles: {} };
  } catch {
    return { actions: {}, profiles: {} };
  }
}

function writeOverlay(overlay) {
  try {
    localStorage.setItem(OVERLAY_KEY, JSON.stringify(overlay));
  } catch {
    // Storage is unavailable; the change lasts until the page reloads.
  }
}

function applyOverlay(store) {
  const overlay = readOverlay();
  for (const action of store.actions ?? []) Object.assign(action, overlay.actions?.[action.id]);
  for (const profile of store.profiles ?? []) Object.assign(profile, overlay.profiles?.[profile.id]);
  // No server: this is the sample data, shown as the demo.
  store.me = { id: 'demo', name: 'Demo', email: null, demo: true };
  return store;
}

export async function loadStore() {
  try {
    const res = await fetch('/api/store', { cache: 'no-store' });
    if (res.status === 401) {
      everLive = true;
      throw Object.assign(new Error('Sign in first.'), { signedOut: true });
    }
    if (!res.ok) throw new Error(`The store answered ${res.status}`);
    const store = await res.json();
    everLive = true;
    return { store, live: true };
  } catch (err) {
    // If the server was there a moment ago, keep the last good data on screen.
    if (everLive) throw err;
    const res = await fetch('/data/seed.json', { cache: 'no-store' });
    if (!res.ok) throw new Error('Could not load the sample data.');
    return { store: applyOverlay(await res.json()), live: false };
  }
}

export async function post(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `The server answered ${res.status}.`);
  return data;
}

export async function get(path) {
  const res = await fetch(path, { cache: 'no-store' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `The server answered ${res.status}.`);
  return data;
}

// patch: { state: 'approved' | 'rejected' } or { body: 'new text' }
export async function updateAction(id, patch) {
  if (everLive) return post(`/api/actions/${encodeURIComponent(id)}`, patch);
  const overlay = readOverlay();
  const change = { ...overlay.actions[id], ...patch };
  if (patch.state) change.decided_at = new Date().toISOString();
  overlay.actions[id] = change;
  writeOverlay(overlay);
  return { ok: true };
}

export async function saveSettings(profileId, settings) {
  if (everLive) return post(`/api/profiles/${encodeURIComponent(profileId)}/settings`, settings);
  const overlay = readOverlay();
  overlay.profiles[profileId] = { ...overlay.profiles[profileId], ...settings };
  writeOverlay(overlay);
  return { ok: true };
}
