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
];

// At most one: how this day sits in the week.
const CONTEXT = [
  { id: 'cy1', when: (c) => c.yesterdayHeavy && c.n, fr: () => `Après la grosse journée d'hier, allez-y doucement.`, en: () => `After yesterday's big day, take it easy.` },
  { id: 'cy2', when: (c) => c.yesterdayHeavy && c.n, fr: () => `Hier a été long ; aujourd'hui, pas besoin d'en faire plus que nécessaire.`, en: () => `Yesterday was long; today, no need to do more than necessary.` },
  { id: 'cl1', when: (c) => c.lastDayOfWeek, fr: () => `Dernière journée de cours de la semaine : encore un effort et c'est le repos.`, en: () => `Last teaching day of the week: one more push and then it's rest.` },
  { id: 'cl2', when: (c) => c.lastDayOfWeek, fr: () => `C'est la dernière ligne droite de la semaine.`, en: () => `It's the home stretch of the week.` },
  { id: 'cm1', when: (c) => c.monday, fr: () => `Nouvelle semaine, nouvelle page.`, en: () => `New week, new page.` },
  { id: 'cm2', when: (c) => c.monday, fr: () => `Début de semaine : on démarre en douceur.`, en: () => `Start of the week: ease into it.` },
];

// Up to two, in this order of importance: practical advice drawn from the schedule.
const DETAILS = [
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
];

// During the day: where she is now.
const DAY = [
  { id: 'dp1', when: (c) => c.next && c.done.length, fr: (c) => `Déjà ${c.doneWord} cours derrière vous. Le prochain : ${c.next.title}, à ${c.nextTime}.`, en: (c) => `Already ${c.doneWord} ${c.done.length > 1 ? 'classes' : 'class'} behind you. Next: ${c.next.title}, at ${c.nextTime}.` },
  { id: 'dp2', when: (c) => c.next, fr: (c) => `Encore ${c.comingWord} cours, et la journée sera faite. Prochain rendez-vous : ${c.nextTime}.`, en: (c) => `${cap(c.comingWord)} more ${c.coming.length > 1 ? 'classes' : 'class'} and the day is done. Next one at ${c.nextTime}.` },
  { id: 'dc1', when: (c) => c.current && !c.next, fr: (c) => `Dernier cours de la journée en ce moment : ${c.current.title}. Le plus dur est fait.`, en: (c) => `Last class of the day right now: ${c.current.title}. The hardest part is done.` },
  { id: 'db1', when: (c) => c.onBreak >= 20, fr: (c) => `C'est la pause jusqu'à ${c.nextTime}. Asseyez-vous, buvez un verre d'eau, et ne pensez pas encore au cours suivant.`, en: (c) => `Break until ${c.nextTime}. Sit down, drink some water, and don't think about the next class just yet.` },
  { id: 'db2', when: (c) => c.onBreak >= 20, fr: (c) => `${cap(c.breakNowLen)} avant ${c.next.title} : de quoi souffler un peu.`, en: (c) => `${cap(c.breakNowLen)} before ${c.next.title}: time to catch your breath.` },
  { id: 'da1', when: (c) => c.attToday && c.attToday.end <= c.now, fr: (c) => `Avez-vous pu demander l'attestation de ${c.attToday.title} ? Si c'est fait, marquez-la comme reçue.`, en: (c) => `Did you manage to ask for the attestation for ${c.attToday.title}? If so, mark it as received.` },
];

// In the evening: a short recap and tomorrow.
const EVENING = [
  { id: 'ev1', when: () => true, fr: (c) => `C'est terminé pour aujourd'hui : ${c.hours} de cours. Bravo.`, en: (c) => `That's it for today: ${c.hours} of teaching. Well done.` },
  { id: 'ev2', when: () => true, fr: (c) => `Journée bouclée, ${c.nWord} ${c.n > 1 ? 'cours donnés' : 'cours donné'}. Le reste de la soirée est à vous.`, en: (c) => `Day done, ${c.nWord} ${c.n > 1 ? 'classes' : 'class'} given. The rest of the evening is yours.` },
  { id: 'ev3', when: (c) => c.heavy, fr: (c) => `Une longue journée derrière vous${c.firstName ? `, ${c.firstName}` : ''}. Ce que vous avez fait aujourd'hui compte vraiment.`, en: (c) => `A long day behind you${c.firstName ? `, ${c.firstName}` : ''}. What you did today really matters.` },
  { id: 'ev4', when: (c) => !c.heavy, fr: () => `Les cours sont finis. Posez le sac, la journée a été bien remplie.`, en: () => `Classes are over. Put the bag down: it was a full day.` },
];
const EVENING_AFTER = [
  { id: 'ea_att', when: (c) => c.attToday, fr: (c) => `Avez-vous pu récupérer l'attestation de ${c.attToday.title} ? Si oui, un clic pour la marquer comme reçue.`, en: (c) => `Did you get the attestation for ${c.attToday.title}? If so, one click to mark it as received.` },
  { id: 'tm1', when: (c) => c.tomorrowEvents.length, fr: (c) => `Demain, premier cours à ${c.tomorrowTime} (${c.tomorrowEvents[0].title}).`, en: (c) => `Tomorrow, first class at ${c.tomorrowTime} (${c.tomorrowEvents[0].title}).` },
  { id: 'tm2', when: (c) => c.tomorrowEvents.length, fr: (c) => `Demain, ça reprend à ${c.tomorrowTime}. Une bonne nuit, et ce sera parfait.`, en: (c) => `Tomorrow it starts again at ${c.tomorrowTime}. A good night's sleep, and it'll be perfect.` },
  { id: 'tn1', when: (c) => !c.tomorrowEvents.length, fr: () => `Pas de cours demain : vous pouvez éteindre le réveil.`, en: () => `No classes tomorrow: you can switch off the alarm.` },
];
const EVENING_CLOSE = [
  { id: 'ec1', fr: () => `Bonne soirée, vous l'avez bien méritée.`, en: () => `Have a good evening; you've earned it.` },
  { id: 'ec2', fr: () => `Ce soir, c'est repos.`, en: () => `Tonight is for resting.` },
  { id: 'ec3', fr: () => `Prenez un moment pour vous ce soir.`, en: () => `Take a moment for yourself tonight.` },
];

