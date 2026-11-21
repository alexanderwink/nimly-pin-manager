const $ = (id) => document.getElementById(id);
const revealed = new Set();
let users = [];
let status = null;

// API paths are resolved relative to the page, so the app also works under a
// reverse-proxy sub-path such as https://host/nimly/.
async function api(method, url, body) {
  const res = await fetch(url.replace(/^\//, ''), {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error ?? `Request failed (${res.status})`);
  return data;
}

function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, 3500);
}

function el(tag, attrs = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (k === 'class') n.className = v;
    else if (v !== false && v != null) n.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children) if (c != null) n.append(c);
  return n;
}

const fmtSlot = (n) => String(n).padStart(3, '0');

function userName(slot) {
  const u = users.find((x) => x.slot === Number(slot));
  return u ? `${u.name} (slot ${fmtSlot(slot)})` : `slot ${fmtSlot(slot)}`;
}

// ---------- Access rules ----------
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0]; // Monday first
const pad = (n) => String(n).padStart(2, '0');
const toLocalInput = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
const fmtDateTime = (s) => new Date(s).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const fmtWhen = (iso) => new Date(iso).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' });
let editorSeq = 0;

function fmtDays(days) {
  const sorted = DAY_ORDER.filter((d) => days.includes(d));
  // Collapse runs of 3+ consecutive days (Mon-first order): Mon–Fri
  const idx = sorted.map((d) => DAY_ORDER.indexOf(d));
  const parts = [];
  for (let i = 0; i < idx.length;) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1] === idx[j] + 1) j++;
    if (j - i >= 2) parts.push(`${DAY_NAMES[DAY_ORDER[idx[i]]]}–${DAY_NAMES[DAY_ORDER[idx[j]]]}`);
    else for (let k = i; k <= j; k++) parts.push(DAY_NAMES[DAY_ORDER[idx[k]]]);
    i = j + 1;
  }
  return parts.join(', ');
}

function summarizeAccess(u) {
  const a = u.access;
  if (!a) return null;
  const parts = [];
  for (const w of a.weekly ?? []) parts.push(`${fmtDays(w.days)} ${w.start}–${w.end}`);
  if (a.from && a.until) parts.push(`${fmtDateTime(a.from)} → ${fmtDateTime(a.until)}`);
  else if (a.from) parts.push(`from ${fmtDateTime(a.from)}`);
  else if (a.until) parts.push(`until ${fmtDateTime(a.until)}`);
  if (a.maxUses != null) {
    const left = Math.max(0, a.maxUses - (u.uses ?? 0));
    parts.push(a.maxUses === 1 ? (left ? 'single use' : 'used') : `${left} of ${a.maxUses} uses left`);
  }
  return parts.join(' · ');
}

