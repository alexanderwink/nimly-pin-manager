import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../src/store.js';
import { createScheduler } from '../src/scheduler.js';

const MIN = 60_000;
const opts = { firstSlot: 3, lastSlot: 20, reserved: [], minLen: 4, maxLen: 8 };
const WED_08_12 = { from: null, until: null, weekly: [{ days: [3], start: '08:00', end: '12:00' }], maxUses: null };

function setup(start) {
  const store = createStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'nimly-')), 'users.json'));
  let now = new Date(start);
  const calls = [];
  const busy = new Set();
  const lock = { apply: (u, d) => calls.push([u.name, d]), deleteUser: (u) => calls.push([u.name, 'delete']), isBusy: (id) => busy.has(id) };
  const sched = createScheduler({ store, lock, clock: () => now, leadMs: 5 * MIN, retryMs: 5 * MIN, graceMs: 2 * MIN });
  const add = (name, pin, patch = {}) => {
    const u = store.add({ name, pin }, opts);
    return store.update(u.id, patch);
  };
  return { store, lock, calls, busy, sched, add, setNow: (s) => { now = new Date(s); } };
}

test('window opening => apply on (5 min early)', () => {
  const t = setup('2026-11-25T07:54');
  const u = t.add('Cleaner', '4829', { access: WED_08_12, applied: 'off' });
  t.sched.tick();
  assert.deepEqual(t.calls, []);
  t.setNow('2026-11-25T07:55');
  t.sched.tick();
  assert.deepEqual(t.calls, [['Cleaner', 'on']]);
  assert.ok(t.store.get(u.id).lastAttemptAt);
});

test('window closing => apply off and offDueAt = window end', () => {
  const t = setup('2026-11-25T12:00');
  const u = t.add('Cleaner', '4829', { access: WED_08_12, applied: 'on' });
  t.sched.tick();
  assert.deepEqual(t.calls, [['Cleaner', 'off']]);
  assert.equal(new Date(t.store.get(u.id).offDueAt).getTime(), new Date('2026-11-25T12:00').getTime());
  assert.equal(t.sched.view(t.store.get(u.id)).overdue, false);
});

test('catch-up after downtime: started 12:30 => off, due 12:00, overdue only if not confirmed within grace of noticing', () => {
  const t = setup('2026-11-25T12:30');
  const u = t.add('Cleaner', '4829', { access: WED_08_12, applied: 'on' });
  t.sched.tick();
  assert.deepEqual(t.calls, [['Cleaner', 'off']]);
  assert.equal(new Date(t.store.get(u.id).offDueAt).getTime(), new Date('2026-11-25T12:00').getTime());
  assert.equal(t.sched.view(t.store.get(u.id)).overdue, false);
  t.setNow('2026-11-25T12:33');
  assert.equal(t.sched.view(t.store.get(u.id)).overdue, true);
});

test('confirmed off is never overdue, even before the next tick', () => {
  const t = setup('2026-11-25T14:00');
  const u = t.add('Cleaner', '4829', { access: WED_08_12, applied: 'on' });
  t.sched.tick();
  t.store.update(u.id, { applied: 'off' });
  t.setNow('2026-11-25T14:10');
  assert.equal(t.sched.view(t.store.get(u.id)).overdue, false);
});

test('failed set (applied unknown) is cleared at window end and stays overdue until confirmed off', () => {
  const t = setup('2026-11-25T12:00');
  const u = t.add('Cleaner', '4829', { access: WED_08_12, applied: 'unknown', syncStatus: 'failed', lastAttemptAt: new Date('2026-11-25T11:50').toISOString() });
  t.sched.tick();
  assert.deepEqual(t.calls, [['Cleaner', 'off']]);
  t.setNow('2026-11-25T12:03');
  assert.equal(t.sched.view(t.store.get(u.id)).overdue, true);
  t.store.update(u.id, { applied: 'off', syncStatus: 'sent' });
  t.sched.tick();
  assert.equal(t.store.get(u.id).offDueAt, null);
  assert.equal(t.sched.view(t.store.get(u.id)).overdue, false);
});

