import test from 'node:test';
import assert from 'node:assert/strict';
import { httpsSource, normalizeSchools, rankSchools, readSignal, schoolSlug, scoreSchool } from '../public/js/schools.js';

const source = { source_label: 'School site', source_url: 'https://example.edu/isss' };

test('a school slug is stable and a score ignores a post on X as a source', () => {
  assert.equal(schoolSlug('University of California, Berkeley'), 'university-of-california-berkeley');
  assert.equal(httpsSource('https://x.com/Stanford/status/1'), '');
  assert.equal(httpsSource('http://example.edu/isss'), '');
  assert.equal(httpsSource('https://bechtel.stanford.edu/'), 'https://bechtel.stanford.edu/');
});

test('the same signals always produce the same score, and a missing signal is not a zero', () => {
  const full = scoreSchool([
    { signal: 'advisor_ratio', value: 120, ...source },
    { signal: 'isss_office', value: true, ...source },
    { signal: 'cpt_opt', value: true, ...source },
    { signal: 'emergency_fund', value: true, ...source },
    { signal: 'intl_pct', value: 24, ...source },
    { signal: 'sentiment', value: 0.4, ...source },
    { signal: 'state_policy', value: 'supportive', ...source },
    { signal: 'processing_days', value: 5, ...source },
  ]);
  assert.equal(full.score, 93);
  assert.equal(scoreSchool([
    { signal: 'advisor_ratio', value: 120, ...source },
    { signal: 'isss_office', value: true, ...source },
    { signal: 'cpt_opt', value: true, ...source },
    { signal: 'emergency_fund', value: true, ...source },
    { signal: 'intl_pct', value: 24, ...source },
    { signal: 'sentiment', value: 0.4, ...source },
    { signal: 'state_policy', value: 'supportive', ...source },
    { signal: 'processing_days', value: 5, ...source },
  ]).score, 93);
  assert.equal(full.why.length, 5);
  assert.ok(full.why.every((line) => line.source_url.startsWith('https://')));

  const onlyOffice = scoreSchool([{ signal: 'isss_office', value: true, ...source }]);
  assert.equal(onlyOffice.score, 100);
  assert.equal(scoreSchool([]).score, null);
  assert.equal(scoreSchool([{ signal: 'made_up', value: 1 }]).score, null);
});

test('a later signal replaces an earlier one, and a Bot cannot store a score', () => {
  const scored = scoreSchool([
    { signal: 'advisor_ratio', value: 900, at: '2026-11-01T00:00:00Z', ...source },
    { signal: 'advisor_ratio', value: 100, at: '2026-11-18T00:00:00Z', ...source },
  ]);
  assert.equal(scored.score, 100);
  assert.equal(scored.updated_at, '2026-11-18T00:00:00Z');
  assert.throws(() => readSignal('score', 90), /signal/);
  assert.throws(() => readSignal('advisor_ratio', 0), /advisor_ratio/);
  assert.equal(readSignal('state_policy', 'restrictive'), 'restrictive');
});

test('targets are ranked by score, and schools still waiting stay unranked', () => {
  const schools = [
    { id: 'michigan', name: 'University of Michigan', status: 'target', state: 'MI' },
    { id: 'stanford', name: 'Stanford University', status: 'target', state: 'CA' },
    { id: 'berkeley', name: 'UC Berkeley', status: 'enrolled', state: 'CA' },
    { id: 'waiting', name: 'Waiting College', status: 'target' },
  ];
  const signals = [
    { school_id: 'stanford', signal: 'isss_office', value: true, ...source },
    { school_id: 'stanford', signal: 'emergency_fund', value: true, ...source },
    { school_id: 'michigan', signal: 'isss_office', value: true, ...source },
    { school_id: 'michigan', signal: 'emergency_fund', value: false, ...source },
    { school_id: 'berkeley', signal: 'isss_office', value: true, ...source },
  ];
  const ranked = rankSchools(schools, signals);
  assert.deepEqual(ranked.map((school) => [school.id, school.rank, school.score]), [
    ['stanford', 1, 100],
    ['michigan', 2, 60],
    ['waiting', null, null],
  ]);
});

test('a profile keeps at most one enrolled school, and the day it was added', () => {
  assert.throws(
    () => normalizeSchools(
      [
        { name: 'Stanford University', status: 'enrolled' },
        { name: 'UC Berkeley', status: 'enrolled' },
      ],
      { today: '2026-11-19' },
    ),
    /Only one school/,
  );
  const once = normalizeSchools([{ name: 'Stanford University', status: 'target', state: 'ca', unitid: '243744' }], { today: '2026-11-19' });
  assert.equal(once[0].id, 'stanford-university');
  assert.equal(once[0].state, 'CA');
  assert.equal(once[0].unitid, '243744');
  assert.equal(once[0].added_at, '2026-11-19');
  assert.equal(normalizeSchools(once, { today: '2026-11-20', previous: once })[0].added_at, '2026-11-19');
});
