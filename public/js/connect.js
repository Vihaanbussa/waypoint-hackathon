// Connect your Bots: the connector address, your key, and each Bot's first message.

import { initPage, el } from './common.js';
import { get, post } from './store.js';
import { botAvatar, setBotState, heroBot } from './bots.js';
import { arriveBands } from './motion.js';

arriveBands();
heroBot('case', 'thinking', 'is ready to be connected');
import { BOT_BRIEFS, CONNECT_MESSAGE, WEBHOOK_MESSAGE, fillBrief } from './bot-briefs.js';

const $ = (id) => document.getElementById(id);
let info = null; // { mcp_url, bot_key, demo, local }
let shown = false; // is the key on screen
let drawnFor = null;

async function copy(text, button, done = 'Copied') {
  const label = button.textContent;
  try {
    await navigator.clipboard.writeText(text);
    button.textContent = done;
  } catch {
    button.textContent = 'Select the text and copy it';
  }
  setTimeout(() => (button.textContent = label), 1800);
}

const masked = (key) => (key ? `${key.slice(0, 8)}${'•'.repeat(12)}` : 'YOUR-BOT-KEY');

function drawConnector(profile) {
  const values = { origin: info.origin, mcp: info.mcp_url, key: info.bot_key };
  $('connect-facts').replaceChildren(
    el('dt', { text: 'Connector address' }),
    el('dd', {}, el('code', { text: info.mcp_url })),
    el('dt', { text: 'Header' }),
    el('dd', {}, el('code', { text: `Authorization: Bearer ${shown ? info.bot_key : masked(info.bot_key)}` })),
    el('dt', { text: 'Your person id' }),
    el('dd', {}, el('code', { text: profile.id })),
  );
  $('connect-message').textContent = fillBrief(CONNECT_MESSAGE, { ...values, key: shown ? info.bot_key : masked(info.bot_key) });
  $('show-key').textContent = shown ? 'Hide key' : 'Show key';
  for (const id of ['copy-connect', 'show-key']) $(id).hidden = !info.bot_key;
  $('rotate-key').hidden = info.demo;

  const notes = [];
  if (info.demo) {
    notes.push(
      info.bot_key
        ? 'You are in the demo, so this key speaks for the two sample people. Create an account to connect Bots to your own details.'
        : 'You are in the demo. The key for the sample people is kept on the server, in data/bot-key.txt. Create an account to get a key of your own.',
    );
  }
  if (info.local) notes.push('This address only works on this computer. Grok Bots run in the cloud, so Waypoint has to be on a public https address before a Bot can reach it.');
  $('connect-notice').textContent = notes.join(' ');
  $('connect-notice').hidden = !notes.length;
}

function drawBriefs() {
  const values = { origin: info.origin, mcp: info.mcp_url };
  $('briefs').replaceChildren(
    ...BOT_BRIEFS.map((brief) => {
      const text = fillBrief(brief.message, values);
      const avatar = botAvatar(brief.id, { state: 'idle', size: 24 });
      const button = el('button', { class: 'btn', type: 'button', text: 'Copy first message' });
      button.addEventListener('click', async () => {
        await copy(text, button);
        // A small thank-you: the Bot you just briefed perks up.
        setBotState(avatar, 'done', 'briefed');
        setTimeout(() => setBotState(avatar, 'idle'), 1500);
      });
      return el(
        'div',
        { class: 'brief-item' },
        el('div', { class: 'brief-head' }, avatar, el('h3', { text: brief.name }), button, el('p', { class: 'brief-when', text: `Runs: ${brief.when}` })),
        el('details', {}, el('summary', { text: 'Read the message' }), el('pre', { class: 'paste', text })),
      );
    }),
  );
  $('webhook-message').textContent = WEBHOOK_MESSAGE;
}

function drawWebhook(profile, me) {
  const hook = profile.bot_webhook;
  $('webhook-form').hidden = me.demo;
  if (document.activeElement !== $('webhook-url')) $('webhook-url').value = hook?.url ?? $('webhook-url').value;
  $('webhook-key').placeholder = hook?.has_key ? 'Saved. Leave empty to keep it.' : '';
  $('webhook-clear').hidden = !hook;
  if (!$('webhook-status').textContent) $('webhook-status').textContent = hook ? 'Connected. Check now on your Brief wakes your Bot.' : '';
}

initPage(async (ctx) => {
  const { profile, me } = ctx;
  document.title = 'Connect your Bots · Waypoint';
  if (drawnFor !== me.id) {
    drawnFor = me.id;
    info = await get('/api/connect');
    drawBriefs();

    $('show-key').onclick = () => {
      shown = !shown;
      drawConnector(profile);
    };
    $('copy-connect').onclick = () =>
      copy(fillBrief(CONNECT_MESSAGE, { origin: info.origin, mcp: info.mcp_url, key: info.bot_key }), $('copy-connect'));
    $('copy-webhook').onclick = () => copy(WEBHOOK_MESSAGE, $('copy-webhook'));
    $('rotate-key').onclick = async () => {
      if (!window.confirm('Make a new key? Bots using the old key stop working until you give them the new one.')) return;
      try {
        ({ bot_key: info.bot_key } = await post('/api/connect/rotate', {}));
        shown = true;
        drawConnector(profile);
        $('connect-status').textContent = 'New key made. Give it to your Bots; the old one no longer works.';
      } catch (err) {
        $('connect-status').textContent = `Couldn't make a new key. ${err.message}`;
      }
    };

    const save = async (body, message) => {
      $('webhook-error').hidden = true;
      try {
        await post('/api/connect/webhook', body);
        $('webhook-key').value = '';
        if (!body.url) $('webhook-url').value = '';
        $('webhook-status').textContent = message;
        await ctx.refresh();
      } catch (err) {
        $('webhook-error').textContent = err.message;
        $('webhook-error').hidden = false;
      }
    };
    $('webhook-form').onsubmit = (event) => {
      event.preventDefault();
      if (!$('webhook-url').value.trim()) {
        $('webhook-error').textContent = 'Paste the webhook address your Bot gave you.';
        $('webhook-error').hidden = false;
        return;
      }
      save({ url: $('webhook-url').value, key: $('webhook-key').value }, 'Saved. Check now on your Brief wakes your Bot.');
    };
    $('webhook-clear').onclick = () => save({ url: '' }, 'Disconnected. Check now is back to a simulated run.');
  }
  drawConnector(profile);
  drawWebhook(profile, me);
});
