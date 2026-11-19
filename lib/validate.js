// Checks on what people and Bots send us. No state.

import { lookup as dnsLookup } from 'node:dns/promises';
import { VISA_TYPES, fieldsFor } from '../public/js/rules.js';
import { parseDay, toIso } from '../public/js/clocks.js';
import { httpError } from './http.js';

export const strictDay = (value) => {
  const text = String(value ?? '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(text) && parseDay(text) != null && toIso(parseDay(text)) === text ? text : null;
};

// An IANA zone name like "America/Chicago", or '' if it is not one.
export function validTimezone(value) {
  const zone = String(value ?? '').trim();
  if (!zone || zone.length > 64) return '';
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: zone });
    return zone;
  } catch {
    return '';
  }
}

// https only, and never an address inside this machine or network.
export function publicHttpsUrl(text) {
  let parsed;
  try {
    parsed = new URL(String(text).trim());
  } catch {
    return null;
  }
  const host = parsed.hostname.toLowerCase();
  const inside = host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal') || /^[\d.]+$/.test(host) || host.includes(':');
  return parsed.protocol === 'https:' && !inside && parsed.href.length <= 500 ? parsed.href : null;
}

const isPrivateIp = (ip) =>
  /^(10\.|127\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(ip) ||
  /^(::1?$|f[cd][0-9a-f]{2}:|fe[89ab][0-9a-f]:|::ffff:(10\.|127\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.))/i.test(ip);

// A name can point inside the network, so check where it resolves. Fails closed.
export async function resolvesPublic(href) {
  try {
    const addresses = await dnsLookup(new URL(href).hostname, { all: true });
    return addresses.length > 0 && addresses.every((a) => !isPrivateIp(a.address));
  } catch (err) {
    // A name that does not exist is harmless (the fetch fails); any other lookup trouble is refused.
    return err?.code === 'ENOTFOUND';
  }
}

// Build a profile from what the person typed. Only fields the visa type uses are kept.
export function profileFromInput(data, existing, session) {
  const visa = String(data.visa_type || '');
  if (!Object.hasOwn(VISA_TYPES, visa)) throw httpError(400, 'Choose a visa type.');
  const name = String(data.name || '').trim().slice(0, 80);
  if (!name) throw httpError(400, 'Add your name.');

  const profile = { id: existing?.id ?? `u-${session.id}`, owner: session.id, name, visa_type: visa };
  for (const field of fieldsFor(visa)) {
    const value = data[field.id];
    if (field.type === 'flag') {
      profile[field.id] = value === true || value === 'true' || value === 'on';
    } else if (value == null || String(value).trim() === '') {
      continue;
    } else if (field.type === 'date') {
      const day = strictDay(value);
      if (!day) throw httpError(400, `"${field.label}" needs a real date, like 2027-02-10.`);
      profile[field.id] = day;
    } else if (field.type === 'number') {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 0 || n > (field.max ?? 1000)) {
        throw httpError(400, `"${field.label}" needs a whole number from 0 to ${field.max ?? 1000}.`);
      }
      profile[field.id] = n;
    }
  }

  const receipts = (Array.isArray(data.receipts) ? data.receipts : String(data.receipts || '').split(/[\s,;]+/))
    .map((r) => String(r).trim().toUpperCase())
    .filter(Boolean)
    .slice(0, 10);
  for (const receipt of receipts) {
    if (!/^[A-Z]{3}\d{10}$/.test(receipt)) {
      throw httpError(400, `"${receipt.slice(0, 20)}" is not a receipt number. They look like IOE0912345678.`);
    }
  }
  profile.receipts = [...new Set(receipts)];

  const phone = String(data.phone || '').trim();
  if (phone && !/^[0-9+()\-. ]{7,24}$/.test(phone)) throw httpError(400, 'The phone number has characters a phone number cannot have.');
  profile.phone = phone;
  profile.timezone = validTimezone(data.timezone) || existing?.timezone || '';

  const channels = data.channels && typeof data.channels === 'object' ? data.channels : existing?.channels;
  profile.channels = {
    sms: channels ? Boolean(channels.sms) : true,
    calendar: channels ? Boolean(channels.calendar) : true,
    gmail: channels ? Boolean(channels.gmail) : true,
  };
  profile.quiet_hours = existing?.quiet_hours ?? { from: '22:00', to: '07:00' };
  profile.accounts = existing?.accounts ?? {};
  if (existing?.bot_webhook) profile.bot_webhook = existing.bot_webhook;
  return profile;
}
