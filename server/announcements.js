import { db } from './db.js';
import { timePart, inWindow } from './time.js';
import { sendMail, layout, esc, APP_URL } from './mailer.js';

// One-time "what's new" messages. A migration queues one (only when an account already exists,
// so a brand-new user is never told about changes she never saw), and the scheduler sends it once
// by email and in the app, outside her quiet hours.

const MESSAGES = {
  'courses-library': {
    fr: (ctx) => ({
      subject: 'Nouveau dans votre agenda : vos cours et leurs résumés',
      heading: 'Votre agenda a été mis à jour',
      intro: 'Suite à vos remarques, voici ce qui change :',
      items: [
        ['📚 Mes cours', 'Enregistrez chaque cours une seule fois (nom, établissement, salle, durée). Pour planifier une séance, choisissez le cours puis la date : tout le reste se remplit tout seul.'],
        ['📝 Un résumé pour chaque cours', 'Attachez à chaque cours son résumé et vos fichiers (PDF, photos, Word, PowerPoint…). Pendant la séance, ouvrez-le en un clic depuis « Aujourd’hui » ou depuis la séance dans l’agenda.'],
        [
          '🗓️ Plus d’emploi du temps fixe',
          'Les séances ne se répètent plus automatiquement : vous ajoutez chaque séance quand vous en avez besoin.' +
            (ctx.generated === 1
              ? ' La séance à venir créée par l’ancien emploi du temps est toujours là : vous pouvez la retirer en un clic dans Paramètres → Données & sauvegarde.'
              : ctx.generated
                ? ` Les ${ctx.generated} séances à venir créées par l’ancien emploi du temps sont toujours là : vous pouvez les retirer en un clic dans Paramètres → Données & sauvegarde.`
                : ''),
        ],
        ['🧾 Fiches de paie retirées', 'Le type « Fiche de paie » n’existe plus. Vos documents déjà enregistrés sont conservés, dans « Autre ».'],
      ],
      cta: 'Découvrir Mes cours',
      notifTitle: 'Nouveau : Mes cours et leurs résumés',
      notifBody: 'Enregistrez vos cours une fois, attachez-y leur résumé, et planifiez une séance en deux clics.',
    }),
    en: (ctx) => ({
      subject: 'New in your planner: your courses and their summaries',
      heading: 'Your planner has been updated',
      intro: 'Following your feedback, here is what changes:',
      items: [
        ['📚 My courses', 'Save each course once (name, institution, room, duration). To plan a session, pick the course and the date: everything else is filled in for you.'],
        ['📝 A summary for each course', 'Attach its summary and your files (PDF, photos, Word, PowerPoint…) to each course. During the lesson, open it in one click from “Today” or from the session in the calendar.'],
        [
          '🗓️ No more fixed timetable',
          'Sessions no longer repeat automatically: you add each session when you need it.' +
            (ctx.generated === 1
              ? ' The upcoming session created by the old timetable is still there: you can remove it in one click in Settings → Data & backup.'
              : ctx.generated
                ? ` The ${ctx.generated} upcoming sessions created by the old timetable are still there: you can remove them in one click in Settings → Data & backup.`
                : ''),
        ],
        ['🧾 Payslips removed', 'The “Payslip” document type is gone. Documents you already saved are kept, under “Other”.'],
      ],
      cta: 'Discover My courses',
      notifTitle: 'New: My courses and their summaries',
      notifBody: 'Save your courses once, attach their summary, and plan a session in two clicks.',
    }),
  },
};

async function generatedUpcoming(now) {
  const row = await db.get(
    `SELECT COUNT(*) AS n FROM events e WHERE e.series_id IS NOT NULL AND e.start >= ?
       AND COALESCE(e.attestation_status, '') NOT IN ('received', 'waived')
       AND NOT EXISTS (SELECT 1 FROM document_events de WHERE de.event_id = e.id)`,
    now
  );
  return row.n;
}

/** The email and notification for one announcement, in her language. */
export async function buildAnnouncement(key, language, now) {
  const build = MESSAGES[key]?.[language === 'fr' ? 'fr' : 'en'];
  if (!build) return null;
  const m = build({ generated: await generatedUpcoming(now) });
  const body = m.items
    .map(
      ([title, text]) => `<div style="margin:0 0 14px;padding:12px 14px;border:1px solid #ececf3;border-radius:12px">
        <div style="font-size:15px;font-weight:600;color:#1c1c28">${esc(title)}</div>
        <div style="font-size:14px;line-height:1.55;color:#4a4a5e;margin-top:4px">${esc(text)}</div></div>`
    )
    .join('');
  return {
    subject: m.subject,
    html: await layout({ heading: m.heading, intro: m.intro, body, cta: m.cta, ctaUrl: `${APP_URL}/#/courses` }),
    text: [m.heading, '', ...m.items.map(([title, text]) => `${title}\n${text}\n`), `${m.cta}: ${APP_URL}/#/courses`].join('\n'),
    notifTitle: m.notifTitle,
    notifBody: m.notifBody,
  };
}

export async function runAnnouncements(settings, now, notify) {
  const pending = await db.all('SELECT key FROM announcements WHERE sent_at IS NULL ORDER BY created_at');
  if (!pending.length || inWindow(timePart(now), settings.quietStart, settings.quietEnd)) return;
  for (const { key } of pending) {
    // Marked first, so a slow or failed email can never lead to the same message twice.
    await db.run('UPDATE announcements SET sent_at = ? WHERE key = ?', now, key);
    const a = await buildAnnouncement(key, settings.language, now);
    if (!a) continue;
    await notify({ type: 'info', title: a.notifTitle, body: a.notifBody, now });
    await sendMail({ subject: a.subject, html: a.html, text: a.text });
  }
}
