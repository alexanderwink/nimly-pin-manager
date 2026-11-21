import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

/** Returns an error message, or null when the PIN is acceptable. */
export function validatePin(pin, { minLen = 4, maxLen = 8 } = {}, users = [], excludeId) {
  if (typeof pin !== 'string' || !/^\d+$/.test(pin)) return 'PIN must contain digits only';
  if (pin.length < minLen || pin.length > maxLen) return `PIN must be ${minLen}–${maxLen} digits`;
  if (pin.startsWith('0')) return 'PIN cannot start with 0 (the lock receives it as a number)';
  if (users.some((u) => u.id !== excludeId && u.pin === pin)) return 'Another user already has this PIN';
  return null;
}

export function createStore(filePath) {
  let users = [];
  if (fs.existsSync(filePath)) {
    const raw = fs.readFileSync(filePath, 'utf8');
    try {
      users = JSON.parse(raw);
      if (!Array.isArray(users)) throw new Error('expected an array');
    } catch (e) {
      throw new Error(`Cannot read user data file ${filePath}: ${e.message}`);
    }
  }

  function save() {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmp = `${filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(users, null, 2));
    fs.renameSync(tmp, filePath);
  }

  function find(id) {
    const u = users.find((x) => x.id === id);
    if (!u) throw httpError(404, 'User not found');
    return u;
  }

  return {
    list: () => [...users].sort((a, b) => a.slot - b.slot),
    get: (id) => users.find((u) => u.id === id),

    add({ name, pin }, { firstSlot, lastSlot, reserved = [], minLen, maxLen }) {
      name = typeof name === 'string' ? name.trim() : '';
      if (!name) throw httpError(400, 'Name is required');
      const pinErr = validatePin(pin, { minLen, maxLen }, users);
      if (pinErr) throw httpError(400, pinErr);
      const used = new Set([...users.map((u) => u.slot), ...reserved]);
      let slot = null;
      for (let s = firstSlot; s <= lastSlot; s++) {
        if (!used.has(s)) { slot = s; break; }
      }
      if (slot === null) throw httpError(409, `All PIN slots ${firstSlot}–${lastSlot} are in use`);
      const now = new Date().toISOString();
      const user = {
        id: crypto.randomUUID(), name, slot, pin, enabled: true,
        syncStatus: 'pending', pendingOp: null, lastError: null,
        // Scheduling: access rules, keypad uses, what the lock holds, overdue tracking.
        access: null, uses: 0, applied: 'unknown', offDueAt: null, offNoticedAt: null, lastAttemptAt: null,
        createdAt: now, updatedAt: now,
      };
      users.push(user);
      save();
      return user;
    },

    update(id, patch) {
      const u = find(id);
      Object.assign(u, patch, { updatedAt: new Date().toISOString() });
      save();
      return u;
    },

    remove(id) {
      find(id);
      users = users.filter((u) => u.id !== id);
      save();
    },
  };
}
