# Schedules, Temporary Codes and Container Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Per-user access limits (period, weekly windows, max uses), enforced by a reconcile loop that sets and clears PINs on the lock, with overdue-removal warnings, packaged as a Docker Compose service.

**Architecture:** A pure `src/access.js` computes desired state and labels from rules and a clock. `src/scheduler.js` reconciles desired against `applied` every 60 s through the existing one-at-a-time lock queue. `src/lock.js` gains `apply(user, 'on'|'off')`, tracking of `applied`, and use counting. The server routes all lock changes through the scheduler.

**Tech Stack:** Node 22/23 ESM, express 5, mqtt 5, node:test; Docker (`node:22-alpine`) + Compose.

**Spec:** `docs/2026-11-21-schedules-design.md` (base app: `docs/2026-11-21-nimly-pin-manager-design.md`)

## Global Constraints
- Not a git repo: no commit steps.
- Local wall-clock strings `YYYY-MM-DDTHH:MM` are parsed with `new Date(str)`, which reads them as local time. Weekly windows are built with `setHours` on local dates, so DST is handled.
- Defaults: `SCHEDULE_LEAD_MINUTES=5`, `RETRY_MINUTES=5`, `OVERDUE_GRACE_MINUTES=2`, tick 60 s.
- `applied` ∈ `on|off|unknown`. Sent ⇒ desired value. A failure after publish (error, timeout or connection lost) ⇒ `unknown`. Not published at all (MQTT down, master slot) ⇒ unchanged.
- Off-commands are queued before on-commands within one tick.
- `days`: 0=Sun … 6=Sat; window `start < end` (`HH:MM`), no midnight crossing.

## Review Focus
1. A timed-out *set* that actually landed must still be cleared at the end, with a warning until confirmed. Test in Task 3.
2. Catch-up after downtime: the app starts at 12:30 for a 08–12 window with `applied: on` ⇒ clear queued and `offDueAt` = 12:00 that day. Test in Task 3.
3. DST: the Wed 08:00 window on the day after a DST change still opens at local 08:00. Test in Task 1, using `TZ=Europe/Stockholm` in the npm test script.
4. A PIN change while on ⇒ new PIN sent. Test in Task 4.
5. A single-use code: a keypad unlock ⇒ uses=1 ⇒ immediate clear. A stray unlock while `applied: off` doesn't count. Test in Task 2/3.

---

### Task 1: `src/access.js` (pure rules)

**Files:** Create `src/access.js`, `test/access.test.js`; modify `package.json` test script to `TZ=Europe/Stockholm node --test`.

