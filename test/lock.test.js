import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../src/store.js';
import { createLock } from '../src/lock.js';

const opts = { firstSlot: 3, lastSlot: 7, reserved: [], minLen: 4, maxLen: 8 };

function setup({ connected = true, timeoutMs = 1000, onUse, onSettled } = {}) {
  const mqtt = new EventEmitter();
  mqtt.connected = connected;
  mqtt.published = [];
  mqtt.subscribed = [];
  mqtt.publish = (topic, payload) => mqtt.published.push({ topic, payload: JSON.parse(payload) });
  mqtt.subscribe = (topic) => mqtt.subscribed.push(topic);
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'nimly-')), 'users.json');
  const store = createStore(file);
  const lock = createLock({ mqtt, baseTopic: 'zigbee2mqtt', lockName: 'door', store, timeoutMs, onUse, onSettled });
  lock.start();
  const send = (topic, obj) => mqtt.emit('message', topic, Buffer.from(JSON.stringify(obj)));
  return { mqtt, store, lock, send };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('start subscribes and requests state', () => {
  const { mqtt } = setup();
  assert.ok(mqtt.subscribed.includes('zigbee2mqtt/door'));
  assert.ok(mqtt.subscribed.includes('zigbee2mqtt/bridge/logging'));
  assert.deepEqual(mqtt.published[0], { topic: 'zigbee2mqtt/door/get', payload: { state: '' } });
});

test('syncUser publishes exact payload to zigbee2mqtt/door/set', () => {
  const { mqtt, store, lock } = setup();
  const u = store.add({ name: 'A', pin: '1234' }, opts);
  lock.syncUser(u);
  assert.deepEqual(mqtt.published.at(-1), {
    topic: 'zigbee2mqtt/door/set',
    payload: { pin_code: { user: 3, user_type: 'unrestricted', user_enabled: true, pin_code: '1234' } },
  });
  assert.equal(store.get(u.id).syncStatus, 'pending');
  lock.stop();
});

test('device state after set => sent', () => {
  const { store, lock, send } = setup();
  const u = store.add({ name: 'A', pin: '1234' }, opts);
  lock.syncUser(u);
  send('zigbee2mqtt/door', { state: 'LOCK', battery: 80 });
  assert.equal(store.get(u.id).syncStatus, 'sent');
  assert.equal(store.get(u.id).pendingOp, null);
});

test('stale cached users map does not fail a command; changed entry decides', () => {
  const { store, lock, send } = setup();
  // z2m caches every slot it has seen and repeats the whole map in every state message
  send('zigbee2mqtt/door', { users: { 3: { status: 'available' } } });
  const u = store.add({ name: 'A', pin: '1234' }, opts);
  lock.syncUser(u);
  send('zigbee2mqtt/door', { battery: 80, users: { 3: { status: 'available' } } });
  assert.equal(store.get(u.id).syncStatus, 'sent');
  lock.deleteUser(store.get(u.id));
  send('zigbee2mqtt/door', { users: { 3: { status: 'enabled', pin_code: '1234' } } });
  assert.equal(store.get(u.id).syncStatus, 'failed', 'changed entry contradicting delete => failed');
});

test('changed users entry for the slot confirms', () => {
  const { store, lock, send } = setup();
  const u = store.add({ name: 'A', pin: '1234' }, opts);
  lock.syncUser(u);
  send('zigbee2mqtt/door', { users: { 3: { status: 'enabled', pin_code: '1234' } } });
  assert.equal(store.get(u.id).syncStatus, 'sent');
});

test('connection lost while command inflight => failed, reconnect state does not confirm it', () => {
  const { mqtt, store, lock, send } = setup();
  const u = store.add({ name: 'A', pin: '1234' }, opts);
  lock.syncUser(u);
  mqtt.connected = false;
  lock.connectionLost();
  assert.equal(store.get(u.id).syncStatus, 'failed');
  assert.equal(store.get(u.id).lastError, 'MQTT connection lost');
  mqtt.connected = true;
  send('zigbee2mqtt/door', { state: 'LOCK' });
  assert.equal(store.get(u.id).syncStatus, 'failed');
});

test('bridge error mentioning lock => failed with message', () => {
  const { store, lock, send } = setup();
  const u = store.add({ name: 'A', pin: '1234' }, opts);
  lock.syncUser(u);
  send('zigbee2mqtt/bridge/logging', { level: 'error', message: "Publish 'set' 'pin_code' to 'door' failed: timeout" });
  assert.equal(store.get(u.id).syncStatus, 'failed');
  assert.match(store.get(u.id).lastError, /timeout/);
});

