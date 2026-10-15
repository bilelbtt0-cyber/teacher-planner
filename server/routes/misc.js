import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ZipArchive } from 'archiver';
import { db, getSettings, saveSettings, DEFAULT_SETTINGS, UPLOAD_DIR } from '../db.js';
import { httpError } from '../recurrence.js';
import { nowIn, addDays, datePart, isDateOnly, isValidTimezone, toDate } from '../time.js';
import { serializeEvent, KINDS } from './events.js';
import { serializeDoc } from './documents.js';
import { categoryProgress, teachingHours } from '../attestation.js';
import { sendMail, smtpConfigured, recipient, layout } from '../mailer.js';
import { tick } from '../scheduler.js';

export const miscRouter = Router();

// ---------- Dashboard ----------

miscRouter.get('/dashboard', (req, res) => {
  const settings = getSettings();
  const now = nowIn(settings.timezone);
  const today = `${datePart(now)}T00:00`;
  const tomorrow = addDays(today, 1);
  const d = toDate(today);
  const weekStart = addDays(today, -((d.getUTCDay() + 6) % 7));
  const weekEnd = addDays(weekStart, 7);
  const monthStart = `${now.slice(0, 7)}-01T00:00`;
  const nm = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
  const monthEnd = `${nm.toISOString().slice(0, 10)}T00:00`;

  const withCat = `SELECT e.*, (SELECT COUNT(*) FROM document_events x WHERE x.event_id = e.id) AS document_count FROM events e`;
  const todayEvents = db.prepare(`${withCat} WHERE e.start < ? AND e.end > ? ORDER BY e.all_day DESC, e.start`).all(tomorrow, today);
  const upcoming = db
    .prepare(`${withCat} WHERE e.start >= ? AND e.start < ? AND e.status = 'scheduled' ORDER BY e.start LIMIT 12`)
    .all(tomorrow, addDays(today, 8));
  const pending = db
    .prepare(
      `${withCat} WHERE e.attestation_required = 1 AND e.attestation_status = 'pending' AND e.status = 'scheduled' AND e.end <= ? ORDER BY e.end`
    )
    .all(now);
  const upcomingAttestations = db
    .prepare(
      `${withCat} WHERE e.attestation_required = 1 AND e.attestation_status = 'pending' AND e.status = 'scheduled'
       AND e.end > ? AND e.start < ? ORDER BY e.start`
    )
    .all(now, addDays(today, 15));

  const hoursIn = (from, to, onlyPast) => {
    const rows = db.prepare(`SELECT * FROM events WHERE start >= ? AND start < ?`).all(from, to);
    return rows.filter((e) => !onlyPast || e.end <= now).reduce((sum, e) => sum + teachingHours(e), 0);
  };

  res.json({
    now,
    today: todayEvents.map((e) => serializeEvent(e)),
    upcoming: upcoming.map((e) => serializeEvent(e)),
    pendingAttestations: pending.map((e) => serializeEvent(e)),
    upcomingAttestations: upcomingAttestations.map((e) => serializeEvent(e)),
    stats: {
      weekHoursPlanned: round(hoursIn(weekStart, weekEnd, false)),
      weekHoursDone: round(hoursIn(weekStart, weekEnd, true)),
      monthHoursPlanned: round(hoursIn(monthStart, monthEnd, false)),
      monthHoursDone: round(hoursIn(monthStart, monthEnd, true)),
      receivedThisYear: db
        .prepare(`SELECT COUNT(*) AS n FROM events WHERE attestation_status = 'received' AND substr(attestation_received_at,1,4) = ?`)
        .get(now.slice(0, 4)).n,
      documents: db.prepare('SELECT COUNT(*) AS n FROM documents').get().n,
    },
    progress: categoryProgress(now).filter((p) => p.everyHours),
    emailReady: smtpConfigured(settings) && settings.emailEnabled,
  });
});

const round = (n) => Math.round(n * 100) / 100;

