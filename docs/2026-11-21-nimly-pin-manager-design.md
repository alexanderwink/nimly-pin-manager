# Nimly PIN Manager — design (approved 2026-11-21)

## Intent
Single-user web app to manage PIN users on a Nimly Touch Pro lock via zigbee2mqtt.
The app is the source of truth for users/codes (the lock cannot reliably report codes back).

## Goals
- Add user (name + PIN, auto-assigned free slot), change PIN, enable/disable, delete, resend.
- Show per-user sync status: pending until zigbee2mqtt confirms, failed on error/timeout.
- Must work well on mobile (responsive, card layout on small screens, reachable on LAN).
- Header: lock state, battery, last unlock (mapped slot -> user name), lock/unlock buttons.

## Non-goals (for now)
Authentication, schedules, temporary codes, database.

## Approaches
- Node + Express + `mqtt` + static vanilla HTML/JS + JSON file — **chosen** (user picked Node).
- Python/FastAPI — equivalent, not chosen.
- Full SPA framework — overkill for one user.

## How
- Config in `.env`: `MQTT_URL`, `MQTT_USERNAME`, `MQTT_PASSWORD`, `Z2M_BASE_TOPIC` (default `zigbee2mqtt`), `LOCK_NAME`, `PORT`, `NUM_SLOTS` fallback.
- Commands to `<base>/<lock>/set`: `{"pin_code":{"user":slot,"user_type":"unrestricted","user_enabled":bool,"pin_code":number|null}}`.
- State from `<base>/<lock>` (state, battery, last_unlock_user, num_pin_users, pin_code responses).
- Confirmation: z2m publishes `<base>/bridge/response/...`? Not for device sets; treat a subsequent device state publish after the command as confirmation, and catch errors from `<base>/bridge/logging` mentioning the lock. Timeout -> failed (resendable).
- Storage: `data/users.json`, atomic write (tmp + rename).
- Builder's call: PIN validated as 4–8 digits by default; overridden by lock's min/max_pin_length if reported.
