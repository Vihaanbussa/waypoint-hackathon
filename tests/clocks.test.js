// The numbers in the PRD's sample profiles, checked against the clock function.
// Every count is from Nov 18, 2026.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildClocks, overall, countLabel, riskFor, daysBetween, addDays, addYears, formatDate } from '../public/js/clocks.js';
import { PACKS, VISA_TYPES } from '../public/js/rules.js';
import { parseCsv } from '../lib/csv.js';

const TODAY = '2026-11-18';
const seed = JSON.parse(await readFile(new URL('../public/data/seed.json', import.meta.url), 'utf8'));
const person = (id) => seed.profiles.find((p) => p.id === id);
const byId = (clocks, id) => clocks.find((c) => c.id === id);

test('date helpers', () => {
  assert.equal(daysBetween('2026-11-18', '2026-12-01'), 13);
  assert.equal(addDays('2026-12-01', 180), '2027-05-30');
  assert.equal(addYears('2024-10-01', 6), '2030-10-01');
  assert.equal(formatDate('2026-12-01', TODAY), 'Dec 1');
  assert.equal(formatDate('2027-05-30', TODAY), 'May 30, 2027');
});

test('default thresholds: Act now at 14, Watch at 45', () => {
  assert.equal(riskFor(14), 'act');
  assert.equal(riskFor(15), 'watch');
  assert.equal(riskFor(45), 'watch');
  assert.equal(riskFor(46), 'clear');
  assert.equal(riskFor(300, undefined, 'watch'), 'watch');
  assert.equal(riskFor(3, undefined, 'watch'), 'act');
});

test('Priya, F-1 on OPT with a STEM extension pending', () => {
  const clocks = buildClocks(person('priya'), seed, TODAY);

  const card = byId(clocks, 'work_permit_expiry');
  assert.equal(card.due, '2026-12-01');
  assert.equal(card.daysLeft, 13);
  assert.equal(card.risk, 'act');
  assert.match(card.reason, /keep working until May 30, 2027/);
  assert.match(card.reason, /by Dec 1\./);

  const unemployment = byId(clocks, 'unemployment_days');
  assert.deepEqual(unemployment.count, { used: 61, limit: 90, left: 29 });
  assert.equal(unemployment.risk, 'watch');
  assert.equal(unemployment.due, null, 'paused while employed');
  assert.equal(countLabel(unemployment), '29 left');

  const pending = byId(clocks, 'stem_pending_work_end');
  assert.equal(pending.due, '2027-05-30');
  assert.equal(pending.daysLeft, 193);
  assert.equal(pending.risk, 'clear');

  const passport = byId(clocks, 'passport_expiry');
  assert.equal(passport.daysLeft, 275);
  assert.equal(passport.risk, 'clear');

  assert.equal(byId(clocks, 'case-ioe0912345678').name, 'STEM OPT case: "Case Was Received"');
  assert.equal(byId(clocks, 'alert-ds-ruling').risk, 'clear');
  assert.equal(byId(clocks, 'alert-h1b-payment'), undefined, 'H-1B news is not shown to a student');

  assert.deepEqual(overall(clocks), { risk: 'act', nextDays: 13, overdue: 0 });
  assert.equal(clocks[0].id, 'work_permit_expiry', 'most urgent stop first');
  assert.equal(clocks[1].id, 'unemployment_days');
});

test('Wei, H-1B, laid off: same code, different rule pack', () => {
  const clocks = buildClocks(person('wei'), seed, TODAY);

  const address = byId(clocks, 'address_change');
  assert.equal(address.due, '2026-11-24');
  assert.equal(address.daysLeft, 6);
  assert.equal(address.risk, 'act');

  const grace = byId(clocks, 'h1b_grace');
  assert.equal(grace.due, '2026-12-25');
  assert.equal(grace.daysLeft, 37);
  assert.equal(grace.risk, 'watch');
  assert.match(grace.reason, /^Day 23 of 60\. By Dec 25 /);

  assert.equal(byId(clocks, 'i94_expiry').daysLeft, 316);
  const limit = byId(clocks, 'six_year_limit');
  assert.equal(limit.due, '2030-09-30');
  assert.equal(countLabel(limit), 'over 3 years');

  assert.equal(byId(clocks, 'alert-h1b-payment').risk, 'watch');
  assert.equal(byId(clocks, 'work_permit_expiry'), undefined, 'no student clocks on H-1B');
  assert.deepEqual(overall(clocks), { risk: 'act', nextDays: 6, overdue: 0 });
});