miscRouter.get('/attestations', (req, res) => {
  const settings = getSettings();
  const now = nowIn(settings.timezone);
  const rows = db
    .prepare(
      `SELECT e.*, (SELECT COUNT(*) FROM document_events x WHERE x.event_id = e.id) AS document_count
       FROM events e WHERE e.attestation_required = 1 AND e.status = 'scheduled' ORDER BY e.start`
    )
    .all();
  const out = { overdue: [], upcoming: [], received: [], waived: [] };
  for (const r of rows) {
    const ev = serializeEvent(r);
    if (r.attestation_status === 'received') out.received.push(ev);
    else if (r.attestation_status === 'waived') out.waived.push(ev);
    else if (r.end <= now) out.overdue.push(ev);
    else out.upcoming.push(ev);
  }
  out.received.reverse();
  out.waived.reverse();
  res.json({ now, ...out, progress: categoryProgress(now) });
});

// ---------- Hours report ----------

miscRouter.get('/stats/hours', (req, res) => {
  const year = /^\d{4}$/.test(req.query.year) ? req.query.year : nowIn(getSettings().timezone).slice(0, 4);
  const rows = db.prepare(`SELECT * FROM events WHERE substr(start, 1, 4) = ?`).all(year);
  const byMonth = Array.from({ length: 12 }, () => ({}));
  const totals = {};
  for (const e of rows) {
    const h = teachingHours(e);
    if (!h) continue;
    const m = parseInt(e.start.slice(5, 7), 10) - 1;
    const key = e.category_id || 0;
    byMonth[m][key] = round((byMonth[m][key] || 0) + h);
    totals[key] = round((totals[key] || 0) + h);
  }
  res.json({ year, byMonth, totals });
});

// ---------- Search ----------

miscRouter.get('/search', (req, res) => {
  const { q = '', from, to, categoryId, kind, attestation, status } = req.query;
  const where = [];
  const args = [];
  const term = String(q).trim();
  if (term) {
    const like = `%${term}%`;
    where.push(`(e.title LIKE ? OR e.location LIKE ? OR e.notes LIKE ? OR e.attestation_note LIKE ? OR c.name LIKE ?)`);
    args.push(like, like, like, like, like);
  }
  if (from && isDateOnly(from)) {
    where.push('e.start >= ?');
    args.push(`${from}T00:00`);
  }
  if (to && isDateOnly(to)) {
    where.push('e.start < ?');
    args.push(addDays(`${to}T00:00`, 1));
  }
  if (categoryId) {
    where.push('e.category_id = ?');
    args.push(parseInt(categoryId, 10));
  }
  if (kind && KINDS.includes(kind)) {
    where.push('e.kind = ?');
    args.push(kind);
  }
  if (attestation === 'required') where.push('e.attestation_required = 1');
  else if (['pending', 'received', 'waived'].includes(attestation)) {
    where.push('e.attestation_required = 1 AND e.attestation_status = ?');
    args.push(attestation);
  } else if (attestation === 'none') where.push('e.attestation_required = 0');
  if (status === 'cancelled' || status === 'scheduled') {
    where.push('e.status = ?');
    args.push(status);
  }
  const events = db
    .prepare(
      `SELECT e.*, (SELECT COUNT(*) FROM document_events x WHERE x.event_id = e.id) AS document_count
       FROM events e LEFT JOIN categories c ON c.id = e.category_id
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY e.start DESC LIMIT 301`
    )
    .all(...args);

  let documents = [];
  if (term) {
    const like = `%${term}%`;
    documents = db
      .prepare(
        `SELECT d.*, c.name AS category_name, c.color AS category_color
         FROM documents d LEFT JOIN categories c ON c.id = d.category_id
         WHERE d.title LIKE ? OR d.notes LIKE ? OR d.tags LIKE ? OR c.name LIKE ? OR d.original_name LIKE ?
         ORDER BY COALESCE(d.doc_date, d.created_at) DESC LIMIT 50`
      )
      .all(like, like, like, like, like)
      .map(serializeDoc);
  }
  const totalHours = events.slice(0, 300).reduce((s, e) => s + teachingHours(e), 0);
  res.json({
    events: events.slice(0, 300).map((e) => serializeEvent(e)),
    truncated: events.length > 300,
    totalHours: round(totalHours),
    documents,
  });
});

