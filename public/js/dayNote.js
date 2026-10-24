import { getLanguage, addDaysStr, minutesBetween } from './i18n.js';
import { state, categoryById, courseById } from './store.js';
import { api } from './api.js';

// "Le mot du jour": a few warm sentences about her day, written from what is really planned
// (number of classes, breaks, early start, late finish, attestation to ask, yesterday, the week).
// Every sentence is hand-written with several versions. The choice is stable for the whole day
// and avoids what she read recently, so it never feels like the same message twice.

// ---------- small helpers for natural wording ----------

const FR_NUM = ['zéro', 'un', 'deux', 'trois', 'quatre', 'cinq', 'six', 'sept', 'huit', 'neuf', 'dix'];
const EN_NUM = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

function num(n, lang) {
  const words = lang === 'fr' ? FR_NUM : EN_NUM;
  return n >= 0 && n <= 10 ? words[n] : String(n);
}

/** "8 h", "14 h 30" in French; "8:00", "14:30" in English. */
function clock(wall, lang) {
  const h = Number(wall.slice(11, 13));
  const m = wall.slice(14, 16);
  if (lang === 'fr') return m === '00' ? `${h} h` : `${h} h ${m}`;
  return `${h}:${m}`;
}

/** "une heure", "deux heures", "1 h 30", "45 minutes". */
function duration(minutes, lang) {
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  if (lang === 'fr') {
    if (!h) return `${m} minutes`;
    if (!m) return h === 1 ? 'une heure' : `${num(h, lang)} heures`;
    return `${h} h ${String(m).padStart(2, '0')}`;
  }
  if (!h) return `${m} minutes`;
  if (!m) return h === 1 ? 'one hour' : `${num(h, lang)} hours`;
  if (m === 30) return h === 1 ? 'an hour and a half' : `${h}.5 hours`;
  return `${h} h ${String(m).padStart(2, '0')}`;
}

function weekdayName(date, lang) {
  return new Intl.DateTimeFormat(lang === 'fr' ? 'fr-FR' : 'en-GB', { weekday: 'long' }).format(new Date(`${date}T12:00`));
}

// Deterministic randomness: the same day always gives the same choices.
function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619);
  return h >>> 0;
}
function seeded(seed) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------- reading the day ----------

function analyse(data) {
  const now = data.now;
  const today = now.slice(0, 10);
  const timed = data.today.filter((e) => e.status !== 'cancelled' && !e.allDay).sort((a, b) => (a.start < b.start ? -1 : 1));
  const teaching = timed.filter((e) => ['class', 'exam'].includes(e.kind));
  const minutes = teaching.reduce((s, e) => s + minutesBetween(e.start, e.end), 0);
  const gaps = [];
  for (let i = 1; i < timed.length; i++) {
    const prev = timed[i - 1];
    const next = timed[i];
    gaps.push({ prev, next, minutes: minutesBetween(prev.end, next.start) });
  }
  const tomorrow = addDaysStr(today, 1);
  const tomorrowEvents = data.upcoming.filter((e) => e.start.slice(0, 10) === tomorrow && !e.allDay);
  const dow = new Date(`${today}T12:00`).getDay();
  const nextTwoDays = data.upcoming.filter((e) => e.start.slice(0, 10) <= addDaysStr(today, 2));
  const first = timed[0];
  const last = timed[timed.length - 1];
  const done = timed.filter((e) => e.end <= now);
  const coming = timed.filter((e) => e.start > now);
  const current = timed.find((e) => e.start <= now && e.end > now);
  const institutions = [...new Set(timed.map((e) => e.categoryId).filter(Boolean))];
  // Lunch is a problem only when classes leave no free half hour between 11:30 and 14:00.
  const lunchBlocked = (() => {
    const from = `${today}T11:30`;
    const to = `${today}T14:00`;
    const busy = timed.filter((e) => e.start < to && e.end > from);
    if (!busy.length || busy[0].start > `${today}T12:00` || busy[busy.length - 1].end < `${today}T13:00`) return false;
    let cursor = from;
    for (const e of busy) {
      if (minutesBetween(cursor, e.start) >= 30) return false;
      if (e.end > cursor) cursor = e.end;
    }
    return minutesBetween(cursor, to) < 30;
  })();
  const attToday = timed.find((e) => e.attestation?.required && e.attestation.status === 'pending');
  const emptySummary = timed.map((e) => courseById(e.courseId)).find((c) => c && !c.summary.trim());
  const tightTravel = gaps.find((g) => g.prev.categoryId && g.next.categoryId && g.prev.categoryId !== g.next.categoryId && g.minutes < 45);

  const holidayIn = data.nextHoliday ? Math.round(minutesBetween(`${today}T00:00`, `${data.nextHoliday.start}T00:00`) / 1440) : 0;

  let phase = 'morning';
  if (timed.length && first.start <= now) phase = last.end <= now ? 'evening' : 'day';

  return {
    now,
    today,
    dow,
    phase,
    timed,
    n: timed.length,
    minutes,
    first,
    last,
    gaps,
    backToBack: gaps.find((g) => g.minutes < 15),
    longBreak: gaps.filter((g) => g.minutes >= 120).sort((a, b) => b.minutes - a.minutes)[0],
    lunchBlocked,
    early: first && first.start.slice(11) < '08:30',
    late: last && last.end.slice(11) >= '18:00',
    institutions,
    tightTravel,
    attToday,
    emptySummary,
    overdue: data.pendingAttestations.length,
    holiday: data.holiday,
    weekend: (dow === 0 || dow === 6) && !timed.length,
    heavy: minutes >= 360 || timed.length >= 5,
    light: timed.length > 0 && minutes <= 120,
    yesterdayHeavy: (data.yesterdayHours || 0) >= 6,
    monday: dow === 1 && timed.length > 0,
    lastDayOfWeek: timed.length > 0 && dow >= 4 && dow <= 6 && !nextTwoDays.length,
    done,
    coming,
    current,
    next: coming[0],
    onBreak: !current && coming.length && done.length ? minutesBetween(now, coming[0].start) : 0,
    tomorrowEvents,
    exam: timed.find((e) => e.kind === 'exam'),
    meeting: timed.find((e) => e.kind === 'meeting'),
    nextHoliday: data.nextHoliday?.name || '',
    holidayIn,
    month: Number(today.slice(5, 7)),
    firstName: (state.user?.name || '').split(' ')[0],
  };
}

// ---------- the phrases ----------
// Each phrase: an id (for "already seen"), an optional condition, and its text in each language.

