// Access rules: when should a user's code be on the lock?
//
// access = null                      → always (while enabled)
// access = {
//   from:  'YYYY-MM-DDTHH:MM' | null, // local wall-clock time (container TZ)
//   until: 'YYYY-MM-DDTHH:MM' | null,
//   weekly: [{ days: [0..6], start: 'HH:MM', end: 'HH:MM' }],  // 0 = Sunday; empty = any time
//   maxUses: integer >= 1 | null,
// }
// Everything is computed in local time with Date's local constructors, so daylight
// saving changes keep "Wednesday 08:00" at 08:00 on the wall clock.

const DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function parseLocal(s) {
  if (typeof s !== 'string' || !DATETIME_RE.test(s)) return null;
  const d = new Date(s); // no zone suffix => local time
  if (Number.isNaN(d.getTime())) return null;
  // Date silently rolls over impossible values (30 Feb → 2 Mar, 24:00 → next day): reject them.
  const [y, mo, day, h, mi] = s.split(/[-T:]/).map(Number);
  const same = d.getFullYear() === y && d.getMonth() + 1 === mo && d.getDate() === day && d.getMinutes() === mi
    // a time skipped by a DST change (02:30 in spring) moves forward an hour; allow that
    && (d.getHours() === h || d.getHours() === (h + 1) % 24);
  return same && h < 24 ? d : null;
}

const minutes = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

function atTime(day, hhmm) {
  return new Date(day.getFullYear(), day.getMonth(), day.getDate(), Number(hhmm.slice(0, 2)), Number(hhmm.slice(3, 5)));
}

const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);

/** Returns an error message, or null when valid. */
export function validateAccess(access) {
  if (access == null) return null;
  if (typeof access !== 'object' || Array.isArray(access)) return 'Access must be an object';
  const { from, until, weekly, maxUses } = access;
  if (from != null && !parseLocal(from)) return 'Start date/time is not valid';
  if (until != null && !parseLocal(until)) return 'End date/time is not valid';
  if (from != null && until != null && parseLocal(from) >= parseLocal(until)) return 'End must be after start';
  if (weekly != null) {
    if (!Array.isArray(weekly)) return 'Weekly times must be a list';
    for (const w of weekly) {
      if (!w || !Array.isArray(w.days) || w.days.length === 0) return 'Each weekly time needs at least one day';
      if (!w.days.every((d) => Number.isInteger(d) && d >= 0 && d <= 6)) return 'Days must be 0 (Sunday) to 6 (Saturday)';
      if (!TIME_RE.test(w.start ?? '') || !TIME_RE.test(w.end ?? '')) return 'Weekly times must be HH:MM';
      if (minutes(w.start) >= minutes(w.end)) return 'Weekly end time must be after start time (same day)';
    }
  }
  if (maxUses != null && !(Number.isInteger(maxUses) && maxUses >= 1)) return 'Max uses must be a whole number of at least 1';
  return null;
}

/** Window occurrences [start, end) on the given local day. */
function windowsOn(weekly, day) {
  return weekly
    .filter((w) => w.days.includes(day.getDay()))
    .map((w) => [atTime(day, w.start), atTime(day, w.end)]);
}

function usesExhausted(user) {
  const max = user.access?.maxUses;
  return max != null && (user.uses ?? 0) >= max;
}

export function isExpired(user, now) {
  const a = user.access;
  if (!a) return false;
  const until = a.until ? parseLocal(a.until) : null;
  return (until != null && now >= until) || usesExhausted(user);
}

export function desiredState(user, now, leadMs) {
  if (!user.enabled) return 'off';
  const a = user.access;
  if (!a) return 'on';
  const from = a.from ? parseLocal(a.from) : null;
  if (from && now.getTime() < from.getTime() - leadMs) return 'off';
  if (isExpired(user, now)) return 'off';
  const weekly = a.weekly ?? [];
  if (weekly.length === 0) return 'on';
  // A window opens `leadMs` early, which may fall on the previous day, so also check
  // the windows of the day `leadMs` ahead.
  const days = [startOfDay(now), startOfDay(new Date(now.getTime() + leadMs))];
  for (const day of days) {
    for (const [s, e] of windowsOn(weekly, day)) {
      if (now.getTime() >= s.getTime() - leadMs && now < e) return 'on';
    }
  }
  return 'off';
}

/** The next moment the desired state differs from now, or null if it never changes by time alone. */
export function nextChange(user, now, leadMs) {
  const a = user.access;
  if (!a || !user.enabled) return null;
  const candidates = [];
  if (a.from) candidates.push(new Date(parseLocal(a.from).getTime() - leadMs));
  if (a.until) candidates.push(parseLocal(a.until));
  // Weekly windows only matter once the period has started, which may be far ahead.
  const fromDate = a.from ? parseLocal(a.from) : null;
  const base = fromDate && fromDate > now ? fromDate : now;
  for (let i = -1; i <= 8; i++) {
    for (const [s, e] of windowsOn(a.weekly ?? [], addDays(base, i))) {
      candidates.push(new Date(s.getTime() - leadMs), e);
    }
  }
  const current = desiredState(user, now, leadMs);
  return candidates
    .filter((t) => t > now)
    .sort((x, y) => x - y)
    .find((t) => desiredState(user, t, leadMs) !== current) ?? null;
}

/** When the code should have gone off: used for the overdue-removal warning. */
export function offDueSince(user, now) {
  if (!user.enabled || usesExhausted(user)) return now;
  const a = user.access;
  if (!a) return now;
  const candidates = [];
  const until = a.until ? parseLocal(a.until) : null;
  if (until && until <= now) candidates.push(until);
  for (let i = 0; i <= 8; i++) {
    for (const [, e] of windowsOn(a.weekly ?? [], addDays(now, -i))) {
      if (e <= now) candidates.push(e);
    }
  }
  if (candidates.length === 0) return now;
  return new Date(Math.max(...candidates.map((d) => d.getTime())));
}

export function accessState(user, now, leadMs) {
  if (!user.enabled) return 'disabled';
  if (!user.access) return 'always';
  if (isExpired(user, now)) return 'expired';
  return desiredState(user, now, leadMs) === 'on' ? 'active' : 'scheduled';
}

