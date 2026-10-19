import { db, getSettings } from './db.js';
import { nowIn, addMinutes, toDate, timePart, datePart, inWindow, addDays } from './time.js';
import { sendMail, layout, itemRow, esc, APP_URL } from './mailer.js';
import { runAnnouncements } from './announcements.js';

const STRINGS = {
  en: {
    reminderSubject: (t) => `Reminder: ${t}`,
    remindersSubject: (n) => `${n} upcoming appointments`,
    reminderHeading: 'Coming up',
    attNeeded: 'Attestation needed',
    attHeadsUp: 'Remember to ask for your attestation at this session.',
    nagSubject: (n) => (n === 1 ? 'Attestation still missing' : `${n} attestations still missing`),
    nagHeading: (n) => (n === 1 ? 'You still have 1 attestation to collect' : `You still have ${n} attestations to collect`),
    nagIntro: 'These reminders will continue until you mark each attestation as received (or not needed).',
    nagCta: 'Open my attestations',
    overdue: (d) => `${d} day${d > 1 ? 's' : ''} overdue`,
    today: 'Today',
    digestSubject: (d) => `Your day — ${d}`,
    digestHeading: 'Good morning! Here is your day',
    noEvents: 'Nothing scheduled today.',
    pendingTitle: 'Attestations to collect',
    cta: 'Open my planner',
    notifReminder: (t) => `Coming up: ${t}`,
    notifAttStart: (t) => `Ask for the attestation: ${t}`,
    notifAttStartBody: 'This session needs an attestation. Ask for it before you leave.',
    notifNag: (t) => `Attestation missing: ${t}`,
    notifNagBody: 'Mark it as received once you have it, ideally with a scan.',
    allDay: 'All day',
    in: (m) => (m < 60 ? `in ${m} min` : m < 1440 ? `in ${Math.round(m / 60)} h` : `in ${Math.round(m / 1440)} day(s)`),
  },
  fr: {
    reminderSubject: (t) => `Rappel : ${t}`,
    remindersSubject: (n) => `${n} rendez-vous à venir`,
    reminderHeading: 'À venir',
    attNeeded: 'Attestation à demander',
    attHeadsUp: "Pensez à demander votre attestation lors de cette séance.",
    nagSubject: (n) => (n === 1 ? 'Attestation toujours manquante' : `${n} attestations toujours manquantes`),
    nagHeading: (n) => (n === 1 ? 'Il vous reste 1 attestation à récupérer' : `Il vous reste ${n} attestations à récupérer`),
    nagIntro: "Ces rappels continueront jusqu'à ce que chaque attestation soit marquée comme reçue (ou non nécessaire).",
    nagCta: 'Voir mes attestations',
    overdue: (d) => `en retard de ${d} jour${d > 1 ? 's' : ''}`,
    today: "Aujourd'hui",
    digestSubject: (d) => `Votre journée — ${d}`,
    digestHeading: 'Bonjour ! Voici votre journée',
    noEvents: "Rien de prévu aujourd'hui.",
    pendingTitle: 'Attestations à récupérer',
    cta: 'Ouvrir mon agenda',
    notifReminder: (t) => `À venir : ${t}`,
    notifAttStart: (t) => `Demandez l'attestation : ${t}`,
    notifAttStartBody: 'Cette séance nécessite une attestation. Demandez-la avant de partir.',
    notifNag: (t) => `Attestation manquante : ${t}`,
    notifNagBody: "Marquez-la comme reçue dès que vous l'avez, idéalement avec un scan.",
    allDay: 'Toute la journée',
    in: (m) => (m < 60 ? `dans ${m} min` : m < 1440 ? `dans ${Math.round(m / 60)} h` : `dans ${Math.round(m / 1440)} jour(s)`),
  },
};

function fmt(settings) {
  const locale = settings.language === 'fr' ? 'fr-FR' : 'en-GB';
  const opts = { timeZone: 'UTC' };
  return {
    day: (w) => new Intl.DateTimeFormat(locale, { ...opts, weekday: 'long', day: 'numeric', month: 'long' }).format(toDate(w)),
    short: (w) => new Intl.DateTimeFormat(locale, { ...opts, weekday: 'short', day: 'numeric', month: 'short' }).format(toDate(w)),
    time: (w) => timePart(w),
  };
}

async function wasSent(key) {
  return !!(await db.get('SELECT 1 AS ok FROM sent_log WHERE key = ?', key));
}
function markSent(key) {
  return db.run('INSERT OR IGNORE INTO sent_log (key) VALUES (?)', key);
}