/** Renders an access-rule editor into `host`; returns { get() } giving access or null (always). */
function accessEditor(host, access) {
  const id = ++editorSeq;
  const limited = !!access;
  const a = access ?? { from: null, until: null, weekly: [], maxUses: null };

  const rows = el('div', { class: 'weekly-rows' });
  const addRow = (w = { days: [], start: '08:00', end: '16:00' }) => {
    const row = el('div', { class: 'weekly-row' },
      el('div', { class: 'chips' }, ...DAY_ORDER.map((d) => el('label', { class: 'chip' },
        el('input', { type: 'checkbox', value: d, checked: w.days.includes(d) }), DAY_NAMES[d]))),
      el('div', { class: 'times' },
        el('input', { type: 'time', value: w.start, 'aria-label': 'Start time', class: 'w-start' }),
        el('span', {}, '–'),
        el('input', { type: 'time', value: w.end, 'aria-label': 'End time', class: 'w-end' }),
        el('button', { type: 'button', class: 'btn small', 'aria-label': 'Remove weekly time', onclick: () => row.remove() }, '✕')),
    );
    rows.append(row);
  };
  (a.weekly ?? []).forEach(addRow);

  const from = el('input', { type: 'datetime-local', value: a.from ?? '' });
  const until = el('input', { type: 'datetime-local', value: a.until ?? '' });
  const maxUses = el('input', { type: 'number', min: 1, step: 1, inputmode: 'numeric', value: a.maxUses ?? '', placeholder: 'unlimited' });

  const details = el('div', { class: 'access-details' },
    el('div', { class: 'presets' },
      el('button', {
        type: 'button', class: 'btn small',
        onclick: () => {
          maxUses.value = 1;
          if (!until.value) until.value = toLocalInput(new Date(Date.now() + 7 * 86_400_000));
        },
      }, 'Single use, valid 7 days')),
    el('div', { class: 'field-title' }, 'Period'),
    el('div', { class: 'period' },
      el('label', {}, 'From', from),
      el('label', {}, 'Until', until)),
    el('div', { class: 'field-title' }, 'Weekly times'),
    rows,
    el('button', { type: 'button', class: 'btn small', onclick: () => addRow() }, '+ Add weekly time'),
    el('label', { class: 'uses' }, 'Max uses', maxUses),
    el('p', { class: 'muted small' }, 'Leave a field empty for no limit. The code is sent a few minutes early and removed at the end time.'),
  );

  const radio = (value, label, checked) => el('label', { class: 'radio' },
    el('input', { type: 'radio', name: `access-mode-${id}`, value, checked, onchange: () => { details.hidden = value === 'always'; } }),
    label);
  const mode = el('div', { class: 'mode' }, radio('always', 'Always', !limited), radio('limited', 'Limited', limited));
  details.hidden = !limited;
  host.replaceChildren(el('div', { class: 'field-title' }, 'Access'), mode, details);

  return {
    get() {
      if (host.querySelector(`input[name=access-mode-${id}]:checked`).value === 'always') return null;
      const weekly = [...rows.querySelectorAll('.weekly-row')].map((r) => ({
        days: [...r.querySelectorAll('.chip input:checked')].map((c) => Number(c.value)),
        start: r.querySelector('.w-start').value,
        end: r.querySelector('.w-end').value,
      }));
      return {
        from: from.value || null,
        until: until.value || null,
        weekly,
        maxUses: maxUses.value ? Number(maxUses.value) : null,
      };
    },
  };
}

function renderStatus() {
  if (!status) return;
  const l = status.lock;
  $('lock-name').textContent = l.lockName ?? 'Lock';
  $('mqtt').className = `dot ${l.connected ? 'on' : 'off'}`;
  $('mqtt-text').textContent = l.connected
    ? (l.lastSeen ? `Seen ${new Date(l.lastSeen).toLocaleTimeString()}` : 'Connected, waiting for lock')
    : 'MQTT disconnected';
  const state = l.lock_state ?? (l.state === 'LOCK' ? 'locked' : l.state === 'UNLOCK' ? 'unlocked' : null);
  const badge = $('lock-state');
  badge.textContent = state ? state.replace(/_/g, ' ') : 'unknown';
  badge.className = `badge ${state ?? ''}`;
  $('battery').textContent = l.battery != null ? `${l.battery}%` : '—';
  $('last-unlock').textContent = l.last_unlock_user != null || l.last_unlock_source
    ? [l.last_unlock_user != null ? userName(l.last_unlock_user) : null, l.last_unlock_source ? `via ${l.last_unlock_source}` : null]
      .filter(Boolean).join(' ')
    : '—';
  $('slots').textContent = `${users.length} / ${status.slots.total}`;
  $('btn-lock').disabled = $('btn-unlock').disabled = !l.connected;
  const banner = $('overdue-banner');
  const n = status.overdueCount ?? 0;
  banner.hidden = n === 0;
  banner.textContent = n === 0 ? '' : `⚠ ${n === 1 ? '1 code' : `${n} codes`} should have been removed from the lock, but the removal is not confirmed. The code may still open the door.`;
}

