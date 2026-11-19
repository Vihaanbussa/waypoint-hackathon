// The five Bots as characters, and the relay that shows work passing between
// them: one Manager and four workers. Each is a solid shape in its own pastel (see "the Bots' own colours"
// in css/app/demo.css), with dark eyes.

const NS = 'http://www.w3.org/2000/svg';

// In the order the work passes along: three workers gather, the Manager counts,
// drafts and holds the approval, and Messenger delivers.
export const BOTS = [
  { id: 'intake', name: 'Intake Clerk', role: 'Worker', does: 'reads your documents' },
  { id: 'case', name: 'Case Clerk', role: 'Worker', does: 'checks the government portal' },
  { id: 'scout', name: 'Scout', role: 'Worker', does: 'watches X and reads your inbox' },
  { id: 'manager', name: 'Manager', role: 'Manager', does: 'runs the night, counts the days and holds your approval' },
  { id: 'messenger', name: 'Messenger', role: 'Worker', does: 'tells you' },
];

// The team used to be six. Rows written under the old names still belong to
// the Bot that took the job over.
const OLD_NAMES = { 'Deadline Keeper': 'Manager', 'Policy Watcher': 'Scout', 'Inbox Scout': 'Scout' };
const OLD_IDS = { keeper: 'manager', policy: 'scout', inbox: 'scout' };
export const botName = (name) => OLD_NAMES[name] ?? name;

// Each Bot is one solid shape that says its job (a page, a monitor, an owl, a
// stopwatch, a speech bubble) with two eyes cut out of it. The
// shapes are drawn for Waypoint; they are not xAI's artwork.
//   fill: the body            cut: detail drawn on the body in the eye colour
//   line/dots: extras (an antenna)
//   eyes: centres             eye: [rx, ry] when not the usual size
const SHAPES = {
  intake: {
    fill: ['M8 2.5h6l5 5V19a2.5 2.5 0 0 1-2.5 2.5h-9A2.5 2.5 0 0 1 5 19V5.5a3 3 0 0 1 3-3z'],
    cut: ['M14 3v3.2a1.5 1.5 0 0 0 1.5 1.5h3'],
    eyes: [[9.4, 14.2], [14.6, 14.2]],
  },
  case: {
    fill: ['M6.5 7h11A2.5 2.5 0 0 1 20 9.5v8a2.500 2.500 0 0 1-2.500 2.500h-11A2.500 2.500 0 0 1 4 17.500v-8A2.500 2.500 0 0 1 6.500 7z'],
    line: ['M12 7V4.6'],
    dots: [[12, 3.4, 1.5]],
    eyes: [[9.3, 13.4], [14.7, 13.4]],
  },
  scout: {
    fill: ['M12 21a7.6 7.6 0 0 0 7.6-7.6c0-2-.7-3.700-1.900-5.100L18.600 3.600 14.600 6a7.900 7.900 0 0 0-5.200 0L5.400 3.600l.900 4.700c-1.200 1.400-1.900 3.100-1.900 5.100A7.600 7.600 0 0 0 12 21z'],
    eyes: [[9.2, 13.2], [14.8, 13.2]],
    eye: [1.45, 1.95],
  },
  manager: {
    // The crown first, so the dial's edge is drawn over where they meet.
    fill: [
      'M10 2.5h4a1 1 0 0 1 1 1v.600a1 1 0 0 1-1 1h-.900v1.600h-2.200V5.100H10a1 1 0 0 1-1-1v-.600a1 1 0 0 1 1-1z',
      'M12 21.5a7.6 7.6 0 1 0 0-15.200 7.600 7.600 0 0 0 0 15.200z',
    ],
    eyes: [[9.5, 13.5], [14.5, 13.5]],
  },
  messenger: {
    fill: ['M6 4.5h12A2.5 2.5 0 0 1 20.500 7v8a2.500 2.500 0 0 1-2.500 2.500h-5.200l-4.300 3.700v-3.700H6A2.500 2.500 0 0 1 3.500 15V7A2.500 2.500 0 0 1 6 4.500z'],
    eyes: [[9.4, 11], [14.6, 11]],
  },
};

function node(tag, attrs) {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  return n;
}