const OPENINGS = [
  // No class today
  { id: 'hol1', when: (c) => c.holiday, fr: (c) => `C'est ${c.holiday} : pas de cours, pas de réveil qui presse. Profitez-en vraiment.`, en: (c) => `It's ${c.holiday}: no classes, no rushing in the morning. Make the most of it.` },
  { id: 'hol2', when: (c) => c.holiday, fr: () => `Pendant les vacances, l'agenda se repose aussi. Prenez soin de vous.`, en: () => `During the holidays, your planner rests too. Take care of yourself.` },
  { id: 'we1', when: (c) => c.weekend && !c.holiday, fr: (c) => `Un ${c.dayName} sans cours. Rangez le cartable et faites quelque chose qui vous fait plaisir.`, en: (c) => `A ${c.dayName} without classes. Put the school bag away and do something you enjoy.` },
  { id: 'we2', when: (c) => c.weekend && !c.holiday, fr: () => `C'est le week-end. Les cours attendront : aujourd'hui, on souffle.`, en: () => `It's the weekend. Classes can wait: today is for breathing.` },
  { id: 'we3', when: (c) => c.weekend && !c.holiday, fr: () => `Rien au programme aujourd'hui, et c'est très bien comme ça.`, en: () => `Nothing planned today, and that's just fine.` },
  { id: 'fr1', when: (c) => !c.n && !c.weekend && !c.holiday, fr: () => `Aucun cours aujourd'hui. Une journée rien qu'à vous, ça se savoure.`, en: () => `No classes today. A day just for you: enjoy it.` },
  { id: 'fr2', when: (c) => !c.n && !c.weekend && !c.holiday, fr: () => `Pas de cours au programme. Avancez à votre rythme, ou ne faites rien du tout : c'est permis aussi.`, en: () => `No classes on the programme. Go at your own pace, or do nothing at all: that's allowed too.` },
  { id: 'fr3', when: (c) => !c.n && !c.weekend && !c.holiday, fr: () => `Journée libre. Si des copies attendent, c'est le bon moment… et sinon, c'est le bon moment pour souffler.`, en: () => `A free day. If some marking is waiting, now is a good time… and if not, it's a good time to rest.` },
  // One light day
  { id: 'li1', when: (c) => c.n === 1, fr: (c) => `Un seul cours aujourd'hui : ${c.first.title}, à ${c.firstTime}. Une journée douce.`, en: (c) => `Just one class today: ${c.first.title}, at ${c.firstTime}. A gentle day.` },
  { id: 'li2', when: (c) => c.n === 1, fr: (c) => `Aujourd'hui, c'est ${c.first.title} à ${c.firstTime}, et c'est tout. Le reste du temps est à vous.`, en: (c) => `Today it's ${c.first.title} at ${c.firstTime}, and that's all. The rest of the time is yours.` },
  { id: 'li3', when: (c) => c.light && c.n > 1, fr: (c) => `Programme léger : ${c.nWord} cours, ${c.hours} en tout. Vous aurez du temps pour vous.`, en: (c) => `A light programme: ${c.nWord} classes, ${c.hours} in all. You'll have time for yourself.` },
  // A normal day
  { id: 'no1', when: (c) => c.n > 1 && !c.light && !c.heavy, fr: (c) => `${cap(c.nWord)} cours aujourd'hui, de ${c.firstTime} à ${c.lastTime}.`, en: (c) => `${cap(c.nWord)} classes today, from ${c.firstTime} to ${c.lastTime}.` },
  { id: 'no2', when: (c) => c.n > 1 && !c.light && !c.heavy, fr: (c) => `Au programme : ${c.nWord} cours, ${c.hours} en tout. On commence à ${c.firstTime} avec ${c.first.title}.`, en: (c) => `On the programme: ${c.nWord} classes, ${c.hours} in all. It starts at ${c.firstTime} with ${c.first.title}.` },
  { id: 'no3', when: (c) => c.n > 1 && !c.light && !c.heavy, fr: (c) => `Votre journée commence à ${c.firstTime} avec ${c.first.title} et se termine vers ${c.lastTime}.`, en: (c) => `Your day starts at ${c.firstTime} with ${c.first.title} and ends around ${c.lastTime}.` },
  { id: 'no4', when: (c) => c.n > 1 && !c.light && !c.heavy, fr: (c) => `Une journée bien remplie mais raisonnable : ${c.hours} de cours, fini vers ${c.lastTime}.`, en: (c) => `A full but reasonable day: ${c.hours} of teaching, done around ${c.lastTime}.` },
  // A heavy day
  { id: 'he1', when: (c) => c.heavy && c.n > 1, fr: (c) => `Grosse journée aujourd'hui : ${c.hours} de cours, de ${c.firstTime} à ${c.lastTime}. On y va pas à pas.`, en: (c) => `A big day today: ${c.hours} of teaching, from ${c.firstTime} to ${c.lastTime}. One step at a time.` },
  { id: 'he2', when: (c) => c.heavy && c.n > 1, fr: (c) => `${cap(c.nWord)} cours au programme, ${c.hours} au total. Gardez un peu d'énergie pour le dernier.`, en: (c) => `${cap(c.nWord)} classes on the programme, ${c.hours} in total. Keep a little energy for the last one.` },
  { id: 'he3', when: (c) => c.heavy && c.n > 1, fr: (c) => `Une longue journée vous attend, jusqu'à ${c.lastTime}. Ménagez-vous entre les cours.`, en: (c) => `A long day ahead, until ${c.lastTime}. Go easy on yourself between classes.` },
  { id: 'he4', when: (c) => c.heavy && c.n > 1, fr: (c) => `Journée dense : ${c.nWord} rendez-vous entre ${c.firstTime} et ${c.lastTime}. Gardez votre rythme, pas celui de l'horloge.`, en: (c) => `A packed day: ${c.nWord} appointments between ${c.firstTime} and ${c.lastTime}. Keep your own pace, not the clock's.` },
  { id: 'he5', when: (c) => c.heavy && c.n > 1, fr: (c) => `Aujourd'hui, ${c.hours} de cours. C'est beaucoup, alors on ne cherche pas la perfection : on cherche à bien finir.`, en: (c) => `Today, ${c.hours} of teaching. That's a lot, so the goal isn't perfection: it's finishing well.` },
  // More versions for the other days, so mornings don't sound alike.
  { id: 'li4', when: (c) => c.n === 1, fr: (c) => `Juste ${c.first.title} aujourd'hui, de ${c.firstTime} à ${c.lastTime}. Le genre de journée qui laisse respirer.`, en: (c) => `Just ${c.first.title} today, from ${c.firstTime} to ${c.lastTime}. The kind of day that lets you breathe.` },
  { id: 'li5', when: (c) => c.light && c.n > 1, fr: (c) => `Une journée tranquille : ${c.nWord} cours, et vous aurez terminé vers ${c.lastTime}.`, en: (c) => `A quiet day: ${c.nWord} classes, and you'll be done around ${c.lastTime}.` },
  { id: 'no5', when: (c) => c.n > 1 && !c.light && !c.heavy, fr: (c) => `Bonjour${c.firstName ? ` ${c.firstName}` : ''} ! ${cap(c.nWord)} cours vous attendent, le premier à ${c.firstTime}.`, en: (c) => `Good morning${c.firstName ? ` ${c.firstName}` : ''}! ${cap(c.nWord)} classes are waiting for you, the first at ${c.firstTime}.` },
  { id: 'no6', when: (c) => c.n > 1 && !c.light && !c.heavy, fr: (c) => `Une journée classique : ${c.first.title} pour commencer à ${c.firstTime}, ${c.last.title} pour finir vers ${c.lastTime}.`, en: (c) => `A typical day: ${c.first.title} to start at ${c.firstTime}, ${c.last.title} to finish around ${c.lastTime}.` },
  { id: 'we4', when: (c) => c.weekend && !c.holiday, fr: () => `Pas de sonnerie aujourd'hui. Une promenade, un bon repas, un livre : la semaine prochaine vous remerciera.`, en: () => `No school bell today. A walk, a good meal, a book: next week will thank you.` },
  { id: 'hol3', when: (c) => c.holiday, fr: () => `Les élèves sont en vacances, vous aussi. Pas d'agenda à surveiller aujourd'hui.`, en: () => `The students are on holiday, and so are you. No planner to watch today.` },
  { id: 'fr4', when: (c) => !c.n && !c.weekend && !c.holiday, fr: () => `Rien dans l'agenda aujourd'hui. Gardez-en une partie pour vous, même si la liste de choses à faire est longue.`, en: () => `Nothing in the planner today. Keep part of it for yourself, even if the to-do list is long.` },
];

