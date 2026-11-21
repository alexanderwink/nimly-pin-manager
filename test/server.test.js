import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../src/store.js';
import { createApp } from '../src/server.js';

let server, base, store;
const calls = [];
const fakeLock = {
  status: { connected: true, state: 'LOCK', num_pin_users: 5 },
  deleteUser: (u) => calls.push(['delete', u.id]),
  setState: (s) => {
    if (s !== 'LOCK' && s !== 'UNLOCK') { const e = new Error('bad state'); e.status = 400; throw e; }
    calls.push(['state', s]);
  },
};

const fakeScheduler = {
  trigger: () => calls.push(['trigger']),
  view: (u) => ({ accessState: u.access ? 'scheduled' : 'always', nextChangeAt: null, overdue: u.name === 'Late' }),
};
const triggered = (n) => calls.slice(n).some((c) => c[0] === 'trigger');

before(async () => {
  store = createStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'nimly-')), 'users.json'));
  const app = createApp({ store, lock: fakeLock, scheduler: fakeScheduler, config: { firstSlot: 3, lastSlot: 999, reserved: [901] } });
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const req = async (method, url, body) => {
  const res = await fetch(base + url, {
    method, headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};

test('status reports usable slots: 3..(num_pin_users-1) minus reserved', async () => {
  const r = await req('GET', '/api/status');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.slots, { first: 3, last: 4, total: 2 });
  assert.equal(r.body.lock.state, 'LOCK');
});

let userId;
test('POST valid user => 201 and scheduler triggered', async () => {
  const n = calls.length;
  const r = await req('POST', '/api/users', { name: 'Anna', pin: '1234' });
  assert.equal(r.status, 201);
  assert.equal(r.body.slot, 3);
  assert.equal(r.body.applied, 'unknown');
  userId = r.body.id;
  assert.ok(triggered(n));
});

test('POST with invalid access => 400 and nothing created', async () => {
  const before = store.list().length;
  const r = await req('POST', '/api/users', { name: 'X', pin: '5555', access: { maxUses: 0 } });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /Max uses/);
  assert.equal(store.list().length, before);
});

test('POST bad pin => 400', async () => {
  const r = await req('POST', '/api/users', { name: 'X', pin: '12' });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /digits/);
});

test('POST with access stores it; POST when full => 409', async () => {
  const access = { from: null, until: null, weekly: [{ days: [3], start: '08:00', end: '12:00' }], maxUses: null };
  const b = await req('POST', '/api/users', { name: 'B', pin: '2345', access });
  assert.equal(b.status, 201);
  assert.deepEqual(b.body.access, access);
  assert.equal(b.body.accessState, 'scheduled');
  const r = await req('POST', '/api/users', { name: 'C', pin: '3456' });
  assert.equal(r.status, 409);
});

test('PATCH name only => no trigger', async () => {
  const n = calls.length;
  const r = await req('PATCH', `/api/users/${userId}`, { name: 'Anna B' });
  assert.equal(r.status, 200);
  assert.equal(r.body.name, 'Anna B');
  assert.equal(triggered(n), false);
});

test('PATCH pin while code is on => applied unknown + trigger; invalid pin => 400', async () => {
  store.update(userId, { applied: 'on' });
  const n = calls.length;
  let r = await req('PATCH', `/api/users/${userId}`, { pin: '7777' });
  assert.equal(r.status, 200);
  assert.equal(r.body.applied, 'unknown');
  assert.ok(triggered(n));
  r = await req('PATCH', `/api/users/${userId}`, { pin: '2345' }); // belongs to B
  assert.equal(r.status, 400);
});

test('PATCH pin while code is off keeps applied off', async () => {
  store.update(userId, { applied: 'off' });
  const r = await req('PATCH', `/api/users/${userId}`, { pin: '7778' });
  assert.equal(r.body.applied, 'off');
});

test('PATCH enabled => stored + trigger', async () => {
  const n = calls.length;
  const r = await req('PATCH', `/api/users/${userId}`, { enabled: false });
  assert.equal(r.body.enabled, false);
  assert.ok(triggered(n));
});

test('PATCH access validates, stores and resets uses', async () => {
  store.update(userId, { uses: 3 });
  let r = await req('PATCH', `/api/users/${userId}`, { access: { weekly: [{ days: [9], start: '08:00', end: '09:00' }] } });
  assert.equal(r.status, 400);
  r = await req('PATCH', `/api/users/${userId}`, { access: { maxUses: 2 } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.access, { maxUses: 2 });
  assert.equal(r.body.uses, 0);
  r = await req('PATCH', `/api/users/${userId}`, { access: null });
  assert.equal(r.body.access, null);
});

test('resend => 202, applied unknown, throttle reset, trigger', async () => {
  store.update(userId, { applied: 'off', lastAttemptAt: new Date().toISOString(), syncStatus: 'failed' });
  const n = calls.length;
  const r = await req('POST', `/api/users/${userId}/resend`);
  assert.equal(r.status, 202);
  assert.equal(store.get(userId).applied, 'unknown');
  assert.equal(store.get(userId).lastAttemptAt, null);
  assert.ok(triggered(n));
});

test('users list includes view fields; status counts overdue', async () => {
  store.update(userId, { name: 'Late' });
  const users = (await req('GET', '/api/users')).body;
  const late = users.find((u) => u.id === userId);
  assert.equal(late.accessState, 'always');
  assert.equal(late.overdue, true);
  assert.equal((await req('GET', '/api/status')).body.overdueCount, 1);
});

test('DELETE => 202 + deleteUser', async () => {
  const r = await req('DELETE', `/api/users/${userId}`);
  assert.equal(r.status, 202);
  assert.deepEqual(calls.at(-1), ['delete', userId]);
});

test('PATCH pin/enabled on a user being deleted => 409, rename allowed', async () => {
  store.update(userId, { pendingOp: 'delete' });
  assert.equal((await req('PATCH', `/api/users/${userId}`, { enabled: true })).status, 409);
  assert.equal((await req('PATCH', `/api/users/${userId}`, { pin: '8888' })).status, 409);
  assert.equal((await req('PATCH', `/api/users/${userId}`, { access: { maxUses: 1 } })).status, 409);
  assert.equal((await req('PATCH', `/api/users/${userId}`, { name: 'Gone' })).status, 200);
});

test('unknown id => 404', async () => {
  assert.equal((await req('PATCH', '/api/users/nope', { name: 'x' })).status, 404);
  assert.equal((await req('DELETE', '/api/users/nope')).status, 404);
  assert.equal((await req('POST', '/api/users/nope/resend')).status, 404);
});

test('POST /api/lock', async () => {
  assert.equal((await req('POST', '/api/lock', { state: 'UNLOCK' })).status, 202);
  assert.equal((await req('POST', '/api/lock', { state: 'OPEN' })).status, 400);
});
