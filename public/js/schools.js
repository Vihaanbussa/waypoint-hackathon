// School support scores. Same signals in, same score out. A Bot may collect a
// signal; it may not pass a score. Nothing here reads the network or the page.

export const SCHOOL_STATUSES = ['target', 'enrolled', 'alumni'];

// Weights sum to 100 when every signal is present. A missing signal is left
// out of both the numerator and the denominator, so an incomplete school is
// not punished for what Scout has not collected yet.
const SPECS = {
  intl_pct: {
    weight: 10,
    parse(value) {
      const n = Number(value);
      if (!Number.isFinite(n) || n < 0 || n > 100) return null;
      return Math.min(1, n / 40);
    },
    line(value) {
      return `International students are ${trimNumber(value)}% of enrollment`;
    },
  },
  advisor_ratio: {
    weight: 20,
    parse(value) {
      const n = Number(value);
      if (!Number.isFinite(n) || n <= 0 || n > 10000) return null;
      if (n <= 150) return 1;
      if (n >= 800) return 0;
      return (800 - n) / (800 - 150);
    },
    line(value) {
      return `About ${trimNumber(value)} students per international advisor`;
    },
  },
  isss_office: {
    weight: 15,
    parse: presence,
    line: (value) => (truthy(value) ? 'A dedicated international office, with a way to book help' : 'No dedicated international office found'),
  },
  cpt_opt: {
    weight: 15,
    parse: presence,
    line: (value) => (truthy(value) ? 'Published CPT, OPT, or STEM support' : 'No published CPT or OPT support found'),
  },
  emergency_fund: {
    weight: 10,
    parse: presence,
    line: (value) => (truthy(value) ? 'A published emergency or hardship fund for international students' : 'No published emergency fund for international students'),
  },
  sentiment: {
    weight: 10,
    parse(value) {
      const n = Number(value);
      if (!Number.isFinite(n) || n < -1 || n > 1) return null;
      return (n + 1) / 2;
    },
    line(value) {
      const n = Number(value);
      if (n > 0.2) return 'Recent student posts lean positive';
      if (n < -0.2) return 'Recent student posts lean negative';
      return 'Recent student posts are mixed';
    },
  },
  state_policy: {
    weight: 15,
    parse(value) {
      const key = String(value).trim().toLowerCase();
      if (key === 'supportive' || value === 1) return 1;
      if (key === 'neutral' || value === 0) return 0.5;
      if (key === 'restrictive' || value === -1) return 0;
      return null;
    },
    line(value) {
      const key = String(value).trim().toLowerCase();
      if (key === 'supportive' || value === 1) return 'The state policy environment is supportive';
      if (key === 'restrictive' || value === -1) return 'The state policy environment is restrictive';
      return 'The state policy environment is neutral';
    },
  },
  processing_days: {
    weight: 5,
    parse(value) {
      const n = Number(value);
      if (!Number.isFinite(n) || n < 0 || n > 365) return null;
      if (n <= 7) return 1;
      if (n >= 30) return 0;
      return (30 - n) / (30 - 7);
    },
    line(value) {
      return `The school says document processing takes about ${trimNumber(value)} days`;
    },
  },
};

export const SIGNAL_TYPES = Object.keys(SPECS);

const trimNumber = (value) => {
  const n = Number(value);
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 10) / 10);
};

function truthy(value) {
  if (value === true || value === 1) return true;
  const key = String(value).trim().toLowerCase();
  return key === 'true' || key === 'yes';
}

function presence(value) {
  if (value === false || value === 0) return 0;
  const key = String(value).trim().toLowerCase();
  if (key === 'false' || key === 'no') return 0;
  if (truthy(value)) return 1;
  return null;
}

