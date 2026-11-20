// Settings: the profile, the three notification channels, and the rules in use.

import { initPage, el, safeUrl, visaLabel, remember, rowsOf, signOut } from './common.js';
import { rulesFor, packsFor, formatDate, parseDay } from './clocks.js';
import { PACKS, FIELD_LABELS, ABOUT_FIELDS } from './rules.js';
import { APPLICATION_STATUS_LABEL } from './applications.js';
import { saveSettings, post } from './store.js';
import { botAvatar, heroBot } from './bots.js';
import { arriveBands } from './motion.js';

arriveBands();
heroBot('intake', 'idle', 'keeps your details');

const CHANNELS = [
  {
    id: 'sms',
    label: 'Text messages',
    describe: (p) => `To ${p.phone || 'your phone'}. One line: what changed, days left and a link. No receipt or ID numbers.`,
  },
  {
    id: 'calendar',
    label: 'Google Calendar',
    describe: (p) =>
      `${p.accounts?.calendar ? `Connected as ${p.accounts.calendar}. ` : 'Not connected. '}One event per deadline, moved when the date moves.`,
  },
  {
    id: 'gmail',
    label: 'Gmail',
    describe: (p) =>
      `${p.accounts?.gmail ? `Connected as ${p.accounts.gmail}. ` : 'Not connected. '}Emails to other people wait for your approval.`,
  },
];

let drawnFor = null; // rebuild the form only when the profile changes

function renderProfile(profile, today, me) {
  const facts = [
    ['Name', profile.name],
    ...ABOUT_FIELDS.filter((f) => profile[f.id]).map((f) => [f.label, String(profile[f.id])]),
    ['Visa type', visaLabel(profile)],
    ['Rules applied', packsFor(profile).map((id) => PACKS[id].label).join(', ')],
  ];
  for (const [field, label] of Object.entries(FIELD_LABELS)) {
    const value = profile[field];
    if (value == null || value === '') continue;
    facts.push([label, parseDay(value) != null ? formatDate(value, today) : String(value)]);
  }
  const receipts = Array.isArray(profile.receipts) ? profile.receipts : [];
  if (receipts.length) facts.push(['Receipt numbers', receipts.join(', ')]);
  document
    .getElementById('profile-facts')
    .replaceChildren(...facts.flatMap(([label, value]) => [el('dt', { text: label }), el('dd', { text: value })]));
  document.getElementById('profile-action').replaceChildren(
    me.demo
      ? el('span', { class: 'muted', text: 'This is a sample person. Create an account to enter your own details.' })
      : el('a', { class: 'btn', href: '/setup/?edit=1', text: 'Edit your details' }),
  );
}

function renderOwn(ctx) {
  const { store, profile, today } = ctx;
  const mine = rowsOf(store.own_deadlines)
    .filter((d) => d.person === profile.id)
    .sort((a, b) => String(a.due_date).localeCompare(String(b.due_date)));
  document.getElementById('own-list').replaceChildren(
    ...mine.map((row) => {
      const remove = el('button', { class: 'link-button', type: 'button', text: 'Remove', 'aria-label': `Remove ${row.label}` });
      remove.addEventListener('click', async () => {
        remove.disabled = true;
        try {
          await post(`/api/own-deadlines/${encodeURIComponent(row.id)}/delete`, {});
          await ctx.refresh();
        } catch (err) {
          remove.disabled = false;
          remove.textContent = `Couldn't remove it. ${err.message}`;
        }
      });
      return el('li', {}, el('span', {}, row.label, el('span', { class: 'muted', text: `  ${formatDate(row.due_date, today)}` })), remove);
    }),
  );
  document.getElementById('own-list').hidden = !mine.length;
  document
    .getElementById('own-note')
    .replaceChildren(
      mine.length ? '' : 'None yet. ',
      el('a', { href: `/?p=${encodeURIComponent(profile.id)}#add-own`, text: 'Add a deadline of your own' }),
      mine.length ? '' : ' for anything the rules do not cover, like an appointment or a lease.',
    );
}

function renderAccount(ctx) {
  const { me, profile } = ctx;
  const connected = Boolean(profile.bot_webhook?.url);
  const hasRuns = rowsOf(ctx.store.runs).some((r) => r.person === profile.id && !r.simulated && !r.sample);
  const line = document.getElementById('connect-line');
  const state = connected || hasRuns ? 'idle' : 'asleep';
  if (line.dataset.state !== state) {
    line.dataset.state = state;
    const text = me.demo
      ? 'The sample people use sample runs. Create an account to connect Grok Bots of your own.'
      : hasRuns
        ? 'A Bot has reported for you. Open the setup to add more Bots or change your key.'
        : connected
          ? 'Check now is wired to your Bot. Waiting for its first report.'
          : 'Not connected yet. The setup gives you the address, your key, and what to tell each Bot.';
    line.replaceChildren(botAvatar('case', { state, size: 30 }), text);
    // Until a Bot is connected, setting them up is the main thing to do here.
    document.getElementById('connect-link').classList.toggle('btn--primary', !me.demo && !connected && !hasRuns);
  }
  document.getElementById('account-line').textContent = me.demo
    ? 'You are exploring the demo. Nothing here is tied to an account.'
    : `Signed in as ${me.email}.`;
  const action = document.getElementById('account-action');
  if (action.dataset.for === me.id) return;
  action.dataset.for = me.id;
  const button = el('button', { class: 'btn', type: 'button', text: me.demo ? 'Exit demo and create an account' : 'Sign out' });
  button.addEventListener('click', async () => {
    if (!me.demo) return signOut();
    await post('/api/auth/logout', {}).catch(() => {});
    location.assign('/login/?mode=signup');
  });
  action.replaceChildren(button);
}

