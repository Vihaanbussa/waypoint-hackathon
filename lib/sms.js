// Text messages, sent through Twilio's REST API with nothing but fetch.
//
// Three settings turn it on:
//   TWILIO_ACCOUNT_SID    starts with AC, from the Twilio console
//   TWILIO_AUTH_TOKEN     beside it in the console
//   TWILIO_FROM_NUMBER    the number Twilio gave you, like +15551234567
// Without all three nothing is sent, and callers are told which are missing.

import { cleanSetting } from './persist.js';

// "(415) 555-0142" -> "+14155550142". A number with no country code is taken
// to be in the US or Canada. Anything that cannot be a phone number is null.
export function toE164(phone) {
  const text = String(phone ?? '').trim();
  const digits = text.replace(/\D/g, '');
  if (text.startsWith('+')) return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return null;
}

// "+14155550142" -> "the number ending 42", for logs and answers to Bots.
export const maskNumber = (number) => `the number ending ${String(number).slice(-2)}`;

// Twilio's error codes, said the way the person fixing it needs to hear them.
const REASONS = {
  20003: 'Twilio refused the Account SID or Auth Token. Check both in the host\'s settings.',
  21211: 'Twilio says that is not a valid mobile number.',
  21408: 'This Twilio account is not allowed to text that country yet.',
  21606: 'TWILIO_FROM_NUMBER is not a number this Twilio account can text from.',
  21608: 'A Twilio trial only texts numbers you have verified. Verify this number in the Twilio console, under Verified Caller IDs.',
  21610: 'This number replied STOP, so Twilio will not text it. Reply START from the phone to turn texts back on.',
  21614: 'Twilio says that number cannot receive texts.',
  21659: 'TWILIO_FROM_NUMBER is not a number this Twilio account owns.',
};

export function createSms({ env = process.env, fetchImpl = (...args) => fetch(...args) } = {}) {
  // Read on every use, so a setting added while the server runs is picked up.
  const config = () => ({
    sid: cleanSetting(env.TWILIO_ACCOUNT_SID, 'TWILIO_ACCOUNT_SID'),
    token: cleanSetting(env.TWILIO_AUTH_TOKEN, 'TWILIO_AUTH_TOKEN'),
    from: toE164(cleanSetting(env.TWILIO_FROM_NUMBER, 'TWILIO_FROM_NUMBER')),
    base: String(env.TWILIO_API_BASE || 'https://api.twilio.com').replace(/\/+$/, ''),
  });
  const missing = () => {
    const c = config();
    return [
      !c.sid && 'TWILIO_ACCOUNT_SID',
      !c.token && 'TWILIO_AUTH_TOKEN',
      !c.from && 'TWILIO_FROM_NUMBER',
    ].filter(Boolean);
  };

  return {
    get ready() {
      return missing().length === 0;
    },
    get missing() {
      return missing();
    },
    // Sends one text. Resolves to { id, status }; rejects with a plain reason.
    async send(to, body) {
      const c = config();
      if (missing().length) throw new Error(`Texting is not set up: ${missing().join(', ')} ${missing().length === 1 ? 'is' : 'are'} missing.`);
      const number = toE164(to);
      if (!number) throw new Error('That is not a mobile number Waypoint can text.');
      let res;
      try {
        res = await fetchImpl(`${c.base}/2010-04-01/Accounts/${encodeURIComponent(c.sid)}/Messages.json`, {
          method: 'POST',
          headers: {
            Authorization: `Basic ${Buffer.from(`${c.sid}:${c.token}`).toString('base64')}`,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: new URLSearchParams({ To: number, From: c.from, Body: String(body) }).toString(),
          signal: AbortSignal.timeout(10000),
        });
      } catch {
        throw new Error('Twilio did not answer. Try again in a minute.');
      }
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const reason = REASONS[data.code] || (res.status === 401 ? REASONS[20003] : '');
        throw new Error(reason || `Twilio would not send it${data.message ? `: ${String(data.message).slice(0, 200)}` : ` (it answered ${res.status}).`}`);
      }
      return { id: String(data.sid || ''), status: String(data.status || 'queued') };
    },
  };
}
