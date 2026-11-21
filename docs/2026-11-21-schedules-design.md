# Schedules, temporary codes and container deployment — design

Status: draft for approval (2026-11-21)
Builds on: `docs/2026-11-21-nimly-pin-manager-design.md` and the app as it is now (`src/store.js`, `src/lock.js`, `src/server.js`, `public/`).

## Intent and why

The owner wants to give people door codes that only work when they should:

- **Cleaner:** every Wednesday 08:00–12:00, indefinitely.
- **Carpenter:** between a start and an end date (optionally only during working hours).
- **Single-use code:** works once, then stops working.

The Nimly lock firmware has no schedules over Zigbee. It only supports lock, unlock, set PIN and clear PIN (vendor spec, per the `onesti-lock` research). So the app enforces access itself, by putting a user's PIN on the lock when access starts and clearing it when access ends. Nimly's own PRO gateway almost certainly does the same thing.

The app will run as a **container on a Linux server**, not on the Mac.

## Goals

1. Each user can have optional access limits, combined freely:
   - **Period:** `from` and/or `until` (local date and time).
   - **Weekly windows:** zero or more of {days of week, start HH:MM, end HH:MM}.
   - **Max uses:** a whole number ≥ 1, counted from keypad unlocks on the user's slot.
   - No limits means **always**, which is today's behaviour.
2. The app keeps the lock in line with the rules on its own, and catches up after downtime.
3. **Overdue-removal warning in the app:** a user whose code should be off but isn't confirmed off gets a red warning on the card and a banner at the top, showing when it should have been removed. No push notifications.
4. **Expired** users (period over, or uses used up) stay in the list, marked expired, so they can be extended or deleted.
5. The app runs as a container: image, compose example, persistent data, correct local time zone, automatic restart.

## Non-goals (for now)

- Push, e-mail or other notifications.
- Weekly windows that cross midnight (end must be after start on the same day).
- Holiday exceptions, or "skip this one Wednesday".
- Login or authentication (unchanged; see Constraints).
- Reading codes back from the lock (not possible).

## Anti-goals (failure even if it "works")

- A code still active on the lock after its access ended **without a visible warning**.
- A schedule that silently stops being enforced after a restart, redeploy or MQTT outage.
- Hammering a sleeping, battery-powered lock with retries.

## Constraints and facts

- Lock commands available: set PIN (slot, PIN) and clear PIN (slot). The user-status field is ignored by the firmware, so "off" always means **clear**.
- The lock is a sleepy end device. Commands may time out, and "sent" is not proof (see the README status model: Sending / Sent / Verified / Failed).
- Keypad unlock events arrive as `action: "unlock"`, `action_source_name: "keypad"`, `action_user: <slot>`. These are what count as **uses**. Fingerprint unlocks don't count, because fingerprints have their own slot numbers.
- Commands go to the lock one at a time (existing queue in `src/lock.js`).
- The app has no login. On a server that's a bigger exposure than on a Mac, but it is unchanged by this work. The README must say to keep it on a trusted network or behind a reverse proxy with authentication.

## Approaches considered

1. **Reconcile loop, picked by the owner.** Every tick (60 s) the app computes each user's *desired* state (code on or off) from rules and time, compares it with the *applied* state (what was last sent and not rejected), and queues set or clear for differences. It catches up after downtime by construction, needs no timer bookkeeping, and gives retries for free.
2. **Exact timers per event.** Precise, but timers are lost on restart and need separate catch-up logic. Rejected.
3. **External scheduler** (Home Assistant or cron calling the API). Splits the rules across two systems. Rejected.

## Design

### Data model (additions to the user in `users.json`)

```jsonc
{
  "access": {                       // null or absent = always
    "from": "2026-12-01T07:00",     // local wall-clock time, no zone; null = no start limit
    "until": "2026-12-12T16:00",    // null = no end limit
    "weekly": [                     // empty = any time within the period
      { "days": [3], "start": "08:00", "end": "12:00" }   // days: 0=Sun … 6=Sat
    ],
    "maxUses": 1                    // null = unlimited
  },
  "uses": 0,                        // keypad unlocks counted since access was last (re)configured
  "applied": "on" | "off" | "unknown",  // last state the lock accepted (set ⇒ on, clear ⇒ off)
  "offDueAt": null                  // when the code should have gone off but isn't confirmed off yet (ISO); drives the warning
}
```

- Times are **local wall-clock** strings, read in the container's time zone (`TZ`). This keeps "Wednesday 08:00" correct across daylight saving changes.
- `enabled` (the manual switch) stays. When off, the code is off regardless of rules.
- Existing users have no `access`, so they're always on, and `applied` is derived from current state: `on` if enabled and status sent/verified, `off` if disabled, otherwise `unknown`.
- Saving new access settings resets `uses` to 0.

### Desired state

`desired(user, now)` is **on** only if all of these hold:

- `enabled` is true;
- `now >= from - LEAD` (if `from` is set) and `now < until` (if `until` is set);
- `weekly` is empty, or `now` is in at least one window, where a window opens `LEAD` before its start;
- `maxUses` is null or `uses < maxUses`.

Otherwise it's **off**.

- `LEAD` (default 5 min, env `SCHEDULE_LEAD_MINUTES`) sends codes early so a sleeping lock has time to receive them.
- There is **no lead on closing**: the code is cleared at the end time.

Derived labels for the UI:

- **expired**: `until` has passed, or uses are used up. This is permanent until edited.
- **scheduled**: currently off by rule but will turn on later. Show the next on-time.
- **active**: currently on.

### Reconciler (new module, e.g. `src/scheduler.js`)

- Runs every 60 s, plus immediately after startup, after any user change, and after a counted use.
- For each user with no command in flight:
  - if desired ≠ applied, queue set (desired on) or clear (desired off) through the existing lock queue.
  - **Delete** keeps working as today.
- On a command result:
  - **sent** sets `applied` to on or off.
  - **failed** sets `applied` to **unknown**, because a timed-out command may still have reached the sleepy lock. While `applied` is unknown, the reconciler keeps sending the desired state on the retry schedule. If desired is off, the overdue warning stays until a clear is confirmed. *(Builder's call, from the builder check: keeping the old value could hide a live code.)*
- **A PIN change** while the code is on sets `applied` to **unknown**, so the new PIN is sent and the old one doesn't stay active. `applied` records on, off or unknown, not which PIN is on the lock.
- **Retry policy:** a failed command for a user is retried on later ticks, at most once every `RETRY_MINUTES` (default 5) per user, so the lock isn't hammered. Turning a code **off** always takes priority over turning one **on** when several are due on the same tick.
- **Overdue removal:** when desired becomes off while `applied` ≠ off (on **or unknown**), set `offDueAt` to the moment it became due (the window end, period end, or the moment uses ran out). Clear `offDueAt` once `applied` = off.
  - The warning shows when `offDueAt` is more than `OVERDUE_GRACE_MINUTES` (default 2) in the past.
- The manual **Retry** button stays. **Delete** of a scheduled user works as now.
- The reconciler takes over today's direct `lock.syncUser` calls from the API for enable, disable and PIN changes. The API changes the stored user, and the reconciler pushes the change.

### Counting uses

- In `src/lock.js`, a keypad unlock for a slot increments that user's `uses`, in addition to the existing Verified logic.
- It counts only while `applied` is on, so stray events don't count against a code that isn't on the lock.
- When `uses` reaches `maxUses`, the next reconcile (triggered immediately) clears the code.
- A single-use code therefore stops working right after first use, as soon as the clear reaches the lock.

### API

- `POST /api/users` and `PATCH /api/users/:id` accept `access` (validated: dates parse, `from < until`, windows have days 0–6, `start < end` as HH:MM, `maxUses` integer ≥ 1).
- Bad input returns 400 with a readable message.
- `GET /api/users` includes the derived fields `accessState` (`always` | `active` | `scheduled` | `expired`), `nextChangeAt` (ISO or null) and `overdue` (bool).
- `GET /api/status` includes `overdueCount`.

### UI

- The add and edit forms get an **Access** section: Always / Limited. Limited shows period from–to (`datetime-local`), weekly windows (day toggles plus start and end times, add or remove rows), and "max uses".
- The card shows a one-line summary ("Wed 08–12", "1 Dec 07:00 → 12 Dec 16:00", "1 use left"), the state (Active / Scheduled, next: Wed 26/11 08:00 / Expired), and a red **"Should have been removed at 12:00 — not confirmed"** line when overdue.
- A page banner appears when `overdueCount > 0`.
- Mobile-first, as now.

### Container

- **Dockerfile:** `node:22-alpine`, `npm ci --omit=dev`, runs as the non-root `node` user, `EXPOSE 3000`, data at `/app/data` (declared volume), `HEALTHCHECK` on `GET /api/status`.
- **`docker-compose.yml` example (decided by the owner: plain Docker Compose, config and data mounted from the host, TZ set on the container):**
  - `restart: unless-stopped`
  - `env_file: .env`, with the `.env` file kept next to the compose file on the server
  - `environment: TZ=Europe/Stockholm`, which the owner sets
  - a **bind mount** `./data:/app/data` for `users.json`
  - port 3000
  - The app must not assume a time zone: it uses whatever `TZ` gives and logs it at startup.
  - If `TZ` is unset (the container defaults to UTC), the startup log warns about it.
  - The container runs as uid 1000 (`node`), so the host `./data` folder must be writable by uid 1000. The README says so.
  - If the data file can't be written, the app fails loudly at startup instead of losing changes.
  - **Build and network (builder's call):**
    - The image is built on the server with `docker compose build` (`build: .`). No registry or CI.
    - `node:22-alpine` is multi-arch, so this works on both x86-64 and ARM.
    - The broker address comes only from `MQTT_URL` in `.env`. `localhost` won't work inside a container, so the README shows three options: the broker in the same compose stack (service name), a broker container on the same host (shared external network or the host's LAN IP), or another machine (its IP or hostname).
  - **No migration needed:** no `users.json` exists on the Mac yet, so the server starts fresh.
    - The README warns: **never run two instances against the same lock**, because their reconcilers would fight.
- Node handles `TZ` through its built-in ICU data, so no extra tzdata package is needed. **Verify** by logging the resolved time zone at startup.
- Startup log line: time zone, MQTT URL, lock name, slot range.
- `.dockerignore`: `node_modules`, `data`, `.env`, `docs`, `test`.
- The README gets a deploy section.

## Left to the builder

- Exact UI layout of the access editor within the mobile-first style.
- Module boundaries beyond "a scheduler module plus small additions to lock, store and server".
- Test structure. Reconciler and desired-state logic must be unit-tested with an injectable clock, including a DST transition and catch-up after downtime.
