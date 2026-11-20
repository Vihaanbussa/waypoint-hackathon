// Application facts and how they map onto a school form.
// A Bot may propose a fact or a status. It may not confirm a fact, mark an
// application submitted, or write over one that already has progress.
// shortcut: one field map for every school, split it when a form uses different boxes.

import { DEGREES } from './rules.js';

export const APPLICATION_STATUSES = ['not_started', 'already_started', 'draft_ready', 'needs_review', 'submitted'];

export const APPLICATION_STATUS_LABEL = {
  not_started: 'Not started',
  already_started: 'Already started',
  draft_ready: 'Ready for your review',
  needs_review: 'In review',
  submitted: 'Submitted',
};

export const BANK_SOURCES = ['user', 'document', 'email'];

export const BANK_FIELDS = [
  { id: 'name', label: 'Full name', required: true, max: 80 },
  { id: 'citizenship', label: 'Country of citizenship', required: true, max: 60 },
  { id: 'degree', label: 'Degree', required: true, options: DEGREES },
  { id: 'term', label: 'Start term', required: true, max: 40 },
  { id: 'email', label: 'Email', max: 120 },
  { id: 'address', label: 'Mailing address', max: 200 },
  { id: 'education', label: 'Education', max: 300 },
  { id: 'tests', label: 'Tests', max: 200 },
];

// The box on the form, and which bank fact fills it.
export const FIELD_MAP = BANK_FIELDS.map((field) => ({
  form: field.id,
  bank: field.id,
  label: field.label,
  required: Boolean(field.required),
}));

const WORDS = /^[\p{L}\p{N} .,'&()/#-]+$/u;

function fieldSpec(id) {
  const spec = BANK_FIELDS.find((field) => field.id === id);
  if (!spec) throw new Error(`"field" must be one of: ${BANK_FIELDS.map((field) => field.id).join(', ')}.`);
  return spec;
}

export function readBankValue(field, value) {
  const spec = fieldSpec(field);
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (!text) throw new Error(`Add a value for ${spec.label}.`);
  if (spec.options && !spec.options.includes(text)) throw new Error(`"${spec.label}" must be one of: ${spec.options.join(', ')}.`);
  if (spec.id === 'email' && !/^[^\s@]+@[^\s@]+$/.test(text)) throw new Error('Email needs an @.');
  if (spec.id !== 'email' && !WORDS.test(text)) throw new Error(`"${spec.label}" has characters it cannot have.`);
  return text.slice(0, spec.max ?? 80);
}

// Copy the facts the student just typed. Leaves anything else in the bank alone.
export function syncUserFacts(bank, facts) {
  const next = bank && typeof bank === 'object' ? { ...bank } : {};
  for (const [id, value] of Object.entries(facts || {})) {
    if (!BANK_FIELDS.some((field) => field.id === id)) continue;
    const text = String(value ?? '').trim();
    if (!text) continue;
    next[id] = { value: readBankValue(id, text), source: 'user', confirmed: true };
  }
  return next;
}

export function putBankFact(bank, { field, value, source }, { by }) {
  fieldSpec(field);
  if (!BANK_SOURCES.includes(source)) throw new Error('"source" must be user, document, or email.');
  if (by === 'bot' && source === 'user') throw new Error('A Bot cannot record a fact as something the student typed.');
  const current = bank && typeof bank === 'object' ? bank : {};
  if (by === 'bot' && current[field]?.confirmed) throw new Error('That fact is already confirmed. The student reviews changes in Waypoint.');
  const text = readBankValue(field, value);
  return { ...current, [field]: { value: text, source, confirmed: by === 'student' } };
}

export function setFactConfirmed(bank, field, confirmed) {
  fieldSpec(field);
  const current = bank && typeof bank === 'object' ? bank : {};
  const fact = current[field];
  if (!fact || !String(fact.value || '').trim()) throw new Error('That fact is not in the bank yet.');
  return { ...current, [field]: { ...fact, confirmed: Boolean(confirmed) } };
}

export function applicationDraft(bank) {
  const facts = bank && typeof bank === 'object' ? bank : {};
  const fields = FIELD_MAP.map((row) => {
    const fact = facts[row.bank];
    const ready = Boolean(fact && fact.confirmed === true && String(fact.value || '').trim());
    return {
      form: row.form,
      label: row.label,
      required: row.required,
      value: ready ? String(fact.value) : '',
      source: ready ? fact.source : fact?.source || '',
      confirmed: ready,
      pending: Boolean(fact && !ready && String(fact.value || '').trim()),
      pending_value: fact && !ready ? String(fact.value || '') : '',
    };
  });
  return { fields, missing: fields.filter((field) => field.required && !field.confirmed).map((field) => field.form) };
}

// Server-side status changes. `by` is "bot" or "student".
export function assertProgress(current, next, { by }) {
  const now = APPLICATION_STATUSES.includes(current) ? current : 'not_started';
  if (!APPLICATION_STATUSES.includes(next)) throw new Error(`"status" must be one of: ${APPLICATION_STATUSES.join(', ')}.`);
  if (next === 'submitted' && by !== 'student') throw new Error('Only the student can mark an application submitted.');
  if (by === 'bot' && next === 'needs_review') throw new Error('Review starts when the student looks at the draft.');
  if (by === 'bot' && next === 'draft_ready' && now !== 'not_started' && now !== 'draft_ready') {
    throw new Error('This application already has progress. Waypoint will not write over it.');
  }
  if (by === 'bot' && next === 'already_started' && (now === 'submitted' || now === 'needs_review')) {
    throw new Error('This application already has progress. Waypoint will not write over it.');
  }
  return next;
}
