import { toDate, fromDate, isDateOnly } from './time.js';

export const MAX_OCCURRENCES = 500;
const MAX_SPAN_DAYS = 3 * 366;

/** Validates and normalises a recurrence rule. Throws a user-facing message on invalid input. */
export function normalizeRule(rule) {
  if (!rule || typeof rule !== 'object') return null;
  const freq = rule.freq;
  if (!['daily', 'weekly', 'monthly'].includes(freq)) return null;
  const interval = Math.max(1, Math.min(52, parseInt(rule.interval, 10) || 1));
  let byweekday = Array.isArray(rule.byweekday)
    ? [...new Set(rule.byweekday.map((d) => parseInt(d, 10)).filter((d) => d >= 0 && d <= 6))].sort()
    : [];
  const until = rule.until && isDateOnly(rule.until) ? rule.until : null;
  const count = rule.count ? Math.max(1, Math.min(MAX_OCCURRENCES, parseInt(rule.count, 10) || 0)) : null;
  if (!until && !count) throw httpError(400, 'Choose when the repetition ends (a date or a number of sessions).');
  if (freq !== 'weekly') byweekday = [];
  return { freq, interval, byweekday, until, count };
}

/** Returns the list of occurrence start times ("YYYY-MM-DDTHH:mm") for a series starting at `start`. */
export function expand(start, rule) {
  const first = toDate(start);
  const limit = new Date(first.getTime() + MAX_SPAN_DAYS * 86400000);
  const untilEnd = rule.until ? new Date(rule.until + 'T23:59:59Z') : limit;
  const stop = untilEnd < limit ? untilEnd : limit;
  const max = rule.count || MAX_OCCURRENCES;
  const out = [];

  if (rule.freq === 'daily') {
    for (let d = new Date(first); d <= stop && out.length < max; d.setUTCDate(d.getUTCDate() + rule.interval)) {
      out.push(fromDate(d));
    }
  } else if (rule.freq === 'weekly') {
    const days = rule.byweekday.length ? rule.byweekday : [first.getUTCDay()];
    // Monday of the first week, used to compute the week index for "every N weeks".
    const weekAnchor = new Date(first);
    weekAnchor.setUTCDate(weekAnchor.getUTCDate() - ((weekAnchor.getUTCDay() + 6) % 7));
    for (let d = new Date(first); d <= stop && out.length < max; d.setUTCDate(d.getUTCDate() + 1)) {
      const weekIndex = Math.floor((d - weekAnchor) / (7 * 86400000));
      if (weekIndex % rule.interval === 0 && days.includes(d.getUTCDay())) out.push(fromDate(d));
    }
  } else if (rule.freq === 'monthly') {
    const day = first.getUTCDate();
    for (let i = 0; out.length < max; i += rule.interval) {
      const d = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + i, 1, first.getUTCHours(), first.getUTCMinutes()));
      if (d > stop) break;
      const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
      if (day > lastDay) continue; // e.g. the 31st does not exist this month: skip, like most calendars
      d.setUTCDate(day);
      if (d > stop) break;
      out.push(fromDate(d));
    }
  }
  return out;
}

export function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}
