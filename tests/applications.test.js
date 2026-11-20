import test from 'node:test';
import assert from 'node:assert/strict';
import { applicationDraft, assertProgress, putBankFact, syncUserFacts } from '../public/js/applications.js';
import { enrollSchool, normalizeSchools } from '../public/js/schools.js';

test('a draft uses only confirmed facts, and a Bot cannot confirm, overwrite, or submit', () => {
  const bank = syncUserFacts({}, { name: 'Noor Shah', citizenship: 'India', degree: "Master's", term: 'Fall 2027' });
  assert.equal(applicationDraft(bank).missing.length, 0);
  assert.equal(applicationDraft(bank).fields.find((field) => field.form === 'address').confirmed, false);

  const proposed = putBankFact(bank, { field: 'address', value: '1 Main Street', source: 'email' }, { by: 'bot' });
  assert.equal(proposed.address.confirmed, false);
  assert.equal(applicationDraft(proposed).fields.find((field) => field.form === 'address').value, '');
  assert.throws(() => putBankFact(bank, { field: 'citizenship', value: 'France', source: 'email' }, { by: 'bot' }), /confirmed/);
  assert.throws(() => putBankFact(bank, { field: 'tests', value: 'GRE 325', source: 'user' }, { by: 'bot' }), /student typed/);
  assert.throws(() => putBankFact({}, { field: 'email', value: 'not-an-email', source: 'document' }, { by: 'bot' }), /@/);

  assert.equal(assertProgress('not_started', 'draft_ready', { by: 'bot' }), 'draft_ready');
  assert.throws(() => assertProgress('already_started', 'draft_ready', { by: 'bot' }), /already has progress/);
  assert.throws(() => assertProgress('submitted', 'draft_ready', { by: 'bot' }), /already has progress/);
  assert.throws(() => assertProgress('not_started', 'submitted', { by: 'bot' }), /student/);
  assert.equal(assertProgress('draft_ready', 'submitted', { by: 'student' }), 'submitted');
});

test('picking a school enrolls that one and keeps application progress', () => {
  const schools = normalizeSchools(
    [
      { name: 'Stanford University', status: 'target' },
      { name: 'University of Michigan', status: 'target' },
    ],
    { today: '2026-11-19' },
  );
  schools[1].application = 'submitted';
  const again = normalizeSchools(schools, { today: '2026-11-20', previous: schools });
  assert.equal(again[1].application, 'submitted');
  const enrolled = enrollSchool(again, 'stanford-university');
  assert.equal(enrolled.find((school) => school.id === 'stanford-university').status, 'enrolled');
  assert.equal(enrolled.find((school) => school.id === 'university-of-michigan').status, 'target');
  assert.throws(() => enrollSchool(enrolled, 'missing'), /not on your list/);
});
