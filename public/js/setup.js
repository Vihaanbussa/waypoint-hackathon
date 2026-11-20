// Your own details in three steps: visa type, dates, how you are told.
// The same form edits them later (/setup/?edit=1).

import { get, post } from './store.js';
import { el } from './common.js';
import { VISA_TYPES, VISA_BLURBS, ABOUT_FIELDS, fieldsFor } from './rules.js';
import { buildClocks, localToday, formatDate, RISK_LABEL } from './clocks.js';
import { botAvatar, setBotState } from './bots.js';

const STEPS = [
  { title: 'About you and your visa', lede: 'Your visa type decides which deadlines Waypoint counts for you. Your school, major and home country tell the Bots who to write to and what news to watch. You can change any of it later.' },
  { title: 'Your dates', lede: 'Fill in what you have and leave the rest empty. Each one says where to find it.' },
  { title: 'How should Waypoint reach you?', lede: 'Messages to you are automatic. Anything to someone else waits for your approval.' },
];

const editing = new URLSearchParams(location.search).get('edit') === '1';
const today = localToday();
const $ = (id) => document.getElementById(id);
const values = {}; // field id -> what the person typed, kept when the visa type changes
let step = 0;
let visa = 'f1_opt'; // most international students start on F-1, so a new account starts there

function fail(message) {
  $('setup-error').textContent = message;
  $('setup-error').hidden = false;
}

// ---- step 1: about you, then visa type ----

const about = {}; // field id -> what the person typed

function drawAbout() {
  $('about-fields').replaceChildren(
    ...ABOUT_FIELDS.map((field) => {
      const id = `about-${field.id}`;
      let input;
      if (field.options) {
        input = el('select', { id }, el('option', { value: '', text: 'Choose one' }), ...field.options.map((o) => el('option', { value: o, text: o })));
      } else {
        input = el('input', { type: 'text', id, maxlength: String(field.max ?? 60), autocomplete: field.id === 'home_country' ? 'country-name' : 'off' });
        if (field.hint) input.setAttribute('aria-describedby', `${id}-hint`);
      }
      input.value = about[field.id] ?? '';
      input.addEventListener('input', () => {
        about[field.id] = input.value;
      });
      input.addEventListener('change', () => {
        about[field.id] = input.value;
      });
      return el(
        'div',
        { class: 'field' },
        el('label', { for: id, text: field.label }),
        field.hint ? el('span', { class: 'hint', id: `${id}-hint`, text: `Optional. ${field.hint}` }) : el('span', { class: 'hint', text: 'Optional.' }),
        input,
      );
    }),
  );
}

function drawVisaList() {
  $('visa-list').replaceChildren(
    ...Object.entries(VISA_TYPES).map(([id, type]) => {
      const radio = el('input', { type: 'radio', name: 'visa', value: id, id: `visa-${id}` });
      radio.checked = visa === id;
      radio.addEventListener('change', () => {
        visa = id;
      });
      return el('label', { class: 'visa-option', for: `visa-${id}` }, radio, el('span', {}, el('strong', { text: type.label }), VISA_BLURBS[id] || ''));
    }),
  );
}

// ---- step 2: dates, drawn from the rule packs ----

function drawFields() {
  const nodes = [];
  for (const field of fieldsFor(visa)) {
    const id = `f-${field.id}`;
    if (field.type === 'flag') {
      const box = el('input', { type: 'checkbox', id });
      box.checked = values[field.id] === true;
      box.addEventListener('change', () => {
        values[field.id] = box.checked;
        drawPreview();
      });
      nodes.push(el('label', { class: 'check', for: id }, box, el('span', { text: field.label })));
      continue;
    }
    const input = el('input', {
      type: field.type === 'number' ? 'number' : 'date',
      id,
      'aria-describedby': field.where ? `${id}-hint` : null,
      min: field.type === 'number' ? '0' : null,
      max: field.type === 'number' ? String(field.max ?? 1000) : null,
      inputmode: field.type === 'number' ? 'numeric' : null,
    });
    input.value = values[field.id] ?? '';
    input.addEventListener('input', () => {
      values[field.id] = input.value;
      drawPreview();
    });
    nodes.push(
      el(
        'div',
        { class: 'field' },
        el('label', { for: id, text: field.label }),
        field.where ? el('span', { class: 'hint', id: `${id}-hint`, text: field.where }) : null,
        input,
      ),
    );
  }
  $('date-fields').replaceChildren(...nodes);
  drawPreview();
}

function schoolsFromText(text) {
  return text
    .split('\n')
    .map((line) => {
      const [name, status, state] = line.split(',').map((part) => part.trim());
      if (!name) return null;
      return { name, status: (status || 'target').toLowerCase(), ...(state ? { state } : {}) };
    })
    .filter(Boolean);
}

function draftProfile() {
  const profile = { id: 'draft', name: $('name').value.trim(), visa_type: visa };
  for (const field of ABOUT_FIELDS) if (String(about[field.id] ?? '').trim()) profile[field.id] = String(about[field.id]).trim();
  for (const field of fieldsFor(visa)) {
    const value = values[field.id];
    if (field.type === 'flag') profile[field.id] = value === true;
    else if (value != null && value !== '') profile[field.id] = field.type === 'number' ? Number(value) : value;
  }
  return profile;
}