// At most one: how this day sits in the week.
const CONTEXT = [
  { id: 'cy1', when: (c) => c.yesterdayHeavy && c.n, fr: () => `Après la grosse journée d'hier, allez-y doucement.`, en: () => `After yesterday's big day, take it easy.` },
  { id: 'cy2', when: (c) => c.yesterdayHeavy && c.n, fr: () => `Hier a été long ; aujourd'hui, pas besoin d'en faire plus que nécessaire.`, en: () => `Yesterday was long; today, no need to do more than necessary.` },
  { id: 'cl1', when: (c) => c.lastDayOfWeek, fr: () => `Dernière journée de cours de la semaine : encore un effort et c'est le repos.`, en: () => `Last teaching day of the week: one more push and then it's rest.` },
  { id: 'cl2', when: (c) => c.lastDayOfWeek, fr: () => `C'est la dernière ligne droite de la semaine.`, en: () => `It's the home stretch of the week.` },
  { id: 'cm1', when: (c) => c.monday, fr: () => `Nouvelle semaine, nouvelle page.`, en: () => `New week, new page.` },
  { id: 'cm2', when: (c) => c.monday, fr: () => `Début de semaine : on démarre en douceur.`, en: () => `Start of the week: ease into it.` },
  { id: 'cm3', when: (c) => c.monday, fr: () => `Lundi : pas besoin de tout régler aujourd'hui, la semaine est encore longue.`, en: () => `Monday: no need to sort everything out today; the week is still long.` },
  { id: 'cl3', when: (c) => c.lastDayOfWeek, fr: () => `Plus que cette journée avant une vraie coupure. Vous y êtes presque.`, en: () => `Just this day left before a real break. You're nearly there.` },
  { id: 'cy3', when: (c) => c.yesterdayHeavy && c.n, fr: () => `Hier vous a demandé beaucoup d'énergie : aujourd'hui, l'essentiel suffira.`, en: () => `Yesterday took a lot of energy: today, the essentials will do.` },
  // Holidays coming soon.
  { id: 'hs1', when: (c) => c.n && c.nextHoliday && c.holidayIn > 1, fr: (c) => `Plus que ${c.holidayInWord} jours avant « ${c.nextHoliday} ».`, en: (c) => `Only ${c.holidayInWord} days until “${c.nextHoliday}”.` },
  { id: 'hs2', when: (c) => c.n && c.nextHoliday && c.holidayIn > 1, fr: (c) => `« ${c.nextHoliday} » approche : encore ${c.holidayInWord} jours, et une pause bien méritée.`, en: (c) => `“${c.nextHoliday}” is coming: ${c.holidayInWord} more days, then a well-earned break.` },
  { id: 'hs3', when: (c) => c.n && c.nextHoliday && c.holidayIn === 1, fr: (c) => `Demain commence « ${c.nextHoliday} ». Dernier effort !`, en: (c) => `“${c.nextHoliday}” starts tomorrow. One last push!` },
];

// At most one, on some days: the time of year (Tunisian school calendar).
const SEASON = [
  { id: 'se_sep1', when: (c) => c.month === 9, fr: () => `C'est la rentrée : les premières semaines donnent le ton, mais rien ne presse. Les habitudes se prennent petit à petit.`, en: () => `It's the start of the school year: the first weeks set the tone, but there's no rush. Habits come little by little.` },
  { id: 'se_sep2', when: (c) => c.month === 9, fr: () => `Nouvelle année scolaire, nouveaux visages. Apprendre les prénoms prend du temps, et c'est normal.`, en: () => `New school year, new faces. Learning names takes time, and that's normal.` },
  { id: 'se_oct', when: (c) => c.month === 10, fr: () => `Octobre : les classes ont trouvé leur rythme, et vous aussi.`, en: () => `October: the classes have found their rhythm, and so have you.` },
  { id: 'se_nov', when: (c) => c.month === 11, fr: () => `Les journées raccourcissent : profitez de la lumière du midi, même cinq minutes.`, en: () => `The days are getting shorter: enjoy the midday light, even for five minutes.` },
  { id: 'se_dec', when: (c) => c.month === 12, fr: () => `Fin du premier trimestre en vue : les copies s'accumulent, mais les vacances aussi approchent.`, en: () => `End of the first term in sight: marking piles up, but the holidays are getting closer too.` },
  { id: 'se_win', when: (c) => c.month === 1 || c.month === 2, fr: () => `Il fait frais le matin : une écharpe dans le sac, et un thé chaud entre deux cours.`, en: () => `Mornings are chilly: a scarf in your bag, and a hot tea between classes.` },
  { id: 'se_mar', when: (c) => c.month === 3, fr: () => `Le printemps arrive : un peu plus de lumière, un peu plus d'énergie.`, en: () => `Spring is coming: a little more light, a little more energy.` },
  { id: 'se_apr', when: (c) => c.month === 4 || c.month === 5, fr: () => `Le dernier trimestre est souvent le plus court : chaque semaine compte, mais pas au point d'oublier de respirer.`, en: () => `The last term is often the shortest: every week counts, but not so much that you forget to breathe.` },
  { id: 'se_jun', when: (c) => c.month === 6, fr: () => `Période d'examens : les élèves sont tendus, vous aussi peut-être. Un mot rassurant fait souvent plus qu'une révision de plus.`, en: () => `Exam season: students are tense, and maybe you are too. A reassuring word often helps more than one more revision.` },
  { id: 'se_sum', when: (c) => c.month === 7 || c.month === 8, fr: () => `L'été : le bon moment pour recharger les batteries, loin des emplois du temps.`, en: () => `Summer: the right time to recharge, far from timetables.` },
];

