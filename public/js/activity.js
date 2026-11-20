// Activity: every Bot run and every message sent, newest first.

import { initPage, el, formatTime, rowsOf, xChecked } from './common.js';
import { botAvatar, botByName, botName, heroBot } from './bots.js';
import { arriveBands } from './motion.js';

arriveBands();

const CHANNEL = { sms: 'Text message', calendar: 'Google Calendar', gmail: 'Gmail', slack: 'Slack', chat: 'Grok Bot chat' };
const newestFirst = (a, b) => String(b.at).localeCompare(String(a.at));

function tags(row) {
  return `${row.simulated ? ' (simulated)' : ''}${row.sample ? ' (sample)' : ''}${row.demo ? ' (sent with a demo button)' : ''}${row.trial_template ? " (Twilio trial: the phone got Twilio's sample text, not this wording)" : ''}`;
}

function avatarFor(name, state, small = true) {
  const bot = botByName(name);
  if (!bot) return null;
  const avatar = botAvatar(bot.id, { state, size: small ? 18 : 22 });
  if (small) avatar.classList.add('bot-avatar--small');
  return avatar;
}

initPage(({ store, profile, today, live }) => {
  document.title = `Activity for ${profile.name} · Waypoint`;

  const notice = document.getElementById('notice');
  notice.textContent = live ? '' : 'The store is not reachable, so this is sample data.';
  notice.hidden = live;

  const runs = rowsOf(store.runs).filter((r) => r.person === profile.id).sort(newestFirst);
  const running = runs.filter((r) => r.status === 'running');
  // The Bot that is working now fronts the page, or the one that reported last.
  const lead = running[0] ?? runs[0];
  heroBot(botByName(lead?.bot)?.id ?? 'messenger', running.length ? 'working' : 'idle', running.length ? 'is working now' : 'reported last');
  const runningLine = document.getElementById('running');
  runningLine.className = running.length ? 'with-bot' : '';
  runningLine.replaceChildren(
    ...running.map((r) => avatarFor(r.bot, 'working', false)),
    running.length ? `${running.map((r) => botName(r.bot)).join(', ')} ${running.length === 1 ? 'is' : 'are'} working.` : 'No Bot is working right now.',
  );

  document.getElementById('runs').replaceChildren(
    ...runs.map((run) =>
      el(
        'li',
        {},
        el('span', { class: 'log-when', text: formatTime(run.at, today) }),
        el(
          'span',
          { class: 'log-who' },
          avatarFor(run.bot, run.status === 'failed' ? 'blocked' : run.status === 'running' ? 'working' : 'idle'),
          botName(run.bot) || 'Bot',
        ),
        el(
          'span',
          { class: 'log-what' },
          `${run.status === 'failed' ? 'Failed: ' : run.status === 'running' ? 'Running: ' : ''}${run.summary || ''}${tags(run)}`,
          xChecked(run) ? el('span', { class: 'log-detail', text: xChecked(run) }) : null,
        ),
      ),
    ),
  );
  document.getElementById('runs-note').textContent = runs.length ? '' : 'No Bot has reported yet.';

  const messages = rowsOf(store.notifications).filter((n) => n.person === profile.id).sort(newestFirst);
  document.getElementById('messages').replaceChildren(
    ...messages.map((message) =>
      el(
        'li',
        {},
        el('span', { class: 'log-when', text: formatTime(message.at, today) }),
        el('span', { class: 'log-who', text: CHANNEL[message.channel] || message.channel || 'Message' }),
        el('span', { class: 'log-what', text: `${message.text || ''}${tags(message)}` }),
      ),
    ),
  );
  document.getElementById('messages-note').textContent = messages.length ? '' : 'Nothing has been sent yet.';
});
