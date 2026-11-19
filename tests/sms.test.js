// The Twilio sender on its own: number clean-up, the request it makes, and
// how Twilio's refusals are worded.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createSms, toE164, maskNumber } from '../lib/sms.js';

test('phone numbers are put in the form Twilio wants, or refused', () => {
  assert.equal(toE164('(415) 555-0142'), '+14155550142');
  assert.equal(toE164('1 415 555 0142'), '+14155550142');
  assert.equal(toE164('+44 20 7946 0958'), '+442079460958');
  assert.equal(toE164('555-0142'), null);
  assert.equal(toE164(''), null);
  assert.equal(toE164(undefined), null);
  assert.equal(maskNumber('+14155550142'), 'the number ending 42');
});

test('texting is off until all three settings are there, and says which are missing', async () => {
  const none = createSms({ env: {} });
  assert.equal(none.ready, false);
  assert.deepEqual(none.missing, ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_FROM_NUMBER']);
  await assert.rejects(none.send('+14155550142', 'hi'), /not set up/);

  const part = createSms({ env: { TWILIO_ACCOUNT_SID: 'ACtest', TWILIO_AUTH_TOKEN: 'tok', TWILIO_FROM_NUMBER: 'not a number' } });
  assert.deepEqual(part.missing, ['TWILIO_FROM_NUMBER']);
});

test('a text is one form post to Twilio, signed with the account id and token', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ sid: 'SMtest1', status: 'queued' }), { status: 201 });
  };
  // Pasted with quotes and the NAME= in front, the way settings often arrive.
  const sms = createSms({
    env: { TWILIO_ACCOUNT_SID: '"ACtest"', TWILIO_AUTH_TOKEN: 'TWILIO_AUTH_TOKEN=tok', TWILIO_FROM_NUMBER: '(555) 010-0100' },
    fetchImpl,
  });
  assert.equal(sms.ready, true);
  assert.deepEqual(await sms.send('(415) 555-0142', 'Waypoint: 12 days left.'), { id: 'SMtest1', status: 'queued' });
  assert.equal(calls[0].url, 'https://api.twilio.com/2010-04-01/Accounts/ACtest/Messages.json');
  assert.equal(calls[0].init.headers.Authorization, `Basic ${Buffer.from('ACtest:tok').toString('base64')}`);
  const form = new URLSearchParams(calls[0].init.body);
  assert.equal(form.get('To'), '+14155550142');
  assert.equal(form.get('From'), '+15550100100');
  assert.equal(form.get('Body'), 'Waypoint: 12 days left.');
});

test('Twilio refusals come back as something a person can act on', async () => {
  const answer = (status, body) => async () => new Response(JSON.stringify(body), { status });
  const env = { TWILIO_ACCOUNT_SID: 'ACtest', TWILIO_AUTH_TOKEN: 'tok', TWILIO_FROM_NUMBER: '+15550100100' };
  await assert.rejects(createSms({ env, fetchImpl: answer(400, { code: 21608 }) }).send('+14155550142', 'x'), /trial only texts numbers you have verified/);
  await assert.rejects(createSms({ env, fetchImpl: answer(401, { code: 20003 }) }).send('+14155550142', 'x'), /refused the Account SID or Auth Token/);
  await assert.rejects(createSms({ env, fetchImpl: answer(400, { code: 99999, message: 'Something odd' }) }).send('+14155550142', 'x'), /Something odd/);
  await assert.rejects(
    createSms({
      env,
      fetchImpl: async () => {
        throw new Error('network');
      },
    }).send('+14155550142', 'x'),
    /did not answer/,
  );
  await assert.rejects(createSms({ env }).send('12', 'x'), /not a mobile number/);
});