// Sometimes, a small idea for the day.
const TIPS = [
  { id: 'tp1', when: (c) => c.n, fr: () => `Petite idée : commencez un cours par une question ouverte, juste pour réveiller la classe.`, en: () => `A small idea: start a class with an open question, just to wake the room up.` },
  { id: 'tp2', when: (c) => c.n, fr: () => `Petite idée : terminez un cours en demandant à un élève de résumer en une phrase ce qu'il a retenu.`, en: () => `A small idea: end a class by asking one student to sum up what they learned in one sentence.` },
  { id: 'tp3', when: (c) => c.n, fr: () => `Petite idée : un compliment précis à un élève discret peut changer sa semaine.`, en: () => `A small idea: a specific compliment to a quiet student can change their week.` },
  { id: 'tp4', when: (c) => c.n, fr: () => `Petite idée : notez ce soir, en une ligne, ce qui a bien marché aujourd'hui. Ça sert pour l'année prochaine.`, en: () => `A small idea: tonight, write down in one line what worked well today. It helps next year.` },
  { id: 'tp5', when: (c) => c.n, fr: () => `Petite idée : parlez un peu moins fort que d'habitude. Souvent, la classe baisse le ton avec vous.`, en: () => `A small idea: speak a little more softly than usual. The class often lowers its voice with you.` },
  { id: 'tp6', when: (c) => c.n, fr: () => `Petite idée : avant d'entrer en classe, trois respirations lentes. Personne ne le verra, et ça change tout.`, en: () => `A small idea: before walking into class, three slow breaths. No one will notice, and it changes everything.` },
  { id: 'tp7', when: (c) => c.n, fr: () => `Petite idée : laissez cinq minutes à la fin pour les questions. Ce sont souvent les meilleures.`, en: () => `A small idea: leave five minutes at the end for questions. They're often the best ones.` },
  { id: 'tp8', when: (c) => c.n, fr: () => `Petite idée : un exemple tiré de la vie de tous les jours rend une notion difficile plus simple.`, en: () => `A small idea: an everyday example makes a difficult idea simpler.` },
  { id: 'tp9', when: (c) => c.n, fr: () => `Petite idée : buvez un verre d'eau à chaque pause. La voix est votre premier outil de travail.`, en: () => `A small idea: drink a glass of water at every break. Your voice is your first working tool.` },
  { id: 'tp10', when: (c) => c.n, fr: () => `Petite idée : si un cours ne se passe pas comme prévu, ce n'est pas un échec : c'est une information pour le suivant.`, en: () => `A small idea: if a class doesn't go to plan, it isn't a failure: it's information for the next one.` },
  { id: 'tp11', when: (c) => !c.n, fr: () => `Petite idée : une heure pour préparer la semaine, pas plus. Le reste de la journée est pour vous.`, en: () => `A small idea: one hour to prepare the week, no more. The rest of the day is yours.` },
  { id: 'tp12', when: (c) => !c.n, fr: () => `Petite idée : appelez quelqu'un que vous n'avez pas eu le temps de voir cette semaine.`, en: () => `A small idea: call someone you haven't had time to see this week.` },
  { id: 'tp13', when: (c) => !c.n, fr: () => `Petite idée : sortez marcher vingt minutes, sans téléphone. L'esprit se range tout seul.`, en: () => `A small idea: go for a twenty-minute walk, without your phone. Your mind tidies itself.` },
  { id: 'tp14', when: (c) => !c.n, fr: () => `Petite idée : profitez-en pour ranger vos attestations reçues dans Mes documents. Cinq minutes, et c'est fait.`, en: () => `A small idea: use the time to file your received attestations in My documents. Five minutes and it's done.` },
];