test('retry throttle after failure', () => {
  const t = setup('2026-11-25T09:00');
  const u = t.add('A', '1234', { applied: 'unknown', syncStatus: 'failed', lastAttemptAt: new Date('2026-11-25T08:59').toISOString() });
  t.sched.tick();
  assert.deepEqual(t.calls, []);
  t.setNow('2026-11-25T09:05');
  t.sched.tick();
  assert.deepEqual(t.calls, [['A', 'on']]);
  assert.ok(u);
});

test('offs are queued before ons', () => {
  const t = setup('2026-11-25T12:00');
  t.add('Always', '1111', { applied: 'unknown' });
  t.add('Cleaner', '4829', { access: WED_08_12, applied: 'on' });
  t.sched.tick();
  assert.deepEqual(t.calls, [['Cleaner', 'off'], ['Always', 'on']]);
});

test('failed delete is retried (throttled) and raises the overdue warning', () => {
  const t = setup('2026-11-25T09:00');
  const u = t.add('Gone', '1111', {
    applied: 'on', pendingOp: 'delete', syncStatus: 'failed', lastAttemptAt: new Date('2026-11-25T08:58').toISOString(),
  });
  t.sched.tick();
  assert.deepEqual(t.calls, []); // throttled
  assert.ok(t.store.get(u.id).offDueAt);
  t.setNow('2026-11-25T09:04');
  t.sched.tick();
  assert.deepEqual(t.calls, [['Gone', 'delete']]);
  assert.equal(t.sched.view(t.store.get(u.id)).overdue, true);
});

test('skips users being deleted (in flight) or busy', () => {
  const t = setup('2026-11-25T09:00');
  t.add('Deleting', '1111', { applied: 'unknown', pendingOp: 'delete', syncStatus: 'pending' });
  const b = t.add('Busy', '2222', { applied: 'unknown' });
  t.busy.add(b.id);
  t.sched.tick();
  assert.deepEqual(t.calls, []);
});

test('in sync => nothing sent, no offDueAt', () => {
  const t = setup('2026-11-25T13:00');
  const u = t.add('Cleaner', '4829', { access: WED_08_12, applied: 'off' });
  t.add('Always', '1111', { applied: 'on' });
  t.sched.tick();
  assert.deepEqual(t.calls, []);
  assert.equal(t.store.get(u.id).offDueAt, null);
});

test('used-up single-use code is cleared immediately', () => {
  const t = setup('2026-11-25T09:00');
  const u = t.add('Once', '1357', { access: { maxUses: 1 }, applied: 'on', uses: 1 });
  t.sched.tick();
  assert.deepEqual(t.calls, [['Once', 'off']]);
  assert.equal(t.sched.view(t.store.get(u.id)).accessState, 'expired');
});

test('legacy users without applied get it derived', () => {
  const t = setup('2026-11-25T09:00');
  const a = t.add('On', '1111', { syncStatus: 'verified' });
  const b = t.add('Off', '2222', { enabled: false, syncStatus: 'sent' });
  const c = t.add('Failed', '3333', { syncStatus: 'failed' });
  for (const id of [a.id, b.id, c.id]) t.store.update(id, { applied: undefined });
  t.sched.tick();
  assert.equal(t.store.get(a.id).applied, 'on');
  assert.equal(t.store.get(b.id).applied, 'off');
  assert.equal(t.store.get(c.id).applied, 'unknown');
  assert.deepEqual(t.calls, [['Failed', 'on']]);
});

test('view gives accessState and nextChangeAt', () => {
  const t = setup('2026-11-24T10:00');
  const u = t.add('Cleaner', '4829', { access: WED_08_12, applied: 'off' });
  const v = t.sched.view(t.store.get(u.id));
  assert.equal(v.accessState, 'scheduled');
  assert.equal(new Date(v.nextChangeAt).getTime(), new Date('2026-11-25T07:55').getTime());
  assert.equal(v.overdue, false);
});

test('trigger coalesces into one tick', async () => {
  const t = setup('2026-11-25T09:00');
  t.add('A', '1234', { applied: 'unknown' });
  t.sched.trigger();
  t.sched.trigger();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(t.calls, [['A', 'on']]);
});
