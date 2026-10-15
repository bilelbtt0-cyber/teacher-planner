// All event times are stored as wall-clock strings "YYYY-MM-DDTHH:mm" in the user's timezone.
// Arithmetic is done by treating those strings as UTC, which gives exact calendar math
// with no DST surprises; "now" is converted into the user's timezone before comparing.

const pad = (n) => String(n).padStart(2, '0');

export function isWallClock(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(s) && !Number.isNaN(toDate(s).getTime());
}

export function isDateOnly(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(new Date(s + 'T00:00:00Z').getTime());
}

export function toDate(wall) {
  return new Date(wall + ':00Z');
}

export function fromDate(d) {
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

export function addMinutes(wall, minutes) {
  return fromDate(new Date(toDate(wall).getTime() + minutes * 60000));
}

export function addDays(wall, days) {
  const d = toDate(wall);
  d.setUTCDate(d.getUTCDate() + days);
  return fromDate(d);
}

export function diffMinutes(a, b) {
  return Math.round((toDate(b).getTime() - toDate(a).getTime()) / 60000);
}

export function nowIn(timezone) {
  let parts;
  try {
    parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(new Date());
  } catch {
    return fromDate(new Date());
  }
  const get = (t) => parts.find((p) => p.type === t).value;
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}`;
}

export function datePart(wall) {
  return wall.slice(0, 10);
}

export function timePart(wall) {
  return wall.slice(11, 16);
}

/** True if "HH:mm" time t falls inside the window [start, end) which may wrap midnight. */
export function inWindow(t, start, end) {
  if (start === end) return false;
  return start < end ? t >= start && t < end : t >= start || t < end;
}

export function isValidTimezone(tz) {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