const QUOTES = {
  teach: [
    { id: 'q_mandela', fr: ['L’éducation est l’arme la plus puissante qu’on puisse utiliser pour changer le monde.', 'Nelson Mandela'], en: ['Education is the most powerful weapon which you can use to change the world.', 'Nelson Mandela'] },
    { id: 'q_malala', fr: ['Un enfant, un enseignant, un livre et un stylo peuvent changer le monde.', 'Malala Yousafzai'], en: ['One child, one teacher, one book and one pen can change the world.', 'Malala Yousafzai'] },
    { id: 'q_joubert', fr: ['Enseigner, c’est apprendre deux fois.', 'Joseph Joubert'], en: ['To teach is to learn twice.', 'Joseph Joubert'] },
    { id: 'q_harf', fr: ['Celui qui m’a appris une lettre, je deviens son serviteur.', 'Proverbe arabe'], en: ['Whoever taught me a single letter, I become their servant.', 'Arab proverb'] },
    { id: 'q_coeur', fr: ['On ne voit bien qu’avec le cœur.', 'Antoine de Saint-Exupéry'], en: ['One sees clearly only with the heart.', 'Antoine de Saint-Exupéry'] },
  ],
  patience: [
    { id: 'q_lafontaine1', fr: ['Patience et longueur de temps font plus que force ni que rage.', 'Jean de La Fontaine'], en: ['Patience and time do more than strength or rage.', 'Jean de La Fontaine'] },
    { id: 'q_lafontaine2', fr: ['Rien ne sert de courir ; il faut partir à point.', 'Jean de La Fontaine'], en: ['There is no point in running; you just have to set off on time.', 'Jean de La Fontaine'] },
    { id: 'q_seneque', fr: ['Ce n’est pas parce que les choses sont difficiles que nous n’osons pas, c’est parce que nous n’osons pas qu’elles sont difficiles.', 'Sénèque'], en: ['It is not because things are difficult that we do not dare; it is because we do not dare that they are difficult.', 'Seneca'] },
    { id: 'q_einstein', fr: ['La vie, c’est comme une bicyclette : il faut avancer pour ne pas perdre l’équilibre.', 'Albert Einstein'], en: ['Life is like riding a bicycle. To keep your balance, you must keep moving.', 'Albert Einstein'] },
    { id: 'q_oiseau', fr: ['Petit à petit, l’oiseau fait son nid.', 'Proverbe'], en: ['Little by little, the bird builds its nest.', 'French proverb'] },
  ],
  rest: [
    { id: 'q_racine', fr: ['Qui veut voyager loin ménage sa monture.', 'Jean Racine'], en: ['Whoever wants to travel far takes care of their horse.', 'Jean Racine'] },
    { id: 'q_lubbock', fr: ['Le repos n’est pas l’oisiveté.', 'John Lubbock'], en: ['Rest is not idleness.', 'John Lubbock'] },
    { id: 'q_voltaire', fr: ['Il faut cultiver notre jardin.', 'Voltaire'], en: ['We must cultivate our garden.', 'Voltaire'] },
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
const ALWAYS = ['at', 'tr'];

function choose(c, rand, recent, restingGroups) {
  const ids = [];
  const add = (p) => p && ids.push(p.id);
  if (c.phase === 'morning' || !c.n) {
    add(pickOne(OPENINGS, c, rand, recent));
    if (c.n) add(pickOne(CONTEXT, c, rand, recent));
    // Up to two practical details, the most important situations first.
    const groups = ['at', 'bb', 'lu', 'tr', 'br', 'ea', 'la', 'mi', 'su', 'ov'];
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

const ALL = [...OPENINGS, ...CONTEXT, ...DETAILS, ...CLOSINGS, ...DAY, ...EVENING, ...EVENING_AFTER, ...EVENING_CLOSE];
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
  for (const id of ids) {
    if (QUOTE_BY_ID[id]) {
      const [text, author] = QUOTE_BY_ID[id][lang];
      quote = { text, author };
    } else lines.push(PHRASE_BY_ID[id][lang](w));
  }
  // The last sentence is the warm word that closes the note; the rest is about the day.
  const closing = lines.length > 1 ? lines.pop() : '';
  return { key, ids, isNew, phase: c.n ? c.phase : 'free', body: lines.join(' '), closing, quote };
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
