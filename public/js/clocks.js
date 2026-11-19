// The clock function. Bots extract facts; this plain code does the date math
// and assigns risk, so every number on screen is deterministic and traceable.
// Pure: no DOM, no network, no clock of its own. Runs in the browser and in Node.

import { PACKS, VISA_TYPES, DEFAULT_THRESHOLDS, NOTICE_THRESHOLDS } from './rules.js';

const DAY = 864e5;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const RISK_ORDER = { act: 0, watch: 1, clear: 2 };

export const RISK_LABEL = { act: 'Act now', watch: 'Watch', clear: 'Clear' };

// ---- dates (all math in UTC on calendar days) ----

export function parseDay(value) {
  if (typeof value !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value.trim());
  if (!m) return null;
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  // Reject a day the calendar would roll over (2026-02-31 becomes March 3).
  return Number.isNaN(t) || new Date(t).getUTCDate() !== Number(m[3]) ? null : t;
}

export const toIso = (t) => new Date(t).toISOString().slice(0, 10);
export const addDays = (iso, n) => toIso(parseDay(iso) + n * DAY);

export function addYears(iso, n) {
  const d = new Date(parseDay(iso));
  d.setUTCFullYear(d.getUTCFullYear() + n);
  return toIso(d.getTime());
}

export const daysBetween = (fromIso, untilIso) => Math.round((parseDay(untilIso) - parseDay(fromIso)) / DAY);