export function schoolSlug(name) {
  return String(name || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
}

// An official page is https and is not a post on X.
export function httpsSource(value) {
  try {
    const url = new URL(String(value || '').trim());
    const host = url.hostname.replace(/^(www|mobile)\./, '');
    if (url.protocol !== 'https:' || !host || host === 'x.com' || host === 'twitter.com') return '';
    return url.href.slice(0, 500);
  } catch {
    return '';
  }
}

// Check a raw signal before it is stored. Throws a reason a Bot can read.
export function readSignal(type, value) {
  const spec = SPECS[type];
  if (!spec) throw new Error(`"signal" must be one of: ${SIGNAL_TYPES.join(', ')}.`);
  if (spec.parse(value) == null) throw new Error(`That value does not fit "${type}".`);
  return value === true || value === false ? value : typeof value === 'number' ? value : String(value).trim().slice(0, 40);
}

function latestRows(rows) {
  const byType = new Map();
  for (const row of rows || []) {
    if (!row || !SPECS[row.signal]) continue;
    const prev = byType.get(row.signal);
    const at = String(row.at || row.observed_on || '');
    if (!prev || at >= String(prev.at || prev.observed_on || '')) byType.set(row.signal, row);
  }
  return [...byType.values()];
}

// signals: rows for one school. Score is null until at least one signal parses.
export function scoreSchool(signals) {
  const rows = latestRows(signals);
  let weight = 0;
  let sum = 0;
  const notes = [];
  let updated = '';
  for (const row of rows) {
    const spec = SPECS[row.signal];
    const unit = spec.parse(row.value);
    if (unit == null) continue;
    weight += spec.weight;
    sum += spec.weight * unit;
    const at = String(row.at || row.observed_on || '');
    if (at > updated) updated = at;
    notes.push({
      signal: row.signal,
      distance: Math.abs(unit - 0.5),
      text: spec.line(row.value),
      source_label: String(row.source_label || '').slice(0, 120),
      source_url: httpsSource(row.source_url),
    });
  }
  notes.sort((a, b) => b.distance - a.distance || a.signal.localeCompare(b.signal));
  if (!weight) return { score: null, why: [], signals_used: 0, updated_at: null };
  return {
    score: Math.round((100 * sum) / weight),
    why: notes.slice(0, 5).map(({ text, source_label, source_url }) => ({ text, source_label, source_url })),
    signals_used: notes.length,
    updated_at: updated || null,
  };
}

// Rank the person's target schools. Enrolled and alumni schools are not ranked.
// Schools with no usable signals stay at the end, with rank null.
export function rankSchools(schools, signalRows) {
  const targets = (Array.isArray(schools) ? schools : []).filter((school) => school && school.status === 'target' && school.id);
  const scored = targets.map((school) => {
    const result = scoreSchool((signalRows || []).filter((row) => row && row.school_id === school.id));
    return {
      id: school.id,
      name: school.name,
      status: 'target',
      state: school.state || '',
      score: result.score,
      why: result.why,
      signals_used: result.signals_used,
      updated_at: result.updated_at,
    };
  });
  const ready = scored.filter((school) => school.score != null).sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  const waiting = scored.filter((school) => school.score == null).sort((a, b) => a.name.localeCompare(b.name));
  return [...ready.map((school, index) => ({ ...school, rank: index + 1 })), ...waiting.map((school) => ({ ...school, rank: null }))];
}

// What the person typed. At most ten schools, and only one enrolled.
export function normalizeSchools(input, { today = '', previous = [] } = {}) {
  const raw = Array.isArray(input) ? input : [];
  if (raw.length > 10) throw new Error('You can track up to 10 schools.');
  const prior = new Map((Array.isArray(previous) ? previous : []).filter((school) => school && school.id).map((school) => [school.id, school]));
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    if (!item || typeof item !== 'object') throw new Error('Each school needs a name.');
    const name = String(item.name || '').trim().replace(/\s+/g, ' ').slice(0, 120);
    if (!name) throw new Error('Each school needs a name.');
    const id = schoolSlug(item.id || name);
    if (!id) throw new Error(`"${name.slice(0, 40)}" needs a name Waypoint can store.`);
    if (seen.has(id)) throw new Error(`"${name}" is already on your list.`);
    seen.add(id);
    const status = String(item.status || 'target').trim().toLowerCase();
    if (!SCHOOL_STATUSES.includes(status)) throw new Error('A school is a target, enrolled, or alumni.');
    let state = String(item.state || '').trim().toUpperCase();
    if (state && !/^[A-Z]{2}$/.test(state)) throw new Error('A state is two letters, like CA.');
    const unitid = String(item.unitid || '').trim();
    if (unitid && !/^\d{4,8}$/.test(unitid)) throw new Error('A Unit ID is the school’s IPEDS number, digits only.');
    const before = prior.get(id);
    const kept = ['not_started', 'already_started', 'draft_ready', 'needs_review', 'submitted'].includes(before?.application) ? before.application : 'not_started';
    out.push({
      id,
      name,
      status,
      application: kept,
      ...(state ? { state } : {}),
      ...(unitid ? { unitid } : {}),
      ...(String(item.notes || '').trim() ? { notes: String(item.notes).trim().slice(0, 300) } : {}),
      added_at: before?.added_at || (/^\d{4}-\d{2}-\d{2}$/.test(String(item.added_at || '')) ? String(item.added_at) : today),
    });
  }
  if (out.filter((school) => school.status === 'enrolled').length > 1) throw new Error('Only one school can be enrolled. Mark the others as target or alumni.');
  return out;
}

// The student got in. One school becomes enrolled. A previous enrolled school goes back to target.
export function enrollSchool(schools, schoolId) {
  const id = schoolSlug(schoolId);
  const list = Array.isArray(schools) ? schools : [];
  if (!list.some((school) => school && school.id === id)) throw new Error('That school is not on your list.');
  return list.map((school) => ({
    ...school,
    status: school.id === id ? 'enrolled' : school.status === 'enrolled' ? 'target' : school.status,
  }));
}
