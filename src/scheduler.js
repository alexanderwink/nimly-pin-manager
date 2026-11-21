import { accessState, desiredState, nextChange, offDueSince } from './access.js';

/**
 * Keeps the lock in line with each user's access rules.
 *
 * Every tick it computes what each user's code *should* be (on/off) and compares it
 * with `applied`, what the lock last accepted ('unknown' after a command that may or
 * may not have landed). Differences are queued through the lock's one-at-a-time
 * queue, removals first. Because it compares state rather than firing timed events,
 * it catches up after downtime by itself.
 */
export function createScheduler({
  store, lock, clock = () => new Date(), leadMs, retryMs, graceMs, intervalMs = 60_000, log = () => {},
}) {
  let timer = null;
  let triggered = false;

  function deriveApplied(u) {
    if (u.enabled && (u.syncStatus === 'sent' || u.syncStatus === 'verified')) return 'on';
    if (!u.enabled && u.syncStatus === 'sent') return 'off';
    return 'unknown';
  }

  function tick() {
    const now = clock();
    const deletes = [];
    const offs = [];
    const ons = [];
    const throttledNow = (u) => u.syncStatus === 'failed' && u.lastAttemptAt && now - new Date(u.lastAttemptAt) < retryMs;
    for (let u of store.list()) {
      if (u.applied === undefined) u = store.update(u.id, { applied: deriveApplied(u) });
      if (lock.isBusy(u.id)) continue;

      if (u.pendingOp === 'delete') {
        // Being deleted: the code must go. Warn while it isn't confirmed off; retry failed deletes.
        if (u.applied !== 'off' && !u.offDueAt) {
          u = store.update(u.id, { offDueAt: now.toISOString(), offNoticedAt: now.toISOString() });
        }
        if (u.syncStatus === 'failed' && !throttledNow(u)) deletes.push(u);
        continue;
      }

      const desired = desiredState(u, now, leadMs);

      if (desired === 'off' && u.applied !== 'off') {
        // offDueAt: when it should have gone off (shown to the user).
        // offNoticedAt: when this app noticed; the grace period counts from here.
        if (!u.offDueAt) {
          u = store.update(u.id, { offDueAt: offDueSince(u, now).toISOString(), offNoticedAt: now.toISOString() });
        }
      } else if (u.offDueAt) {
        u = store.update(u.id, { offDueAt: null, offNoticedAt: null });
      }

      if (desired === u.applied) continue;
      if (throttledNow(u)) continue;
      (desired === 'off' ? offs : ons).push(u);
    }
    for (const u of deletes) {
      log(`retrying delete of ${u.name} (slot ${u.slot})`);
      lock.deleteUser(store.update(u.id, { lastAttemptAt: now.toISOString() }));
    }
    for (const u of [...offs, ...ons]) {
      const desired = offs.includes(u) ? 'off' : 'on';
      log(`${u.name} (slot ${u.slot}) should be ${desired}, lock has ${u.applied}`);
      const updated = store.update(u.id, { lastAttemptAt: now.toISOString() });
      lock.apply(updated, desired);
    }
  }

  function isOverdue(u, now) {
    if (!u.offDueAt || u.applied === 'off') return false;
    const since = Math.max(new Date(u.offDueAt).getTime(), new Date(u.offNoticedAt ?? u.offDueAt).getTime());
    return now.getTime() - since > graceMs;
  }

  return {
    tick,

    /** Run a tick soon; several calls in a row result in one tick. */
    trigger() {
      if (triggered) return;
      triggered = true;
      queueMicrotask(() => {
        triggered = false;
        try { tick(); } catch (e) { console.error('scheduler tick failed', e); }
      });
    },

    start() {
      this.trigger();
      timer = setInterval(() => {
        try { tick(); } catch (e) { console.error('scheduler tick failed', e); }
      }, intervalMs);
      timer.unref?.();
    },

    stop() {
      clearInterval(timer);
    },

    /** Derived fields for the UI. */
    view(u) {
      const now = clock();
      const next = nextChange(u, now, leadMs);
      return {
        accessState: accessState(u, now, leadMs),
        nextChangeAt: next ? next.toISOString() : null,
        overdue: isOverdue(u, now),
      };
    },
  };
}