// Up to two, in this order of importance: practical advice drawn from the schedule.
const DETAILS = [
  { id: 'ex1', when: (c) => c.exam, fr: (c) => `Examen aujourd'hui : ${c.exam.title}, à ${c.examTime}. Vérifiez que vous avez assez de sujets et de copies.`, en: (c) => `Exam today: ${c.exam.title}, at ${c.examTime}. Check you have enough papers and answer sheets.` },
  { id: 'ex2', when: (c) => c.exam, fr: (c) => `${c.exam.title} à ${c.examTime} : un mot calme au début de l'épreuve, et les élèves partiront plus sereins.`, en: (c) => `${c.exam.title} at ${c.examTime}: a calm word at the start, and the students will begin more at ease.` },
  { id: 'me1', when: (c) => c.meeting, fr: (c) => `Réunion à ${c.meetingTime} : ${c.meeting.title}. Notez deux ou trois points à dire avant d'y aller.`, en: (c) => `Meeting at ${c.meetingTime}: ${c.meeting.title}. Jot down two or three points to raise before you go.` },
  { id: 'me2', when: (c) => c.meeting, fr: (c) => `N'oubliez pas ${c.meeting.title} à ${c.meetingTime}. Si un support y est joint, il est dans le rendez-vous.`, en: (c) => `Don't forget ${c.meeting.title} at ${c.meetingTime}. If a support is attached, it's in the appointment.` },
  { id: 'at1', when: (c) => c.attToday, fr: (c) => `À la fin de ${c.attToday.title}, pensez à demander l'attestation : une minute, et c'est réglé.`, en: (c) => `At the end of ${c.attToday.title}, remember to ask for the attestation: one minute and it's done.` },
  { id: 'at2', when: (c) => c.attToday, fr: (c) => `Petite chose à ne pas oublier : l'attestation de ${c.attToday.title}, à demander sur place.`, en: (c) => `One small thing not to forget: the attestation for ${c.attToday.title}, to ask for on the spot.` },
  { id: 'bb1', when: (c) => c.backToBack, fr: (c) => `Entre ${c.bbFrom} et ${c.bbTo}, les cours s'enchaînent sans pause : gardez une bouteille d'eau à portée de main.`, en: (c) => `Between ${c.bbFrom} and ${c.bbTo}, classes follow each other with no break: keep a bottle of water close by.` },
  { id: 'bb2', when: (c) => c.backToBack, fr: (c) => `Pas de temps mort entre ${c.backToBack.prev.title} et ${c.backToBack.next.title}. Même trente secondes pour respirer entre les deux, ça compte.`, en: (c) => `No gap between ${c.backToBack.prev.title} and ${c.backToBack.next.title}. Even thirty seconds to breathe in between makes a difference.` },
  { id: 'lu1', when: (c) => c.lunchBlocked, fr: () => `Vos cours tombent sur l'heure du déjeuner : glissez quelque chose à grignoter dans votre sac.`, en: () => `Your classes fall over lunchtime: slip something to eat into your bag.` },
  { id: 'lu2', when: (c) => c.lunchBlocked, fr: () => `Pas de vraie pause à midi aujourd'hui. Un fruit ou un sandwich vous rendra service vers 13 h.`, en: () => `No real lunch break today. A piece of fruit or a sandwich will help around 1 pm.` },
  { id: 'tr1', when: (c) => c.tightTravel, fr: (c) => `Vous changez d'établissement entre ${c.travelFrom} et ${c.travelTo} : partez quelques minutes plus tôt pour ne pas courir.`, en: (c) => `You change schools between ${c.travelFrom} and ${c.travelTo}: leave a few minutes early so you don't have to rush.` },
  { id: 'br1', when: (c) => c.longBreak, fr: (c) => `Vous avez une vraie pause de ${c.breakFrom} à ${c.breakTo} : de quoi manger tranquillement, et pourquoi pas marcher un peu.`, en: (c) => `You have a real break from ${c.breakFrom} to ${c.breakTo}: time to eat calmly, and maybe take a short walk.` },
  { id: 'br2', when: (c) => c.longBreak, fr: (c) => `Entre ${c.breakFrom} et ${c.breakTo}, ${c.breakLen} de pause. Ne la remplissez pas trop : elle est là pour souffler.`, en: (c) => `Between ${c.breakFrom} and ${c.breakTo}, ${c.breakLen} of break. Don't fill it too much: it's there to rest.` },
  { id: 'ea1', when: (c) => c.early, fr: (c) => `Ça commence tôt, à ${c.firstTime}. Prenez quand même le temps d'un vrai petit-déjeuner.`, en: (c) => `It starts early, at ${c.firstTime}. Still take the time for a proper breakfast.` },
  { id: 'ea2', when: (c) => c.early, fr: (c) => `Premier cours à ${c.firstTime} : un café avant de partir, et la journée sera plus facile.`, en: (c) => `First class at ${c.firstTime}: a coffee before you leave, and the day will feel easier.` },
  { id: 'la1', when: (c) => c.late, fr: (c) => `Le dernier cours finit à ${c.lastTime}. Ce soir, pas de corrections : ça peut attendre demain.`, en: (c) => `The last class ends at ${c.lastTime}. Tonight, no marking: it can wait until tomorrow.` },
  { id: 'la2', when: (c) => c.late, fr: (c) => `Vous terminez tard (${c.lastTime}). Prévoyez une soirée calme, vous l'aurez méritée.`, en: (c) => `You finish late (${c.lastTime}). Plan a quiet evening; you'll have earned it.` },
  { id: 'mi1', when: (c) => c.institutions.length > 1 && !c.tightTravel, fr: (c) => `Deux établissements aujourd'hui (${c.instNames}) : vérifiez que vous avez les bons supports dans le sac.`, en: (c) => `Two schools today (${c.instNames}): check you have the right materials in your bag.` },
  { id: 'su1', when: (c) => c.emptySummary, fr: (c) => `Le résumé de « ${c.emptySummary.title} » est encore vide. Deux minutes pour noter les points clés, et vous l'aurez sous les yeux en classe.`, en: (c) => `The summary of “${c.emptySummary.title}” is still empty. Two minutes to note the key points, and you'll have it in front of you in class.` },
  { id: 'ov1', when: (c) => c.overdue === 1, fr: () => `Une attestation attend encore d'être récupérée. Si vous passez par là, c'est l'occasion.`, en: () => `One attestation is still waiting to be collected. If you're passing by, it's a good chance.` },
  { id: 'ov2', when: (c) => c.overdue > 1, fr: (c) => `${cap(c.overdueWord)} attestations sont encore à récupérer. Une à la fois, sans stress.`, en: (c) => `${cap(c.overdueWord)} attestations are still to collect. One at a time, no stress.` },
  { id: 'ov3', when: (c) => c.overdue > 1, fr: (c) => `Il reste ${c.overdueWord} attestations à demander. Commencez par la plus ancienne : elle est en haut de la page Attestations.`, en: (c) => `${cap(c.overdueWord)} attestations are left to ask for. Start with the oldest: it's at the top of the Attestations page.` },
  { id: 'br3', when: (c) => c.longBreak, fr: (c) => `Grande pause de ${c.breakLen} à partir de ${c.breakFrom}. Un vrai repas assis vaut mieux que des copies corrigées debout.`, en: (c) => `A long break of ${c.breakLen} from ${c.breakFrom}. A proper seated meal beats marking on your feet.` },
  { id: 'la3', when: (c) => c.late, fr: (c) => `Fin des cours à ${c.lastTime} : gardez un en-cas pour la fin d'après-midi.`, en: (c) => `Classes end at ${c.lastTime}: keep a snack for late afternoon.` },
  { id: 'ea3', when: (c) => c.early, fr: (c) => `Départ matinal (${c.firstTime}) : préparez votre sac la veille, le matin sera plus léger.`, en: (c) => `Early start (${c.firstTime}): pack your bag the night before and the morning will feel lighter.` },
];

const CLOSINGS = [
  { id: 'cg1', when: (c) => c.n && !c.heavy, fr: () => `Belle journée à vous.`, en: () => `Have a lovely day.` },
  { id: 'cg2', when: (c) => c.n && !c.heavy, fr: () => `Vous allez faire du bon travail, comme d'habitude.`, en: () => `You're going to do good work, as usual.` },
  { id: 'cg3', when: (c) => c.n, fr: () => `Vos élèves ont de la chance de vous avoir.`, en: () => `Your students are lucky to have you.` },
  { id: 'cg4', when: (c) => c.n, fr: () => `Un cours à la fois, et tout ira bien.`, en: () => `One class at a time, and all will be well.` },
  { id: 'cg5', when: (c) => c.n && !c.heavy, fr: () => `Faites de votre mieux : c'est déjà beaucoup.`, en: () => `Do your best: that's already a lot.` },
  { id: 'ch1', when: (c) => c.heavy, fr: () => `Courage : vous avez déjà réussi des journées comme celle-ci.`, en: () => `Courage: you've already made it through days like this one.` },
  { id: 'ch2', when: (c) => c.heavy, fr: () => `Une journée chargée reste une journée comme les autres, juste un peu plus longue. Vous y arriverez.`, en: () => `A busy day is still a day like any other, just a little longer. You'll get there.` },
  { id: 'cf1', when: (c) => !c.n, fr: () => `Profitez-en bien.`, en: () => `Enjoy it.` },
  { id: 'cf2', when: (c) => !c.n, fr: () => `Le repos fait aussi partie du métier.`, en: () => `Rest is part of the job too.` },
  { id: 'cf3', when: (c) => !c.n, fr: () => `À demain, reposée et prête.`, en: () => `See you tomorrow, rested and ready.` },
  { id: 'cg6', when: (c) => c.n, fr: () => `Ce que vous semez aujourd'hui, vos élèves le récolteront longtemps.`, en: () => `What you sow today, your students will harvest for a long time.` },
  { id: 'cg7', when: (c) => c.n && !c.heavy, fr: () => `Souriez en entrant en classe : c'est contagieux.`, en: () => `Smile as you walk into class: it's contagious.` },
  { id: 'cg8', when: (c) => c.n, fr: (c) => `On croit en vous${c.firstName ? `, ${c.firstName}` : ''}.`, en: (c) => `We believe in you${c.firstName ? `, ${c.firstName}` : ''}.` },
  { id: 'ch3', when: (c) => c.heavy, fr: () => `Respirez entre deux cours : la journée se gagne une heure à la fois.`, en: () => `Breathe between classes: the day is won one hour at a time.` },
];