export function botGlyph(id, size = 28) {
  id = OLD_IDS[id] ?? id;
  const shape = SHAPES[id] ?? SHAPES.case;
  const svg = node('svg', { viewBox: '0 0 24 24', width: size, height: size, 'aria-hidden': 'true', class: `bot-glyph bot-glyph--${id}` });
  // The body is one group so it can squash and stretch from its feet.
  const body = node('g', { class: 'bot-body' });
  for (const d of shape.fill) body.append(node('path', { d, class: 'bot-fill' }));
  for (const d of shape.line ?? []) body.append(node('path', { d, class: 'bot-line' }));
  for (const [cx, cy, r] of shape.dots ?? []) body.append(node('circle', { cx, cy, r, class: 'bot-dot' }));
  for (const d of shape.cut ?? []) body.append(node('path', { d, class: 'bot-cut' }));
  const [rx, ry] = shape.eye ?? [1.1, 1.65];
  for (const [cx, cy] of shape.eyes) body.append(node('ellipse', { cx, cy, rx, ry, class: 'bot-eye' }));
  svg.append(body);
  return svg;
}

// What a Bot is doing, the way a teammate's status reads at a glance. Each state
// has its own motion (see css/app/bots.css): asleep breathes with its eyes shut, idle
// floats, blinks and glances, thinking tilts and looks up, working bounces
// inside a turning ring, waiting pulses with a dot, blocked shakes once, done
// hops and lands.
export const BOT_STATES = {
  asleep: 'not connected',
  idle: 'idle',
  thinking: 'thinking',
  working: 'working',
  waiting: 'waiting for you',
  blocked: 'could not finish',
  done: 'done',
};

export const botByName = (name) => BOTS.find((b) => b.name === botName(name)) ?? null;

// One Bot as a round avatar. `detail` is what hovering says ("checked at 2:03 AM").
export function botAvatar(id, { state = 'idle', size = 28, detail = '' } = {}) {
  id = OLD_IDS[id] ?? id;
  const bot = BOTS.find((b) => b.id === id);
  const avatar = document.createElement('span');
  avatar.className = 'bot-avatar';
  avatar.append(botGlyph(id, size));
  setBotState(avatar, state, detail, bot?.name);
  return avatar;
}

export function setBotState(avatar, state, detail = '', name = avatar.dataset.name) {
  if (avatar.dataset.state !== state) avatar.dataset.state = state;
  if (name) avatar.dataset.name = name;
  const words = `${name ?? 'Bot'}: ${detail || BOT_STATES[state] || state}`;
  avatar.setAttribute('role', 'img');
  avatar.setAttribute('aria-label', words);
  avatar.title = words;
}

// The large Bot in a page's opening band. Built once, then only its state
// changes. `doing` continues the Bot's name ("is waiting for your answer") and
// is what a screen reader and the hover tip say.
export function heroBot(id, state = 'idle', doing = '') {
  const slot = document.getElementById('hero-bot');
  if (!slot) return;
  id = OLD_IDS[id] ?? id;
  const bot = BOTS.find((b) => b.id === id);
  const line = `${bot?.name ?? 'Bot'} ${doing}`.trim();
  let avatar = slot.querySelector('.bot-avatar');
  if (!avatar || avatar.dataset.bot !== id) {
    avatar = botAvatar(id, { state, size: 160 });
    avatar.dataset.bot = id;
    avatar.classList.add('bot-avatar--hero');
    slot.replaceChildren(avatar);
  } else {
    setBotState(avatar, state);
  }
  avatar.setAttribute('aria-label', line);
  avatar.title = line;
}