// Under "Text messages": a button that sends one real text to your own phone,
// when this site can text. The demo's people have made-up numbers, so not there.
function textTest(profile, me, canText) {
  if (me.demo) return null;
  if (!canText) return el('p', { class: 'channel-extra', text: 'Texting is not switched on for this site yet.' });
  const status = el('span', { class: 'channel-status', role: 'status' });
  const button = el('button', { class: 'btn btn--small', type: 'button', text: 'Send a test text' });
  button.addEventListener('click', async () => {
    button.disabled = true;
    status.classList.remove('is-error');
    status.textContent = 'Sending…';
    try {
      const sent = await post(`/api/profiles/${encodeURIComponent(profile.id)}/test-text`, {});
      status.textContent = `Sent to ${sent.to}. It can take a few seconds to arrive.${sent.trial ? " Your Twilio account is on a trial, so it arrives as one of Twilio's sample texts, not Waypoint's wording." : ''}`;
    } catch (err) {
      status.classList.add('is-error');
      status.textContent = err.message;
    }
    button.disabled = false;
  });
  return el('div', { class: 'channel-extra' }, button, status);
}

function renderChannels(profile, live, me, canText) {
  const status = document.getElementById('save-status');
  const from = document.getElementById('quiet-from');
  const to = document.getElementById('quiet-to');
  const fieldset = document.getElementById('channels');

  async function save() {
    const channels = Object.fromEntries(CHANNELS.map((c) => [c.id, document.getElementById(`channel-${c.id}`).checked]));
    try {
      await saveSettings(profile.id, { channels, quiet_hours: { from: from.value, to: to.value } });
      const time = new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
      status.classList.remove('is-error');
      status.textContent = live ? `Saved at ${time}.` : `Saved in this browser at ${time}.`;
    } catch (err) {
      status.classList.add('is-error');
      status.textContent = `Couldn't save. ${err.message}`;
    }
  }

  fieldset.replaceChildren(
    el('legend', { class: 'visually-hidden', text: 'Channels' }),
    ...CHANNELS.map((channel) => {
      const id = `channel-${channel.id}`;
      const box = el('input', { type: 'checkbox', id, 'aria-describedby': `${id}-help` });
      box.checked = profile.channels?.[channel.id] !== false;
      box.addEventListener('change', save);
      return el(
        'div',
        { class: 'channel' },
        box,
        el('label', { for: id, text: channel.label }),
        el('p', { id: `${id}-help`, text: channel.describe(profile) }),
        channel.id === 'sms' ? textTest(profile, me, canText) : null,
      );
    }),
  );
  from.value = profile.quiet_hours?.from || '22:00';
  to.value = profile.quiet_hours?.to || '07:00';
  from.onchange = save;
  to.onchange = save;
  status.textContent = '';
}

const SCHOOL_STATUS = [
  ['target', 'Target'],
  ['enrolled', 'Enrolled'],
  ['alumni', 'Alumni'],
];

let schoolsDrawn = '';