test('the grace period stops at the I-94 date when that comes first', () => {
  const clocks = buildClocks({ ...person('wei'), i94_end: '2026-12-10' }, seed, TODAY);
  assert.equal(byId(clocks, 'h1b_grace').due, '2026-12-10');
});

test('a closed clock leaves the route', () => {
  const clocks = buildClocks({ ...person('wei'), address_reported: true }, seed, TODAY);
  assert.equal(byId(clocks, 'address_change'), undefined);
});

test('the live change: a request for evidence adds a stop', () => {
  const store = structuredClone(seed);
  store.case_status.push({
    person: 'priya',
    receipt: 'IOE0912345678',
    title: 'STEM OPT case',
    status: 'Request for Evidence Was Sent',
    last_changed: '2026-11-18',
    response_due: '2027-02-10',
    checked_at: '2026-11-18T19:40:00',
  });
  const clocks = buildClocks(person('priya'), store, TODAY);
  const notice = byId(clocks, 'notice-ioe0912345678');
  assert.equal(notice.daysLeft, 84);
  assert.equal(notice.risk, 'watch', 'an evidence request is at least Watch from day one');
  assert.equal(byId(clocks, 'case-ioe0912345678').name, 'STEM OPT case: "Request for Evidence Was Sent"');
});

test('an overdue deadline is Act now and says so', () => {
  const clocks = buildClocks(person('priya'), seed, '2026-12-04');
  const card = byId(clocks, 'work_permit_expiry');
  assert.equal(card.risk, 'act');
  assert.equal(countLabel(card), '3 days overdue');
  assert.equal(overall(clocks).overdue, 1);
});

test('malformed rows from a hand-edited sheet do not break the brief', () => {
  const store = {
    ...seed,
    case_status: [null, 'oops', { person: 'priya' }, { person: 'priya', receipt: 'X1', response_due: 'soon' }],
    alerts: [{ visa_types: 'f1_opt; j1', title: 'From a sheet', risk: 'YELLOW' }, 42],
    inbox_facts: 'not a table',
    clock_notes: [{ person: 'priya', clock: 'passport_expiry', reason: 'Renew before your winter trip.' }],
  };
  const clocks = buildClocks(person('priya'), store, TODAY);
  assert.equal(byId(clocks, 'alert-from-a-sheet').risk, 'watch');
  assert.equal(byId(clocks, 'passport_expiry').reason, 'Renew before your winter trip.');
  assert.ok(byId(clocks, 'case-x1'));
  assert.equal(byId(clocks, 'notice-x1'), undefined);
});

test('every visa type points at rule packs that exist, with unique rule ids', () => {
  for (const [visa, { packs }] of Object.entries(VISA_TYPES)) {
    const ids = packs.flatMap((p) => {
      assert.ok(PACKS[p], `${visa} uses a missing pack: ${p}`);
      return PACKS[p].rules.map((r) => r.id);
    });
    assert.equal(new Set(ids).size, ids.length, `${visa} has duplicate rule ids`);
  }
});

test('other packs compute from their own fields', () => {
  const j1 = buildClocks({ id: 'x', visa_type: 'j1', program_end: '2026-12-15' }, {}, TODAY);
  assert.equal(byId(j1, 'j1_grace').due, '2027-01-14');
  const gc = buildClocks({ id: 'x', visa_type: 'green_card', conditional_end: '2027-06-01' }, {}, TODAY);
  assert.equal(byId(gc, 'i751_window_opens').due, '2027-03-03');
});

test('csv reader handles quotes, commas and blank lines', () => {
  const rows = parseCsv('bot,summary,at\r\nCase Clerk,"Read status: ""Case Was Received""",2026-11-18T02:03:00\n\nMessenger,"Synced 3 events, sent 1 text",\n');
  assert.deepEqual(rows, [
    { bot: 'Case Clerk', summary: 'Read status: "Case Was Received"', at: '2026-11-18T02:03:00' },
    { bot: 'Messenger', summary: 'Synced 3 events, sent 1 text' },
  ]);
});