test('bridge error for other device is ignored', () => {
  const { store, lock, send } = setup();
  const u = store.add({ name: 'A', pin: '1234' }, opts);
  lock.syncUser(u);
  send('zigbee2mqtt/bridge/logging', { level: 'error', message: "Publish 'set' to 'kitchen' failed" });
  assert.equal(store.get(u.id).syncStatus, 'pending');
  lock.stop();
});

test('timeout => failed', async () => {
  const { store, lock } = setup({ timeoutMs: 20 });
  const u = store.add({ name: 'A', pin: '1234' }, opts);
  lock.syncUser(u);
  await wait(50);
  assert.equal(store.get(u.id).syncStatus, 'failed');
  assert.equal(store.get(u.id).lastError, 'No response from lock');
});

test('deleteUser + state => user removed from store', () => {
  const { mqtt, store, lock, send } = setup();
  const u = store.add({ name: 'A', pin: '1234' }, opts);
  lock.deleteUser(u);
  assert.deepEqual(mqtt.published.at(-1).payload, {
    pin_code: { user: 3, user_type: 'unrestricted', user_enabled: false, pin_code: null },
  });
  assert.equal(store.get(u.id).pendingOp, 'delete');
  send('zigbee2mqtt/door', { state: 'LOCK' });
  assert.equal(store.get(u.id), undefined);
});

test('disconnected => failed immediately, nothing published', () => {
  const { mqtt, store, lock } = setup({ connected: false });
  const before = mqtt.published.length;
  const u = store.add({ name: 'A', pin: '1234' }, opts);
  lock.syncUser(u);
  assert.equal(mqtt.published.length, before);
  assert.equal(store.get(u.id).syncStatus, 'failed');
  assert.equal(store.get(u.id).lastError, 'MQTT not connected');
});

test('state message updates status', () => {
  const { lock, send } = setup();
  send('zigbee2mqtt/door', { state: 'UNLOCK', battery: 55, last_unlock_user: 3, last_unlock_source: 'keypad', num_pin_users: 50 });
  assert.equal(lock.status.state, 'UNLOCK');
  assert.equal(lock.status.battery, 55);
  assert.equal(lock.status.last_unlock_user, 3);
  assert.equal(lock.status.num_pin_users, 50);
  assert.ok(lock.status.lastSeen);
  assert.equal(lock.status.connected, true);
});

test('setState publishes and rejects bad values', () => {
  const { mqtt, lock } = setup();
  lock.setState('UNLOCK');
  assert.deepEqual(mqtt.published.at(-1), { topic: 'zigbee2mqtt/door/set', payload: { state: 'UNLOCK' } });
  assert.throws(() => lock.setState('OPEN'), (e) => e.status === 400);
});

test('commands are sent one at a time so responses are attributed correctly', () => {
  const { mqtt, store, lock, send } = setup();
  const a = store.add({ name: 'A', pin: '1234' }, opts);
  const b = store.add({ name: 'B', pin: '2345' }, opts);
  lock.syncUser(a);
  lock.syncUser(b);
  const sets = () => mqtt.published.filter((p) => p.topic.endsWith('/set'));
  assert.equal(sets().length, 1, 'second command must wait');
  assert.equal(store.get(b.id).syncStatus, 'pending');
  send('zigbee2mqtt/bridge/logging', { level: 'error', message: "Publish 'set' 'pin_code' to 'door' failed" });
  assert.equal(store.get(a.id).syncStatus, 'failed');
  assert.equal(store.get(b.id).syncStatus, 'pending');
  assert.equal(sets().length, 2);
  assert.equal(sets()[1].payload.pin_code.user, 4);
  send('zigbee2mqtt/door', { state: 'LOCK' });
  assert.equal(store.get(b.id).syncStatus, 'sent');
  assert.equal(store.get(a.id).syncStatus, 'failed');
});

test('re-sending a queued user replaces its queued command', () => {
  const { mqtt, store, lock, send } = setup();
  const a = store.add({ name: 'A', pin: '1234' }, opts);
  const b = store.add({ name: 'B', pin: '2345' }, opts);
  lock.syncUser(a);
  lock.syncUser(b);
  lock.deleteUser(store.get(b.id));
  send('zigbee2mqtt/door', { state: 'LOCK' });
  const sets = mqtt.published.filter((p) => p.topic.endsWith('/set'));
  assert.equal(sets.length, 2);
  assert.equal(sets[1].payload.pin_code.pin_code, null);
  send('zigbee2mqtt/door', { state: 'LOCK' });
  assert.equal(store.get(b.id), undefined);
});

