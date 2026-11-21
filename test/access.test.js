import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateAccess, desiredState, isExpired, nextChange, offDueSince, accessState,
} from '../src/access.js';

// Tests run with TZ=Europe/Stockholm (see package.json). Local wall-clock strings below.
const at = (s) => new Date(s);
const LEAD = 5 * 60_000;
const user = (access, extra = {}) => ({ enabled: true, uses: 0, access, ...extra });
const cleaner = user({ from: null, until: null, weekly: [{ days: [3], start: '08:00', end: '12:00' }], maxUses: null });
// 2026-11-25 is a Wednesday

test('no access => on; disabled => off', () => {
  assert.equal(desiredState(user(null), at('2026-11-25T03:00'), LEAD), 'on');
  assert.equal(desiredState(user(null, { enabled: false }), at('2026-11-25T03:00'), LEAD), 'off');
  assert.equal(accessState(user(null), at('2026-11-25T03:00'), LEAD), 'always');
  assert.equal(accessState(user(null, { enabled: false }), at('2026-11-25T03:00'), LEAD), 'disabled');
});

test('weekly Wed 08-12 with 5 min lead', () => {
  const d = (s) => desiredState(cleaner, at(s), LEAD);
  assert.equal(d('2026-11-25T07:54'), 'off');
  assert.equal(d('2026-11-25T07:55'), 'on');
  assert.equal(d('2026-11-25T11:59'), 'on');
  assert.equal(d('2026-11-25T12:00'), 'off');
  assert.equal(d('2026-11-26T09:00'), 'off');
  assert.equal(accessState(cleaner, at('2026-11-25T09:00'), LEAD), 'active');
  assert.equal(accessState(cleaner, at('2026-11-24T09:00'), LEAD), 'scheduled');
});

test('window starting just after midnight opens the evening before', () => {
  const u = user({ weekly: [{ days: [4], start: '00:02', end: '01:00' }] });
  assert.equal(desiredState(u, at('2026-11-25T23:57'), LEAD), 'on');
  assert.equal(desiredState(u, at('2026-11-25T23:56'), LEAD), 'off');
});

test('period from/until', () => {
  const u = user({ from: '2026-12-01T07:00', until: '2026-12-12T16:00', weekly: [], maxUses: null });
  const d = (s) => desiredState(u, at(s), LEAD);
  assert.equal(d('2026-12-01T06:54'), 'off');
  assert.equal(d('2026-12-01T06:55'), 'on');
  assert.equal(d('2026-12-05T03:00'), 'on');
  assert.equal(d('2026-12-12T15:59'), 'on');
  assert.equal(d('2026-12-12T16:00'), 'off');
  assert.equal(isExpired(u, at('2026-12-12T16:00')), true);
  assert.equal(accessState(u, at('2026-12-13T00:00'), LEAD), 'expired');
});

test('period combined with weekly working hours', () => {
  const u = user({ from: '2026-12-01T00:00', until: '2026-12-12T23:59', weekly: [{ days: [1, 2, 3, 4, 5], start: '07:00', end: '16:00' }] });
  assert.equal(desiredState(u, at('2026-12-02T10:00'), LEAD), 'on'); // Wed, inside
  assert.equal(desiredState(u, at('2026-12-02T17:00'), LEAD), 'off'); // Wed, after hours
  assert.equal(desiredState(u, at('2026-12-06T10:00'), LEAD), 'off'); // Sunday
  assert.equal(desiredState(u, at('2026-11-25T10:00'), LEAD), 'off'); // before period
});

test('max uses', () => {
  const u = user({ maxUses: 1 }, { uses: 0 });
  assert.equal(desiredState(u, at('2026-11-25T10:00'), LEAD), 'on');
  const used = { ...u, uses: 1 };
  assert.equal(desiredState(used, at('2026-11-25T10:00'), LEAD), 'off');
  assert.equal(isExpired(used, at('2026-11-25T10:00')), true);
  assert.equal(accessState(used, at('2026-11-25T10:00'), LEAD), 'expired');
});

test('nextChange', () => {
  assert.deepEqual(nextChange(cleaner, at('2026-11-24T10:00'), LEAD), at('2026-11-25T07:55'));
  assert.deepEqual(nextChange(cleaner, at('2026-11-25T09:00'), LEAD), at('2026-11-25T12:00'));
  assert.equal(nextChange(user(null), at('2026-11-25T09:00'), LEAD), null);
  const expired = user({ until: '2026-11-20T10:00' });
  assert.equal(nextChange(expired, at('2026-11-25T09:00'), LEAD), null);
});

test('nextChange finds the first window after a start date far ahead', () => {
  const u = user({ from: '2026-12-20T00:00', until: null, weekly: [{ days: [3], start: '08:00', end: '12:00' }] });
  assert.deepEqual(nextChange(u, at('2026-11-25T13:00'), LEAD), at('2026-12-23T07:55'));
});

test('offDueSince', () => {
  assert.deepEqual(offDueSince(cleaner, at('2026-11-25T12:30')), at('2026-11-25T12:00'));
  const period = user({ until: '2026-11-25T16:00' });
  assert.deepEqual(offDueSince(period, at('2026-11-25T18:00')), at('2026-11-25T16:00'));
  const now = at('2026-11-25T10:00');
  assert.deepEqual(offDueSince(user(null, { enabled: false }), now), now);
  assert.deepEqual(offDueSince(user({ maxUses: 1 }, { uses: 1 }), now), now);
});

test('DST: Wednesday window after the October change still opens at local 07:55', () => {
  // DST ended Sun 2026-10-25 in Europe/Stockholm
  assert.equal(desiredState(cleaner, at('2026-10-28T07:54'), LEAD), 'off');
  assert.equal(desiredState(cleaner, at('2026-10-28T07:55'), LEAD), 'on');
  assert.deepEqual(nextChange(cleaner, at('2026-10-27T10:00'), LEAD), at('2026-10-28T07:55'));
  // and across the spring change (Sun 2027-03-28)
  assert.equal(desiredState(cleaner, at('2027-03-31T07:55'), LEAD), 'on');
});

test('validateAccess', () => {
  assert.equal(validateAccess(null), null);
  assert.equal(validateAccess(undefined), null);
  assert.equal(validateAccess({ from: '2026-12-01T07:00', until: '2026-12-02T07:00', weekly: [{ days: [0, 6], start: '08:00', end: '09:30' }], maxUses: 3 }), null);
  const bad = [
    { from: 'nope' },
    { until: '2026-13-45T99:00' },
    { from: '2026-12-02T07:00', until: '2026-12-01T07:00' },
    { weekly: [{ days: [7], start: '08:00', end: '09:00' }] },
    { weekly: [{ days: [], start: '08:00', end: '09:00' }] },
    { weekly: [{ days: [1], start: '12:00', end: '08:00' }] },
    { weekly: [{ days: [1], start: '8', end: '09:00' }] },
    { weekly: 'wed' },
    { maxUses: 0 },
    { until: '2026-02-30T23:00' },
    { from: '2026-11-25T24:00' },
    { maxUses: 1.5 },
    'always',
  ];
  for (const b of bad) assert.ok(validateAccess(b), `expected error for ${JSON.stringify(b)}`);
});
