# Nimly PIN Manager

Small personal web app for managing PIN users on a Nimly Touch Pro lock through
[zigbee2mqtt](https://www.zigbee2mqtt.io/devices/Nimly.html). It supports permanent codes,
weekly schedules, date-limited codes and single-use codes, and works on desktop and mobile.

## Deploy with Docker Compose

On the server, in a folder containing this project:

```sh
cp .env.example .env          # set MQTT_URL, credentials and LOCK_NAME (see below)
mkdir -p data && sudo chown 1000:1000 data   # the container runs as uid 1000
# edit docker-compose.yml: TZ (e.g. Europe/Stockholm) and the port if needed
docker compose up -d --build
docker compose logs -f        # check the "Time zone:" and "MQTT connected" lines
```

Open `http://<server>:3000`. To update, pull or copy the new code and run
`docker compose up -d --build` again. `./data/users.json` is kept.

**`MQTT_URL` from inside the container.** `localhost` means the container itself, so use one of these:
- **Broker in the same compose file:** use its service name, e.g. `mqtt://mosquitto:1883`.
- **Broker container in another compose project on the same host:** put both on a shared
  external Docker network and use the broker's container name, or use the host's LAN IP.
- **Broker on another machine:** use its IP or hostname, e.g. `mqtt://192.168.1.10:1883`.

**Important:**
- **Set `TZ`.** Schedules use local wall-clock time. Without `TZ` the container runs on UTC,
  and the log warns about it.
- **Never run two instances against the same lock.** Each one enforces schedules, and they
  would fight over the codes.
- **The app has no login.** Keep it on a trusted network, or put a reverse proxy with
  authentication in front of it.
- `data/users.json` contains PINs in plain text.

## Run locally (development)

```sh
cp .env.example .env
npm install
npm start      # http://localhost:3000
npm test       # runs with TZ=Europe/Stockholm
```

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `MQTT_URL` | `mqtt://localhost:1883` | Broker used by zigbee2mqtt |
| `MQTT_USERNAME` / `MQTT_PASSWORD` | – | Broker credentials |
| `Z2M_BASE_TOPIC` | `zigbee2mqtt` | zigbee2mqtt base topic |
| `LOCK_NAME` | `nimly` | Friendly name of the lock in zigbee2mqtt |
| `PORT` / `HOST` | `3000` / `0.0.0.0` | Web server |
| `FIRST_SLOT` / `LAST_SLOT` | `3` / `49` | Slot range the app assigns from. 000–002 are master slots and are never written. The keypad manual allows 999, but over Zigbee the lock reports 50 PIN users. Also capped by `num_pin_users` if reported |
| `RESERVED_SLOTS` | (empty) | Optional comma-separated slots in the range the app should never use |
| `DATA_FILE` | `data/users.json` | Where users and PINs are stored |
| `CONFIRM_TIMEOUT_MS` | `15000` | How long to wait for the lock before marking a command failed |
| `SCHEDULE_LEAD_MINUTES` | `5` | How early a scheduled code is sent (the lock may be asleep) |
| `RETRY_MINUTES` | `5` | Minimum wait between automatic retries of a failed command, per user |
| `OVERDUE_GRACE_MINUTES` | `2` | How long a removal may go unconfirmed before the warning shows |
| `LOG_MQTT` | `0` | Set to `1` to log every MQTT payload sent (`[mqtt >]`) and received (`[mqtt <]`). PIN values are masked as `****` |

## Access rules

Each user is either **Always** or **Limited**. A limited user can combine:

- **Period:** from and/or until a date and time (e.g. a carpenter, 1 Dec 07:00 → 12 Dec 16:00).
- **Weekly times:** days plus a time window, as many rows as needed (e.g. cleaner, Wed 08:00–12:00).
  Windows can't cross midnight.
- **Max uses:** counted from keypad unlocks with that code. "Single use, valid 7 days" fills
  in a single-use code.

The lock firmware has no schedules, so **the app enforces them** by putting the PIN on the lock
when access starts and clearing it when access ends. Every minute it compares what each code
*should* be with what the lock last accepted, and sends set or clear commands for differences,
removals first. Because it compares state rather than running timers, it catches up by itself
after a restart or an MQTT outage. Codes are sent `SCHEDULE_LEAD_MINUTES` early and cleared
at the end time. Schedules only work while the app is running. Nimly's own gateway has the
same limitation.

Card states: **Active now**, **Scheduled · next …**, **Expired** (period over or uses used up;
the user is kept so you can extend or delete it), **Disabled**.

**Overdue warning.** If a code should have been removed but the removal isn't confirmed within
`OVERDUE_GRACE_MINUTES` of the app noticing, the card and a banner at the top turn red: the code
may still open the door. The app keeps retrying every `RETRY_MINUTES`. Press **Lock** to wake
the lock, then **Retry**.

## Command status

- **The app is the source of truth.** Users, slots, PINs and rules live in `data/users.json`.
  The lock can't report its codes back.
- Each user gets the lowest free slot from 003–049, skipping any `RESERVED_SLOTS`. Commands go to
  `<base>/<lock>/set` as `{"pin_code":{"user":<slot>,"user_type":"unrestricted","user_enabled":<bool>,"pin_code":<number|null>}}`,
  one at a time.
- **Sending**: waiting for the lock.
- **Sent** / **Off on lock**: the lock published state afterwards and zigbee2mqtt reported no
  error. This is *not* proof. The lock sends no reliable confirmation for PIN changes.
- **Verified**: someone unlocked with that slot at the keypad (`action: unlock`, source
  `keypad`). This is the only real proof the code works.
- **Failed**: zigbee2mqtt logged an error, or nothing came back in time. The lock is a sleepy
  device, so this often means "not delivered yet". A failed command may still have reached the
  lock, so the app treats the code's state on the lock as *unknown* and keeps sending what it
  should be.
- **Disable clears the code on the lock.** The Nimly firmware ignores the enabled/disabled
  field, so the app keeps the PIN and sends it again when you re-enable the user.
- Deleting a user clears the slot first, and the user is removed only after the lock answers.
- PINs must be 4–8 digits (or the limits the lock reports) and can't start with `0`, because the
  lock receives the PIN as a number. Two users can't share a PIN.

## Limitations

- Codes added at the keypad are invisible to the app, so the app could hand out a slot that is
  already used at the keypad.
- "Sent" is a heuristic. Only "Verified" proves a code works at the door.