test('never sends commands to master slots 0-2', () => {
  const { mqtt, store, lock } = setup();
  const before = mqtt.published.length;
  const u = store.add({ name: 'A', pin: '1234' }, { ...opts, firstSlot: 0 });
  assert.equal(u.slot, 0);
  lock.syncUser(u);
  lock.deleteUser(store.get(u.id));
  assert.equal(mqtt.published.length, before);
  assert.equal(store.get(u.id).syncStatus, 'failed');
  assert.match(store.get(u.id).lastError, /master/);
});

test('disabling a user clears the code on the lock but keeps it in the app', () => {
  const { mqtt, store, lock, send } = setup();
  const u = store.add({ name: 'A', pin: '1234' }, opts);
  const disabled = store.update(u.id, { enabled: false });
  lock.syncUser(disabled);
  assert.deepEqual(mqtt.published.at(-1).payload, {
    pin_code: { user: 3, user_type: 'unrestricted', user_enabled: false, pin_code: null },
  });
  send('zigbee2mqtt/door', { state: 'LOCK' });
  assert.equal(store.get(u.id).syncStatus, 'sent');
  assert.equal(store.get(u.id).pin, '1234');
  // a cleared slot reported by z2m confirms a disable instead of failing it
  const again = store.get(u.id);
  lock.syncUser(again);
  send('zigbee2mqtt/door', { users: { 3: { status: 'available' } } });
  assert.equal(store.get(u.id).syncStatus, 'sent');
  // re-enabling sends the stored PIN again
  lock.syncUser(store.update(u.id, { enabled: true }));
  assert.equal(mqtt.published.at(-1).payload.pin_code.pin_code, '1234');
});

test('keypad unlock by a sent user marks it verified', () => {
  const { store, lock, send } = setup();
  const u = store.add({ name: 'A', pin: '1234' }, opts);
  lock.syncUser(u);
  send('zigbee2mqtt/door', { state: 'LOCK' });
  send('zigbee2mqtt/door', { state: 'UNLOCK', action: 'unlock', action_user: 3, action_source_name: 'keypad', last_unlock_user: '3' });
  assert.equal(store.get(u.id).syncStatus, 'verified');
  assert.ok(store.get(u.id).verifiedAt);
});

test('fingerprint unlock, stale last_unlock_user, or pending user do not verify', () => {
  const { store, lock, send } = setup();
  const a = store.add({ name: 'A', pin: '1234' }, opts);
  lock.syncUser(a);
  send('zigbee2mqtt/door', { state: 'LOCK' });
  send('zigbee2mqtt/door', { action: 'unlock', action_user: 3, action_source_name: 'fingerprintsensor' });
  send('zigbee2mqtt/door', { last_unlock_user: '3', last_unlock_source: 'keypad' });
  assert.equal(store.get(a.id).syncStatus, 'sent');
  const b = store.add({ name: 'B', pin: '2345' }, opts);
  lock.syncUser(b);
  // unlock arrives while B's command is in flight: confirms the command, but B is not yet verified
  send('zigbee2mqtt/door', { action: 'unlock', action_user: 4, action_source_name: 'keypad' });
  assert.equal(store.get(b.id).syncStatus, 'sent');
});

test('disabled user is never verified', () => {
  const { store, lock, send } = setup();
  const u = store.add({ name: 'A', pin: '1234' }, opts);
  lock.syncUser(store.update(u.id, { enabled: false }));
  send('zigbee2mqtt/door', { state: 'LOCK' });
  send('zigbee2mqtt/door', { action: 'unlock', action_user: 3, action_source_name: 'keypad' });
  assert.equal(store.get(u.id).syncStatus, 'sent');
});

test('apply off clears the slot and records applied off', () => {
  const { mqtt, store, lock, send } = setup();
  const u = store.add({ name: 'A', pin: '1234' }, opts);
  lock.apply(u, 'off');
  assert.equal(mqtt.published.at(-1).payload.pin_code.pin_code, null);
  send('zigbee2mqtt/door', { state: 'LOCK' });
  assert.equal(store.get(u.id).applied, 'off');
  lock.apply(store.get(u.id), 'on');
  assert.equal(mqtt.published.at(-1).payload.pin_code.pin_code, '1234');
  send('zigbee2mqtt/door', { state: 'LOCK' });
  assert.equal(store.get(u.id).applied, 'on');
});