// ---------- Notifications ----------

miscRouter.get('/notifications', (req, res) => {
  const rows = db.prepare(`SELECT * FROM notifications ORDER BY created_at DESC, id DESC LIMIT 60`).all();
  const unread = db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE read_at IS NULL').get().n;
  const pending = db
    .prepare(
      `SELECT COUNT(*) AS n FROM events WHERE attestation_required = 1 AND attestation_status = 'pending' AND status = 'scheduled' AND end <= ?`
    )
    .get(nowIn(getSettings().timezone)).n;
  res.json({
    unread,
    pendingAttestations: pending,
    items: rows.map((n) => ({
      id: n.id,
      type: n.type,
      title: n.title,
      body: n.body,
      eventId: n.event_id,
      createdAt: n.created_at,
      read: !!n.read_at,
    })),
  });
});

miscRouter.post('/notifications/read-all', (req, res) => {
  db.prepare(`UPDATE notifications SET read_at = datetime('now') WHERE read_at IS NULL`).run();
  res.json({ ok: true });
});

miscRouter.post('/notifications/:id/read', (req, res) => {
  db.prepare(`UPDATE notifications SET read_at = datetime('now') WHERE id = ? AND read_at IS NULL`).run(parseInt(req.params.id, 10));
  res.json({ ok: true });
});

// ---------- Settings ----------

function publicSettings() {
  const s = getSettings();
  return {
    ...s,
    smtp: { ...s.smtp, pass: s.smtp.pass ? '__unchanged__' : '' },
    smtpConfigured: smtpConfigured(s),
    recipient: recipient(s),
  };
}

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

miscRouter.get('/settings', (req, res) => res.json(publicSettings()));

miscRouter.put('/settings', (req, res) => {
  const b = req.body || {};
  const current = getSettings();
  const patch = {};
  if (b.language !== undefined) patch.language = b.language === 'fr' ? 'fr' : 'en';
  if (b.theme !== undefined) patch.theme = ['light', 'dark', 'system'].includes(b.theme) ? b.theme : 'system';
  if (b.timezone !== undefined) {
    if (!isValidTimezone(b.timezone)) throw httpError(400, 'Unknown timezone.');
    patch.timezone = b.timezone;
  }
  if (b.weekStart !== undefined) patch.weekStart = b.weekStart === 0 ? 0 : 1;
  for (const k of ['dayStart', 'dayEnd', 'quietStart', 'quietEnd', 'digestTime']) {
    if (b[k] !== undefined) {
      if (!TIME.test(b[k])) throw httpError(400, 'Please enter times as HH:MM.');
      patch[k] = b[k];
    }
  }
  if ((patch.dayStart || current.dayStart) >= (patch.dayEnd || current.dayEnd))
    throw httpError(400, 'The day must end after it starts.');
  if (b.notifyEmail !== undefined) {
    const e = String(b.notifyEmail).trim();
    if (e && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) throw httpError(400, 'Please enter a valid email address.');
    patch.notifyEmail = e;
  }
  if (b.emailEnabled !== undefined) patch.emailEnabled = !!b.emailEnabled;
  if (b.digestEnabled !== undefined) patch.digestEnabled = !!b.digestEnabled;
  if (b.nagIntervalHours !== undefined) {
    const n = Number(b.nagIntervalHours);
    if (!Number.isFinite(n) || n < 1 || n > 168) throw httpError(400, 'The reminder interval must be between 1 and 168 hours.');
    patch.nagIntervalHours = n;
  }
  if (b.defaultReminders !== undefined && Array.isArray(b.defaultReminders)) {
    patch.defaultReminders = b.defaultReminders
      .map((r) => ({ minutes: parseInt(r.minutes, 10), email: !!r.email }))
      .filter((r) => Number.isFinite(r.minutes) && r.minutes >= 0)
      .slice(0, 6);
  }
  if (b.smtp !== undefined) {
    const s = b.smtp || {};
    const port = parseInt(s.port, 10);
    patch.smtp = {
      host: String(s.host || '').trim(),
      port: Number.isFinite(port) && port > 0 ? port : DEFAULT_SETTINGS.smtp.port,
      secure: !!s.secure,
      user: String(s.user || '').trim(),
      pass: s.pass === '__unchanged__' ? current.smtp.pass : String(s.pass || ''),
      from: String(s.from || '').trim(),
    };
  }
  saveSettings(patch);
  res.json(publicSettings());
});

