// Settings: the profile, the three notification channels, and the rules in use.

import { initPage, el, safeUrl, visaLabel, remember, rowsOf, signOut } from './common.js';
import { rulesFor, packsFor, formatDate, parseDay } from './clocks.js';
import { PACKS, FIELD_LABELS } from './rules.js';
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
  renderOwn(ctx);
  renderAccount(ctx);
  renderRules(profile);
  // Don't rebuild the form under the person's hands on every poll.
  if (drawnFor !== profile.id) {
    renderChannels(profile, live, me, Boolean(ctx.store.features?.sms));
    drawnFor = profile.id;
  }
});