test('failure after publish => applied unknown; not published => applied unchanged', async () => {
  const t = setup({ timeoutMs: 20 });
  const u = t.store.add({ name: 'A', pin: '1234' }, opts);
  t.store.update(u.id, { applied: 'off' });
  t.lock.apply(t.store.get(u.id), 'on');
  await wait(50);
  assert.equal(t.store.get(u.id).applied, 'unknown');

  const d = setup({ connected: false });
  const v = d.store.add({ name: 'B', pin: '2345' }, opts);
  d.store.update(v.id, { applied: 'off' });
  d.lock.apply(d.store.get(v.id), 'on');
  assert.equal(d.store.get(v.id).applied, 'off');
});

test('connection lost while inflight => applied unknown', () => {
  const { store, lock } = setup();
  const u = store.add({ name: 'A', pin: '1234' }, opts);
  store.update(u.id, { applied: 'on' });
  lock.apply(store.get(u.id), 'off');
  lock.connectionLost();
  assert.equal(store.get(u.id).applied, 'unknown');
});

test('isBusy while queued or inflight', () => {
  const { store, lock, send } = setup();
  const a = store.add({ name: 'A', pin: '1234' }, opts);
  const b = store.add({ name: 'B', pin: '2345' }, opts);
  assert.equal(lock.isBusy(a.id), false);
  lock.apply(a, 'on');
  lock.apply(b, 'on');
  assert.equal(lock.isBusy(a.id), true);
  assert.equal(lock.isBusy(b.id), true);
  send('zigbee2mqtt/door', { state: 'LOCK' });
  assert.equal(lock.isBusy(a.id), false);
  assert.equal(lock.isBusy(b.id), true);
});

test('keypad unlock proves the code is live: counts a use and marks it on even if the app thought off', () => {
  const used = [];
  const { store, lock, send } = setup({ onUse: (u) => used.push(u.id) });
  const u = store.add({ name: 'A', pin: '1234' }, opts);
  lock.apply(u, 'on');
  send('zigbee2mqtt/door', { state: 'LOCK' });
  send('zigbee2mqtt/door', { action: 'unlock', action_user: 3, action_source_name: 'keypad' });
  assert.equal(store.get(u.id).uses, 1);
  assert.deepEqual(used, [u.id]);
  assert.equal(store.get(u.id).syncStatus, 'verified');
  // the app believes the code is off, but the lock says it was just used
  store.update(u.id, { applied: 'off' });
  send('zigbee2mqtt/door', { action: 'unlock', action_user: 3, action_source_name: 'keypad' });
  assert.equal(store.get(u.id).uses, 2);
  assert.equal(store.get(u.id).applied, 'on');
  // counted while unknown too
  store.update(u.id, { applied: 'unknown' });
  send('zigbee2mqtt/door', { action: 'unlock', action_user: 3, action_source_name: 'keypad' });
  assert.equal(store.get(u.id).uses, 3);
  assert.equal(used.length, 3);
});

test('a failed set clears pendingOp; a failed delete keeps it', async () => {
  const d = setup({ connected: false });
  const a = d.store.add({ name: 'A', pin: '1234' }, opts);
  d.lock.apply(a, 'on');
  assert.equal(d.store.get(a.id).pendingOp, null);
  d.lock.deleteUser(d.store.get(a.id));
  assert.equal(d.store.get(a.id).pendingOp, 'delete');

  const t = setup({ timeoutMs: 20 });
  const b = t.store.add({ name: 'B', pin: '2345' }, opts);
  t.lock.apply(b, 'on');
  await wait(50);
  assert.equal(t.store.get(b.id).pendingOp, null);
  assert.equal(t.store.get(b.id).syncStatus, 'failed');
});

test('PIN changed while its command is in flight => applied unknown after it lands', () => {
  const { store, lock, send } = setup();
  const u = store.add({ name: 'A', pin: '1234' }, opts);
  lock.apply(u, 'on');
  store.update(u.id, { pin: '5678' });
  send('zigbee2mqtt/door', { state: 'LOCK' });
  assert.equal(store.get(u.id).applied, 'unknown');
});

test('onSettled is called after each command resolves', () => {
  let n = 0;
  const { store, lock, send } = setup({ onSettled: () => { n += 1; } });
  const u = store.add({ name: 'A', pin: '1234' }, opts);
  lock.apply(u, 'on');
  send('zigbee2mqtt/door', { state: 'LOCK' });
  assert.equal(n, 1);
});

test('malformed message does not crash', () => {
  const { mqtt } = setup();
  mqtt.emit('message', 'zigbee2mqtt/door', Buffer.from('not json'));
});

test('PIN with a leading zero is sent as a string', () => {
  const { mqtt, store, lock } = setup();
  const u = store.add({ name: 'A', pin: '0123' }, opts);
  lock.syncUser(u);
  assert.equal(mqtt.published.at(-1).payload.pin_code.pin_code, '0123');
  lock.stop();
});
