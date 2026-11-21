import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore, validatePin } from '../src/store.js';

const opts = { firstSlot: 3, lastSlot: 5, reserved: [], minLen: 4, maxLen: 8 };
const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'nimly-')), 'sub', 'users.json');

test('add assigns lowest free slot from firstSlot', () => {
  const s = createStore(tmpFile());
  assert.equal(s.add({ name: 'A', pin: '1234' }, opts).slot, 3);
  const b = s.add({ name: 'B', pin: '2345' }, opts);
  assert.equal(b.slot, 4);
  assert.equal(b.enabled, true);
  assert.equal(b.syncStatus, 'pending');
});

test('add after remove reuses slot', () => {
  const s = createStore(tmpFile());
  const a = s.add({ name: 'A', pin: '1234' }, opts);
  s.add({ name: 'B', pin: '2345' }, opts);
  s.remove(a.id);
  assert.equal(s.add({ name: 'C', pin: '3456' }, opts).slot, 3);
});

test('add throws status 409 when all slots in range used', () => {
  const s = createStore(tmpFile());
  s.add({ name: 'A', pin: '1234' }, opts);
  s.add({ name: 'B', pin: '2345' }, opts);
  s.add({ name: 'C', pin: '3456' }, opts);
  assert.throws(() => s.add({ name: 'D', pin: '4567' }, opts), (e) => e.status === 409);
});

test('reserved slots are skipped and lastSlot is respected', () => {
  const s = createStore(tmpFile());
  const o = { ...opts, firstSlot: 900, lastSlot: 902, reserved: [901] };
  assert.equal(s.add({ name: 'A', pin: '1234' }, o).slot, 900);
  assert.equal(s.add({ name: 'B', pin: '2345' }, o).slot, 902);
  assert.throws(() => s.add({ name: 'C', pin: '3456' }, o), (e) => e.status === 409);
});

test('validatePin rules', () => {
  const users = [{ id: 'x', pin: '9999' }];
  const l = { minLen: 4, maxLen: 8 };
  for (const bad of ['12a4', '123', '123456789', '0123', '9999', '', undefined]) {
    assert.ok(validatePin(bad, l, users), `expected error for ${bad}`);
  }
  assert.equal(validatePin('1234', l, users), null);
  assert.equal(validatePin('9999', l, users, 'x'), null);
});

test('add rejects invalid pin with status 400; duplicate name allowed', () => {
  const s = createStore(tmpFile());
  s.add({ name: 'A', pin: '1234' }, opts);
  assert.throws(() => s.add({ name: 'B', pin: '1234' }, opts), (e) => e.status === 400);
  assert.throws(() => s.add({ name: '  ', pin: '5555' }, opts), (e) => e.status === 400);
  assert.equal(s.add({ name: 'A', pin: '5555' }, opts).slot, 4);
});

test('persists and reloads from disk', () => {
  const f = tmpFile();
  const s = createStore(f);
  const a = s.add({ name: 'A', pin: '1234' }, opts);
  s.update(a.id, { syncStatus: 'sent' });
  const s2 = createStore(f);
  assert.equal(s2.list().length, 1);
  assert.equal(s2.get(a.id).syncStatus, 'sent');
});

test('missing file => empty list', () => {
  assert.deepEqual(createStore(tmpFile()).list(), []);
});

test('corrupt file => throws with path, file untouched', () => {
  const f = tmpFile();
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, '{oops');
  assert.throws(() => createStore(f), (e) => e.message.includes(f));
  assert.equal(fs.readFileSync(f, 'utf8'), '{oops');
});

test('update/remove unknown id => 404', () => {
  const s = createStore(tmpFile());
  assert.throws(() => s.update('nope', {}), (e) => e.status === 404);
  assert.throws(() => s.remove('nope'), (e) => e.status === 404);
});