export async function notify({ type, title, body = '', eventId = null, now, replaceUnread = false }) {
  if (replaceUnread && eventId) {
    const existing = await db.get('SELECT id FROM notifications WHERE event_id = ? AND type = ? AND read_at IS NULL', eventId, type);
    if (existing) {
      await db.run('UPDATE notifications SET title = ?, body = ?, created_at = ? WHERE id = ?', title, body, now, existing.id);
      return;
    }
  }
  await db.run('INSERT INTO notifications (type, title, body, event_id, created_at) VALUES (?, ?, ?, ?, ?)', type, title, body, eventId, now);
}

async function categoryMap() {
  const map = new Map();
  for (const c of await db.all('SELECT id, name, color FROM categories')) map.set(c.id, c);
  return map;
}

function eventMeta(e, f, s, cats) {
  const cat = cats.get(e.category_id);
  const when = e.all_day ? `${f.short(e.start)} · ${s.allDay}` : `${f.short(e.start)} · ${f.time(e.start)}–${f.time(e.end)}`;
  return [when, cat ? esc(cat.name) : '', e.location ? esc(e.location) : ''].filter(Boolean).join(' · ');
}

async function runReminders(settings, now, s, f, cats) {
  const horizon = addMinutes(now, 40320);
  const rows = await db.all(`SELECT * FROM events WHERE status = 'scheduled' AND start > ? AND start <= ? AND reminders != '[]'`, addMinutes(now, -5), horizon);
  const emailItems = [];
  for (const e of rows) {
    let reminders = [];
    try {
      reminders = JSON.parse(e.reminders);
    } catch {
      continue;
    }
    // If several reminders are due at once (e.g. the computer was off), only the closest one is delivered.
    // Time check first (no database), then only the reminders that are due are looked up.
    const due = [];
    for (const r of reminders) {
      if (addMinutes(e.start, -r.minutes) <= now && !(await wasSent(`rem:${e.id}:${r.minutes}:${e.start}`))) due.push(r);
    }
    due.sort((a, b) => a.minutes - b.minutes);
    if (!due.length) continue;
    for (const r of due) await markSent(`rem:${e.id}:${r.minutes}:${e.start}`);
    const r = due[0];
    const minutesLeft = Math.max(0, Math.round((toDate(e.start) - toDate(now)) / 60000));
    const body = `${e.all_day ? s.allDay : `${f.time(e.start)}–${f.time(e.end)}`} · ${s.in(minutesLeft)}${
      e.attestation_required && e.attestation_status === 'pending' ? ` · ${s.attNeeded}` : ''
    }`;
    await notify({ type: 'reminder', title: s.notifReminder(e.title), body, eventId: e.id, now });
    if (due.some((x) => x.email)) emailItems.push(e);
  }
  if (emailItems.length && settings.emailEnabled) {
    const list = emailItems
      .map((e) =>
        itemRow({
          title: e.title,
          meta:
            eventMeta(e, f, s, cats) +
            (e.attestation_required && e.attestation_status === 'pending' ? `<br><b style="color:#b4232a">${esc(s.attHeadsUp)}</b>` : ''),
          color: cats.get(e.category_id)?.color,
          badge: e.attestation_required && e.attestation_status === 'pending' ? s.attNeeded : null,
        })
      )
      .join('');
    await sendMail({
      subject: emailItems.length === 1 ? s.reminderSubject(emailItems[0].title) : s.remindersSubject(emailItems.length),
      html: await layout({ heading: s.reminderHeading, body: list, cta: s.cta, ctaUrl: `${APP_URL}/#/calendar` }),
      text: emailItems.map((e) => `${e.title} — ${e.start.replace('T', ' ')}`).join('\n'),
    });
  }
}