function renderSchools(profile, me, refresh) {
  const panel = document.getElementById('schools-panel');
  const status = document.getElementById('schools-status');
  const schools = Array.isArray(profile.schools) ? profile.schools : [];
  const signature = `${profile.id}:${JSON.stringify(schools)}:${profile.track_schools !== false}:${me.demo}`;
  if (schoolsDrawn === signature) return;
  schoolsDrawn = signature;

  const list = schools.length
    ? el(
        'ul',
        { class: 'school-list' },
        ...schools.map((school) => el('li', { class: 'school-card' }, el('span', { text: SCHOOL_STATUS.find((item) => item[0] === school.status)?.[1] || school.status }), el('span', {}, school.name, school.state ? el('span', { class: 'muted', text: ` · ${school.state}` }) : null))),
      )
    : el('p', { text: 'No schools yet.' });

  if (me.demo) {
    panel.replaceChildren(list, el('p', { class: 'muted', text: 'This is a sample person. Create an account to add your own schools.' }));
    return;
  }

  const track = el('input', { type: 'checkbox', id: 'track-schools' });
  track.checked = profile.track_schools !== false;
  const name = el('input', { type: 'text', id: 'school-name', maxlength: '120', placeholder: 'School name' });
  const state = el('input', { type: 'text', id: 'school-state', maxlength: '2', placeholder: 'CA' });
  const select = el('select', { id: 'school-status' }, ...SCHOOL_STATUS.map(([id, label]) => el('option', { value: id, text: label })));
  const add = el('button', { class: 'btn', type: 'button', text: 'Add school' });
  const error = el('p', { class: 'form-error', role: 'alert', hidden: true });

  async function save(next, trackOn) {
    error.hidden = true;
    try {
      await post(`/api/profiles/${encodeURIComponent(profile.id)}/schools`, { schools: next, track_schools: trackOn });
      status.classList.remove('is-error');
      status.textContent = 'Saved.';
      schoolsDrawn = '';
      await refresh?.();
    } catch (err) {
      status.classList.add('is-error');
      status.textContent = err.message;
      error.hidden = false;
      error.textContent = err.message;
    }
  }

  track.addEventListener('change', () => save(schools, track.checked));
  add.addEventListener('click', () => {
    const schoolName = name.value.trim();
    if (!schoolName) {
      error.hidden = false;
      error.textContent = 'Add the school’s name.';
      name.focus();
      return;
    }
    save([...schools, { name: schoolName, status: select.value, state: state.value.trim() }], track.checked);
  });

  const rows = schools.map((school) => {
    const remove = el('button', { class: 'link-button', type: 'button', text: 'Remove', 'aria-label': `Remove ${school.name}` });
    remove.addEventListener('click', () => save(schools.filter((item) => item.id !== school.id), track.checked));
    const progress = school.status === 'target' && school.application ? APPLICATION_STATUS_LABEL[school.application] : '';
    return el('li', {}, el('span', {}, `${school.name} · ${SCHOOL_STATUS.find((item) => item[0] === school.status)?.[1] || school.status}${progress ? ` · ${progress}` : ''}`), remove);
  });

  const targets = schools.filter((school) => school.status === 'target');
  let gotIn = null;
  if (profile.stage === 'applying' && targets.length) {
    const pick = el('select', { id: 'got-in' }, ...targets.map((school) => el('option', { value: school.id, text: school.name })));
    const button = el('button', { class: 'btn btn--primary', type: 'button', text: 'I got in here' });
    button.addEventListener('click', () => saveEnrolled(profile, pick.value, status, refresh));
    gotIn = el(
      'div',
      { class: 'field' },
      el('label', { for: 'got-in', text: 'The school you got into' }),
      el('span', { class: 'hint', text: 'This is the only choice after you are admitted. Waypoint then watches that campus.' }),
      pick,
      el('div', { class: 'form-actions' }, button),
    );
  }

  panel.replaceChildren(
    gotIn,
    el('label', { class: 'check', for: 'track-schools' }, track, el('span', { text: 'Track these schools on the Brief' })),
    el('ul', { class: 'rule-list', id: 'school-edit-list' }, ...rows),
    el('div', { class: 'field' }, el('label', { for: 'school-name', text: 'Add a school' }), name),
    el('div', { class: 'field' }, el('label', { for: 'school-status', text: 'Status' }), select),
    el('div', { class: 'field' }, el('label', { for: 'school-state', text: 'State' }), state),
    error,
    el('div', { class: 'form-actions' }, add),
  );
}

async function saveEnrolled(profile, schoolId, status, refresh) {
  try {
    await post(`/api/profiles/${encodeURIComponent(profile.id)}/enroll`, { school_id: schoolId });
    status.classList.remove('is-error');
    status.textContent = 'Saved.';
    schoolsDrawn = '';
    await refresh?.();
  } catch (err) {
    status.classList.add('is-error');
    status.textContent = err.message;
  }
}

function renderRules(profile) {
  const rules = rulesFor(profile);
  document.getElementById('rules-intro').textContent =
    `${rules.length} rules apply to ${visaLabel(profile)}. Each one links to the official page it comes from.`;
  document.getElementById('rules').replaceChildren(
    ...rules.map((rule) => {
      const url = rule.source && safeUrl(rule.source.url);
      const source = !rule.source
        ? null
        : url
          ? el('a', { class: 'rule-source', href: url, target: '_blank', rel: 'noopener', text: rule.source.label })
          : el('span', { class: 'rule-source', text: rule.source.label });
      return el('li', {}, el('span', { text: `${rule.name} (${rule.pack})` }), source);
    }),
  );
}

initPage((ctx) => {
  const { profile, today, live, me } = ctx;
  document.title = `Settings for ${profile.name} · Waypoint`;
  const notice = document.getElementById('notice');
  notice.textContent = live ? '' : 'The store is not reachable, so changes stay in this browser.';
  notice.hidden = live;

  // Step three of the first-visit guide: this person has seen where Settings lives.
  remember(`waypoint.guide.v1.${me.id}.settings`, '1');
  renderProfile(profile, today, me);
  renderSchools(profile, me, ctx.refresh);
  renderOwn(ctx);
  renderAccount(ctx);
  renderRules(profile);
  // Don't rebuild the form under the person's hands on every poll.
  if (drawnFor !== profile.id) {
    renderChannels(profile, live, me, Boolean(ctx.store.features?.sms));
    drawnFor = profile.id;
  }
});