const STATUS_TEXT = {
  pending: '… Sending',
  sent: '✓ Sent',
  verified: '✓✓ Verified',
  failed: '✗ Failed',
};
const STATUS_TITLE = {
  sent: 'The lock did not reject it, but it is not proven until someone unlocks with this code at the keypad.',
  verified: 'Someone unlocked with this code at the keypad.',
};
const SLEEP_HINT = 'The lock may be asleep. Press Lock to wake it, then Retry.';
const looksAsleep = (err) => /no response|timeout|timed out/i.test(err ?? '');
const fmtTime = (iso) => new Date(iso).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' });

function renderUsers() {
  const list = $('users');
  list.replaceChildren(...users.map((u) => {
    const deleting = u.pendingOp === 'delete';
    const statusText = deleting && u.syncStatus === 'pending' ? '… Deleting'
      : u.applied === 'off' && u.syncStatus === 'sent' ? '✓ Off on lock'
      : STATUS_TEXT[u.syncStatus] ?? u.syncStatus;
    const summary = summarizeAccess(u);
    const lead = (status?.scheduleLeadMinutes ?? 0) * 60_000;
    const stateText = {
      active: 'Active now',
      scheduled: u.nextChangeAt ? `Scheduled · next ${fmtWhen(new Date(new Date(u.nextChangeAt).getTime() + lead))}` : 'Scheduled',
      expired: 'Expired',
    }[u.accessState];
    const pinShown = revealed.has(u.id);
    return el('li', { class: `user ${u.enabled ? '' : 'disabled'}` },
      el('div', {},
        el('div', { class: 'name' }, u.name),
        el('div', { class: 'sub' },
          el('span', {}, `Slot ${fmtSlot(u.slot)}`),
          u.syncStatus === 'verified' && u.verifiedAt ? el('span', {}, `used ${fmtTime(u.verifiedAt)}`) : null,
          el('button', {
            class: 'pin', title: 'Show/hide PIN', 'aria-label': 'Show or hide PIN',
            onclick: () => { pinShown ? revealed.delete(u.id) : revealed.add(u.id); renderUsers(); },
          }, pinShown ? u.pin : '•'.repeat(u.pin.length)),
        ),
      ),
      el('span', { class: `status ${u.syncStatus}`, title: STATUS_TITLE[u.syncStatus] ?? false }, statusText),
      u.syncStatus === 'failed' && u.lastError && !u.overdue
        ? el('div', { class: 'err' }, `${deleting ? 'Delete' : 'Update'} failed: ${u.lastError}`,
          looksAsleep(u.lastError) ? el('div', { class: 'hint' }, SLEEP_HINT) : null) : null,
      summary || stateText
        ? el('div', { class: 'access-line' },
          stateText ? el('span', { class: `state ${u.accessState}` }, stateText) : null,
          summary ? el('span', {}, summary) : null)
        : null,
      u.overdue
        ? el('div', { class: 'overdue' }, `⚠ Should have been removed at ${fmtWhen(u.offDueAt)}, not confirmed. The code may still open the door.`,
          u.lastError ? el('div', { class: 'hint' }, `Last attempt: ${u.lastError}`) : null,
          el('div', { class: 'hint' }, `${SLEEP_HINT} The app also retries by itself every few minutes.`))
        : null,
      !u.enabled && !deleting && u.applied === 'off'
        ? el('div', { class: 'note' }, 'Disabled: the code is removed from the lock and kept here. Enable to send it again.') : null,
      u.accessState === 'expired' && !deleting && u.applied === 'off'
        ? el('div', { class: 'note' }, 'Access has ended and the code is removed from the lock. Edit access to extend it, or delete the user.') : null,
      el('div', { class: 'actions' },
        el('label', { class: 'switch' },
          el('input', {
            type: 'checkbox', checked: u.enabled, disabled: deleting,
            onchange: (e) => act(() => api('PATCH', `/api/users/${u.id}`, { enabled: e.target.checked })),
          }),
          'Enabled'),
        el('button', { class: 'btn small', disabled: deleting, onclick: () => changePin(u) }, 'Change PIN'),
        el('button', { class: 'btn small', disabled: deleting, onclick: () => editAccess(u) }, 'Access'),
        el('button', { class: 'btn small', onclick: () => rename(u) }, 'Rename'),
        u.syncStatus === 'failed' || u.overdue
          ? el('button', { class: 'btn small', onclick: () => act(() => api('POST', `/api/users/${u.id}/resend`), 'Resent') }, 'Retry')
          : null,
        el('button', {
          class: 'btn small danger', disabled: deleting && u.syncStatus === 'pending',
          onclick: () => {
            if (confirm(`Delete ${u.name} and clear slot ${fmtSlot(u.slot)} on the lock?`)) {
              act(() => api('DELETE', `/api/users/${u.id}`), 'Deleting…');
            }
          },
        }, 'Delete'),
      ),
    );
  }));
  $('empty').hidden = users.length > 0;
}