**Produces:**
- `validateAccess(access) -> string|null`. `null`/`undefined` is valid (always). Checks: `from`/`until` parse; `from < until`; `weekly` is an array of `{days: int[] in 0..6 non-empty, start, end}` with `HH:MM` and `start < end`; `maxUses` null or int ≥ 1.
- `desiredState(user, now: Date, leadMs) -> 'on'|'off'` (rules exactly as the design's "Desired state").
- `isExpired(user, now) -> boolean` (`until <= now`, or `maxUses != null && uses >= maxUses`).
- `nextChange(user, now, leadMs) -> Date|null`. Evaluates candidates (`from-lead`, `until`, each window `start-lead` and `end` for the next 8 days) in order, and returns the first where `desiredState` differs from now.
- `offDueSince(user, now) -> Date`. If disabled or uses exhausted ⇒ `now`. Otherwise the latest of `until` (if ≤ now) and the most recent window end ≤ now within 8 days; else `now`.
- `accessState(user, now, leadMs) -> 'disabled'|'always'|'active'|'scheduled'|'expired'`.

- [ ] Tests:
  - no access ⇒ on;
  - disabled ⇒ off;
  - Wed 08–12: Wed 07:54 off, 07:55 on (lead 5), 11:59 on, 12:00 off, Thu 09:00 off;
  - period: before `from - lead` off, inside on, at `until` off;
  - period + weekly combined;
  - `maxUses` 1 with uses 1 ⇒ off and expired;
  - `nextChange` for Wed 08–12 at Tue 10:00 ⇒ Wed 07:55;
  - `offDueSince` at Wed 12:30 ⇒ Wed 12:00;
  - DST: Wed 2026-10-28 (after the 25 Oct change) window opens at local 07:55;
  - `validateAccess` rejects bad dates, `from >= until`, day 7, `start >= end`, `maxUses` 0.
- [ ] Run ⇒ FAIL; implement; run ⇒ PASS.

### Task 2: lock.js — `apply`, `applied`, uses

**Files:** Modify `src/lock.js`, `test/lock.test.js`.

**Produces:**
- `lock.apply(user, desired: 'on'|'off')`: on ⇒ set PIN, off ⇒ clear (payload as today). Queue entries carry `desired`.
- `lock.isBusy(id) -> boolean` (queued or inflight).
- `syncUser(user)` stays as `apply(user, user.enabled ? 'on' : 'off')`.
- On resolve:
  - ok ⇒ `applied: desired`;
  - fail after publish ⇒ `applied: 'unknown'`, `lastAttemptAt` is set by the scheduler.
  - The delete path is unchanged.
- `createLock({..., onUse})`: a keypad unlock for a slot whose user has `applied === 'on'` and no pendingOp ⇒ `uses += 1` (store) and `onUse(user)` is called. Verification now requires `applied === 'on'` instead of `enabled`.
- `connectionLost()` ⇒ inflight fails ⇒ `unknown`.

- [ ] Tests:
  - `apply(u,'off')` publishes `pin_code: null`; ok ⇒ `applied 'off'`;
  - set timeout ⇒ `applied 'unknown'`;
  - not connected ⇒ `applied` unchanged;
  - keypad unlock with `applied on` ⇒ uses 1 and onUse called;
  - with `applied off` ⇒ uses unchanged;
  - `isBusy` true while queued.
- [ ] Update existing tests that rely on `enabled` for verification.
- [ ] FAIL ⇒ implement ⇒ PASS.

### Task 3: `src/scheduler.js` (reconciler)

**Files:** Create `src/scheduler.js`, `test/scheduler.test.js`.

**Consumes:** access.js, `lock.apply/isBusy`, store.

**Produces:**
- `createScheduler({store, lock, clock = () => new Date(), leadMs, retryMs, graceMs, intervalMs = 60000})` returning `{tick(), trigger(), start(), stop(), view(user) -> {accessState, nextChangeAt, overdue}}`.
- `tick()`:
  - First, normalize legacy users: if `applied` is undefined ⇒ `on` if enabled and sent or verified, `off` if disabled and sent, else `unknown`.
  - Then for users with no `pendingOp === 'delete'` and not `lock.isBusy`, compute desired:
    - If desired is off and applied ≠ off and no `offDueAt` ⇒ `offDueAt = offDueSince(...)`.
    - If applied === desired, or desired is on ⇒ `offDueAt = null` (only clear it when applied is off or desired is on).
    - If desired ≠ applied and not throttled (throttled = `syncStatus === 'failed' && now - lastAttemptAt < retryMs`) ⇒ collect.
  - Queue the offs first, then the ons, each with `lastAttemptAt = now` and `lock.apply`.
- `trigger()` runs `tick` on the next microtask, coalescing repeated calls.
- `overdue = offDueAt && now - offDueAt > graceMs`.

- [ ] Tests with a fake lock (records `apply` calls, `isBusy` false) and a fake clock:
  - Wed 07:55 ⇒ apply on;
  - Wed 12:00 with `applied on` ⇒ apply off and `offDueAt` 12:00;
  - catch-up at 12:30 ⇒ off and `offDueAt` 12:00, overdue true after 12:02;
  - failed set ⇒ `applied unknown` at window end ⇒ off queued and overdue;
  - throttle: failed 1 min ago ⇒ no apply; failed 6 min ago ⇒ apply;
  - offs queued before ons;
  - user being deleted ⇒ skipped;
  - legacy user without `applied` ⇒ derived;
  - `applied off` + desired off ⇒ no apply and `offDueAt` null.
- [ ] FAIL ⇒ implement ⇒ PASS.

### Task 4: server + index wiring

**Files:** Modify `src/store.js` (add defaults: `access: null, uses: 0, applied: 'unknown', offDueAt: null, lastAttemptAt: null, pendingOp: null`), `src/server.js`, `src/index.js`, `test/server.test.js`, `test/store.test.js`.

**Produces:** `createApp({store, lock, scheduler, config})`:
- POST accepts `access` (validated ⇒ 400) and calls `scheduler.trigger()`; there is no direct `syncUser`.
- PATCH:
  - `access` ⇒ validate, set, `uses: 0`;
  - `pin` change with `applied !== 'off'` ⇒ `applied: 'unknown'`;
  - `enabled` ⇒ store only;
  - then `trigger()`.
  - The 409-on-delete rule stays, and also covers `access`.
- Resend: delete ⇒ `lock.deleteUser`; otherwise `applied: 'unknown', lastAttemptAt: null` then `trigger()`.
- `GET /api/users` merges `scheduler.view(u)`.
- `GET /api/status` adds `overdueCount`.

`index.js`:
- env for lead, retry and grace;
- `scheduler.start()`; `onUse ⇒ scheduler.trigger()`;
- log `Intl.DateTimeFormat().resolvedOptions().timeZone` and warn if it is `UTC` and `TZ` is unset;
- data-dir write check at startup (mkdir, write and remove `.write-test`; on failure log the path and `process.exit(1)`);
- `MQTT_URL` default unchanged.

- [ ] Tests (fake scheduler records `trigger` and returns a fixed view):
  - POST with valid access ⇒ 201 and trigger; invalid ⇒ 400;
  - PATCH pin while `applied on` ⇒ `applied unknown`;
  - PATCH access resets uses;
  - users list includes `accessState`;
  - status `overdueCount`;
  - existing tests adapted (trigger instead of sync).
- [ ] FAIL ⇒ implement ⇒ PASS. E2E against the fake z2m: add a user with a window covering now ⇒ on; PATCH the window into the past ⇒ cleared.

### Task 5: UI

**Files:** Modify `public/index.html`, `public/app.js`, `public/style.css`.

- Shared `accessEditor(container, access) -> { get(): access|null }`:
  - Always/Limited radio;
  - Limited: `datetime-local` from and until; weekly rows (7 day toggle chips Mon-first, start and end `time` inputs, remove button); "+ Add weekly time"; max uses (blank = unlimited).
- The add form gets the editor (default Always). Each card gets an **Access** button that opens a dialog with the editor and saves via PATCH.
- Card summary line, e.g. `Wed 08:00–12:00 · 1 Dec 07:00 → 12 Dec 16:00 · 1 use left`, plus a state badge:
  - Active
  - Scheduled · next Wed 26/11 08:00
  - Expired
  - Disabled
- Overdue line: "Should have been removed at HH:MM, not confirmed". Page banner when `overdueCount > 0`.
- [ ] Verify with Playwright at 390 px and 1100 px: no horizontal scroll, no console errors; screenshot reviewed.

### Task 6: Container + docs

**Files:** Create `Dockerfile`, `docker-compose.yml`, `.dockerignore`; modify `README.md`, `.env.example`.

- **Dockerfile:**
  - `node:22-alpine`, `WORKDIR /app`, copy package files, `npm ci --omit=dev`, copy `src` and `public`;
  - `RUN mkdir -p /app/data && chown node:node /app/data`, `USER node`, `ENV NODE_ENV=production`, `EXPOSE 3000`, `VOLUME /app/data`;
  - `HEALTHCHECK` using `wget -qO- http://127.0.0.1:3000/api/status`;
  - `CMD ["node","src/index.js"]`.
- **Compose:** service `nimly`, `build: .`, `restart: unless-stopped`, `env_file: .env`, `environment: TZ: Europe/Stockholm`, `volumes: ./data:/app/data`, `ports: "3000:3000"`.
- **README:**
  - deploy steps, including `chown 1000:1000 data`;
  - the three `MQTT_URL` options;
  - never run two instances;
  - no login ⇒ trusted network or proxy with auth;
  - a section on access rules and statuses.
- [ ] If Docker is available locally: `docker compose build` and run against the fake broker. Otherwise ledger that it was not verified.
