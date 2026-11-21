import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { httpError, validatePin } from './store.js';
import { validateAccess } from './access.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

/**
 * HTTP API. Changes to users are stored and then handed to the scheduler, which
 * decides what the lock should hold; only delete and resend-of-delete talk to the
 * lock directly.
 */
export function createApp({ store, lock, scheduler, config }) {
  const app = express();
  app.use(express.json());
  app.use(express.static(PUBLIC_DIR));

  const limits = () => ({
    firstSlot: config.firstSlot,
    // Slots are 0-based on the lock, so num_pin_users N means the highest slot is N-1.
    lastSlot: lock.status.num_pin_users
      ? Math.min(config.lastSlot, lock.status.num_pin_users - 1)
      : config.lastSlot,
    reserved: config.reserved ?? [],
    minLen: lock.status.min_pin_length ?? 4,
    maxLen: lock.status.max_pin_length ?? 8,
  });
  const mustGet = (id) => {
    const u = store.get(id);
    if (!u) throw httpError(404, 'User not found');
    return u;
  };
  const withView = (u) => (u ? { ...u, ...scheduler.view(u) } : null);
  const checkAccess = (access) => {
    const err = validateAccess(access);
    if (err) throw httpError(400, err);
  };

  app.get('/api/status', (_req, res) => {
    const l = limits();
    const reservedInRange = new Set(l.reserved.filter((s) => s >= l.firstSlot && s <= l.lastSlot)).size;
    const total = Math.max(0, l.lastSlot - l.firstSlot + 1 - reservedInRange);
    const overdueCount = store.list().filter((u) => scheduler.view(u).overdue).length;
    res.json({
      lock: lock.status, slots: { first: l.firstSlot, last: l.lastSlot, total }, pin: { min: l.minLen, max: l.maxLen }, overdueCount,
      scheduleLeadMinutes: (config.leadMs ?? 0) / 60_000,
    });
  });

  app.get('/api/users', (_req, res) => res.json(store.list().map(withView)));

  app.post('/api/users', (req, res) => {
    const access = req.body?.access ?? null;
    checkAccess(access);
    const user = store.add({ name: req.body?.name, pin: req.body?.pin }, limits());
    if (access) store.update(user.id, { access });
    scheduler.trigger();
    res.status(201).json(withView(store.get(user.id)));
  });

  app.patch('/api/users/:id', (req, res) => {
    const user = mustGet(req.params.id);
    const body = req.body ?? {};
    const { name, pin, enabled } = body;
    if ((pin !== undefined || enabled !== undefined || 'access' in body) && user.pendingOp === 'delete') {
      throw httpError(409, 'This user is being deleted. Retry or finish the delete first.');
    }
    const patch = {};
    if (name !== undefined) {
      if (typeof name !== 'string' || !name.trim()) throw httpError(400, 'Name is required');
      patch.name = name.trim();
    }
    if (pin !== undefined && pin !== user.pin) {
      const l = limits();
      const err = validatePin(pin, l, store.list(), user.id);
      if (err) throw httpError(400, err);
      patch.pin = pin;
      // The old PIN may be on the lock: make sure the new one gets sent.
      if (user.applied !== 'off') patch.applied = 'unknown';
    }
    if (enabled !== undefined && enabled !== user.enabled) {
      if (typeof enabled !== 'boolean') throw httpError(400, 'enabled must be true or false');
      patch.enabled = enabled;
    }
    if ('access' in body) {
      checkAccess(body.access);
      patch.access = body.access ?? null;
      patch.uses = 0;
    }
    store.update(user.id, patch);
    if ('pin' in patch || 'enabled' in patch || 'access' in patch) scheduler.trigger();
    res.json(withView(store.get(user.id)));
  });

  app.delete('/api/users/:id', (req, res) => {
    lock.deleteUser(mustGet(req.params.id));
    res.status(202).json(withView(store.get(req.params.id)));
  });

  app.post('/api/users/:id/resend', (req, res) => {
    const user = mustGet(req.params.id);
    if (user.pendingOp === 'delete') {
      lock.deleteUser(user);
    } else {
      // Forget what we think the lock holds and skip the retry wait: resend now.
      store.update(user.id, { applied: 'unknown', lastAttemptAt: null });
      scheduler.trigger();
    }
    res.status(202).json(withView(store.get(user.id)));
  });

  app.post('/api/lock', (req, res) => {
    lock.setState(req.body?.state);
    res.status(202).json({ ok: true });
  });

  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    const status = err.status ?? (err.type === 'entity.parse.failed' ? 400 : 500);
    if (status >= 500) console.error(err);
    res.status(status).json({ error: err.message });
  });

  return app;
}
