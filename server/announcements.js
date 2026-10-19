import { db } from './db.js';
import { timePart, inWindow } from './time.js';
import { sendMail, layout, esc, APP_URL } from './mailer.js';

// One-time "what's new" messages. A migration queues one (only when an account already exists,
// so a brand-new user is never told about changes she never saw), and the scheduler sends it once
// by email and in the app, outside her quiet hours.

const MESSAGES = {
  'courses-library': {
    fr: (ctx) => ({
      subject: 'Votre agenda a été mis à jour',
      heading: 'Quelques nouveautés pour vous',
      intro: 'Suite à vos remarques, voici ce qui change :',
      items: [
        ['📚 Mes cours', 'Enregistrez chaque cours une seule fois, avec son résumé et vos fichiers. Pour planifier une séance, choisissez le cours puis la date : le reste se remplit tout seul. En classe, ouvrez le support en un clic.'],
        [
          '🗓️ Plus d’emploi du temps fixe',
          'Les séances ne se répètent plus automatiquement : vous ajoutez chaque séance quand vous en avez besoin.' +
            (ctx.generated === 1
              ? ' La séance à venir créée par l’ancien emploi du temps est toujours là : vous pouvez la retirer dans Paramètres → Mes données.'
              : ctx.generated
                ? ` Les ${ctx.generated} séances à venir créées par l’ancien emploi du temps sont toujours là : vous pouvez les retirer dans Paramètres → Mes données.`
                : ''),
        ],
        ['☀️ Le mot du jour', 'Chaque matin, quelques mots sur votre journée en ouvrant l’application : vos cours, vos pauses, et un petit conseil quand il le faut.'],
        ['📷 Un vrai scanner', 'Prenez une page en photo : l’application la trouve, la redresse et la nettoie toute seule. Elle lit aussi le texte, pour retrouver un document grâce aux mots qu’il contient.'],
        ['📄 Votre planning en PDF', 'Dans « Aujourd’hui » ou dans l’agenda : choisissez la semaine ou le mois, et le PDF se télécharge, prêt à imprimer.'],
        ['⚙️ Des paramètres plus simples', 'Quatre rubriques au lieu de huit, et vos rappels en un seul choix : Doux, Normal ou Suivi rapproché.'],
        ['🧾 Fiches de paie retirées', 'Le type « Fiche de paie » n’existe plus. Vos documents déjà enregistrés sont conservés, dans « Autre ».'],
      ],
      cta: 'Ouvrir mon agenda',
      notifTitle: 'Votre agenda a été mis à jour',
      notifBody: 'Mes cours, le mot du jour, un vrai scanner, le planning en PDF et des paramètres plus simples.',
    }),
    en: (ctx) => ({
      subject: 'Your planner has been updated',
      heading: 'A few new things for you',
      intro: 'Following your feedback, here is what changes:',
      items: [
        ['📚 My courses', 'Save each course once, with its summary and your files. To plan a session, pick the course and the date: the rest fills itself in. In class, open the support in one click.'],
        [
          '🗓️ No more fixed timetable',
          'Sessions no longer repeat automatically: you add each session when you need it.' +
            (ctx.generated === 1
              ? ' The upcoming session created by the old timetable is still there: you can remove it in Settings → My data.'
              : ctx.generated
                ? ` The ${ctx.generated} upcoming sessions created by the old timetable are still there: you can remove them in Settings → My data.`
                : ''),
        ],
        ['☀️ A word for your day', 'Every morning, a few words about your day when you open the app: your classes, your breaks, and a little advice when it helps.'],
        ['📷 A real scanner', 'Take a photo of a page: the app finds it, straightens it and cleans it up by itself. It also reads the text, so you can find a document by the words it contains.'],
        ['📄 Your schedule as a PDF', 'From “Today” or the calendar: choose the week or the month, and the PDF downloads, ready to print.'],
        ['⚙️ Simpler settings', 'Four sections instead of eight, and your reminders in a single choice: Gentle, Normal or Close follow-up.'],
        ['🧾 Payslips removed', 'The “Payslip” document type is gone. Documents you already saved are kept, under “Other”.'],
      ],
      cta: 'Open my planner',
      notifTitle: 'Your planner has been updated',
      notifBody: 'My courses, a word for your day, a real scanner, your schedule as a PDF and simpler settings.',
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
    html: await layout({ heading: m.heading, intro: m.intro, body, cta: m.cta, ctaUrl: `${APP_URL}/#/today` }),
    text: [m.heading, '', ...m.items.map(([title, text]) => `${title}\n${text}\n`), `${m.cta}: ${APP_URL}/#/today`].join('\n'),
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