miscRouter.post('/settings/test-email', async (req, res) => {
  const s = getSettings();
  const fr = s.language === 'fr';
  await sendMail(
    {
      subject: fr ? 'Test : vos emails fonctionnent' : 'Test: your emails are working',
      html: layout({
        heading: fr ? 'Tout fonctionne ✔' : 'Everything works ✔',
        intro: fr
          ? 'Vous recevrez vos rappels et vos attestations manquantes à cette adresse.'
          : 'Your reminders and missing-attestation alerts will arrive at this address.',
      }),
      text: 'Test email from your Planner.',
    },
    { throwOnError: true, force: true }
  );
  res.json({ ok: true, to: recipient(s) });
});

miscRouter.get('/settings/email-log', (req, res) => {
  res.json(db.prepare('SELECT * FROM email_log ORDER BY id DESC LIMIT 30').all());
});

miscRouter.post('/scheduler/run', async (req, res) => {
  await tick();
  res.json({ ok: true });
});

// ---------- Export ----------

function icsEscape(s) {
  return String(s || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}
const icsDate = (w) => w.replace(/[-:]/g, '') + '00';

miscRouter.get('/export/calendar.ics', (req, res) => {
  const s = getSettings();
  const cats = new Map(db.prepare('SELECT id, name FROM categories').all().map((c) => [c.id, c.name]));
  const rows = db.prepare(`SELECT * FROM events WHERE status = 'scheduled' ORDER BY start`).all();
  const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15) + 'Z';
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Planner//EN', 'CALSCALE:GREGORIAN', `X-WR-TIMEZONE:${s.timezone}`];
  for (const e of rows) {
    lines.push('BEGIN:VEVENT', `UID:event-${e.id}@planner`, `DTSTAMP:${stamp}`);
    if (e.all_day) {
      lines.push(`DTSTART;VALUE=DATE:${e.start.slice(0, 10).replace(/-/g, '')}`, `DTEND;VALUE=DATE:${e.end.slice(0, 10).replace(/-/g, '')}`);
    } else {
      lines.push(`DTSTART;TZID=${s.timezone}:${icsDate(e.start)}`, `DTEND;TZID=${s.timezone}:${icsDate(e.end)}`);
    }
    lines.push(`SUMMARY:${icsEscape(e.title)}`);
    if (e.location) lines.push(`LOCATION:${icsEscape(e.location)}`);
    const desc = [cats.get(e.category_id), e.notes, e.attestation_required ? `Attestation: ${e.attestation_status}` : '']
      .filter(Boolean)
      .join('\n');
    if (desc) lines.push(`DESCRIPTION:${icsEscape(desc)}`);
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="planner.ics"');
  res.send(lines.join('\r\n'));
});

miscRouter.get('/export/backup', async (req, res) => {
  const tmp = path.join(os.tmpdir(), `planner-backup-${Date.now()}.db`);
  db.prepare('VACUUM INTO ?').run(tmp);
  const date = nowIn(getSettings().timezone).slice(0, 10);
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="planner-backup-${date}.zip"`);
  const archive = new ZipArchive({ zlib: { level: 6 } });
  archive.on('error', (err) => {
    console.error('[backup]', err);
    res.destroy(err);
  });
  res.on('close', () => fs.rm(tmp, { force: true }, () => {}));
  archive.pipe(res);
  archive.file(tmp, { name: 'planner.db' });
  archive.directory(UPLOAD_DIR, 'uploads');
  archive.append(
    'Planner backup\n\nTo restore: stop the app, replace data/planner.db with planner.db from this archive,\nand copy the "uploads" folder into data/. Then start the app again.\n',
    { name: 'README.txt' }
  );
  await archive.finalize();
});
