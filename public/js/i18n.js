// English strings are the keys; French translations live in fr.js. A missing translation
// simply falls back to English, so the UI can never show a raw key.
import { FR } from './fr.js';

let lang = 'en';

export function setLanguage(l) {
  lang = l === 'fr' ? 'fr' : 'en';
  document.documentElement.lang = lang;
}
export const getLanguage = () => lang;
export const locale = () => (lang === 'fr' ? 'fr-FR' : 'en-GB');

export function t(str, vars) {
  let out = lang === 'fr' && FR[str] ? FR[str] : str;
  if (vars) out = out.replace(/\{(\w+)\}/g, (m, k) => (vars[k] !== undefined ? vars[k] : m));
  return out;
}

/** Plural helper: tn(3, '{n} session', '{n} sessions'). */
export function tn(n, one, other, vars = {}) {
  const useOne = lang === 'fr' ? Math.abs(n) < 2 : n === 1;
  return t(useOne ? one : other, { n, ...vars });
}

// ---------- Dates (wall-clock strings "YYYY-MM-DDTHH:mm") ----------

const pad = (n) => String(n).padStart(2, '0');
export const wallToDate = (w) => new Date(w.length === 10 ? `${w}T00:00` : w);
export function dateToWall(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
export const nowWall = () => dateToWall(new Date());
export const todayStr = () => nowWall().slice(0, 10);
export function addDaysStr(dateStr, n) {
  const d = new Date(`${dateStr}T12:00`);
  d.setDate(d.getDate() + n);
  return dateToWall(d).slice(0, 10);
}
export function addMinutesWall(w, m) {
  return dateToWall(new Date(wallToDate(w).getTime() + m * 60000));
}
export function minutesBetween(a, b) {
  return Math.round((wallToDate(b) - wallToDate(a)) / 60000);
}

const fmtCache = new Map();
function fmt(opts) {
  const key = lang + JSON.stringify(opts);
  if (!fmtCache.has(key)) fmtCache.set(key, new Intl.DateTimeFormat(locale(), opts));
  return fmtCache.get(key);
}

export const fmtTime = (w) => w.slice(11, 16);
export const fmtDay = (w) => fmt({ weekday: 'long', day: 'numeric', month: 'long' }).format(wallToDate(w));
export const fmtDayYear = (w) => fmt({ weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(wallToDate(w));
export const fmtShort = (w) => fmt({ weekday: 'short', day: 'numeric', month: 'short' }).format(wallToDate(w));
export const fmtDate = (w) => fmt({ day: 'numeric', month: 'short', year: 'numeric' }).format(wallToDate(w));
const capFirst = (s) => s.charAt(0).toUpperCase() + s.slice(1);
export const fmtMonthYear = (w) => capFirst(fmt({ month: 'long', year: 'numeric' }).format(wallToDate(w)));
export const fmtMonthShort = (w) => fmt({ month: 'short' }).format(wallToDate(w));
export const fmtWeekdayShort = (dayIndex) =>
  // dayIndex: 0 = Sunday … 6 = Saturday (2023-01-01 was a Sunday)
  fmt({ weekday: 'short' }).format(new Date(2023, 0, 1 + dayIndex));
export const fmtWeekdayLong = (dayIndex) => fmt({ weekday: 'long' }).format(new Date(2023, 0, 1 + dayIndex));

/** "Today", "Tomorrow", "Yesterday" or the formatted day. */
export function relativeDay(w) {
  const d = w.slice(0, 10);
  const today = todayStr();
  if (d === today) return t('Today');
  if (d === addDaysStr(today, 1)) return t('Tomorrow');
  if (d === addDaysStr(today, -1)) return t('Yesterday');
  const diff = Math.round((new Date(`${d}T12:00`) - new Date(`${today}T12:00`)) / 86400000);
  if (diff > 1 && diff < 7) return fmt({ weekday: 'long' }).format(wallToDate(w));
  return fmtShort(w);
}

export function timeRange(e) {
  if (e.allDay) {
    const lastDay = addDaysStr(e.end.slice(0, 10), -1);
    return lastDay > e.start.slice(0, 10) ? `${fmtShort(e.start)} → ${fmtShort(lastDay)}` : t('All day');
  }
  return `${fmtTime(e.start)} – ${fmtTime(e.end)}`;
}

export function durationLabel(minutes) {
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h} h ${pad(m)}` : `${h} h`;
}

export function hoursLabel(h) {
  const n = Math.round((h || 0) * 100) / 100;
  return `${n.toLocaleString(locale(), { maximumFractionDigits: 2 })} h`;
}

export function daysAgo(w) {
  return Math.floor((Date.now() - wallToDate(w).getTime()) / 86400000);
}

export function timeAgo(w) {
  const mins = Math.round((Date.now() - wallToDate(w).getTime()) / 60000);
  if (mins < 1) return t('just now');
  if (mins < 60) return t('{n} min ago', { n: mins });
  const h = Math.round(mins / 60);
  if (h < 24) return t('{n} h ago', { n: h });
  const d = Math.round(h / 24);
  if (d < 7) return tn(d, '{n} day ago', '{n} days ago');
  return fmtDate(w);
}

export function reminderLabel(minutes) {
  if (minutes === 0) return t('At start time');
  if (minutes < 60) return t('{n} min before', { n: minutes });
  if (minutes < 1440) return tn(minutes / 60, '{n} hour before', '{n} hours before');
  if (minutes % 10080 === 0) return tn(minutes / 10080, '{n} week before', '{n} weeks before');
  return tn(Math.round(minutes / 1440), '{n} day before', '{n} days before');
}

export function fileSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