// During the day: where she is now.
const DAY = [
  { id: 'dp1', when: (c) => c.next && c.done.length, fr: (c) => `Déjà ${c.doneWord} cours derrière vous. Le prochain : ${c.next.title}, à ${c.nextTime}.`, en: (c) => `Already ${c.doneWord} ${c.done.length > 1 ? 'classes' : 'class'} behind you. Next: ${c.next.title}, at ${c.nextTime}.` },
  { id: 'dp2', when: (c) => c.next, fr: (c) => `Encore ${c.comingWord} cours, et la journée sera faite. Prochain rendez-vous : ${c.nextTime}.`, en: (c) => `${cap(c.comingWord)} more ${c.coming.length > 1 ? 'classes' : 'class'} and the day is done. Next one at ${c.nextTime}.` },
  { id: 'dc1', when: (c) => c.current && !c.next, fr: (c) => `Dernier cours de la journée en ce moment : ${c.current.title}. Le plus dur est fait.`, en: (c) => `Last class of the day right now: ${c.current.title}. The hardest part is done.` },
  { id: 'db1', when: (c) => c.onBreak >= 20, fr: (c) => `C'est la pause jusqu'à ${c.nextTime}. Asseyez-vous, buvez un verre d'eau, et ne pensez pas encore au cours suivant.`, en: (c) => `Break until ${c.nextTime}. Sit down, drink some water, and don't think about the next class just yet.` },
  { id: 'db2', when: (c) => c.onBreak >= 20, fr: (c) => `${cap(c.breakNowLen)} avant ${c.next.title} : de quoi souffler un peu.`, en: (c) => `${cap(c.breakNowLen)} before ${c.next.title}: time to catch your breath.` },
  { id: 'dp3', when: (c) => c.next && c.done.length, fr: (c) => `La journée avance bien. Prochaine étape : ${c.next.title} à ${c.nextTime}.`, en: (c) => `The day is going well. Next step: ${c.next.title} at ${c.nextTime}.` },
  { id: 'dp4', when: (c) => c.current && c.next, fr: (c) => `En ce moment : ${c.current.title}. Ensuite, ${c.next.title} à ${c.nextTime}.`, en: (c) => `Right now: ${c.current.title}. Then ${c.next.title} at ${c.nextTime}.` },
  { id: 'dc2', when: (c) => c.current && !c.next, fr: (c) => `${c.current.title}, et ce sera tout pour aujourd'hui. Vous y êtes presque.`, en: (c) => `${c.current.title}, and that's all for today. You're nearly there.` },
  { id: 'db3', when: (c) => c.onBreak >= 20, fr: (c) => `Pause jusqu'à ${c.nextTime} : sortez prendre l'air quelques minutes si vous pouvez.`, en: (c) => `Break until ${c.nextTime}: step outside for a few minutes if you can.` },
  { id: 'da1', when: (c) => c.attToday && c.attToday.end <= c.now, fr: (c) => `Avez-vous pu demander l'attestation de ${c.attToday.title} ? Si c'est fait, marquez-la comme reçue.`, en: (c) => `Did you manage to ask for the attestation for ${c.attToday.title}? If so, mark it as received.` },
];

// In the evening: a short recap and tomorrow.
const EVENING = [
  { id: 'ev1', when: () => true, fr: (c) => `C'est terminé pour aujourd'hui : ${c.hours} de cours. Bravo.`, en: (c) => `That's it for today: ${c.hours} of teaching. Well done.` },
  { id: 'ev2', when: () => true, fr: (c) => `Journée bouclée, ${c.nWord} ${c.n > 1 ? 'cours donnés' : 'cours donné'}. Le reste de la soirée est à vous.`, en: (c) => `Day done, ${c.nWord} ${c.n > 1 ? 'classes' : 'class'} given. The rest of the evening is yours.` },
  { id: 'ev3', when: (c) => c.heavy, fr: (c) => `Une longue journée derrière vous${c.firstName ? `, ${c.firstName}` : ''}. Ce que vous avez fait aujourd'hui compte vraiment.`, en: (c) => `A long day behind you${c.firstName ? `, ${c.firstName}` : ''}. What you did today really matters.` },
  { id: 'ev4', when: (c) => !c.heavy, fr: () => `Les cours sont finis. Posez le sac, la journée a été bien remplie.`, en: () => `Classes are over. Put the bag down: it was a full day.` },
  { id: 'ev5', when: () => true, fr: (c) => `Mission accomplie${c.firstName ? `, ${c.firstName}` : ''} : ${c.nWord} cours aujourd'hui, de ${c.firstTime} à ${c.lastTime}.`, en: (c) => `Mission accomplished${c.firstName ? `, ${c.firstName}` : ''}: ${c.nWord} ${c.n > 1 ? 'classes' : 'class'} today, from ${c.firstTime} to ${c.lastTime}.` },
  { id: 'ev6', when: (c) => c.exam, fr: (c) => `L'examen ${c.exam.title} est passé. Les copies peuvent attendre demain matin.`, en: (c) => `The ${c.exam.title} exam is done. The papers can wait until tomorrow morning.` },
];
const EVENING_AFTER = [
  { id: 'ea_att', when: (c) => c.attToday, fr: (c) => `Avez-vous pu récupérer l'attestation de ${c.attToday.title} ? Si oui, un clic pour la marquer comme reçue.`, en: (c) => `Did you get the attestation for ${c.attToday.title}? If so, one click to mark it as received.` },
  { id: 'tm1', when: (c) => c.tomorrowEvents.length, fr: (c) => `Demain, premier cours à ${c.tomorrowTime} (${c.tomorrowEvents[0].title}).`, en: (c) => `Tomorrow, first class at ${c.tomorrowTime} (${c.tomorrowEvents[0].title}).` },
  { id: 'tm2', when: (c) => c.tomorrowEvents.length, fr: (c) => `Demain, ça reprend à ${c.tomorrowTime}. Une bonne nuit, et ce sera parfait.`, en: (c) => `Tomorrow it starts again at ${c.tomorrowTime}. A good night's sleep, and it'll be perfect.` },
  { id: 'tn1', when: (c) => !c.tomorrowEvents.length, fr: () => `Pas de cours demain : vous pouvez éteindre le réveil.`, en: () => `No classes tomorrow: you can switch off the alarm.` },
  { id: 'tm3', when: (c) => c.tomorrowEvents.length > 1, fr: (c) => `Demain, ${c.tomorrowWord} rendez-vous, le premier à ${c.tomorrowTime}. Un coup d'œil à l'agenda, et vous serez prête.`, en: (c) => `Tomorrow, ${c.tomorrowWord} appointments, the first at ${c.tomorrowTime}. A glance at the planner and you'll be ready.` },
  { id: 'tn2', when: (c) => !c.tomorrowEvents.length, fr: () => `Rien de prévu demain : une grasse matinée n'a jamais fait de mal.`, en: () => `Nothing planned tomorrow: a lie-in never hurt anyone.` },
];
const EVENING_CLOSE = [
  { id: 'ec1', fr: () => `Bonne soirée, vous l'avez bien méritée.`, en: () => `Have a good evening; you've earned it.` },
  { id: 'ec2', fr: () => `Ce soir, c'est repos.`, en: () => `Tonight is for resting.` },
  { id: 'ec3', fr: () => `Prenez un moment pour vous ce soir.`, en: () => `Take a moment for yourself tonight.` },
  { id: 'ec4', fr: () => `Éteignez les écrans un peu plus tôt ce soir : le sommeil fait la moitié du travail.`, en: () => `Switch off the screens a little earlier tonight: sleep does half the work.` },
  { id: 'ec5', fr: () => `Fière de vous ? Vous devriez l'être.`, en: () => `Proud of yourself? You should be.` },
  { id: 'ec6', fr: () => `Bonne soirée, et à demain.`, en: () => `Have a good evening, and see you tomorrow.` },
];

