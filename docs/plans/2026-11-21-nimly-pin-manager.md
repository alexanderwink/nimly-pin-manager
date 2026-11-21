# Nimly PIN Manager Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Local web app to add/change/enable/disable/delete PIN users on a Nimly lock via zigbee2mqtt, with the app's JSON file as source of truth.

**Architecture:** Express server owns a JSON-file store and an MQTT lock client. A sync manager turns user operations into z2m `set` commands and tracks each user's `syncStatus` (pending → synced | failed). A static vanilla-JS page polls the REST API.

**Tech Stack:** Node 23 (ESM), express, mqtt, dotenv; tests with `node:test` + `node:assert/strict`, HTTP tests via `fetch` against `app.listen(0)`.

**Spec:** `docs/2026-11-21-nimly-pin-manager-design.md`

## Global Constraints
- Folder is not a git repo: no commit steps.
- Config via `.env`: `MQTT_URL`, `MQTT_USERNAME`, `MQTT_PASSWORD`, `Z2M_BASE_TOPIC=zigbee2mqtt`, `LOCK_NAME`, `PORT=3000`, `NUM_SLOTS=20` (fallback when lock hasn't reported `num_pin_users`), `FIRST_SLOT=1`, `DATA_FILE=data/users.json`, `CONFIRM_TIMEOUT_MS=15000`.
- Set payload exactly: `{"pin_code":{"user":<slot>,"user_type":"unrestricted","user_enabled":<bool>,"pin_code":<number|null>}}` to `<base>/<lock>/set`.
- PIN: digits only, length 4–8 unless lock reported `min_pin_length`/`max_pin_length`. PIN sent as a number; stored as a string (keeps leading zeros visible to user — note: a leading-zero PIN is rejected by validation because numeric send would drop it).
- PIN shown masked in UI; revealed on click.

## Review Focus
1. Leading-zero PIN ("0123") — would be silently altered by numeric send; expect validation error. Test in Task 1.
2. All slots full — expect 409 with clear message, not a crash. Test in Task 1 + Task 3.
3. MQTT broker down at startup/command — app must still start and serve UI; commands end as `failed` after timeout, resendable. Test in Task 2.
4. Corrupt/missing `users.json` — missing ⇒ empty list; corrupt ⇒ startup error naming the file (never overwrite it). Test in Task 1.
5. Duplicate user name or duplicate PIN — duplicate PIN rejected (lock ambiguity); duplicate name allowed. Test in Task 1.

---

### Task 1: Store (`src/store.js`)

**Files:** Create `package.json`, `.env.example`, `.gitignore` (`node_modules`, `.env`, `data/`), `src/store.js`, `test/store.test.js`

**Interfaces — Produces:**
- `createStore(filePath: string) -> Store` (loads synchronously; missing file ⇒ `[]`; invalid JSON ⇒ throws `Error` containing filePath)
- `Store.list() -> User[]` sorted by slot
- `Store.get(id) -> User|undefined`
- `Store.add({name, pin}, {numSlots, firstSlot, minLen, maxLen}) -> User` (assigns lowest free slot, `enabled:true`, `syncStatus:'pending'`, `id` = `crypto.randomUUID()`, `createdAt`/`updatedAt` ISO)
- `Store.update(id, patch) -> User` (shallow merge + `updatedAt`)
- `Store.remove(id) -> void`
- `validatePin(pin, {minLen, maxLen}, users, excludeId?) -> string|null` (error message or null)
- `User = {id, name, slot, pin, enabled, syncStatus:'pending'|'synced'|'failed', pendingOp:'set'|'delete'|null, lastError:string|null, createdAt, updatedAt}`
- Errors thrown carry `err.status` (400 validation, 404 not found, 409 no free slot).
- Every mutation persists atomically: write `<file>.tmp`, `fs.renameSync`; creates parent dir.

- [ ] Step 1: `npm init`, set `"type":"module"`, `"scripts":{"start":"node src/index.js","test":"node --test"}`; install `express mqtt dotenv`.
- [ ] Step 2: Write tests: `add assigns lowest free slot from firstSlot`; `add after remove reuses slot`; `add throws status 409 when all numSlots used`; `validatePin rejects "12a4", "123", "123456789", "0123", duplicate pin of another user; accepts "1234"`; `persists and reloads from disk`; `missing file => empty list`; `corrupt file => throws with path, file untouched`.
- [ ] Step 3: `npm test` → FAIL (module missing).
- [ ] Step 4: Implement `src/store.js`.
- [ ] Step 5: `npm test` → PASS.

### Task 2: Lock client + sync (`src/lock.js`)

**Files:** Create `src/lock.js`, `test/lock.test.js`

**Interfaces — Consumes:** Store from Task 1. **Produces:**
- `createLock({mqtt, baseTopic, lockName, store, timeoutMs}) -> Lock` where `mqtt` is any object with `publish(topic, payload)`, `subscribe(topic)`, `on('message', (topic, Buffer)=>{})`, `connected: boolean` (real `mqtt` client or test fake EventEmitter).
- `Lock.status -> {connected, state, lock_state, battery, last_unlock_user, last_unlock_source, num_pin_users, min_pin_length, max_pin_length, lastSeen}`
- `Lock.syncUser(user) -> void` publishes set payload (`pin_code: Number(pin)`, `user_enabled: enabled`), marks `syncStatus:'pending', pendingOp:'set'`, starts timeout.
- `Lock.deleteUser(user) -> void` publishes `pin_code:null`, `user_enabled:false`, marks `pendingOp:'delete'`.
- `Lock.setState('LOCK'|'UNLOCK') -> void`
- `Lock.start()` subscribes to `<base>/<lock>`, `<base>/bridge/logging`; publishes `<base>/<lock>/get` `{"state":""}`.

**Confirmation rules (decided here):**
- Device state message on `<base>/<lock>` received after a pending op was published ⇒ confirm all pending ops for that lock older than the message: `set` ⇒ `syncStatus:'synced'`; `delete` ⇒ `store.remove(id)`. If the message contains `users` object with entry for slot, use it (status/pin) as the confirmation for that slot only.
- `<base>/bridge/logging` message with `level:'error'` whose `message` includes the lock name ⇒ all pending ops for that lock ⇒ `failed`, `lastError` = message.
- Timeout `timeoutMs` without either ⇒ `failed`, `lastError:'No response from lock'`.
- If `mqtt.connected` is false at publish time ⇒ immediately `failed`, `lastError:'MQTT not connected'`.

- [ ] Step 1: Tests with fake mqtt: `syncUser publishes exact payload to zigbee2mqtt/door/set`; `device state after set => synced`; `bridge error mentioning lock => failed with message`; `timeout => failed` (timeoutMs 20); `deleteUser + state => user removed from store`; `disconnected => failed immediately`; `state message updates status.battery/last_unlock_user`.
- [ ] Step 2: Run → FAIL. Step 3: implement. Step 4: Run → PASS.

### Task 3: HTTP API (`src/server.js`) + entry (`src/index.js`)

**Files:** Create `src/server.js`, `src/index.js`, `test/server.test.js`

**Interfaces — Consumes:** Store, Lock. **Produces:** `createApp({store, lock, config}) -> express.App`. Routes (JSON; errors `{error}` with `err.status` or 500):
- `GET /api/status` → `{lock: lock.status, slots:{first, total}}` (total = `lock.status.num_pin_users ?? config.numSlots`)
- `GET /api/users` → `User[]`
- `POST /api/users {name, pin}` → 201 User (validate, add, `lock.syncUser`)
- `PATCH /api/users/:id {name?, pin?, enabled?}` → User; resync only if pin or enabled changed
- `DELETE /api/users/:id` → 202 (`lock.deleteUser`)
- `POST /api/users/:id/resend` → 202 (re-run pendingOp, default `set`)
- `POST /api/lock {state:'LOCK'|'UNLOCK'}` → 202; other values 400
- static `public/`
`src/index.js`: dotenv, `mqtt.connect(MQTT_URL, {username, password, reconnectPeriod:5000})`, starts lock and app; broker failure logged, server still starts.

- [ ] Step 1: Tests with fake lock (records calls): POST valid → 201 + syncUser called; POST bad pin → 400; POST when full → 409; PATCH name only → no sync; PATCH pin → sync; DELETE → 202 + deleteUser; unknown id → 404; POST /api/lock bad state → 400.
- [ ] Step 2: FAIL → implement → PASS.

### Task 4: UI (`public/`)

**Files:** Create `public/index.html`, `public/app.js`, `public/style.css`

- Header: lock name, state badge, battery %, last unlock ("Anna (slot 3) via keypad"), Lock/Unlock buttons, MQTT connected dot.
- Table: Name | Slot | PIN (•••• click to reveal) | Enabled toggle | Status (pending spinner / synced ✓ / failed ✗ with lastError tooltip) | actions: Change PIN, Rename, Resend (only when failed), Delete (confirm()).
- Add form: name + PIN, shows API error inline.
- Polls `/api/status` and `/api/users` every 3 s. Light/dark via `prefers-color-scheme`.
- **Mobile-first:** viewport meta; below 640px the table becomes a card per user (name + slot on top, status, actions as a row of ≥44px tap targets); Lock/Unlock buttons full-width; no horizontal scroll at 360px; PIN inputs use `inputmode="numeric"` and `autocomplete="off"`. Server binds `0.0.0.0` so the phone can reach it on the LAN.

- [ ] Step 1: Build. Step 2: Verify manually: `npm start` with no broker → page loads, adding a user ends `failed` "MQTT not connected"; then against a local mosquitto (`brew install mosquitto` if available) publish fake state to `zigbee2mqtt/<lock>` with `mosquitto_pub` and confirm user goes `synced`.

### Task 5: README
- [ ] Setup (`cp .env.example .env`, `npm i`, `npm start`), config table, behavior notes (app is source of truth; slot numbering; resend).
