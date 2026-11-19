// Shared by the three places: the top bar, the profile switcher, loading and
// polling the store, and small DOM and formatting helpers.

import { loadStore, post } from './store.js';
import { localToday, parseDay, formatDate } from './clocks.js';
import { VISA_TYPES } from './rules.js';

const PROFILE_KEY = 'waypoint.profile';

// Small remembered choices. Storage can be blocked; the page works without it.
export function recall(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function remember(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Not remembered: the choice still holds until the page closes.
  }
}

// Build an element. Text always goes in as text, never as HTML.
// What Policy Watcher searched on X in a run, as one line under its summary.
// Empty when the run did not say.
export function xChecked(run) {
  const searches = Array.isArray(run?.x_searches) ? run.x_searches.filter(Boolean) : [];
  if (!searches.length) return '';
  const shown = searches.slice(0, 3).map((s) => `"${s}"`).join(', ');
  const more = searches.length > 3 ? ` and ${searches.length - 3} more` : '';
  const read = Number(run.x_posts_read);
  return `Searched X for ${shown}${more}.${read > 0 ? ` Read ${read} post${read === 1 ? '' : 's'}.` : ''}`;
}

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    node.append(child);
  }
  return node;
}

// Only http(s) links from the store are ever turned into links.
export function safeUrl(url) {
  try {
    const parsed = new URL(String(url));
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.href : null;
  } catch {
    return null;
  }
}

// "2:03 AM" today, "Nov 17, 2:03 AM" on another day.
export function formatTime(stamp, todayIso) {
  const d = new Date(stamp);
  if (Number.isNaN(d.getTime())) return '';
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  const day = localToday(d);
  return day === todayIso ? time : `${formatDate(day, todayIso)}, ${time}`;
}

export const visaLabel = (profile) => profile.visa_label || VISA_TYPES[profile.visa_type]?.label || 'Visa type not set';
export const rowsOf = (table) => (Array.isArray(table) ? table.filter((r) => r && typeof r === 'object') : []);

// Small solid shape for a risk level: square, triangle, circle.
export function riskMark(risk, size = 16) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('mark', `mark--${risk}`);
  const shape =
    risk === 'act'
      ? ['rect', { x: 1.5, y: 1.5, width: 13, height: 13 }]
      : risk === 'watch'
        ? ['polygon', { points: '8,1 15.5,14.5 0.5,14.5' }]
        : ['circle', { cx: 8, cy: 8, r: risk === 'today' ? 5.5 : 7 }];
  const node = document.createElementNS(ns, shape[0]);
  for (const [k, v] of Object.entries(shape[1])) node.setAttribute(k, v);
  svg.append(node);
  return svg;
}

function pickProfile(store) {
  const profiles = rowsOf(store.profiles);
  const fromUrl = new URLSearchParams(location.search).get('p');
  let saved = null;
  try {
    saved = localStorage.getItem(PROFILE_KEY);
  } catch {
    // No storage: the address still carries the choice.
  }
  return profiles.find((p) => p.id === fromUrl) || profiles.find((p) => p.id === saved) || profiles[0] || null;
}

function rememberProfile(id) {
  try {
    localStorage.setItem(PROFILE_KEY, id);
  } catch {
    // Ignore: the address carries the choice.
  }
  const url = new URL(location.href);
  url.searchParams.set('p', id);
  history.replaceState(null, '', url);
}

function syncTopbar(store, profile, onSwitch) {
  const page = document.body.dataset.page;
  for (const link of document.querySelectorAll('.places a, .wordmark, .help-link, .site-foot a[data-keep]')) {
    if (link.dataset.place && link.dataset.place === page) link.setAttribute('aria-current', 'page');
    const url = new URL(link.getAttribute('href'), location.origin);
    if (profile) url.searchParams.set('p', profile.id);
    link.setAttribute('href', url.pathname + url.search);
  }
  syncAccount(store.me);
  syncPicker(rowsOf(store.profiles), profile, onSwitch);
}

function lineIcon(d, cls) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  for (const [k, v] of Object.entries({ viewBox: '0 0 16 16', width: 16, height: 16, 'aria-hidden': 'true', class: cls })) svg.setAttribute(k, v);
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', d);
  svg.append(path);
  return svg;
}

