import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import mqtt from 'mqtt';
import { createStore } from './store.js';
import { createLock } from './lock.js';
import { createScheduler } from './scheduler.js';
import { createApp } from './server.js';

const env = process.env;
const minutes = (name, def) => Number(env[name] ?? def) * 60_000;
const config = {
  mqttUrl: env.MQTT_URL ?? 'mqtt://localhost:1883',
  baseTopic: env.Z2M_BASE_TOPIC ?? 'zigbee2mqtt',
  lockName: env.LOCK_NAME ?? 'nimly',
  port: Number(env.PORT ?? 3000),
  host: env.HOST ?? '0.0.0.0',
  // Slots 000–002 are the lock's master slots and must never be assigned.
  firstSlot: Math.max(3, Number(env.FIRST_SLOT ?? 3)), // never below 3, even if misconfigured
  lastSlot: Number(env.LAST_SLOT ?? 49), // lock reports 50 PIN users over Zigbee (0–49)
  reserved: (env.RESERVED_SLOTS ?? '').split(',').map((s) => s.trim()).filter(Boolean).map(Number),
  dataFile: env.DATA_FILE ?? 'data/users.json',
  timeoutMs: Number(env.CONFIRM_TIMEOUT_MS ?? 15000),
  leadMs: minutes('SCHEDULE_LEAD_MINUTES', 5),
  retryMs: minutes('RETRY_MINUTES', 5),
  graceMs: minutes('OVERDUE_GRACE_MINUTES', 2),
};

// Schedules are in local wall-clock time, so the time zone matters.
const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
console.log(`Time zone: ${timeZone}, local time now ${new Date().toLocaleString('sv-SE')}`);
if (!env.TZ && (timeZone === 'UTC' || timeZone === 'Etc/UTC')) {
  console.warn('WARNING: TZ is not set and the time zone is UTC. Schedules will run on UTC. Set TZ (e.g. TZ=Europe/Stockholm).');
}

// Fail loudly now rather than losing changes later (e.g. a bind mount not writable by this user).
const dataDir = path.dirname(path.resolve(config.dataFile));
try {
  fs.mkdirSync(dataDir, { recursive: true });
  const probe = path.join(dataDir, '.write-test');
  fs.writeFileSync(probe, 'ok');
  fs.rmSync(probe);
} catch (e) {
  console.error(`FATAL: data folder ${dataDir} is not writable (${e.code ?? e.message}). In Docker: chown 1000:1000 the mounted folder.`);
  process.exit(1);
}

const store = createStore(config.dataFile);
const client = mqtt.connect(config.mqttUrl, {
  username: env.MQTT_USERNAME || undefined,
  password: env.MQTT_PASSWORD || undefined,
  reconnectPeriod: 5000,
});

// LOG_MQTT=1 prints every MQTT payload sent and received, with PIN values masked.
if (/^(1|true|yes|on)$/i.test(env.LOG_MQTT ?? '')) {
  // Also matches escaped JSON inside zigbee2mqtt's own log messages (\"pin_code\":1234).
  const mask = (s) => String(s).replace(/(\\?"pin_code\\?"\s*:\s*)(\\?"\d*\\?"|\d+)/g, '$1****');
  const publish = client.publish.bind(client);
  client.publish = (topic, message, ...rest) => {
    console.log(`[mqtt >] ${topic} ${mask(message)}`);
    return publish(topic, message, ...rest);
  };
  client.on('message', (topic, buf) => console.log(`[mqtt <] ${topic} ${mask(buf)}`));
  console.log('MQTT payload logging is on (LOG_MQTT), PINs masked.');
}

let scheduler;
const lock = createLock({
  mqtt: client, baseTopic: config.baseTopic, lockName: config.lockName, store,
  timeoutMs: config.timeoutMs, log: (m) => console.log(`[lock] ${m}`),
  onUse: () => scheduler.trigger(),
  onSettled: () => scheduler.trigger(), // e.g. a PIN changed while its command was in flight
});
scheduler = createScheduler({
  store, lock, leadMs: config.leadMs, retryMs: config.retryMs, graceMs: config.graceMs,
  log: (m) => console.log(`[schedule] ${m}`),
});

client.on('connect', () => {
  console.log(`MQTT connected to ${config.mqttUrl}`);
  lock.refresh();
  // Commands that never left because MQTT was down: retry now instead of after the retry wait.
  for (const u of store.list()) {
    if (u.lastError === 'MQTT not connected') store.update(u.id, { lastAttemptAt: null });
  }
  scheduler.trigger();
});
client.on('error', (e) => console.error(`MQTT error: ${e.message}`));
client.on('offline', () => console.warn('MQTT offline, retrying…'));
client.on('close', () => lock.connectionLost());
lock.start();
scheduler.start();

createApp({ store, lock, scheduler, config }).listen(config.port, config.host, () => {
  console.log(`Nimly PIN manager on http://${config.host}:${config.port}`);
  console.log(`Lock: ${config.baseTopic}/${config.lockName}, slots ${config.firstSlot}–${config.lastSlot}, MQTT ${config.mqttUrl}`);
});