// A row of the five Bots joined by a line.
//   statusOf(bot) -> a short line under each name ("2:03 AM", "Not connected")
//   stateOf(bot)  -> one of BOT_STATES
//   loop: true plays the hand-off on its own (the sign-in page)
export function botRelay({ statusOf, stateOf, loop = false } = {}) {
  const relay = document.createElement('div');
  relay.className = `relay${loop ? ' relay--loop' : ''}`;

  const track = document.createElement('ol');
  track.className = 'relay-track';
  BOTS.forEach((bot, i) => {
    const item = document.createElement('li');
    item.className = 'relay-bot';
    item.dataset.bot = bot.id;
    item.style.setProperty('--i', String(i));
    const face = botAvatar(bot.id, { state: loop ? 'idle' : stateOf?.(bot) ?? 'idle', detail: statusOf?.(bot) ?? '' });
    face.classList.add('relay-face');
    const name = document.createElement('span');
    name.className = 'relay-name';
    name.textContent = bot.name;
    item.append(face, name);
    if (statusOf) {
      const status = document.createElement('span');
      status.className = 'relay-status';
      status.textContent = statusOf(bot) ?? '';
      item.append(status);
    }
    track.append(item);
  });

  const packet = document.createElement('span');
  packet.className = 'relay-packet';
  packet.setAttribute('aria-hidden', 'true');
  relay.append(track, packet);

  if (loop) {
    // Decoration: the page's own words already say what the Bots do.
    relay.setAttribute('aria-hidden', 'true');
    // One line of words under the row, changing as the work moves along.
    const says = document.createElement('ol');
    says.className = 'relay-says';
    says.setAttribute('aria-hidden', 'true');
    BOTS.forEach((bot, i) => {
      const line = document.createElement('li');
      line.style.setProperty('--i', String(i));
      line.textContent = `${bot.name} ${bot.does}.`;
      says.append(line);
    });
    relay.append(says);
  }
  return relay;
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Put the named Bots to work one after another while `work` (a promise) runs.
// Returns what `work` returned. With reduced motion it only waits for the work.
export async function playRelay(relay, botNames, work) {
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const faces = botNames
    .map((n) => relay.querySelector(`[data-bot="${botByName(n)?.id}"] .bot-avatar`))
    .filter(Boolean);
  const before = faces.map((f) => f.dataset.state);
  try {
    if (reduced) {
      faces.forEach((f) => setBotState(f, 'working'));
      return await work;
    }
    const steps = (async () => {
      for (const face of faces) {
        sendPacket(relay, face.closest('[data-bot]').dataset.bot);
        setBotState(face, 'working');
        await wait(900);
        setBotState(face, 'done');
      }
    })();
    const [result] = await Promise.all([work, steps]);
    await wait(500);
    return result;
  } catch (err) {
    faces.forEach((f, i) => setBotState(f, before[i]));
    throw err;
  } finally {
    sendPacket(relay, null);
  }
}

// Move the relay's packet along the wire to a Bot, or put it away with null.
// The first move places it without a slide, so it does not fly in from the edge.
export function sendPacket(relay, botId) {
  const at = BOTS.findIndex((b) => b.id === botId);
  if (at === -1) {
    relay.classList.remove('relay--live');
    return;
  }
  const starting = !relay.classList.contains('relay--live');
  if (starting) relay.classList.add('relay--placing');
  relay.style.setProperty('--at', String(at));
  relay.classList.add('relay--live');
  if (starting) {
    void relay.offsetWidth;
    relay.classList.remove('relay--placing');
  }
}

// The Bots look at the pointer. Each avatar gets --lx and --ly, a small offset
// its eyes follow (see .bot-eye). Off for touch screens and reduced motion.
function watchPointer() {
  const fine = window.matchMedia('(hover: hover) and (pointer: fine)');
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  let x = 0;
  let y = 0;
  let queued = false;
  const look = () => {
    queued = false;
    for (const avatar of document.querySelectorAll('.bot-avatar')) {
      const box = avatar.getBoundingClientRect();
      if (box.bottom < 0 || box.top > window.innerHeight || !box.width) continue;
      const dx = x - (box.left + box.width / 2);
      const dy = y - (box.top + box.height / 2);
      const far = Math.hypot(dx, dy) || 1;
      const reach = Math.min(1, far / 160) * 0.9;
      avatar.style.setProperty('--lx', ((dx / far) * reach).toFixed(2));
      avatar.style.setProperty('--ly', ((dy / far) * reach).toFixed(2));
    }
  };
  window.addEventListener(
    'pointermove',
    (event) => {
      if (!fine.matches || reduced.matches) return;
      x = event.clientX;
      y = event.clientY;
      if (!queued) {
        queued = true;
        requestAnimationFrame(look);
      }
    },
    { passive: true },
  );
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') watchPointer();