// The Manager sits on the preview: thinking while there is nothing to count,
// working for a moment each time a date changes, then settled.
const keeper = botAvatar('manager', { state: 'thinking', size: 32 });
let keeperTimer = null;
function nudgeKeeper(hasWork) {
  clearTimeout(keeperTimer);
  if (!hasWork) return setBotState(keeper, 'thinking', 'waiting for a date to count from');
  setBotState(keeper, 'working', 'counting the days');
  keeperTimer = setTimeout(() => setBotState(keeper, 'done', 'counted'), 900);
}

// Show what the dates turn into, as they are typed: the product, before saving.
function drawPreview() {
  const clocks = buildClocks(draftProfile(), {}, today);
  const preview = $('preview');
  if (!clocks.length) {
    nudgeKeeper(false);
    preview.replaceChildren(
      el('h3', { class: 'with-bot' }, keeper, 'Nothing to count yet'),
      el('p', { class: 'muted', text: 'Add a date and the deadline it creates shows up here.' }),
    );
    return;
  }
  nudgeKeeper(true);
  preview.replaceChildren(
    el('h3', { class: 'with-bot' }, keeper, `The Manager will count ${clocks.length} ${clocks.length === 1 ? 'deadline' : 'deadlines'} for you`),
    el(
      'ul',
      {},
      ...clocks.map((clock) => {
        const n = clock.daysLeft;
        const when =
          n == null ? '' : n < 0 ? `${-n} days late` : n === 0 ? 'today' : n > 730 ? `${Math.floor(n / 365)}+ years left` : `${n} ${n === 1 ? 'day' : 'days'} left`;
        return el(
          'li',
          {},
          el('span', {}, clock.name, clock.due ? el('span', { class: 'muted', text: `, ${formatDate(clock.due, today)}` }) : null),
          el('span', { text: `${RISK_LABEL[clock.risk]}${when ? ` · ${when}` : ''}` }),
        );
      }),
    ),
  );
}

// ---- steps ----

function show(next, focus = true) {
  step = next;
  $('setup-error').hidden = true;
  for (let i = 0; i < 3; i += 1) $(`step-${i + 1}`).hidden = i !== step;
  [...$('progress').children].forEach((li, i) => li.classList.toggle('is-on', i <= step));
  $('step-count').textContent = `${editing ? 'Edit your details' : 'Set up'} · Step ${step + 1} of 3`;
  $('step-title').textContent = STEPS[step].title;
  $('step-lede').textContent = STEPS[step].lede;
  $('back').hidden = step === 0;
  $('next').textContent = step < 2 ? 'Continue' : editing ? 'Save changes' : 'Finish and see my deadlines';
  if (step === 1) drawFields();
  else drawPreview();
  if (focus) {
    $('step-title').focus({ preventScroll: true });
    window.scrollTo({ top: 0 });
  }
}

$('back').addEventListener('click', () => show(step - 1));

$('setup-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (step === 0) {
    if (!$('name').value.trim()) return fail('Add your name.');
    if (!visa) return fail('Choose the visa you are on.');
    return show(1);
  }
  if (step === 1) return show(2);

  const next = $('next');
  next.disabled = true;
  try {
    await post('/api/profile', {
      ...draftProfile(),
      receipts: $('receipts').value,
      phone: $('phone').value,
      // So the server counts days from the person's own today, not the server's.
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      channels: { sms: $('ch-sms').checked, calendar: $('ch-calendar').checked, gmail: $('ch-gmail').checked },
      schools: schoolsFromText($('schools').value),
      track_schools: $('track-schools').checked,
    });
    location.assign(editing ? '/settings/' : '/');
  } catch (err) {
    next.disabled = false;
    fail(err.message);
  }
});

$('sign-out').addEventListener('click', async () => {
  await post('/api/auth/logout', {}).catch(() => {});
  location.assign('/login/');
});

// ---- start ----

try {
  const store = await get('/api/store');
  if (store.me?.demo) location.replace('/');
  const profile = store.profiles?.[0] ?? null;
  if (profile && !editing) location.replace('/');
  $('name').value = profile?.name ?? store.me?.name ?? '';
  if (profile) {
    for (const field of ABOUT_FIELDS) about[field.id] = profile[field.id] ?? '';
    visa = profile.visa_type;
    for (const field of fieldsFor(visa)) {
      const value = profile[field.id];
      if (value != null && value !== '') values[field.id] = field.type === 'flag' ? value === true : String(value);
    }
    $('receipts').value = (profile.receipts ?? []).join(', ');
    $('phone').value = profile.phone ?? '';
    $('ch-sms').checked = profile.channels?.sms !== false;
    $('ch-calendar').checked = profile.channels?.calendar !== false;
    $('ch-gmail').checked = profile.channels?.gmail !== false;
    $('schools').value = (profile.schools || []).map((school) => [school.name, school.status, school.state].filter(Boolean).join(', ')).join('\n');
    $('track-schools').checked = profile.track_schools !== false;
  }
  $('cancel-link').hidden = !editing;
  drawAbout();
  drawVisaList();
  show(0, false);
} catch {
  location.replace('/login/');
}