const QUOTES = {
  teach: [
    { id: 'q_mandela', fr: ['L’éducation est l’arme la plus puissante qu’on puisse utiliser pour changer le monde.', 'Nelson Mandela'], en: ['Education is the most powerful weapon which you can use to change the world.', 'Nelson Mandela'] },
    { id: 'q_malala', fr: ['Un enfant, un enseignant, un livre et un stylo peuvent changer le monde.', 'Malala Yousafzai'], en: ['One child, one teacher, one book and one pen can change the world.', 'Malala Yousafzai'] },
    { id: 'q_joubert', fr: ['Enseigner, c’est apprendre deux fois.', 'Joseph Joubert'], en: ['To teach is to learn twice.', 'Joseph Joubert'] },
    { id: 'q_harf', fr: ['Celui qui m’a appris une lettre, je deviens son serviteur.', 'Proverbe arabe'], en: ['Whoever taught me a single letter, I become their servant.', 'Arab proverb'] },
    { id: 'q_coeur', fr: ['On ne voit bien qu’avec le cœur.', 'Antoine de Saint-Exupéry'], en: ['One sees clearly only with the heart.', 'Antoine de Saint-Exupéry'] },
    { id: 'q_plutarque', fr: ['L’esprit n’est pas un vase qu’on remplit, mais un feu qu’on allume.', 'Plutarque'], en: ['The mind is not a vessel to be filled, but a fire to be kindled.', 'Plutarch'] },
    { id: 'q_montaigne', fr: ['Mieux vaut une tête bien faite qu’une tête bien pleine.', 'Montaigne'], en: ['Better a well-made head than a well-filled one.', 'Montaigne'] },
    { id: 'q_hugo', fr: ['Celui qui ouvre une porte d’école ferme une prison.', 'Victor Hugo'], en: ['He who opens a school door closes a prison.', 'Victor Hugo'] },
    { id: 'q_adams', fr: ['Un enseignant touche l’éternité : il ne peut jamais dire où s’arrête son influence.', 'Henry Adams'], en: ['A teacher affects eternity; he can never tell where his influence stops.', 'Henry Adams'] },
    { id: 'q_village', fr: ['Il faut tout un village pour élever un enfant.', 'Proverbe africain'], en: ['It takes a village to raise a child.', 'African proverb'] },
  ],
  patience: [
    { id: 'q_lafontaine1', fr: ['Patience et longueur de temps font plus que force ni que rage.', 'Jean de La Fontaine'], en: ['Patience and time do more than strength or rage.', 'Jean de La Fontaine'] },
    { id: 'q_lafontaine2', fr: ['Rien ne sert de courir ; il faut partir à point.', 'Jean de La Fontaine'], en: ['There is no point in running; you just have to set off on time.', 'Jean de La Fontaine'] },
    { id: 'q_seneque', fr: ['Ce n’est pas parce que les choses sont difficiles que nous n’osons pas, c’est parce que nous n’osons pas qu’elles sont difficiles.', 'Sénèque'], en: ['It is not because things are difficult that we do not dare; it is because we do not dare that they are difficult.', 'Seneca'] },
    { id: 'q_einstein', fr: ['La vie, c’est comme une bicyclette : il faut avancer pour ne pas perdre l’équilibre.', 'Albert Einstein'], en: ['Life is like riding a bicycle. To keep your balance, you must keep moving.', 'Albert Einstein'] },
    { id: 'q_oiseau', fr: ['Petit à petit, l’oiseau fait son nid.', 'Proverbe'], en: ['Little by little, the bird builds its nest.', 'French proverb'] },
    { id: 'q_sabr', fr: ['La patience est la clé du soulagement.', 'Proverbe arabe'], en: ['Patience is the key to relief.', 'Arab proverb'] },
    { id: 'q_laotseu', fr: ['Un voyage de mille lieues commence toujours par un premier pas.', 'Lao Tseu'], en: ['A journey of a thousand miles begins with a single step.', 'Lao Tzu'] },
    { id: 'q_confucius', fr: ['Peu importe que tu ailles lentement, du moment que tu ne t’arrêtes pas.', 'Confucius'], en: ['It does not matter how slowly you go, as long as you do not stop.', 'Confucius'] },
    { id: 'q_rousseau', fr: ['La patience est amère, mais son fruit est doux.', 'Jean-Jacques Rousseau'], en: ['Patience is bitter, but its fruit is sweet.', 'Jean-Jacques Rousseau'] },
  ],
  rest: [
    { id: 'q_racine', fr: ['Qui veut voyager loin ménage sa monture.', 'Jean Racine'], en: ['Whoever wants to travel far takes care of their horse.', 'Jean Racine'] },
    { id: 'q_lubbock', fr: ['Le repos n’est pas l’oisiveté.', 'John Lubbock'], en: ['Rest is not idleness.', 'John Lubbock'] },
    { id: 'q_voltaire', fr: ['Il faut cultiver notre jardin.', 'Voltaire'], en: ['We must cultivate our garden.', 'Voltaire'] },
    { id: 'q_ovide', fr: ['Ce qui n’a pas de repos ne dure pas.', 'Ovide'], en: ['What lacks rest does not last.', 'Ovid'] },
    { id: 'q_piano', fr: ['Qui va doucement va sûrement, et qui va sûrement va loin.', 'Proverbe italien'], en: ['Who goes slowly goes safely, and who goes safely goes far.', 'Italian proverb'] },
  ],
};

// ---------- choosing ----------

/** The variable bits each phrase may use, already worded for the language. */
function words(c, lang) {
  const t = (e, key) => (e ? clock(e[key], lang) : '');
  return {
    ...c,
    dayName: weekdayName(c.today, lang),
    nWord: num(c.n, lang),
    hours: duration(c.minutes || c.timed.reduce((s, e) => s + minutesBetween(e.start, e.end), 0), lang),
    firstTime: t(c.first, 'start'),
    lastTime: t(c.last, 'end'),
    nextTime: t(c.next, 'start'),
    bbFrom: t(c.backToBack?.prev, 'start'),
    bbTo: t(c.backToBack?.next, 'end'),
    breakFrom: t(c.longBreak?.prev, 'end'),
    breakTo: t(c.longBreak?.next, 'start'),
    breakLen: c.longBreak ? duration(c.longBreak.minutes, lang) : '',
    breakNowLen: c.onBreak ? duration(c.onBreak, lang) : '',
    travelFrom: t(c.tightTravel?.prev, 'end'),
    travelTo: t(c.tightTravel?.next, 'start'),
    instNames: c.institutions.map((id) => categoryById(id)?.name).filter(Boolean).join(lang === 'fr' ? ' et ' : ' and '),
    overdueWord: num(c.overdue, lang),
    doneWord: num(c.done.length, lang),
    comingWord: num(c.coming.length, lang),
    tomorrowTime: t(c.tomorrowEvents[0], 'start'),
    tomorrowWord: num(c.tomorrowEvents.length, lang),
    examTime: t(c.exam, 'start'),
    meetingTime: t(c.meeting, 'start'),
    holidayInWord: num(c.holidayIn, lang),
  };
}

