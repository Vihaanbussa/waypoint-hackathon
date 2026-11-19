// Sending one text to a person's own phone, with the caps that keep a looping
// Bot from flooding a phone or spending the Twilio balance.

import { toE164 } from './sms.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const TEXTS_A_DAY = 6;

export function createTexts({ store, sms, appendRow, save }) {
  const dailyCapAll = Math.max(1, Number(process.env.SMS_DAILY_CAP) || 60);

  const textsSince = (ms, person = null) =>
    (store.notifications ?? []).filter(
      (n) => n && n.via === 'twilio' && n.state === 'sent' && (!person || n.person === person) && Date.now() - Date.parse(n.at) < ms,
    ).length;

  // Texts started but not yet recorded. They count against the caps, so a Bot
  // firing several at once cannot all pass the check before any is saved.
  const inFlight = new Map(); // person -> count
  const inFlightAll = () => [...inFlight.values()].reduce((a, b) => a + b, 0);

  // Sends one text to a person's own phone and records it, sent or failed, where
  // Activity shows it. The sample people have made-up numbers: their texts go to
  // SMS_DEMO_TO when the host sets it (the presenter's phone) and nowhere otherwise.
  async function sendText(profile, input, meta = {}) {
    const text = String(input ?? '').replace(/\s+/g, ' ').trim();
    if (!text) throw new Error('The text is empty.');
    if (text.length > 300) throw new Error('Keep a text to one line, 300 characters at most.');
    if (/\b[A-Z]{3}\d{10}\b/.test(text)) throw new Error('Leave receipt numbers out of a text.');
    if (profile.channels?.sms === false) throw new Error(`${profile.name} has text messages turned off in Settings.`);
    if (!sms.ready) throw new Error(`Texting is not switched on for this site yet (${sms.missing.join(', ')} missing on the host).`);
    const to = toE164(profile.owner ? profile.phone : process.env.SMS_DEMO_TO);
    if (!to) {
      throw new Error(
        profile.owner
          ? `${profile.name} has no mobile number Waypoint can text. Add one under "Edit your details" in Settings.`
          : 'The sample people have made-up phone numbers, so nothing was sent. Set SMS_DEMO_TO on the host to get their texts on a real phone.',
      );
    }
    if (textsSince(DAY_MS, profile.id) + (inFlight.get(profile.id) ?? 0) >= TEXTS_A_DAY) throw new Error(`${profile.name} has already had ${TEXTS_A_DAY} texts in the last day. That is the limit.`);
    if (textsSince(DAY_MS) + inFlightAll() >= dailyCapAll) throw new Error('This site has sent its limit of texts for today.');
    // The same news is not texted twice in a day, however often a Bot asks.
    if (meta.kind) {
      const again = store.notifications.some(
        (n) => n && n.via === 'twilio' && n.state === 'sent' && n.person === profile.id && n.kind === meta.kind && (n.deadline_id ?? '') === (meta.deadline_id ?? '') && Date.now() - Date.parse(n.at) < 20 * 60 * 60 * 1000,
      );
      if (again) throw new Error(`${profile.name} was already texted about this in the last day, so nothing was sent.`);
    }
    const row = { person: profile.id, channel: 'sms', text, via: 'twilio', ...(meta.kind ? { kind: meta.kind } : {}), ...(meta.deadline_id ? { deadline_id: meta.deadline_id } : {}) };
    inFlight.set(profile.id, (inFlight.get(profile.id) ?? 0) + 1);
    const release = () => inFlight.set(profile.id, inFlight.get(profile.id) - 1);
    try {
      let sent;
      try {
        sent = await sms.send(to, text, { template: meta.template });
      } finally {
        release();
      }
      // On a Twilio trial the phone gets Twilio's sample text, not this wording.
      const saved = appendRow('notifications', { ...row, state: 'sent', twilio_id: sent.id, ...(sent.template ? { trial_template: sent.template } : {}) });
      await save();
      return { row: saved, to, template: sent.template || '' };
    } catch (err) {
      appendRow('notifications', { ...row, state: 'failed', error: String(err.message).slice(0, 300) });
      await save();
      throw err;
    }
  }

  return { textsSince, sendText };
}