export function localToday(now = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

// "Dec 1" in the current year, "May 30, 2027" otherwise.
export function formatDate(iso, todayIso) {
  const t = parseDay(iso);
  if (t == null) return '';
  const d = new Date(t);
  const text = `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
  const thisYear = todayIso ? new Date(parseDay(todayIso)).getUTCFullYear() : null;
  return d.getUTCFullYear() === thisYear ? text : `${text}, ${d.getUTCFullYear()}`;
}

// ---- tolerant readers (the store may be a hand-edited sheet) ----

const isTrue = (v) => v === true || ['true', 'yes', '1'].includes(String(v).trim().toLowerCase());
const isSet = (v) => v != null && v !== '' && v !== false && String(v).trim().toLowerCase() !== 'false';
const rows = (table) => (Array.isArray(table) ? table.filter((r) => r && typeof r === 'object') : []);
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'x';

export function toList(v) {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v !== 'string') return [];
  return v.split(/[;,]/).map((s) => s.trim()).filter(Boolean);
}

export function normalizeRisk(v) {
  const s = String(v ?? '').trim().toLowerCase();
  if (s === 'act' || s === 'act now' || s === 'red') return 'act';
  if (s === 'watch' || s === 'yellow') return 'watch';
  if (s === 'clear' || s === 'green') return 'clear';
  return null;
}

// ---- risk ----

export function riskFor(daysLeft, thresholds = DEFAULT_THRESHOLDS, floor = 'clear') {
  let risk = 'clear';
  if (daysLeft != null) {
    if (daysLeft <= thresholds.act) risk = 'act';
    else if (daysLeft <= thresholds.watch) risk = 'watch';
  }
  return RISK_ORDER[floor] < RISK_ORDER[risk] ? floor : risk;
}

// "13 days", "1 day", "today", "3 days overdue", "over 3 years", "29 left"
export function countLabel(clock) {
  if (clock.kind === 'counter') return `${clock.count.left} left`;
  const n = clock.daysLeft;
  if (n == null) return '';
  if (n < 0) return `${-n} ${n === -1 ? 'day' : 'days'} overdue`;
  if (n === 0) return 'today';
  if (n > 730) return `over ${Math.floor(n / 365)} years`;
  return `${n} ${n === 1 ? 'day' : 'days'}`;
}

// ---- reasons ----

function fill(template, profile, today, values) {
  return String(template ?? '').replace(/\{(\w+)(?:\+(\d+))?\}/g, (whole, key, plus) => {
    if (key in values) return values[key];
    const iso = parseDay(profile[key]) == null ? null : toIso(parseDay(profile[key]));
    if (!iso) return whole;
    return formatDate(plus ? addDays(iso, Number(plus)) : iso, today);
  });
}

// ---- clocks from rule packs ----

export function packsFor(profile) {
  const fromProfile = toList(profile.packs).filter((id) => PACKS[id]);
  if (fromProfile.length) return fromProfile;
  return VISA_TYPES[profile.visa_type]?.packs ?? ['base'];
}

function fromRule(rule, packId, profile, today) {
  if ((rule.requires ?? []).some((f) => !isSet(profile[f]) && profile[f] !== 0)) return null;
  if (rule.unless && isTrue(profile[rule.unless])) return null;

  const base = {
    id: rule.id,
    pack: packId,
    name: rule.name,
    source: rule.source ?? null,
    link: rule.link ?? null,
  };

  if (rule.kind === 'counter') {
    const used = Number(profile[rule.usedField]);
    if (!Number.isFinite(used)) return null;
    const limit = rule.limitWhen && isTrue(profile[rule.limitWhen.field]) ? rule.limitWhen.limit : rule.limit;
    const left = limit - used;
    const paused = isTrue(profile[rule.pausedField]);
    const values = { used: String(used), limit: String(limit), left: String(left) };
    return {
      ...base,
      kind: 'counter',
      name: `${rule.name}: ${used} of ${limit} used`,
      due: paused ? null : addDays(today, left),
      daysLeft: left,
      count: { used, limit, left },
      paused,
      risk: riskFor(left, rule.thresholds, rule.floor),
      reason: fill(paused ? rule.reason : rule.reasonRunning ?? rule.reason, profile, today, values),
    };
  }

  const anchor = parseDay(profile[rule.anchor]);
  if (anchor == null) return null;
  let due = toIso(anchor);
  if (rule.offsetYears) due = addYears(due, rule.offsetYears);
  if (rule.offsetDays) due = addDays(due, rule.offsetDays);
  const cap = rule.capField ? parseDay(profile[rule.capField]) : null;
  const capped = cap != null && cap < parseDay(due);
  if (capped) due = toIso(cap);

  const daysLeft = daysBetween(today, due);
  const variant = (rule.variants ?? []).find((v) => isSet(profile[v.when]));
  const values = {
    due: formatDate(due, today),
    elapsed: String(Math.max(0, daysBetween(toIso(anchor), today))),
  };
  return {
    ...base,
    kind: 'date',
    due,
    daysLeft,
    capped,
    risk: riskFor(daysLeft, rule.thresholds, rule.floor),
    reason: fill((variant ?? rule).reason, profile, today, values),
  };
}

// ---- clocks from facts the Bots wrote ----

function fromCases(profile, store, today) {
  const latest = new Map();
  for (const row of rows(store.case_status)) {
    if (row.person !== profile.id) continue;
    const key = String(row.receipt || row.title || 'case');
    const prev = latest.get(key);
    if (!prev || String(row.checked_at ?? '') >= String(prev.checked_at ?? '')) latest.set(key, row);
  }
  const out = [];
  for (const [key, row] of latest) {
    const title = String(row.title || 'Case');
    const changed = formatDate(row.last_changed, today);
    out.push({
      id: `case-${slug(key)}`,
      kind: 'case',
      name: `${title}: "${row.status || 'Status unknown'}"`,
      due: null,
      daysLeft: null,
      risk: 'clear',
      reason: changed ? `Last changed ${changed}.` : '',
      checkedAt: row.checked_at ?? null,
      source: { label: String(row.portal || 'Case status portal') },
      link: null,
    });
    if (parseDay(row.response_due) != null) {
      const due = toIso(parseDay(row.response_due));
      const daysLeft = daysBetween(today, due);
      out.push({
        id: `notice-${slug(key)}`,
        kind: 'date',
        name: 'Respond to request for evidence',
        due,
        daysLeft,
        risk: riskFor(daysLeft, NOTICE_THRESHOLDS, 'watch'),
        reason: `USCIS asked for more evidence on your ${title}. The due date comes from the notice.`,
        source: { label: 'The notice' },
        link: null,
      });
    }
  }
  return out;
}

function fromInbox(profile, store, today) {
  const out = [];
  for (const row of rows(store.inbox_facts)) {
    if (row.person !== profile.id || parseDay(row.due_date) == null) continue;
    const due = toIso(parseDay(row.due_date));
    const daysLeft = daysBetween(today, due);
    out.push({
      id: `inbox-${slug(row.id ?? row.subject ?? due)}`,
      kind: 'date',
      name: String(row.label || row.subject || 'Date from your inbox'),
      due,
      daysLeft,
      risk: riskFor(daysLeft, NOTICE_THRESHOLDS, 'watch'),
      reason: `From an email${row.sender ? ` from ${row.sender}` : ''}${row.subject ? `: "${row.subject}"` : ''}.`,
      source: { label: 'Your inbox', url: row.link },
      link: null,
    });
  }
  return out;
}

// Deadlines the person typed in themselves.
function fromOwn(profile, store, today) {
  const out = [];
  for (const row of rows(store.own_deadlines)) {
    if (row.person !== profile.id || parseDay(row.due_date) == null) continue;
    const due = toIso(parseDay(row.due_date));
    const daysLeft = daysBetween(today, due);
    out.push({
      id: `own-${slug(row.id ?? `${row.label}-${due}`)}`,
      kind: 'date',
      name: String(row.label || 'Your deadline'),
      due,
      daysLeft,
      risk: riskFor(daysLeft),
      reason: String(row.note || ''),
      source: { label: 'Added by you' },
      link: null,
      ownId: row.id ?? null,
    });
  }
  return out;
}

function fromAlerts(profile, store) {
  const out = [];
  for (const row of rows(store.alerts)) {
    const visas = toList(row.visa_types);
    const mine = row.person ? row.person === profile.id : visas.length === 0 || visas.includes(profile.visa_type);
    if (!mine) continue;
    out.push({
      id: `alert-${slug(row.id ?? row.title)}`,
      kind: 'alert',
      name: `Rule change: ${row.title || 'New notice'}`,
      due: null,
      daysLeft: null,
      risk: normalizeRisk(row.risk) ?? 'clear',
      reason: String(row.why ?? ''),
      source: row.source_label ? { label: String(row.source_label), url: row.source_url } : null,
      // Policy Watcher first saw it on X; the source above is what confirmed it.
      seenOnX: row.x_url || row.seen_on_x === true || String(row.seen_on_x).toLowerCase() === 'true' ? { url: row.x_url || null } : null,
      link: null,
    });
  }
  return out;
}

function compareClocks(a, b) {
  if (a.risk !== b.risk) return RISK_ORDER[a.risk] - RISK_ORDER[b.risk];
  const ad = a.kind === 'date' ? parseDay(a.due) : null;
  const bd = b.kind === 'date' ? parseDay(b.due) : null;
  if (ad != null && bd != null && ad !== bd) return ad - bd;
  if ((ad == null) !== (bd == null)) return ad == null ? 1 : -1;
  return a.name.localeCompare(b.name);
}

// Every clock for one person, most urgent first.
export function buildClocks(profile, store, today) {
  const clocks = [];
  for (const packId of packsFor(profile)) {
    for (const rule of PACKS[packId].rules) {
      const clock = fromRule(rule, packId, profile, today);
      if (clock) clocks.push(clock);
    }
  }
  clocks.push(
    ...fromCases(profile, store, today),
    ...fromInbox(profile, store, today),
    ...fromOwn(profile, store, today),
    ...fromAlerts(profile, store),
  );

  // Deadline Keeper (the Bot) may replace a reason with its own wording.
  for (const note of rows(store.clock_notes)) {
    if (note.person !== profile.id || !note.reason) continue;
    const clock = clocks.find((c) => c.id === note.clock);
    if (clock) clock.reason = String(note.reason);
  }
  return clocks.sort(compareClocks);
}

// The one-line summary: worst risk, and days to the nearest dated deadline.
export function overall(clocks) {
  const risk = clocks.reduce((worst, c) => (RISK_ORDER[c.risk] < RISK_ORDER[worst] ? c.risk : worst), 'clear');
  const dated = clocks.filter((c) => c.kind === 'date' && c.daysLeft != null && c.daysLeft >= 0);
  const next = dated.length ? Math.min(...dated.map((c) => c.daysLeft)) : null;
  const overdue = clocks.filter((c) => c.kind === 'date' && c.daysLeft < 0).length;
  return { risk, nextDays: next, overdue };
}

// Rules that apply to a profile, for the Settings page.
export function rulesFor(profile) {
  return packsFor(profile).flatMap((packId) =>
    PACKS[packId].rules.map((rule) => ({ pack: PACKS[packId].label, name: rule.name, source: rule.source ?? null })),
  );
}