async function act(fn, okMsg) {
  try {
    await fn();
    if (okMsg) toast(okMsg);
  } catch (e) {
    toast(e.message);
  }
  await refresh();
}

function prompt2({ title, value = '', numeric = false, submit }) {
  const dlg = $('dlg');
  const input = $('dlg-input');
  const err = $('dlg-error');
  $('dlg-title').textContent = title;
  input.value = value;
  input.inputMode = numeric ? 'numeric' : 'text';
  input.pattern = numeric ? '[0-9]*' : '.*';
  err.hidden = true;
  const onOk = async (e) => {
    e.preventDefault();
    try {
      await submit(input.value);
      dlg.close();
      await refresh();
    } catch (ex) {
      err.textContent = ex.message;
      err.hidden = false;
    }
  };
  $('dlg-form').onsubmit = onOk;
  dlg.showModal();
  input.focus();
}

function changePin(u) {
  prompt2({
    title: `New PIN for ${u.name}`, numeric: true,
    submit: (pin) => api('PATCH', `/api/users/${u.id}`, { pin: pin.trim() }),
  });
}

function rename(u) {
  prompt2({
    title: 'Rename user', value: u.name,
    submit: (name) => api('PATCH', `/api/users/${u.id}`, { name }),
  });
}

function editAccess(u) {
  const dlg = $('access-dlg');
  const err = $('access-error');
  $('access-title').textContent = `Access for ${u.name}`;
  const editor = accessEditor($('access-host'), u.access);
  err.hidden = true;
  $('access-form').onsubmit = async (e) => {
    e.preventDefault();
    try {
      await api('PATCH', `/api/users/${u.id}`, { access: editor.get() });
      dlg.close();
      toast('Access saved');
      await refresh();
    } catch (ex) {
      err.textContent = ex.message;
      err.hidden = false;
    }
  };
  dlg.showModal();
}

async function refresh() {
  try {
    [status, users] = await Promise.all([api('GET', '/api/status'), api('GET', '/api/users')]);
    renderUsers();
    renderStatus();
  } catch {
    $('mqtt').className = 'dot off';
    $('mqtt-text').textContent = 'Server unreachable';
  }
}

let addAccess = accessEditor($('add-access'), null);

$('add-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const err = $('add-error');
  err.hidden = true;
  try {
    const access = addAccess.get();
    await api('POST', '/api/users', { name: form.elements.name.value, pin: form.elements.pin.value.trim(), access });
    form.reset();
    addAccess = accessEditor($('add-access'), null);
    toast(access ? 'User added with limited access' : 'User added, sending to lock…');
  } catch (ex) {
    err.textContent = ex.message;
    err.hidden = false;
  }
  await refresh();
});

$('btn-lock').addEventListener('click', () => act(() => api('POST', '/api/lock', { state: 'LOCK' }), 'Locking…'));
$('btn-unlock').addEventListener('click', () => act(() => api('POST', '/api/lock', { state: 'UNLOCK' }), 'Unlocking…'));

$('dlg-cancel').addEventListener('click', () => $('dlg').close());
$('access-cancel').addEventListener('click', () => $('access-dlg').close());

refresh();
setInterval(() => { if (!document.hidden && !$('dlg').open && !$('access-dlg').open) refresh(); }, 3000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
