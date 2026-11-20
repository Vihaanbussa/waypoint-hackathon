// Checks on what people and Bots send us. No state.

import { lookup as dnsLookup } from 'node:dns/promises';
import { ABOUT_FIELDS, VISA_TYPES, fieldsFor } from '../public/js/rules.js';
import { parseDay, toIso } from '../public/js/clocks.js';
import { httpError } from './http.js';
import { BOTS, botName } from './config.js';
import { buildClocks } from '../public/js/clocks.js';
import { syncUserFacts } from '../public/js/applications.js';
import { httpsSource, normalizeSchools, readSignal, schoolSlug } from '../public/js/schools.js';

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
  const stage = data.stage === 'applying' || data.stage === 'enrolled' ? data.stage : existing?.stage === 'applying' ? 'applying' : 'enrolled';
  const visa = String(data.visa_type ?? (stage === 'applying' ? existing?.visa_type || '' : '')).trim();
  if (stage === 'enrolled' && !Object.hasOwn(VISA_TYPES, visa)) throw httpError(400, 'Choose a visa type.');
  if (visa && !Object.hasOwn(VISA_TYPES, visa)) throw httpError(400, 'Choose a visa type.');
  const name = String(data.name || '').trim().slice(0, 80);
  if (!name) throw httpError(400, 'Add your name.');

  const profile = { id: existing?.id ?? `u-${session.id}`, owner: session.id, name, visa_type: visa, stage };
  // School, degree, major and home country: plain words, all optional.
  for (const field of ABOUT_FIELDS) {
    const value = String(data[field.id] ?? '').replace(/\s+/g, ' ').trim();
    if (!value) continue;
    if (field.options && !field.options.includes(value)) throw httpError(400, `"${field.label}" must be one of: ${field.options.join(', ')}.`);
    if (!field.options && !/^[\p{L}\p{N} .,'&()\/-]+$/u.test(value)) throw httpError(400, `"${field.label}" has characters it cannot have.`);
    profile[field.id] = value.slice(0, field.max ?? 60);
  }
  for (const field of (visa ? fieldsFor(visa) : [])) {
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
  if (data.schools === undefined) profile.schools = Array.isArray(existing?.schools) ? existing.schools : [];
  else {
    try {
      const today = new Date().toISOString().slice(0, 10);
      profile.schools = normalizeSchools(data.schools, { today, previous: existing?.schools });
    } catch (err) {
      throw httpError(400, err.message);
    }
  }
  profile.track_schools = data.track_schools === undefined ? existing?.track_schools !== false : data.track_schools === true || data.track_schools === 'true' || data.track_schools === 'on';
  if (stage === 'applying') {
    if (!profile.home_country) throw httpError(400, 'Add your country of citizenship.');
    if (!profile.degree) throw httpError(400, 'Choose your degree.');
    if (!profile.term) throw httpError(400, 'Add the term you want to start.');
    if (!(profile.schools || []).some((school) => school.status === 'target')) throw httpError(400, 'Add the schools you want to apply to.');
  }
  try {
    profile.bank = syncUserFacts(existing?.bank, {
      name: profile.name,
      citizenship: profile.home_country,
      degree: profile.degree,
      term: profile.term,
    });
  } catch (err) {
    throw httpError(400, err.message);
  }
  return profile;
}

// ---- rows Bots write: one set of rules for every door (connector, report form, /api/rows) ----

// A link counts as an X post only if it really is on X.
export function xPostUrl(value) {
  try {
    const url = new URL(String(value || ''));
    const host = url.hostname.replace(/^(www|mobile)\./, '');
    return url.protocol === 'https:' && (host === 'x.com' || host === 'twitter.com') ? url.href : '';
  } catch {
    return '';
  }
}

// The searches a Bot says it ran on X: a short list of short strings, no repeats.
export function xSearches(value) {
  const list = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[\n;]+/) : [];
  const seen = new Set();
  for (const item of list) {
    const text = String(item ?? '').replace(/\s+/g, ' ').trim().slice(0, 100);
    if (text) seen.add(text);
  }
  return [...seen].slice(0, 8);
}

const RECEIPT = /\b[A-Z]{3}\d{10}\b/;

// An official page: https, and not a post on X.
function officialSource(value) {
  try {
    const url = new URL(String(value || ''));
    const host = url.protocol === 'https:' ? url.hostname.replace(/^(www|mobile)\./, '') : '';
    if (!host || host === 'x.com' || host === 'twitter.com') return '';
    return url.href;
  } catch {
    return '';
  }
}

// One line a person might read on their phone or in Activity. Receipt numbers stay out.
export function plainText(value) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (!text) throw httpError(400, 'The text is empty.');
  if (text.length > 300) throw httpError(400, 'Keep a text to one line, 300 characters at most.');
  if (RECEIPT.test(text)) throw httpError(400, 'Leave receipt numbers out of a text.');
  return text;
}

const quietMinutes = (value) => {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(value || ''));
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
};

// Minutes since midnight where the person is.
function minutesNow(timeZone, now) {
  const parts = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: validTimezone(timeZone) || undefined }).formatToParts(now);
  const get = (type) => Number(parts.find((p) => p.type === type)?.value);
  return get('hour') * 60 + get('minute');
}