// The demo's "Viewing" picker: a button that opens a short list of people.
// Drawn here rather than as a native select so the open list matches the page.
// Keys: Enter, Space or the arrows open it; arrows, Home and End move; Enter or
// Space choose; Escape closes.
function syncPicker(profiles, profile, onSwitch) {
  const root = document.getElementById('profile-picker');
  if (!root || !profile) return;
  const wanted = `${profiles.map((p) => `${p.id}|${p.name}|${visaLabel(p)}`).join('\n')}\n@${profile.id}`;
  if (root.dataset.options === wanted) return;
  root.dataset.options = wanted;

  const [first, ...rest] = profile.name.split(' ');
  const button = el(
    'button',
    { class: 'picker-button', type: 'button', id: 'profile-select', 'aria-haspopup': 'listbox', 'aria-expanded': 'false', 'aria-labelledby': 'profile-label profile-select' },
    el('span', { class: 'picker-name', text: first }),
    el('span', { class: 'picker-rest', text: `${rest.length ? ` ${rest.join(' ')}` : ''}, ${visaLabel(profile)}` }),
    lineIcon('M4 6l4 4 4-4', 'picker-chevron'),
  );
  const options = profiles.map((p) =>
    el(
      'li',
      { class: 'picker-option', role: 'option', id: `person-${p.id}`, 'data-id': p.id, 'aria-selected': String(p.id === profile.id) },
      el('span', { class: 'picker-option-name', text: p.name }),
      el('span', { class: 'picker-option-note', text: visaLabel(p) }),
      p.id === profile.id ? lineIcon('M3.500 8.500l3 3 6-7', 'picker-tick') : null,
    ),
  );
  const list = el('ul', { class: 'picker-list', role: 'listbox', tabindex: '-1', 'aria-labelledby': 'profile-label', hidden: true }, ...options);
  // Choosing someone redraws the picker; keep the keyboard where it was.
  const hadFocus = root.contains(document.activeElement);
  root.replaceChildren(button, list);
  if (hadFocus) button.focus();

  let active = Math.max(0, profiles.findIndex((p) => p.id === profile.id));
  const mark = (index) => {
    active = (index + options.length) % options.length;
    options.forEach((option, n) => option.classList.toggle('is-active', n === active));
    list.setAttribute('aria-activedescendant', options[active].id);
  };
  const open = () => {
    list.hidden = false;
    root.classList.add('is-open');
    button.setAttribute('aria-expanded', 'true');
    mark(profiles.findIndex((p) => p.id === profile.id));
    list.focus();
  };
  const close = (refocus) => {
    list.hidden = true;
    root.classList.remove('is-open');
    button.setAttribute('aria-expanded', 'false');
    if (refocus) button.focus();
  };
  const choose = (id) => {
    close(true);
    if (id !== profile.id) onSwitch(id);
  };

  button.addEventListener('click', () => (list.hidden ? open() : close(true)));
  button.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      open();
    }
  });
  list.addEventListener('keydown', (event) => {
    const moves = { ArrowDown: active + 1, ArrowUp: active - 1, Home: 0, End: options.length - 1 };
    if (event.key in moves) mark(moves[event.key]);
    else if (event.key === 'Enter' || event.key === ' ') choose(options[active].dataset.id);
    else if (event.key === 'Escape') close(true);
    else if (event.key === 'Tab') return close(false);
    else return;
    event.preventDefault();
  });
  options.forEach((option, n) => {
    option.addEventListener('pointermove', () => mark(n));
    option.addEventListener('click', () => choose(option.dataset.id));
  });
  // Clicking or tabbing anywhere else puts it away.
  root.addEventListener('focusout', (event) => {
    if (!root.contains(event.relatedTarget)) close(false);
  });
}

// The right end of the top bar. The demo can switch between the sample people;
// an account sees its own name. Either way there is one way out.
function syncAccount(me) {
  const demo = !me || me.demo;
  const switcher = document.getElementById('profile-switch');
  if (switcher) switcher.hidden = !demo;
  const name = document.getElementById('account-name');
  if (name) {
    name.textContent = demo ? '' : me.name;
    name.hidden = demo;
  }
  const out = document.getElementById('sign-out');
  if (out && !out.dataset.ready) {
    out.dataset.ready = 'yes';
    out.addEventListener('click', signOut);
  }
  if (out) out.textContent = demo ? 'Exit demo' : 'Sign out';
}

export async function signOut() {
  await post('/api/auth/logout', {}).catch(() => {});
  location.assign('/login/');
}

// Load the store, draw the page, and keep it fresh. `render` gets
// { store, profile, today, live, refresh, setBusy }.
export async function initPage(render) {
  const params = new URLSearchParams(location.search);
  const today = parseDay(params.get('today')) != null ? params.get('today') : localToday();
  const state = { store: null, live: false, json: '', busy: false };
  const main = document.getElementById('main');

  function draw() {
    const profile = pickProfile(state.store);
    syncTopbar(state.store, profile, (id) => {
      rememberProfile(id);
      draw();
    });
    if (!profile && state.store.me && !state.store.me.demo) {
      // An account with no details yet: go and add them.
      location.replace('/setup/');
      return;
    }
    if (!profile) {
      main.replaceChildren(el('h1', { text: 'No profile yet' }), el('p', { text: 'Add a profile to the store to see a brief.' }));
      return;
    }
    const focusedId = document.activeElement?.id;
    render({
      store: state.store,
      me: state.store.me ?? { id: 'demo', name: 'Demo', email: null, demo: true },
      profile,
      today,
      live: state.live,
      refresh: () => refresh(true),
      setBusy: (busy) => {
        state.busy = busy;
      },
    });
    if (focusedId && document.activeElement === document.body) document.getElementById(focusedId)?.focus();
  }

  async function refresh(force) {
    const { store, live } = await loadStore();
    const json = JSON.stringify(store);
    if (!force && (json === state.json || state.busy)) return;
    Object.assign(state, { store, live, json });
    draw();
  }

  try {
    await refresh(true);
  } catch (err) {
    if (err.signedOut) {
      location.replace('/login/');
      return;
    }
    main.replaceChildren(
      el('h1', { text: 'Waypoint could not load' }),
      el('p', { text: 'The store did not answer and the sample data is missing. Start the server with "node server.js" and reload.' }),
    );
    return;
  }
  setInterval(() => {
    if (!document.hidden) {
      refresh(false).catch((err) => {
        if (err.signedOut) location.replace('/login/');
      });
    }
  }, 5000);
}
