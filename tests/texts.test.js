// The wording of each kind of text. Waypoint writes it; the numbers are its own.

import test from 'node:test';
import assert from 'node:assert/strict';
import { composeText, sayDate, sayDays, TEXT_KINDS } from '../lib/text-kinds.js';

const today = '2026-11-19';
const link = 'https://waypoint.example/';
const permit = { id: 'work_permit_expiry', name: 'Work permit card expires', due: '2026-12-01', daysLeft: 12 };

test('dates and day counts are said the way a person would', () => {
  assert.equal(sayDate('2026-12-01', today), 'Dec 1');
  assert.equal(sayDate('2027-02-10', today), 'Feb 10, 2027');
  assert.equal(sayDays(12), '12 days left');
  assert.equal(sayDays(1), '1 day left');
  assert.equal(sayDays(0), 'due today');
  assert.equal(sayDays(-3), '3 days overdue');
  assert.equal(sayDays(null), '');
});

test('each kind of text says what it is, what to do or by when, and where to look', () => {
  assert.equal(
    composeText('act_now', { clock: permit, today, link, draftWaiting: true }),
    'Waypoint: act now. Work permit card expires: Dec 1, 12 days left. A drafted email is waiting for your approval. Open your brief: https://waypoint.example/',
  );
  assert.equal(
    composeText('reminder', { clock: { name: 'Unemployment days: 61 of 90 used', due: null, daysLeft: 29 }, today, link }),
    'Waypoint reminder. Unemployment days: 61 of 90 used, 29 days left. See what to do: https://waypoint.example/',
  );
  assert.equal(
    composeText('status_change', { caseRow: { status: 'Request for Evidence Was Sent', response_due: '2027-02-10' }, clock: { due: '2027-02-10', daysLeft: 83 }, today, link }),
    'Waypoint: your case status changed to "Request for Evidence Was Sent". Respond by Feb 10, 2027 (83 days left). See what it means: https://waypoint.example/',
  );
  assert.equal(
    composeText('approval', { waiting: 2, today, link }),
    'Waypoint: 2 emails are waiting for your approval. Nothing is sent until you approve. Review: https://waypoint.example/',
  );
  assert.equal(
    composeText('rule_change', { clock: { name: 'Rule change: duration of status stays' }, today, link }),
    'Waypoint: a rule change may affect you: duration of status stays. See why: https://waypoint.example/',
  );
  assert.equal(
    composeText('problem', { bot: 'Case Clerk', today }),
    'Waypoint: Case Clerk could not finish its check, so your deadlines show the last good check. Details are in your Waypoint brief.',
  );
  for (const kind of Object.keys(TEXT_KINDS)) assert.match(TEXT_KINDS[kind].trial, /^sms_[a-z_]+$/);
});

test('a kind that lacks what it needs says so instead of sending something vague', () => {
  assert.throws(() => composeText('act_now', { today, link }), /deadline_id/);
  assert.throws(() => composeText('approval', { waiting: 0, today }), /No emails are waiting/);
  assert.throws(() => composeText('status_change', { today }), /No case status/);
  assert.throws(() => composeText('problem', { today }), /which Bot/);
  assert.throws(() => composeText('party', { today }), /must be one of/);
});