/** Picks one phrase from `pool` whose condition holds, preferring those not read recently. */
function pickOne(pool, c, rand, recent) {
  const ok = pool.filter((p) => !p.when || p.when(c));
  if (!ok.length) return null;
  const fresh = ok.filter((p) => !recent.has(p.id));
  if (fresh.length) return fresh[Math.floor(rand() * fresh.length)];
  // Everything was read recently: take the one read the longest time ago.
  return ok.reduce((best, p) => (recent.get(p.id) < recent.get(best.id) ? p : best));
}

// The same advice every morning would feel automatic: a topic rests a few days after being given,
// except the reminders she must act on today.
const ALWAYS = ['ex', 'me', 'at', 'tr'];

function choose(c, rand, recent, restingGroups) {
  const ids = [];
  const add = (p) => p && ids.push(p.id);
  if (c.phase === 'morning' || !c.n) {
    add(pickOne(OPENINGS, c, rand, recent));
    if (c.n) add(pickOne(CONTEXT, c, rand, recent));
    // The time of year, one morning in three.
    if (rand() < 0.35) add(pickOne(SEASON, c, rand, recent));
    // Up to two practical details, the most important situations first.
    const groups = ['ex', 'me', 'at', 'bb', 'lu', 'tr', 'br', 'ea', 'la', 'mi', 'su', 'ov'];
    let details = 0;
    for (const g of groups) {
      if (details >= 2) break;
      if (!ALWAYS.includes(g) && restingGroups.has(g)) continue;
      const p = pickOne(DETAILS.filter((d) => d.id.startsWith(g)), c, rand, recent);
      if (p) {
        add(p);
        details++;
      }
    }
    // A small idea, most days, when the note isn't already full of advice.
    if (details < 2 && rand() < 0.6) add(pickOne(TIPS, c, rand, recent));
    add(pickOne(CLOSINGS, c, rand, recent));
    // A quotation most mornings, not every single day.
    if (rand() < 0.75) {
      const theme = !c.n ? 'rest' : c.heavy || c.yesterdayHeavy ? 'patience' : rand() < 0.6 ? 'teach' : 'patience';
      add(pickOne(QUOTES[theme], c, rand, recent));
    }
  } else if (c.phase === 'day') {
    add(pickOne(DAY.filter((d) => d.id.startsWith('dp') || d.id.startsWith('dc')), c, rand, recent));
    add(pickOne(DAY.filter((d) => d.id.startsWith('db')), c, rand, recent));
    add(pickOne(DAY.filter((d) => d.id.startsWith('da')), c, rand, recent));
  } else {
    add(pickOne(EVENING, c, rand, recent));
    add(pickOne(EVENING_AFTER.filter((d) => d.id === 'ea_att'), c, rand, recent));
    add(pickOne(EVENING_AFTER.filter((d) => d.id !== 'ea_att'), c, rand, recent));
    add(pickOne(EVENING_CLOSE, c, rand, recent));
    if (rand() < 0.4) add(pickOne(QUOTES.rest, c, rand, recent));
  }
  return ids;
}

const ALL = [...OPENINGS, ...CONTEXT, ...SEASON, ...TIPS, ...DETAILS, ...CLOSINGS, ...DAY, ...EVENING, ...EVENING_AFTER, ...EVENING_CLOSE];
const QUOTE_BY_ID = Object.fromEntries(Object.values(QUOTES).flat().map((q) => [q.id, q]));
const PHRASE_BY_ID = Object.fromEntries(ALL.map((p) => [p.id, p]));

/** Writes the note for today, at this moment of the day. */
export function composeDayNote(data) {
  const lang = getLanguage() === 'fr' ? 'fr' : 'en';
  const c = analyse(data);
  const w = words(c, lang);
  const key = `${c.today}|${c.n ? c.phase : 'free'}`;
  const store = state.settings.dayNote || { picks: {}, history: [] };
  let ids = store.picks?.[key];
  // A saved choice is reused all day, unless the day changed so much that a sentence no longer fits.
  const fits = (id) => (QUOTE_BY_ID[id] ? true : PHRASE_BY_ID[id] && (!PHRASE_BY_ID[id].when || PHRASE_BY_ID[id].when(c)));
  let isNew = false;
  if (!ids || !ids.every(fits)) {
    // id → how recently it was read (higher = more recent).
    const recent = new Map((store.history || []).slice(-60).map((id, i) => [id, i]));
    // Detail topics given in the last two days (not counting today).
    const resting = new Set(
      (store.days || [])
        .filter((d) => d.d < c.today && d.d >= addDaysStr(c.today, -2))
        .flatMap((d) => d.ids.filter((id) => DETAILS.some((x) => x.id === id)).map((id) => id.slice(0, 2)))
    );
    ids = choose(c, seeded(hash(key)), recent, resting);
    isNew = true;
  }
  const lines = [];
  let quote = null;
  let tip = null;
  for (const id of ids) {
    if (QUOTE_BY_ID[id]) {
      const [text, author] = QUOTE_BY_ID[id][lang];
      quote = { text, author };
    } else if (TIPS.some((x) => x.id === id)) {
      // "Petite idée : …" is shown on its own line, with the label set apart.
      const full = PHRASE_BY_ID[id][lang](w);
      const cut = full.indexOf(': ') + 1;
      tip = { label: full.slice(0, cut), text: cap(full.slice(cut + 1)) };
    } else lines.push(PHRASE_BY_ID[id][lang](w));
  }
  // The last sentence is the warm word that closes the note; the rest is about the day.
  const closing = lines.length > 1 ? lines.pop() : '';
  return { key, ids, isNew, phase: c.n ? c.phase : 'free', body: lines.join(' '), tip, closing, quote };
}

/** Remembers today's choice (stable all day) and what was read (to avoid repeating it). */
export async function rememberDayNote(note) {
  if (!note.isNew) return;
  const prev = state.settings.dayNote || { picks: {}, history: [] };
  const today = note.key.slice(0, 10);
  const picks = Object.fromEntries(Object.entries(prev.picks || {}).filter(([k]) => k.startsWith(today)));
  picks[note.key] = note.ids;
  const history = [...(prev.history || []).filter((id) => !note.ids.includes(id)), ...note.ids].slice(-150);
  // What was said each day, to rest a topic for a few days.
  const days = (prev.days || []).filter((d) => d.d !== today);
  days.push({ d: today, ids: [...new Set([...(prev.days || []).find((d) => d.d === today)?.ids || [], ...note.ids])] });
  state.settings.dayNote = { picks, history, days: days.slice(-10) };
  try {
    await api.put('/api/settings', { dayNote: state.settings.dayNote });
  } catch {
    /* not important: it will simply be chosen again */
  }
}