async function runAttestations(settings, now, s, f, cats) {
  // Heads-up when a session that needs an attestation begins.
  const starting = await db.all(`SELECT * FROM events WHERE status = 'scheduled' AND attestation_required = 1 AND attestation_status = 'pending'
       AND start <= ? AND end > ?`, now, now);
  for (const e of starting) {
    const key = `att-start:${e.id}:${e.start}`;
    if (await wasSent(key)) continue;
    await markSent(key);
    await notify({ type: 'attestation', title: s.notifAttStart(e.title), body: s.notifAttStartBody, eventId: e.id, now, replaceUnread: true });
  }

  // Persistent nagging after the session ended, until received or waived.
  if (inWindow(timePart(now), settings.quietStart, settings.quietEnd)) return;
  const pending = await db.all(`SELECT * FROM events WHERE status = 'scheduled' AND attestation_required = 1 AND attestation_status = 'pending'
       AND end <= ? ORDER BY end`, now);
  const interval = Math.max(1, Number(settings.nagIntervalHours) || 24) * 60;
  const due = pending.filter(
    (e) =>
      (!e.attestation_snoozed_until || e.attestation_snoozed_until <= now) &&
      (!e.attestation_last_nag_at || addMinutes(e.attestation_last_nag_at, interval) <= now)
  );
  if (!due.length) return;
  for (const e of due) {
    await db.run('UPDATE events SET attestation_last_nag_at = ? WHERE id = ?', now, e.id);
    await notify({ type: 'attestation', title: s.notifNag(e.title), body: s.notifNagBody, eventId: e.id, now, replaceUnread: true });
  }
  if (!settings.emailEnabled) return;
  // One email listing everything still missing, so many sessions never mean many emails.
  const visible = pending.filter((e) => !e.attestation_snoozed_until || e.attestation_snoozed_until <= now);
  const list = visible
    .map((e) => {
      const days = Math.floor((toDate(now) - toDate(e.end)) / 86400000);
      return itemRow({
        title: e.title,
        meta: eventMeta(e, f, s, cats) + (e.attestation_note ? `<br><i>${esc(e.attestation_note)}</i>` : ''),
        color: cats.get(e.category_id)?.color,
        badge: days >= 1 ? s.overdue(days) : null,
      });
    })
    .join('');
  await sendMail({
    subject: s.nagSubject(visible.length),
    html: await layout({
      heading: s.nagHeading(visible.length),
      intro: s.nagIntro,
      body: list,
      cta: s.nagCta,
      ctaUrl: `${APP_URL}/#/attestations`,
      accent: '#e5484d',
    }),
    text: visible.map((e) => `- ${e.title} (${e.start.replace('T', ' ')})`).join('\n'),
  });
}

async function runDigest(settings, now, s, f, cats) {
  if (!settings.digestEnabled || !settings.emailEnabled) return;
  const today = datePart(now);
  const key = `digest:${today}`;
  const sendAt = `${today}T${settings.digestTime || '07:00'}`;
  // Send within 3 hours after the chosen time (covers a computer that starts a bit late).
  if (now < sendAt || now > addMinutes(sendAt, 180) || (await wasSent(key))) return;
  await markSent(key);
  const dayStart = `${today}T00:00`;
  const dayEnd = addDays(dayStart, 1);
  const events = await db.all(`SELECT * FROM events WHERE status = 'scheduled' AND start < ? AND end > ? ORDER BY all_day DESC, start`, dayEnd, dayStart);
  const pending = await db.all(`SELECT * FROM events WHERE status = 'scheduled' AND attestation_required = 1 AND attestation_status = 'pending'
       AND end <= ? ORDER BY end`, now);
  if (!events.length && !pending.length) return;
  const list = events.length
    ? events
        .map((e) =>
          itemRow({
            title: e.title,
            meta: eventMeta(e, f, s, cats),
            color: cats.get(e.category_id)?.color,
            badge: e.attestation_required && e.attestation_status === 'pending' ? s.attNeeded : null,
          })
        )
        .join('')
    : `<p style="color:#6b6b80">${s.noEvents}</p>`;
  const pend = pending.length
    ? `<h2 style="font-size:16px;margin:22px 0 10px;color:#b4232a">${s.pendingTitle} (${pending.length})</h2>` +
      pending.map((e) => itemRow({ title: e.title, meta: eventMeta(e, f, s, cats), color: '#e5484d' })).join('')
    : '';
  await sendMail({
    subject: s.digestSubject(f.day(now)),
    html: await layout({ heading: s.digestHeading, intro: f.day(now), body: list + pend, cta: s.cta, ctaUrl: `${APP_URL}/#/today` }),
    text: events.map((e) => `${e.all_day ? s.allDay : f.time(e.start)} ${e.title}`).join('\n'),
  });
}

async function cleanup() {
  await db.run(`DELETE FROM sessions WHERE expires_at < ?`, new Date().toISOString());
  await db.run(`DELETE FROM sent_log WHERE sent_at < datetime('now', '-120 days')`);
  await db.run(`DELETE FROM notifications WHERE read_at IS NOT NULL AND read_at < datetime('now', '-180 days')`);
  await db.run(`DELETE FROM email_log WHERE created_at < datetime('now', '-90 days')`);
}

let running = false;
export async function tick() {
  if (running) return;
  running = true;
  try {
    // Nothing to do before the account exists.
    if (!(await db.get('SELECT id FROM users LIMIT 1'))) return;
    const settings = await getSettings();
    const now = nowIn(settings.timezone);
    const s = STRINGS[settings.language] || STRINGS.en;
    const f = fmt(settings);
    const cats = await categoryMap();
    await runReminders(settings, now, s, f, cats);
    await runAttestations(settings, now, s, f, cats);
    await runDigest(settings, now, s, f, cats);
    await runAnnouncements(settings, now, notify);
    if (now.endsWith(':00')) await cleanup();
  } catch (err) {
    console.error('[scheduler]', err);
  } finally {
    running = false;
  }
}

export function startScheduler() {
  setTimeout(tick, 3000);
  setInterval(tick, 60 * 1000);
}