// True when now falls inside quiet hours, including a window that passes midnight.
export function inQuietHours(quiet, timeZone, now = new Date()) {
  const from = quietMinutes(quiet?.from);
  const to = quietMinutes(quiet?.to);
  if (from == null || to == null || from === to) return false;
  const at = minutesNow(timeZone, now);
  return from < to ? at >= from && at < to : at >= from || at < to;
}

// send_text waits out quiet hours. A deadline already at Act now still goes through.
export function textDuringQuietHours(profile, store, now = new Date()) {
  if (!inQuietHours(profile.quiet_hours, profile.timezone, now)) return;
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: validTimezone(profile.timezone) || undefined }).format(now);
  if (buildClocks(profile, store, day).some((clock) => clock.risk === 'act')) return;
  throw httpError(400, `It is quiet hours for ${profile.name} (${profile.quiet_hours.from} to ${profile.quiet_hours.to}). A text waits unless a deadline is Act now.`);
}

// Checks and tidies a row before it is stored.
export function prepareRow(table, row, store) {
  if (table === 'alerts') {
    const source = officialSource(row.source_url);
    if (!source) throw httpError(400, 'A rule change needs a link to the official page (https). A post on X is not enough.');
    row.source_url = source;
    row.x_url = xPostUrl(row.x_url);
    row.seen_on_x = Boolean(row.x_url);
    if (!['act', 'watch', 'clear'].includes(row.risk)) row.risk = 'clear';
    if (!String(row.title || '').trim() || !String(row.why || '').trim()) throw httpError(400, 'A title and a "why" are both needed.');
  }
  if (table === 'case_status') {
    const profile = store.profiles.find((p) => p.id === String(row.person));
    const receipt = String(row.receipt || '').trim().toUpperCase();
    const owned = (profile?.receipts ?? []).map((item) => String(item).toUpperCase());
    if (!owned.includes(receipt)) {
      throw httpError(400, `That receipt number is not on ${profile?.name || 'this person'}'s profile. Add it under Settings before recording a status.`);
    }
    row.receipt = receipt;
    if (!String(row.status || '').trim()) throw httpError(400, 'Pass the status as the portal words it.');
    for (const field of ['last_changed', 'response_due']) {
      if (row[field] && !strictDay(row[field])) throw httpError(400, `"${field}" must be a real date like 2027-02-10.`);
    }
  }
  if (table === 'inbox_facts' && !strictDay(row.due_date)) throw httpError(400, '"due_date" must be a real date like 2026-12-09.');
  if (table === 'school_signals' || table === 'school_alerts') {
    const profile = store.profiles.find((p) => p.id === String(row.person));
    const id = schoolSlug(row.school_id || row.school_name || '');
    const school = (profile?.schools || []).find((item) => item.id === id);
    if (!school) throw httpError(400, 'That school is not on this person\'s list. Add it in Waypoint first.');
    row.school_id = school.id;
    row.school_name = school.name;
    delete row.score;
    delete row.rank;
    if (table === 'school_signals') {
      try {
        row.value = readSignal(String(row.signal || ''), row.value);
      } catch (err) {
        throw httpError(400, err.message);
      }
      row.signal = String(row.signal);
      const source = httpsSource(row.source_url);
      if (!source) throw httpError(400, 'A school signal needs a link to the official page (https). A post on X is not enough.');
      row.source_url = source;
      row.source_label = String(row.source_label || '').slice(0, 120);
    } else {
      if (!String(row.title || '').trim() || !String(row.why || '').trim()) throw httpError(400, 'A title and a "why" are both needed.');
      const source = httpsSource(row.source_url);
      if (!source) throw httpError(400, 'A school alert needs a link to the official page (https). A post on X is not enough.');
      row.source_url = source;
      row.title = String(row.title).slice(0, 160);
      row.why = String(row.why).slice(0, 500);
      if (!['act', 'watch', 'clear'].includes(row.risk)) row.risk = 'watch';
      if (row.date && !strictDay(row.date)) throw httpError(400, '"date" must be a real date like 2026-12-09.');
      if (!row.date) delete row.date;
    }
  }
  if (table === 'notifications') row.text = plainText(row.text);
  if (table === 'runs') {
    const reportedAs = String(row.bot || '');
    const bot = botName(reportedAs);
    if (!BOTS.includes(bot)) throw httpError(400, `"bot" must be one of: ${BOTS.join(', ')}.`);
    if (!String(row.summary || '').trim()) throw httpError(400, 'Add a one-line summary.');
    row.bot = bot;
    row.status = row.status === 'failed' || row.status === 'running' ? row.status : 'ok';
    // Inbox Scout never searched X, so a report still using that old name is let be.
    if (['Scout', 'Policy Watcher'].includes(reportedAs) && row.status === 'ok') {
      const searches = xSearches(row.x_searches);
      if (!searches.length) {
        throw httpError(
          400,
          'Scout has to search X before it reports. Run your X searches for this person\'s visa type, then call report_run again with x_searches (the searches you ran) and x_posts_read (how many posts you read). If you cannot search X right now, report status "failed" and say so in the summary.',
        );
      }
      row.x_searches = searches;
      row.x_posts_read = Math.max(0, Math.min(9999, Math.floor(Number(row.x_posts_read)) || 0));
    } else {
      delete row.x_searches;
      delete row.x_posts_read;
    }
  }
}
