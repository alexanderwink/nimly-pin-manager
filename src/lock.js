import { httpError } from './store.js';

// Slots 000–002 hold the lock's master codes. The app must never write to them.
export const MASTER_SLOTS = [0, 1, 2];

const STATUS_FIELDS = [
  'state', 'lock_state', 'battery', 'voltage', 'last_unlock_user', 'last_unlock_source',
  'last_lock_user', 'last_lock_source', 'num_pin_users', 'min_pin_length', 'max_pin_length',
  'sound_volume', 'auto_relock', 'linkquality',
];

/**
 * Talks to a Nimly lock through zigbee2mqtt and tracks the sync state of each user.
 * zigbee2mqtt has no explicit acknowledgement for PIN commands, so a command is
 * marked 'sent' when the lock publishes state afterwards, 'failed' when the bridge
 * logs an error mentioning the lock or after `timeoutMs`. That is not proof the code
 * works: a user becomes 'verified' only when the lock reports a keypad unlock by
 * their slot.
 *
 * The Nimly firmware ignores the user-status field of setPinCode, so a disabled user
 * is cleared from the lock (the app keeps the PIN) and re-sent when enabled again.
 */
export function createLock({ mqtt, baseTopic, lockName, store, timeoutMs = 15000, log = () => {}, onUse = () => {}, onSettled = () => {} }) {
  const deviceTopic = `${baseTopic}/${lockName}`;
  const loggingTopic = `${baseTopic}/bridge/logging`;
  // Commands are sent one at a time: zigbee2mqtt responses do not say which
  // slot they belong to, so only one command may be awaiting a response.
  let queue = []; // { id, op, desired, pin, slot, payload, expectCleared }
  let inflight = null; // { id, op, desired, pin, slot, expectCleared, timer, before }
  // A failed 'set' is no longer pending; a failed delete stays marked so it is retried.
  const failedOp = (op) => (op === 'delete' ? 'delete' : null);
  const isBusy = (id) => inflight?.id === id || queue.some((q) => q.id === id);
  const info = { lastSeen: null };
  let lastUsers = {}; // z2m's cached per-slot map; repeated in every state message, kept out of status (contains PINs)
  const slotKey = (slot) => JSON.stringify(lastUsers[slot] ?? lastUsers[String(slot)] ?? null);

  function resolve(ok, message) {
    const cmd = inflight;
    if (!cmd) return;
    clearTimeout(cmd.timer);
    inflight = null;
    // A newer command for the same user is queued: still record what the lock now
    // (probably) holds, but leave the status to that newer command.
    const superseded = queue.some((q) => q.id === cmd.id);
    if (store.get(cmd.id)) {
      if (!ok) {
        // The command was published, so it may still have reached the sleepy lock.
        store.update(cmd.id, {
          applied: 'unknown',
          ...(superseded ? {} : { syncStatus: 'failed', pendingOp: failedOp(cmd.op), lastError: message }),
        });
      } else if (cmd.op === 'delete' && !superseded) {
        store.remove(cmd.id);
      } else {
        // If the PIN changed while this command was on its way, the lock holds the old one.
        const stalePin = cmd.desired === 'on' && store.get(cmd.id).pin !== cmd.pin;
        store.update(cmd.id, {
          applied: stalePin ? 'unknown' : cmd.desired,
          ...(superseded ? {} : { syncStatus: 'sent', pendingOp: null, lastError: null, verifiedAt: null }),
        });
      }
    }
    pump();
    onSettled();
  }

  function pump() {
    while (!inflight && queue.length) {
      const cmd = queue.shift();
      if (!store.get(cmd.id)) continue;
      if (!mqtt.connected) {
        store.update(cmd.id, { syncStatus: 'failed', pendingOp: failedOp(cmd.op), lastError: 'MQTT not connected' });
        continue;
      }
      mqtt.publish(`${deviceTopic}/set`, JSON.stringify(cmd.payload));
      const timer = setTimeout(() => resolve(false, 'No response from lock'), timeoutMs);
      timer.unref?.();
      inflight = { id: cmd.id, op: cmd.op, desired: cmd.desired, pin: cmd.pin, slot: cmd.slot, expectCleared: cmd.expectCleared, timer, before: slotKey(cmd.slot) };
    }
  }

  function send(user, op, desired, payload) {
    const expectCleared = desired === 'off';
    queue = queue.filter((q) => q.id !== user.id);
    if (MASTER_SLOTS.includes(Number(user.slot))) {
      store.update(user.id, { syncStatus: 'failed', pendingOp: failedOp(op), lastError: `Slot ${user.slot} is a master slot and is never written` });
      return;
    }
    if (!mqtt.connected) {
      store.update(user.id, { syncStatus: 'failed', pendingOp: failedOp(op), lastError: 'MQTT not connected' });
      return;
    }
    store.update(user.id, { syncStatus: 'pending', pendingOp: op, lastError: null });
    queue.push({ id: user.id, op, desired, pin: user.pin, slot: user.slot, payload, expectCleared });
    pump();
  }

  const pinPayload = (slot, enabled, pin) => ({
    pin_code: { user: slot, user_type: 'unrestricted', user_enabled: enabled, pin_code: pin },
  });

  function onDeviceMessage(msg) {
    for (const f of STATUS_FIELDS) if (f in msg) info[f] = msg[f];
    info.lastSeen = new Date().toISOString();
    const users = msg.users && typeof msg.users === 'object' ? msg.users : null;
    if (users) lastUsers = users;
    // Checked before resolving the inflight command, so a user whose command is still
    // in flight cannot be verified by this message.
    if (msg.action === 'unlock' && msg.action_source_name === 'keypad') keypadUnlock(Number(msg.action_user));
    if (!inflight) return;
    const entry = users?.[inflight.slot] ?? users?.[String(inflight.slot)];
    // Only an entry that changed since the command was sent says anything about this command;
    // an unchanged one is z2m's cache being repeated, so treat the message as a plain state report.
    if (!entry || JSON.stringify(entry) === inflight.before) return resolve(true);
    const cleared = entry.status === 'available';
    if (inflight.expectCleared === cleared) resolve(true);
    else resolve(false, `Lock reports slot ${inflight.slot} as "${entry.status}"`);
  }

  /**
   * A keypad unlock by `slot` proves that slot's code is on the lock right now. It always
   * counts as a use (so max-uses can't be dodged) and, if the app believed otherwise,
   * corrects `applied` to 'on' so the scheduler clears it again when it shouldn't be there.
   */
  function keypadUnlock(slot) {
    const u = store.list().find((x) => x.slot === slot);
    if (!u) return;
    const busy = isBusy(u.id); // a command in flight decides `applied` when it lands
    const patch = { uses: (u.uses ?? 0) + 1 };
    if (!busy && u.applied === 'on' && (u.syncStatus === 'sent' || u.syncStatus === 'verified')) {
      Object.assign(patch, { syncStatus: 'verified', verifiedAt: new Date().toISOString() });
    }
    if (!busy && u.applied !== 'on') patch.applied = 'on';
    onUse(store.update(u.id, patch));
  }

  function onLogging(msg) {
    if (msg.level !== 'error' || typeof msg.message !== 'string') return;
    if (!msg.message.includes(`'${lockName}'`)) return; // z2m quotes friendly names
    resolve(false, msg.message);
  }

  return {
    get status() {
      return { connected: !!mqtt.connected, lockName, ...info };
    },

    start() {
      mqtt.subscribe(deviceTopic);
      mqtt.subscribe(loggingTopic);
      mqtt.on('message', (topic, buf) => {
        let msg;
        try { msg = JSON.parse(buf.toString()); } catch { return; }
        if (!msg || typeof msg !== 'object') return;
        if (topic === deviceTopic) onDeviceMessage(msg);
        else if (topic === loggingTopic) onLogging(msg);
      });
      this.refresh();
    },

    refresh() {
      if (mqtt.connected) mqtt.publish(`${deviceTopic}/get`, JSON.stringify({ state: '' }));
    },

    /** Call when the MQTT connection drops: the inflight command may have been lost. */
    connectionLost() {
      resolve(false, 'MQTT connection lost');
    },

    stop() {
      if (inflight) clearTimeout(inflight.timer);
      inflight = null;
      queue = [];
    },

    /** Puts the user's PIN on the lock ('on') or clears their slot ('off'). */
    apply(user, desired) {
      if (desired === 'on') {
        log(`set slot ${user.slot} (${user.name})`);
        send(user, 'set', 'on', pinPayload(user.slot, true, Number(user.pin)));
      } else {
        log(`clear slot ${user.slot} (${user.name})`);
        send(user, 'set', 'off', pinPayload(user.slot, false, null));
      }
    },

    /** Brings the lock in line with the manual switch only (no schedule). */
    syncUser(user) {
      this.apply(user, user.enabled ? 'on' : 'off');
    },

    deleteUser(user) {
      log(`clear slot ${user.slot} (${user.name}, delete)`);
      send(user, 'delete', 'off', pinPayload(user.slot, false, null));
    },

    /** True while a command for this user is queued or awaiting the lock. */
    isBusy,

    setState(state) {
      if (state !== 'LOCK' && state !== 'UNLOCK') throw httpError(400, 'state must be LOCK or UNLOCK');
      if (!mqtt.connected) throw httpError(503, 'MQTT not connected');
      mqtt.publish(`${deviceTopic}/set`, JSON.stringify({ state }));
    },
  };
}
