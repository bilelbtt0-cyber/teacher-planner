import { api } from '../api.js';
import { t, tn, todayStr, addDaysStr, fmtDate, fmtWeekdayLong, reminderLabel, hoursLabel } from '../i18n.js';
import { state, loadSettings, loadCategories, changed, applyTheme, activeCategories, emit } from '../store.js';
import { esc, icon, on, toast, errorToast, setBusy, CATEGORY_COLORS, openModal } from '../ui.js';

// The welcome guide: a few friendly steps that collect her answers AND set the app up with them.
// Everything is saved after each step, so she can stop at any time and continue later.

const STEPS = [
  { key: 'intro', title: 'Welcome', icon: 'sparkles' },
  { key: 'about', title: 'About you', icon: 'user' },
  { key: 'institutions', title: 'Institutions', icon: 'building' },
  { key: 'timetable', title: 'Timetable', icon: 'calendar' },
  { key: 'reminders', title: 'Reminders', icon: 'bell' },
  { key: 'email', title: 'Email', icon: 'mail' },
  { key: 'documents', title: 'Documents & wishes', icon: 'folder' },
  { key: 'done', title: 'All set', icon: 'checkCircle' },
];

const MODES = [
  { value: 'none', label: 'No attestation', hint: 'This institution gives no attestation.' },
  { value: 'hours', label: 'After a number of hours', hint: 'e.g. one attestation every 30 teaching hours.' },
  { value: 'session', label: 'After each session', hint: 'Every class needs its own attestation.' },
  { value: 'monthly', label: 'Once a month', hint: 'One attestation at the last class of each month.' },
  { value: 'manual', label: 'It varies', hint: 'You will mark the sessions that need one yourself.' },
];

const DEVICES = [
  { value: 'laptop', label: 'Laptop' },
  { value: 'desktop', label: 'Desktop computer' },
  { value: 'android', label: 'Android phone' },
  { value: 'iphone', label: 'iPhone' },
  { value: 'tablet', label: 'Tablet' },
];

const PROVIDERS = {
  gmail: { label: 'Gmail', host: 'smtp.gmail.com', port: 465, secure: true },
  outlook: { label: 'Outlook / Hotmail', host: 'smtp-mail.outlook.com', port: 587, secure: false },
  yahoo: { label: 'Yahoo', host: 'smtp.mail.yahoo.com', port: 465, secure: true },
  other: { label: 'Other', host: '', port: 587, secure: false },
};

const DOC_TYPES = ['Attestations', 'Certificates', 'Contracts', 'Payslips', 'Official timetables', 'Mission orders', 'Invoices'];
const WISHES = [
  { value: 'payments', label: 'Track my payments (amounts per institution)' },
  { value: 'report', label: 'A monthly hours report to print or send (PDF / Excel)' },
  { value: 'sms', label: 'Reminders by SMS or WhatsApp' },
  { value: 'sync', label: 'See my classes in Google Calendar or on my iPhone' },
  { value: 'shared', label: 'Give access to someone else (read only)' },
  { value: 'senddocs', label: 'Send a document by email from the app' },
];
const NAG_CHOICES = [2, 4, 12, 24, 48];
const REMINDER_CHOICES = [0, 10, 30, 60, 120, 1440, 2880];

const uid = () => Math.random().toString(36).slice(2, 10);

function schoolYear() {
  const now = new Date();
  const y = now.getMonth() >= 6 ? now.getFullYear() : now.getFullYear() - 1;
  return { start: `${y}-09-15`, end: `${y + 1}-06-30` };
}

/** First date on or after `from` that falls on weekday `day` (0 = Sunday). */
function firstOnWeekday(from, day) {
  for (let i = 0; i < 7; i++) {
    const d = addDaysStr(from, i);
    if (new Date(`${d}T12:00`).getDay() === day) return d;
  }
  return from;
}

export async function render(root) {
  await loadSettings().catch(() => {});
  const ob = structuredClone(state.settings.onboarding || { step: 0, answers: {} });
  const A = ob.answers || (ob.answers = {});
  let step = Math.min(ob.step || 0, STEPS.length - 1);
  if (ob.completed) step = 0;
  let maxVisited = Math.max(step, ob.completed ? STEPS.length - 1 : step);
  let busy = false;

  // ----- default answers (pre-filled from what the app already knows) -----
  const s = state.settings;
  A.about ||= {
    name: state.user.name,
    language: s.language,
    theme: s.theme,
    accentColor: s.accentColor || '#5b5bd6',
    appName: s.appName && s.appName !== 'Planner' ? s.appName : '',
    devices: [],
    phoneScan: '',
    computerOn: '',
  };
  A.institutions ||= { rows: [], deadline: '', multiSessions: '', backlog: '' };
  if (!A.institutions.rows.length) {
    A.institutions.rows = activeCategories().map((c) => ({
      id: uid(),
      categoryId: c.id,
      name: c.name,
      color: c.color,
      mode: c.attestationMode || 'none',
      every: c.attestationEveryHours || '',
      offset: c.attestationOffsetHours || '',
      signer: c.attestationSigner || '',
      notes: c.notes || '',
    }));
    if (!A.institutions.rows.length) A.institutions.rows.push(newInstitution(0));
  }
  const sy = schoolYear();
  A.timetable ||= {
    yearStart: sy.start,
    yearEnd: sy.end,
    dayStart: s.dayStart,
    dayEnd: s.dayEnd,
    weekStart: s.weekStart,
    slots: [],
    holidays: [],
    cancelInHolidays: true,
    extraKinds: '',
    privateLessons: '',
    photoDocId: null,
  };
  A.reminders ||= {
    defaults: structuredClone(s.defaultReminders || []),
    nagIntervalHours: s.nagIntervalHours,
    quietStart: s.quietStart,
    quietEnd: s.quietEnd,
    digestEnabled: s.digestEnabled,
    digestTime: s.digestTime,
    smsWish: '',
  };
  A.email ||= { recipient: s.notifyEmail || state.user.email, provider: '', dedicated: '', ccWish: '', user: '', connected: s.smtpConfigured };
  A.documents ||= { docTypes: ['Attestations'], naming: 'default', namingOther: '', backlogCount: '', arabic: '', sendTo: '' };
  A.wishes ||= { list: [], timeWaster: '', other: '' };

  function newInstitution(i) {
    return { id: uid(), categoryId: null, name: '', color: CATEGORY_COLORS[i % CATEGORY_COLORS.length], mode: '', every: '', offset: '', signer: '', notes: '' };
  }
  function newSlot() {
    const last = A.timetable.slots[A.timetable.slots.length - 1];
    return {
      id: uid(),
      day: last ? last.day : 1,
      start: last ? last.end : '08:00',
      end: last ? addTime(last.end, 120) : '10:00',
      title: '',
      // With one institution it is the obvious choice; with several she picks it herself.
      categoryId: last?.categoryId || (activeCategories().length === 1 ? activeCategories()[0].id : ''),
      location: '',
      kind: 'class',
      every: last?.every || '1',
      seriesId: null,
      count: 0,
    };
  }
  function addTime(hhmm, minutes) {
    const [h, m] = hhmm.split(':').map(Number);
    const total = Math.min(23 * 60 + 59, h * 60 + m + minutes);
    return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
  }

  async function persist(extra = {}) {
    Object.assign(ob, extra);
    await api.put('/api/settings', { onboarding: ob });
    state.settings.onboarding = structuredClone(ob);
  }

  // ---------- layout ----------
  const afterRender = {
    institutions: (body) => {
      const empty = [...body.querySelectorAll('[data-f="name"]')].find((i) => !i.value);
      empty?.focus({ preventScroll: true });
    },
  };

  let drawnStep = step;
  function draw() {
    if (drawnStep !== step) missingKeys = new Set();
    drawnStep = step;
    const st = STEPS[step];
    const visible = STEPS.slice(1, -1);
    root.innerHTML = `
      <div class="wizard">
        ${
          step > 0 && step < STEPS.length - 1
            ? `<div class="wiz-progress">
              <div class="wiz-bar"><div style="width:${Math.round(((step - 1) / (visible.length - 1)) * 100)}%"></div></div>
              <div class="wiz-steps">${visible
                .map((x, i) => {
                  const idx = i + 1;
                  const cls = idx === step ? 'active' : idx < step || idx <= maxVisited ? 'done' : '';
                  return `<button class="wiz-step ${cls}" data-goto="${idx}" ${idx <= maxVisited ? '' : 'disabled'}><span class="n">${idx < step ? icon('check', 'sm') : idx}</span><span class="l">${esc(t(x.title))}</span></button>`;
                })
                .join('')}</div></div>`
            : ''
        }
        <div class="wiz-card card">
          <div class="wiz-body" data-body></div>
          ${
            st.key !== 'intro' && st.key !== 'done'
              ? `<div class="wiz-foot">
              <button class="btn ghost" data-back>${icon('arrowL', 'sm')}${esc(t('Back'))}</button>
              <span class="spacer"></span>
              <span class="small muted hide-sm">${esc(t('Step {a} of {b}', { a: step, b: visible.length }))}</span>
              <span class="small muted"><span class="req">*</span> ${esc(t('required'))}</span>
              <button class="btn primary" data-next>${esc(step === STEPS.length - 2 ? t('Finish') : t('Save & continue'))}${icon('arrowR', 'sm')}</button>
            </div>`
              : ''
          }
        </div>
      </div>`;
    const body = root.querySelector('[data-body]');
    body.innerHTML = VIEWS[st.key]();
    afterRender[st.key]?.(body);
    root.querySelector('.wiz-card').scrollIntoView({ block: 'start' });
    window.scrollTo(0, 0);
  }

  const header = (title, subtitle) =>
    `<div class="wiz-head"><h2>${esc(title)}</h2>${subtitle ? `<p>${esc(subtitle)}</p>` : ''}</div>`;
  const yesNo = (name, value, options = [['yes', 'Yes'], ['no', 'No']]) =>
    `<div class="segmented" data-radio="${name}">${options
      .map(([v, l]) => `<button type="button" data-val="${v}" class="${value === v ? 'active' : ''}">${esc(t(l))}</button>`)
      .join('')}</div>`;
  // Questions given a key are required: marked with * and checked before moving on.
  let missingKeys = new Set();
  const missingNote = (text) => `<div class="wiz-missing">${icon('alertCircle', 'sm')}<span>${esc(text)}</span></div>`;
  const q = (label, control, hint = '', key = '') =>
    `<div class="wiz-q ${key && missingKeys.has(key) ? 'missing' : ''}" ${key ? `data-q="${key}"` : ''}><div class="wiz-q-label">${esc(label)}${key ? ' <span class="req">*</span>' : ''}</div>${hint ? `<div class="hint">${esc(hint)}</div>` : ''}<div class="wiz-q-control">${control}</div>${key && missingKeys.has(key) ? missingNote(t('Please answer this question.')) : ''}</div>`;

  // ---------- step views ----------
  const VIEWS = {
    intro: () => `
      <div class="wiz-hero">
        <div class="wiz-hero-ic">${icon('sparkles', 'xl')}</div>
        <h2>${esc(t('Welcome, {name}!', { name: (state.user.name || '').split(' ')[0] }))}</h2>
        <p>${esc(t('Let’s make this planner yours. In 6 short steps we will add your institutions, your timetable and your reminders — the app sets itself up as you answer.'))}</p>
        <ul class="wiz-points">
          <li>${icon('clock')}<span>${esc(t('About 5 minutes'))}</span></li>
          <li>${icon('check')}<span>${esc(t('Saved at every step — stop and continue whenever you like'))}</span></li>
          ${ob.completed ? '' : `<li>${icon('info')}<span>${esc(t('Please complete it once before using your planner.'))}</span></li>`}
          <li>${icon('edit')}<span>${esc(t('Everything can be changed later in Settings'))}</span></li>
        </ul>
        <div class="flex wrap" style="justify-content:center;margin-top:8px">
          <button class="btn primary lg" data-start>${esc(ob.completed ? t('Review my answers step by step') : maxVisited > 0 ? t('Continue where I stopped') : t('Let’s start'))}${icon('arrowR')}</button>
          ${ob.completed ? `<a class="btn ghost lg" href="#/today">${esc(t('Back to my planner'))}</a>` : `<button class="btn ghost lg" data-logout>${esc(t('Sign out'))}</button>`}
        </div>
      </div>`,

    about: () => {
      const a = A.about;
      return `${header(t('About you'), t('A few details so the planner feels like yours.'))}
        <div class="stack">
          ${q(t('Your name'), `<input class="input" name="name" value="${esc(a.name)}" maxlength="80">`, '', 'name')}
          ${q(t('Language'), yesNo('language', a.language, [['fr', 'Français'], ['en', 'English']]))}
          ${q(t('Name of your planner'), `<input class="input" name="appName" value="${esc(a.appName)}" placeholder="${esc(t('e.g. Marwa’s planner'))}" maxlength="40">`, t('Shown at the top of the app and in your emails. Leave empty to keep “Planner”.'))}
          ${q(
            t('Your colour'),
            `<div class="color-swatches">${CATEGORY_COLORS.slice(0, 9)
              .map((c) => `<button type="button" class="swatch ${c === a.accentColor ? 'active' : ''}" data-accent="${c}" style="background:${c}" aria-label="${c}"></button>`)
              .join('')}</div>`,
            t('The whole app changes colour as you pick.')
          )}
          ${q(t('Theme'), yesNo('theme', a.theme, [['system', 'Automatic'], ['light', 'Light'], ['dark', 'Dark']]))}
          ${q(
            t('Which devices will you use?'),
            `<div class="pills">${DEVICES.map((d) => `<button type="button" class="pill ${a.devices.includes(d.value) ? 'active' : ''}" data-multi="devices" data-val="${d.value}">${esc(t(d.label))}</button>`).join('')}</div>`,
            '',
            'devices'
          )}
          ${q(t('Will you scan your attestations with your phone?'), yesNo('phoneScan', a.phoneScan), '', 'phoneScan')}
          ${q(
            t('Is your computer usually on during the day?'),
            yesNo('computerOn', a.computerOn, [['yes', 'Yes'], ['sometimes', 'Sometimes'], ['no', 'No']]),
            t('While the app runs on your computer, reminder emails are only sent when it is on.'),
            'computerOn'
          )}
        </div>`;
    },

    institutions: () => {
      const I = A.institutions;
      return `${header(t('Your institutions'), t('Add each school or training centre where you work, and tell us how it gives attestations. This is what lets the app remind you at the right moment.'))}
        <div class="stack">
          ${I.rows
            .map(
              (r, i) => `<div class="wiz-inst ${missingKeys.has('row:' + r.id) ? 'missing' : ''}" data-row="${r.id}" style="--c:${r.color}" data-missing-text="${esc(t('Give it a name and choose how it gives attestations.'))}">
              <div class="flex">
                <span class="wiz-inst-num" style="background:${r.color}">${i + 1}</span>
                <input class="input" data-f="name" value="${esc(r.name)}" placeholder="${esc(t('Name, e.g. Lycée Pilote Ariana'))}" maxlength="120" style="font-weight:600">
                ${!r.categoryId && I.rows.length > 1 ? `<button type="button" class="btn ghost icon-only sm" data-del-inst="${r.id}" aria-label="${esc(t('Remove'))}">${icon('trash', 'sm')}</button>` : ''}
              </div>
              <div class="color-swatches" style="margin:10px 0 2px 38px">${CATEGORY_COLORS.map(
                (c) => `<button type="button" class="swatch sm ${c === r.color ? 'active' : ''}" data-inst-color="${c}" style="background:${c}" aria-label="${c}"></button>`
              ).join('')}</div>
              <div class="wiz-inst-body">
                <div class="label" style="margin-bottom:8px">${esc(t('How does it give attestations?'))}</div>
                <div class="wiz-modes">${MODES.map(
                  (m) => `<button type="button" class="wiz-mode ${r.mode === m.value ? 'active' : ''}" data-mode="${m.value}"><span class="t">${esc(t(m.label))}</span><span class="d">${esc(t(m.hint))}</span></button>`
                ).join('')}</div>
                ${
                  r.mode === 'hours'
                    ? `<div class="grid-2" style="margin-top:12px">
                    <div class="field"><label>${esc(t('One attestation every … hours'))}</label><input class="input" type="number" min="0.5" step="0.5" data-f="every" value="${esc(r.every)}" placeholder="30"></div>
                    <div class="field"><label>${esc(t('Hours already done since your last attestation'))}</label><input class="input" type="number" min="0" step="0.5" data-f="offset" value="${esc(r.offset)}" placeholder="0"></div>
                  </div>`
                    : ''
                }
                ${
                  r.mode && r.mode !== 'none'
                    ? `<div class="grid-2" style="margin-top:12px">
                    <div class="field"><label>${esc(t('Who gives or signs it?'))}</label><input class="input" data-f="signer" value="${esc(r.signer)}" placeholder="${esc(t('e.g. the director, the secretariat'))}" maxlength="200"></div>
                    <div class="field"><label>${esc(t('Notes'))}</label><input class="input" data-f="notes" value="${esc(r.notes)}" placeholder="${esc(t('e.g. ask before the 25th'))}" maxlength="500"></div>
                  </div>`
                    : ''
                }
              </div>
            </div>`
            )
            .join('')}
          <button type="button" class="btn soft" data-add-inst style="align-self:flex-start">${icon('plus', 'sm')}${esc(t('Add another institution'))}</button>
          <div class="wiz-sub">${esc(t('A few more details'))}</div>
          ${q(t('Is there a deadline to collect your attestations?'), `<input class="input" name="deadline" value="${esc(I.deadline)}" placeholder="${esc(t('e.g. before the end of each month, before payment'))}">`)}
          ${q(t('Does one attestation sometimes cover several sessions?'), yesNo('multiSessions', I.multiSessions), '', 'multiSessions')}
          ${q(t('Have you forgotten attestations that you still need to collect?'), `<textarea class="textarea" name="backlog" rows="2" placeholder="${esc(t('Which ones, and for which dates?'))}">${esc(I.backlog)}</textarea>`, t('We can add them so the app reminds you.'))}
        </div>`;
    },

    timetable: () => {
      const T = A.timetable;
      const cats = activeCategories();
      const order = T.weekStart === 0 ? [0, 1, 2, 3, 4, 5, 6] : [1, 2, 3, 4, 5, 6, 0];
      const from = T.yearStart > todayStr() ? T.yearStart : todayStr();
      return `${header(t('Your weekly timetable'), t('Add your usual weekly classes once: the app fills your calendar until the end of the school year.'))}
        <div class="stack">
          <div class="grid-2">
            <div class="field"><label>${esc(t('First day of the school year'))}</label><input class="input" type="date" name="yearStart" value="${esc(T.yearStart)}"></div>
            <div class="field"><label>${esc(t('Last day of the school year'))}</label><input class="input" type="date" name="yearEnd" value="${esc(T.yearEnd)}"></div>
          </div>
          ${missingKeys.has('year') ? missingNote(t('Please check the dates of the school year.')) : ''}
          <div class="wiz-sub">${esc(t('Weekly classes'))} <span class="req">*</span></div>
          <div class="tip">${icon('info')}<span>${esc(t('Classes are added from {from} to {to}. Past weeks are not created.', { from: fmtDate(from), to: fmtDate(T.yearEnd) }))}</span></div>
          <div class="stack tight">
            ${T.slots
              .map((sl) => {
                if (sl.seriesId) {
                  const cat = cats.find((c) => c.id === Number(sl.categoryId));
                  return `<div class="wiz-slot done">${icon('checkCircle')}<span class="strong">${esc(fmtWeekdayLong(sl.day))} ${esc(sl.start)}–${esc(sl.end)}</span>${sl.every && sl.every !== '1' ? `<span class="chip">${esc(t('every 2 weeks'))}</span>` : ''}
                    <span>${esc(sl.title)}</span>${cat ? `<span class="chip"><span class="cat-dot" style="background:${cat.color}"></span>${esc(cat.name)}</span>` : ''}
                    <span class="spacer"></span><span class="small muted">${esc(tn(sl.count, '{n} session in your calendar', '{n} sessions in your calendar'))}</span></div>`;
                }
                return `<div class="wiz-slot ${missingKeys.has('slot:' + sl.id) ? 'missing' : ''}" data-slot="${sl.id}" data-missing-text="${esc(t('Check the times and choose the institution.'))}">
                  <select class="select" data-s="day">${order.map((d) => `<option value="${d}" ${Number(sl.day) === d ? 'selected' : ''}>${esc(fmtWeekdayLong(d))}</option>`).join('')}</select>
                  <select class="select" data-s="every" title="${esc(t('How often'))}">${[['1', 'Every week'], ['2a', 'Every 2 weeks (from this week)'], ['2b', 'Every 2 weeks (from next week)']]
                    .map(([v, l]) => `<option value="${v}" ${String(sl.every || '1') === v ? 'selected' : ''}>${esc(t(l))}</option>`)
                    .join('')}</select>
                  <input class="input" type="time" data-s="start" value="${esc(sl.start)}" step="60">
                  <input class="input" type="time" data-s="end" value="${esc(sl.end)}" step="60">
                  <input class="input grow" data-s="title" value="${esc(sl.title)}" placeholder="${esc(t('Class, e.g. Maths 3A'))}" maxlength="200">
                  <select class="select" data-s="categoryId"><option value="">${esc(t('— Institution —'))}</option>${cats.map((c) => `<option value="${c.id}" ${Number(sl.categoryId) === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select>
                  <input class="input" data-s="location" value="${esc(sl.location)}" placeholder="${esc(t('Room'))}" maxlength="100" style="max-width:110px">
                  <button type="button" class="btn ghost icon-only sm" data-dup-slot="${sl.id}" title="${esc(t('Duplicate'))}">${icon('copy', 'sm')}</button>
                  <button type="button" class="btn ghost icon-only sm" data-del-slot="${sl.id}" title="${esc(t('Remove'))}">${icon('trash', 'sm')}</button>
                </div>`;
              })
              .join('')}
          </div>
          ${missingKeys.has('slots') ? missingNote(t('Add at least one weekly class (or a photo of your timetable).')) : ''}
          <div class="flex wrap">
            <button type="button" class="btn soft" data-add-slot>${icon('plus', 'sm')}${esc(t('Add a weekly class'))}</button>
            <button type="button" class="btn ghost" data-photo>${icon('camera', 'sm')}${esc(T.photoDocId ? t('Timetable photo saved ✓') : t('Or save a photo of your paper timetable'))}</button>
            <input type="file" accept="image/*,application/pdf" data-photo-input hidden>
          </div>

          <div class="wiz-sub">${esc(t('School holidays'))}</div>
          <div class="stack tight">
            ${T.holidays
              .map((h) =>
                h.holidayId
                  ? `<div class="wiz-slot done">${icon('checkCircle')}<span class="strong">${esc(h.name)}</span><span>${esc(fmtDate(h.start))} → ${esc(fmtDate(h.end))}</span>
                    <span class="spacer"></span><span class="small muted">${esc(t('added to your calendar'))}</span></div>`
                  : `<div class="wiz-slot" data-hol="${h.id}">
                  <input class="input grow" data-h="name" value="${esc(h.name)}" placeholder="${esc(t('e.g. Winter holidays'))}" maxlength="120">
                  <input class="input" type="date" data-h="start" value="${esc(h.start)}">
                  <span class="muted">→</span>
                  <input class="input" type="date" data-h="end" value="${esc(h.end)}">
                  <button type="button" class="btn ghost icon-only sm" data-del-hol="${h.id}" title="${esc(t('Remove'))}">${icon('trash', 'sm')}</button>
                </div>`
              )
              .join('')}
          </div>
          <div class="flex wrap">
            <button type="button" class="btn soft" data-add-hol>${icon('plus', 'sm')}${esc(t('Add a holiday period'))}</button>
            <label class="switch"><input type="checkbox" name="cancelInHolidays" ${T.cancelInHolidays ? 'checked' : ''}><span class="track"></span>${esc(t('Cancel my classes during holidays automatically'))}</label>
          </div>

          <div class="wiz-sub">${esc(t('Your working hours'))}</div>
          <div class="grid-3">
            <div class="field"><label>${esc(t('Day starts at'))}</label><input class="input" type="time" name="dayStart" value="${esc(T.dayStart)}"></div>
            <div class="field"><label>${esc(t('Day ends at'))}</label><input class="input" type="time" name="dayEnd" value="${esc(T.dayEnd)}"></div>
            <div class="field"><label>${esc(t('Week starts on'))}</label>${yesNo('weekStart', String(T.weekStart), [['1', 'Monday'], ['0', 'Sunday']])}</div>
          </div>
          ${q(t('Other kinds of appointments you would like to track?'), `<input class="input" name="extraKinds" value="${esc(T.extraKinds)}" placeholder="${esc(t('e.g. exam supervision, marking, training I attend'))}">`)}
          ${q(t('Do you give private lessons?'), `<input class="input" name="privateLessons" value="${esc(T.privateLessons)}" placeholder="${esc(t('If yes: would you like to note the student, the price, the payment?'))}">`)}
        </div>`;
    },

    reminders: () => {
      const R = A.reminders;
      return `${header(t('Your reminders'), t('Choose how the app keeps you on track. You can change this at any time.'))}
        <div class="stack">
          ${q(
            t('Remind me before each class'),
            `<div class="pills">${REMINDER_CHOICES.map((m) => {
              const on = R.defaults.some((r) => r.minutes === m);
              return `<button type="button" class="pill ${on ? 'active' : ''}" data-rem="${m}">${esc(reminderLabel(m))}</button>`;
            }).join('')}</div>`,
            t('Reminders of one day or more are also sent by email.')
          )}
          ${q(
            t('Missing attestation: remind me every'),
            `<div class="pills">${NAG_CHOICES.map((h) => `<button type="button" class="pill ${Number(R.nagIntervalHours) === h ? 'active' : ''}" data-nag="${h}">${esc(h < 24 ? t('{n} hours', { n: h }) : h === 24 ? t('day') : t('2 days'))}</button>`).join('')}</div>`,
            t('Until you mark it as received. You can always snooze one until tomorrow.')
          )}
          ${q(t('Quiet hours — no reminders between'), `<div class="flex"><input class="input" type="time" name="quietStart" value="${esc(R.quietStart)}" style="width:auto"><span class="muted">${esc(t('and'))}</span><input class="input" type="time" name="quietEnd" value="${esc(R.quietEnd)}" style="width:auto"></div>`)}
          ${q(
            t('A summary email every morning?'),
            `<div class="flex wrap">${yesNo('digestEnabled', R.digestEnabled ? 'yes' : 'no')}${R.digestEnabled ? `<span class="muted">${esc(t('at'))}</span><input class="input" type="time" name="digestTime" value="${esc(R.digestTime)}" style="width:auto">` : ''}</div>`,
            t('Your day and the attestations still missing.')
          )}
          <div class="tip">${icon('bellRing')}<span>${esc(t('When a class needing an attestation starts, the app also reminds you to ask for it on the spot.'))}</span></div>
          ${q(t('Would you also like reminders by SMS or WhatsApp?'), yesNo('smsWish', R.smsWish, [['yes', 'Yes, I would like that'], ['no', 'No need']]), t('This needs an external service, which may have a small cost.'), 'smsWish')}
        </div>`;
    },

    email: () => {
      const E = A.email;
      const p = PROVIDERS[E.provider];
      if (state.settings.emailManaged) {
        // Online, the planner sends emails itself: she only says where to receive them.
        return `${header(t('Your emails'), t('Where should your reminders arrive?'))}
          <div class="stack">
            ${q(t('Send my reminders to'), `<input class="input" type="email" name="recipient" value="${esc(E.recipient)}" placeholder="${esc(state.user.email)}">`, '', 'recipient')}
            <div class="tip">${icon('checkCircle')}<span>${esc(t('Email reminders are ready. There is nothing else to set up.'))}</span></div>
            ${q(t('Should someone else also receive the reminders?'), `<input class="input" name="ccWish" value="${esc(E.ccWish)}" placeholder="${esc(t('Optional: who, and which address?'))}">`)}
          </div>`;
      }
      return `${header(t('Your emails'), t('Where should reminders arrive, and which mailbox should send them?'))}
        <div class="stack">
          ${q(t('Send my reminders to'), `<input class="input" type="email" name="recipient" value="${esc(E.recipient)}" placeholder="${esc(state.user.email)}">`, '', 'recipient')}
          ${q(t('Which email service do you use?'), `<div class="pills">${Object.entries(PROVIDERS).map(([k, v]) => `<button type="button" class="pill ${E.provider === k ? 'active' : ''}" data-provider="${k}">${esc(t(v.label))}</button>`).join('')}</div>`)}
          ${q(t('Would you prefer a separate address just for sending reminders?'), yesNo('dedicated', E.dedicated, [['yes', 'Yes (recommended)'], ['no', 'No, use mine']]), t('e.g. a new Gmail address like my.planner@gmail.com.'))}
          ${
            E.connected
              ? `<div class="tip">${icon('checkCircle')}<span>${esc(t('Your email is already connected. Reminders will be sent by email.'))}</span></div>`
              : `<details class="wiz-connect" ${E.provider ? 'open' : ''}>
                <summary>${icon('key', 'sm')} ${esc(t('Connect the sending mailbox now (optional)'))}</summary>
                <div class="stack tight" style="margin-top:12px">
                  ${E.provider === 'gmail' ? `<div class="tip">${icon('info')}<span>${esc(t('For Gmail: turn on 2-step verification, then create an “App password” (Google Account → Security → App passwords) and paste it below. Your normal password will not work.'))}</span></div>` : ''}
                  <div class="grid-2">
                    <div class="field"><label>${esc(t('Sending address'))}</label><input class="input" name="smtpUser" type="email" value="${esc(E.user)}" autocomplete="off"></div>
                    <div class="field"><label>${esc(t('Password / app password'))}</label><input class="input" name="smtpPass" type="password" autocomplete="new-password"></div>
                  </div>
                  ${
                    !p || E.provider === 'other'
                      ? `<div class="grid-2"><div class="field"><label>${esc(t('Server'))}</label><input class="input" name="smtpHost" value="${esc(p?.host || '')}" placeholder="smtp.example.com"></div>
                         <div class="field"><label>${esc(t('Port'))}</label><input class="input" name="smtpPort" type="number" value="${esc(p?.port || 587)}"></div></div>`
                      : ''
                  }
                  <div class="flex"><button type="button" class="btn" data-connect>${icon('mail', 'sm')}${esc(t('Connect and send a test email'))}</button>
                  <span class="small muted">${esc(t('You can also do this later in Settings.'))}</span></div>
                </div>
              </details>`
          }
          ${q(t('Should someone else also receive the reminders?'), `<input class="input" name="ccWish" value="${esc(E.ccWish)}" placeholder="${esc(t('Optional: who, and which address?'))}">`)}
        </div>`;
    },

    documents: () => {
      const D = A.documents;
      const W = A.wishes;
      return `${header(t('Documents & wishes'), t('Last step! Tell us what you keep, and what would make the app even more useful.'))}
        <div class="stack">
          ${q(t('Which documents do you want to keep here?'), `<div class="pills">${DOC_TYPES.map((d) => `<button type="button" class="pill ${D.docTypes.includes(d) ? 'active' : ''}" data-multi="docTypes" data-val="${d}">${esc(t(d))}</button>`).join('')}</div>`, '', 'docTypes')}
          ${q(
            t('How should scanned attestations be named?'),
            `${yesNo('naming', D.naming, [['default', 'Attestation — Institution — Month'], ['date', 'Institution — Date'], ['other', 'Other']])}
             ${D.naming === 'other' ? `<input class="input" name="namingOther" value="${esc(D.namingOther)}" placeholder="${esc(t('Describe your format'))}" style="margin-top:8px">` : ''}`
          )}
          ${q(t('Do you already have paper attestations to add?'), yesNo('backlogCount', D.backlogCount, [['none', 'None'], ['few', 'Fewer than 20'], ['some', '20 to 100'], ['many', 'More than 100']]), t('We can plan a session to scan and file them together.'), 'backlogCount')}
          ${q(t('Are some of your attestations in Arabic?'), yesNo('arabic', D.arabic), '', 'arabic')}
          ${q(t('Do you send these documents to someone?'), `<input class="input" name="sendTo" value="${esc(D.sendTo)}" placeholder="${esc(t('e.g. the administration, an accountant'))}">`)}
          <div class="wiz-sub">${esc(t('What would you like next?'))}</div>
          <div class="wiz-checks">${WISHES.map(
            (w) => `<label class="wiz-check"><input type="checkbox" data-wish="${w.value}" ${W.list.includes(w.value) ? 'checked' : ''}><span>${esc(t(w.label))}</span></label>`
          ).join('')}</div>
          ${q(t('What makes you lose the most time today in organising your work?'), `<textarea class="textarea" name="timeWaster" rows="2">${esc(W.timeWaster)}</textarea>`)}
          ${q(t('Anything else you would like in the app?'), `<textarea class="textarea" name="other" rows="2">${esc(W.other)}</textarea>`)}
        </div>`;
    },

    done: () => {
      const cats = activeCategories();
      const rules = cats.filter((c) => c.attestationMode);
      const slots = A.timetable.slots.filter((x) => x.seriesId);
      const sessions = slots.reduce((n, x) => n + (x.count || 0), 0);
      const hols = A.timetable.holidays.filter((h) => h.holidayId);
      const emailOk = state.settings.smtpConfigured;
      const item = (ic, text, okFlag = true) => `<li class="${okFlag ? '' : 'todo'}">${icon(okFlag ? ic : 'alertCircle')}<span>${text}</span></li>`;
      return `<div class="wiz-hero">
          <div class="wiz-hero-ic done">${icon('checkCircle', 'xl')}</div>
          <h2>${esc(t('Your planner is ready!'))}</h2>
          <p>${esc(t('Here is what we set up together:'))}</p>
          <ul class="wiz-summary">
            ${item('building', esc(tn(cats.length, '{n} institution', '{n} institutions')) + (rules.length ? ` · ${esc(tn(rules.length, '{n} with an attestation rule', '{n} with an attestation rule'))}` : ''), cats.length > 0)}
            ${item('calendar', slots.length ? esc(tn(slots.length, '{n} weekly class', '{n} weekly classes')) + ` · ${esc(tn(sessions, '{n} session in your calendar', '{n} sessions in your calendar'))}` : esc(t('No weekly class yet — add them from the calendar')), slots.length > 0)}
            ${hols.length ? item('sun', esc(tn(hols.length, '{n} holiday period', '{n} holiday periods'))) : ''}
            ${item('bell', esc(t('Reminders: {list}', { list: A.reminders.defaults.map((r) => reminderLabel(r.minutes)).join(', ') || t('none') })))}
            ${item('mail', esc(emailOk ? t('Email reminders are on') : t('Email not connected yet — reminders appear in the app')), emailOk)}
          </ul>
          <div class="flex wrap" style="justify-content:center;margin-top:10px">
            <a class="btn primary lg" href="#/calendar">${icon('calendar')}${esc(t('Open my calendar'))}</a>
            <a class="btn lg" href="#/today">${esc(t('Go to today'))}</a>
            ${emailOk ? '' : `<a class="btn ghost lg" href="#/settings?s=email">${icon('mail')}${esc(t('Connect my email'))}</a>`}
          </div>
          <button class="btn ghost sm" data-summary style="margin-top:14px">${icon('fileText', 'sm')}${esc(t('See all my answers'))}</button>
        </div>`;
    },
  };

  // ---------- reading the form back into answers ----------
  function val(name) {
    const el = root.querySelector(`[name="${name}"]`);
    return el ? (el.type === 'checkbox' ? el.checked : el.value) : undefined;
  }
  function collect() {
    const key = STEPS[step].key;
    if (key === 'about') {
      A.about.name = val('name') ?? A.about.name;
      A.about.appName = val('appName') ?? A.about.appName;
    } else if (key === 'institutions') {
      root.querySelectorAll('[data-row]').forEach((rowEl) => {
        const r = A.institutions.rows.find((x) => x.id === rowEl.dataset.row);
        rowEl.querySelectorAll('[data-f]').forEach((inp) => (r[inp.dataset.f] = inp.value));
      });
      for (const k of ['deadline', 'backlog']) A.institutions[k] = val(k) ?? A.institutions[k];
    } else if (key === 'timetable') {
      const T = A.timetable;
      for (const k of ['yearStart', 'yearEnd', 'dayStart', 'dayEnd', 'extraKinds', 'privateLessons']) T[k] = val(k) ?? T[k];
      T.cancelInHolidays = val('cancelInHolidays') ?? T.cancelInHolidays;
      root.querySelectorAll('[data-slot]').forEach((el) => {
        const sl = T.slots.find((x) => x.id === el.dataset.slot);
        el.querySelectorAll('[data-s]').forEach((inp) => (sl[inp.dataset.s] = inp.dataset.s === 'day' ? Number(inp.value) : inp.value));
      });
      root.querySelectorAll('[data-hol]').forEach((el) => {
        const h = T.holidays.find((x) => x.id === el.dataset.hol);
        el.querySelectorAll('[data-h]').forEach((inp) => (h[inp.dataset.h] = inp.value));
      });
    } else if (key === 'reminders') {
      for (const k of ['quietStart', 'quietEnd', 'digestTime']) A.reminders[k] = val(k) ?? A.reminders[k];
    } else if (key === 'email') {
      A.email.recipient = val('recipient') ?? A.email.recipient;
      A.email.ccWish = val('ccWish') ?? A.email.ccWish;
      A.email.user = val('smtpUser') ?? A.email.user;
    } else if (key === 'documents') {
      for (const k of ['namingOther', 'sendTo']) A.documents[k] = val(k) ?? A.documents[k];
      for (const k of ['timeWaster', 'other']) A.wishes[k] = val(k) ?? A.wishes[k];
    }
  }

  // ---------- applying each step to the app ----------
  const APPLY = {
    async about() {
      const a = A.about;
      if (!a.name.trim()) throw new Error(t('Please enter your name.'));
      if (a.name.trim() !== state.user.name) {
        const res = await api.put('/api/auth/profile', { name: a.name.trim() });
        state.user = res.user;
      }
      await api.put('/api/settings', { theme: a.theme, accentColor: a.accentColor, appName: a.appName.trim() || 'Planner' });
    },
    async institutions() {
      const rows = A.institutions.rows.filter((r) => r.name.trim());
      for (const r of rows) {
        const body = {
          name: r.name.trim(),
          color: r.color,
          attestationMode: ['hours', 'session', 'monthly'].includes(r.mode) ? r.mode : null,
          attestationEveryHours: r.mode === 'hours' ? r.every : null,
          attestationOffsetHours: r.mode === 'hours' ? r.offset || 0 : 0,
          attestationSigner: r.signer,
          notes: r.notes,
        };
        if (r.mode === 'hours' && !(Number(r.every) > 0)) throw new Error(t('Please enter the number of hours for {name}.', { name: body.name }));
        const saved = r.categoryId ? await api.put(`/api/categories/${r.categoryId}`, body) : await api.post('/api/categories', body);
        r.categoryId = saved.id;
      }
      A.institutions.rows = A.institutions.rows.filter((r) => r.name.trim() || !r.categoryId);
      await loadCategories();
    },
    async timetable() {
      const T = A.timetable;
      if (!T.yearStart || !T.yearEnd || T.yearEnd <= T.yearStart) throw new Error(t('Please check the dates of the school year.'));
      await api.put('/api/settings', { dayStart: T.dayStart, dayEnd: T.dayEnd, weekStart: Number(T.weekStart) });
      // Holidays first, so classes created next already skip them.
      for (const h of T.holidays) {
        if (h.holidayId || !h.name.trim()) continue;
        if (!h.start || !h.end || h.end < h.start) throw new Error(t('Please check the dates of “{name}”.', { name: h.name }));
        const res = await api.post('/api/holidays', { name: h.name.trim(), start: h.start, end: h.end, cancelClasses: T.cancelInHolidays });
        h.holidayId = res.holiday.id;
      }
      const from = T.yearStart > todayStr() ? T.yearStart : todayStr();
      for (const sl of T.slots) {
        if (sl.seriesId || !sl.title.trim()) continue;
        if (!sl.start || !sl.end || sl.end <= sl.start) throw new Error(t('Check the times of “{name}”: the end must be after the start.', { name: sl.title }));
        // Every 2 weeks: she picks whether it starts this week or next week (week A / week B).
        const date = sl.every === '2b' ? addDaysStr(firstOnWeekday(from, Number(sl.day)), 7) : firstOnWeekday(from, Number(sl.day));
        if (date > T.yearEnd) continue;
        const res = await api.post('/api/events', {
          title: sl.title.trim(),
          kind: sl.kind || 'class',
          categoryId: sl.categoryId ? Number(sl.categoryId) : null,
          location: sl.location,
          start: `${date}T${sl.start}`,
          end: `${date}T${sl.end}`,
          reminders: state.settings.defaultReminders,
          recurrence: { freq: 'weekly', interval: sl.every && sl.every !== '1' ? 2 : 1, byweekday: [Number(sl.day)], until: T.yearEnd },
        });
        sl.seriesId = res.event.seriesId;
        sl.count = res.count;
      }
      T.slots = T.slots.filter((x) => x.seriesId || x.title.trim());
      T.holidays = T.holidays.filter((h) => h.holidayId || h.name.trim());
      changed();
    },
    async reminders() {
      const R = A.reminders;
      await api.put('/api/settings', {
        defaultReminders: R.defaults,
        nagIntervalHours: Number(R.nagIntervalHours),
        quietStart: R.quietStart,
        quietEnd: R.quietEnd,
        digestEnabled: !!R.digestEnabled,
        digestTime: R.digestTime,
      });
    },
    async email() {
      const E = A.email;
      const recipient = (E.recipient || '').trim();
      await api.put('/api/settings', { notifyEmail: recipient.toLowerCase() === state.user.email ? '' : recipient, emailEnabled: true });
    },
    async documents() {},
  };

  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  function findMissing() {
    const key = STEPS[step].key;
    const m = new Set();
    if (key === 'about') {
      if (!A.about.name.trim()) m.add('name');
      if (!A.about.devices.length) m.add('devices');
      if (!A.about.phoneScan) m.add('phoneScan');
      if (!A.about.computerOn) m.add('computerOn');
    } else if (key === 'institutions') {
      const rows = A.institutions.rows;
      if (!rows.some((r) => r.name.trim())) m.add('row:' + rows[0]?.id);
      for (const r of rows) {
        if (!r.name.trim() && !r.mode) continue; // an empty extra card is simply ignored
        if (!r.name.trim() || !r.mode || (r.mode === 'hours' && !(Number(r.every) > 0))) m.add('row:' + r.id);
      }
      if (!A.institutions.multiSessions) m.add('multiSessions');
    } else if (key === 'timetable') {
      const T = A.timetable;
      if (!T.yearStart || !T.yearEnd || T.yearEnd <= T.yearStart) m.add('year');
      if (!T.slots.some((x) => x.seriesId || x.title.trim()) && !T.photoDocId) m.add('slots');
      const needInstitution = activeCategories().length > 0;
      for (const x of T.slots) {
        if (x.seriesId || !x.title.trim()) continue;
        if (!x.start || !x.end || x.end <= x.start || (needInstitution && !x.categoryId)) m.add('slot:' + x.id);
      }
    } else if (key === 'reminders') {
      if (!A.reminders.smsWish) m.add('smsWish');
    } else if (key === 'email') {
      if (!EMAIL_RE.test((A.email.recipient || '').trim())) m.add('recipient');
    } else if (key === 'documents') {
      if (!A.documents.docTypes.length) m.add('docTypes');
      if (!A.documents.backlogCount) m.add('backlogCount');
      if (!A.documents.arabic) m.add('arabic');
    }
    return m;
  }

  async function next() {
    if (busy) return;
    collect();
    missingKeys = findMissing();
    if (missingKeys.size) {
      const y = window.scrollY;
      draw();
      window.scrollTo(0, y);
      root.querySelector('.missing')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      toast(t('Please answer the questions marked *.'), { type: 'error' });
      return;
    }
    const key = STEPS[step].key;
    const btn = root.querySelector('[data-next]');
    busy = true;
    setBusy(btn, true);
    try {
      if (APPLY[key]) await APPLY[key]();
      const isLast = step === STEPS.length - 2;
      step += 1;
      maxVisited = Math.max(maxVisited, step);
      await persist({ step: isLast ? 0 : step, ...(isLast ? { completed: true, completedAt: new Date().toISOString() } : {}) });
      await loadSettings();
      draw();
    } catch (err) {
      setBusy(btn, false);
      errorToast(err);
    } finally {
      busy = false;
    }
  }

  // ---------- interactions ----------
  const rerender = () => {
    collect();
    // Highlights disappear as soon as the answer is given.
    if (missingKeys.size) missingKeys = findMissing();
    const y = window.scrollY;
    draw();
    window.scrollTo(0, y);
  };

  on(root, 'click', '[data-start]', async () => {
    step = 1;
    maxVisited = Math.max(maxVisited, 1);
    draw();
  });
  on(root, 'click', '[data-logout]', async () => {
    const { logout } = await import('../app.js');
    logout();
  });
  on(root, 'click', '[data-later]', async () => {
    try {
      await persist({ step: Math.max(ob.step || 0, 0) });
    } catch {
      /* not important */
    }
    location.hash = '#/today';
  });
  on(root, 'click', '[data-next]', () => next(false));
  on(root, 'click', '[data-back]', () => {
    collect();
    step = Math.max(0, step - 1);
    draw();
  });
  on(root, 'click', '[data-goto]', (e, b) => {
    collect();
    step = Number(b.dataset.goto);
    draw();
  });
  on(root, 'click', '[data-radio] [data-val]', async (e, b) => {
    const name = b.closest('[data-radio]').dataset.radio;
    const v = b.dataset.val;
    collect();
    const key = STEPS[step].key;
    if (key === 'about') {
      A.about[name] = v;
      if (name === 'theme') {
        state.settings.theme = v;
        applyTheme();
      }
      if (name === 'language' && v !== state.settings.language) {
        // Save first: switching language rebuilds the page.
        try {
          await persist({ step });
          await api.put('/api/settings', { language: v });
          await loadSettings();
        } catch (err) {
          errorToast(err);
        }
        return;
      }
    } else if (key === 'institutions') A.institutions[name] = v;
    else if (key === 'timetable') A.timetable[name] = name === 'weekStart' ? Number(v) : v;
    else if (key === 'reminders') A.reminders[name] = name === 'digestEnabled' ? v === 'yes' : v;
    else if (key === 'email') A.email[name] = v;
    else if (key === 'documents') A.documents[name] = v;
    rerender();
  });
  on(root, 'click', '[data-multi]', (e, b) => {
    collect();
    const list = b.dataset.multi === 'devices' ? A.about.devices : A.documents.docTypes;
    const i = list.indexOf(b.dataset.val);
    if (i > -1) list.splice(i, 1);
    else list.push(b.dataset.val);
    rerender();
  });
  on(root, 'click', '[data-accent]', (e, b) => {
    collect();
    A.about.accentColor = b.dataset.accent;
    state.settings.accentColor = b.dataset.accent;
    applyTheme();
    rerender();
  });
  on(root, 'input', '[name="appName"]', (e, inp) => {
    document.querySelectorAll('[data-app-name]').forEach((n) => (n.textContent = inp.value.trim() || 'Planner'));
  });
  // institutions
  on(root, 'click', '[data-add-inst]', () => {
    collect();
    A.institutions.rows.push(newInstitution(A.institutions.rows.length));
    rerender();
    root.querySelector('[data-row]:last-of-type [data-f="name"]')?.focus();
  });
  on(root, 'click', '[data-del-inst]', (e, b) => {
    collect();
    A.institutions.rows = A.institutions.rows.filter((r) => r.id !== b.dataset.delInst);
    rerender();
  });
  on(root, 'click', '[data-inst-color]', (e, b) => {
    collect();
    A.institutions.rows.find((r) => r.id === b.closest('[data-row]').dataset.row).color = b.dataset.instColor;
    rerender();
  });
  on(root, 'click', '[data-mode]', (e, b) => {
    collect();
    A.institutions.rows.find((r) => r.id === b.closest('[data-row]').dataset.row).mode = b.dataset.mode;
    rerender();
  });
  // timetable
  on(root, 'click', '[data-add-slot]', () => {
    collect();
    A.timetable.slots.push(newSlot());
    rerender();
  });
  on(root, 'click', '[data-dup-slot]', (e, b) => {
    collect();
    const i = A.timetable.slots.findIndex((x) => x.id === b.dataset.dupSlot);
    const copy = { ...A.timetable.slots[i], id: uid(), seriesId: null, count: 0, day: (Number(A.timetable.slots[i].day) + 1) % 7 };
    A.timetable.slots.splice(i + 1, 0, copy);
    rerender();
  });
  on(root, 'click', '[data-del-slot]', (e, b) => {
    collect();
    A.timetable.slots = A.timetable.slots.filter((x) => x.id !== b.dataset.delSlot);
    rerender();
  });
  on(root, 'click', '[data-add-hol]', () => {
    collect();
    A.timetable.holidays.push({ id: uid(), name: '', start: '', end: '', holidayId: null });
    rerender();
  });
  on(root, 'click', '[data-del-hol]', (e, b) => {
    collect();
    A.timetable.holidays = A.timetable.holidays.filter((x) => x.id !== b.dataset.delHol);
    rerender();
  });
  on(root, 'click', '[data-photo]', () => root.querySelector('[data-photo-input]').click());
  on(root, 'change', '[data-photo-input]', async (e, inp) => {
    const file = inp.files[0];
    if (!file) return;
    collect();
    const fd = new FormData();
    fd.append('file', file, file.name);
    fd.append('title', t('My timetable'));
    fd.append('docType', 'other');
    fd.append('docDate', todayStr());
    fd.append('tags', t('timetable'));
    try {
      const doc = await api.upload('/api/documents', fd);
      A.timetable.photoDocId = doc.id;
      toast(t('Photo saved in My documents. We can enter the classes for you from it.'), { type: 'success', duration: 6000 });
      rerender();
    } catch (err) {
      errorToast(err);
    }
  });
  // reminders
  on(root, 'click', '[data-rem]', (e, b) => {
    collect();
    const m = Number(b.dataset.rem);
    const list = A.reminders.defaults;
    const i = list.findIndex((r) => r.minutes === m);
    if (i > -1) list.splice(i, 1);
    else list.push({ minutes: m, email: m >= 1440 });
    list.sort((x, y) => x.minutes - y.minutes);
    rerender();
  });
  on(root, 'click', '[data-nag]', (e, b) => {
    collect();
    A.reminders.nagIntervalHours = Number(b.dataset.nag);
    rerender();
  });
  // email
  on(root, 'click', '[data-provider]', (e, b) => {
    collect();
    A.email.provider = b.dataset.provider;
    rerender();
  });
  on(root, 'click', '[data-connect]', async (e, btn) => {
    collect();
    const p = PROVIDERS[A.email.provider] || PROVIDERS.other;
    const user = val('smtpUser');
    const pass = val('smtpPass');
    const host = val('smtpHost') ?? p.host;
    const port = val('smtpPort') ?? p.port;
    if (!user || !pass || !host) return toast(t('Please fill in the address and the password.'), { type: 'error' });
    setBusy(btn, true);
    try {
      await api.put('/api/settings', { smtp: { host, port, secure: p.secure && String(port) === '465', user, pass, from: user }, emailEnabled: true });
      const res = await api.post('/api/settings/test-email');
      await loadSettings();
      A.email.connected = true;
      toast(t('Test email sent to {e}. Check your inbox (and spam folder).', { e: res.to }), { type: 'success', duration: 7000 });
      rerender();
    } catch (err) {
      setBusy(btn, false);
      errorToast(err);
    }
  });
  // documents
  on(root, 'change', '[data-wish]', (e, c) => {
    const list = A.wishes.list;
    const i = list.indexOf(c.dataset.wish);
    if (c.checked && i < 0) list.push(c.dataset.wish);
    if (!c.checked && i > -1) list.splice(i, 1);
  });
  on(root, 'click', '[data-summary]', () => openAnswersSummary());

  draw();
}

// ---------- Printable summary of all answers (also opened from Settings) ----------

export function openAnswersSummary() {
  const ob = state.settings.onboarding || {};
  const A = ob.answers || {};
  const yes = (v) => ({ yes: t('Yes'), no: t('No'), sometimes: t('Sometimes') })[v] || v || '—';
  const row = (label, value) => `<tr><th>${esc(label)}</th><td>${value === undefined || value === '' || value === null ? '—' : value}</td></tr>`;
  const section = (title, rows) => `<h3>${esc(title)}</h3><table class="ans">${rows.join('')}</table>`;
  const modeLabel = (m) => t(MODES.find((x) => x.value === m)?.label || 'No attestation');
  const a = A.about || {};
  const I = A.institutions || {};
  const T = A.timetable || {};
  const R = A.reminders || {};
  const E = A.email || {};
  const D = A.documents || {};
  const W = A.wishes || {};
  const html = `
    ${ob.completed ? `<p class="muted small">${esc(t('Completed on {d}', { d: fmtDate((ob.completedAt || '').slice(0, 10) || todayStr()) }))}</p>` : `<p class="muted small">${esc(t('The welcome guide is not finished yet.'))}</p>`}
    ${section(t('About you'), [
      row(t('Name'), esc(a.name)),
      row(t('Name of your planner'), esc(a.appName || 'Planner')),
      row(t('Devices'), esc((a.devices || []).map((d) => t(DEVICES.find((x) => x.value === d)?.label || d)).join(', '))),
      row(t('Scans with phone'), esc(yes(a.phoneScan))),
      row(t('Computer on during the day'), esc(yes(a.computerOn))),
    ])}
    ${section(t('Institutions'), [
      ...(I.rows || []).filter((r) => r.name).map((r) =>
        row(r.name, esc([modeLabel(r.mode) + (r.mode === 'hours' ? ` (${r.every} h${r.offset ? `, ${t('{h} already done', { h: r.offset })}` : ''})` : ''), r.signer && `${t('Signed by')}: ${r.signer}`, r.notes].filter(Boolean).join(' · ')))
      ),
      row(t('Deadline'), esc(I.deadline)),
      row(t('One attestation for several sessions'), esc(yes(I.multiSessions))),
      row(t('Forgotten attestations'), esc(I.backlog)),
    ])}
    ${section(t('Timetable'), [
      row(t('School year'), T.yearStart ? esc(`${fmtDate(T.yearStart)} → ${fmtDate(T.yearEnd)}`) : '—'),
      row(t('Weekly classes'), esc((T.slots || []).filter((s) => s.title).map((s) => `${fmtWeekdayLong(s.day)} ${s.start}–${s.end} ${s.title}`).join(' · '))),
      row(t('Holidays'), esc((T.holidays || []).filter((h) => h.name).map((h) => `${h.name} (${h.start} → ${h.end})`).join(' · '))),
      row(t('Other kinds of appointments'), esc(T.extraKinds)),
      row(t('Private lessons'), esc(T.privateLessons)),
      row(t('Timetable photo'), T.photoDocId ? esc(t('Saved in My documents')) : '—'),
    ])}
    ${section(t('Reminders'), [
      row(t('Before each class'), esc((R.defaults || []).map((r) => reminderLabel(r.minutes)).join(', '))),
      row(t('Missing attestation reminders'), R.nagIntervalHours ? esc(hoursLabel(R.nagIntervalHours)) : '—'),
      row(t('Quiet hours'), esc(R.quietStart ? `${R.quietStart} → ${R.quietEnd}` : '')),
      row(t('Morning summary'), esc(R.digestEnabled ? `${t('Yes')} (${R.digestTime})` : t('No'))),
      row(t('SMS / WhatsApp'), esc(yes(R.smsWish))),
    ])}
    ${section(t('Email'), [
      row(t('Reminders sent to'), esc(E.recipient)),
      row(t('Email service'), esc(PROVIDERS[E.provider]?.label || '')),
      row(t('Separate sending address'), esc(yes(E.dedicated))),
      row(t('Someone else to notify'), esc(E.ccWish)),
    ])}
    ${section(t('Documents & wishes'), [
      row(t('Documents to keep'), esc((D.docTypes || []).map((d) => t(d)).join(', '))),
      row(t('Naming'), esc(D.naming === 'other' ? D.namingOther : D.naming === 'date' ? t('Institution — Date') : t('Attestation — Institution — Month'))),
      row(t('Paper attestations to add'), esc({ none: t('None'), few: t('Fewer than 20'), some: t('20 to 100'), many: t('More than 100') }[D.backlogCount] || '')),
      row(t('Attestations in Arabic'), esc(yes(D.arabic))),
      row(t('Documents sent to'), esc(D.sendTo)),
      row(t('Wishes'), esc((W.list || []).map((w) => t(WISHES.find((x) => x.value === w)?.label || w)).join(' · '))),
      row(t('What wastes the most time'), esc(W.timeWaster)),
      row(t('Anything else'), esc(W.other)),
    ])}`;
  const m = openModal({
    title: t('My answers'),
    size: 'lg',
    content: `<div class="answers">${html}</div>`,
    footer: `<span class="spacer"></span><button class="btn" data-print>${icon('printer', 'sm')}${esc(t('Print / save as PDF'))}</button><button class="btn primary" data-close>${esc(t('Close'))}</button>`,
  });
  m.root.querySelector('[data-print]').addEventListener('click', () => {
    const w = window.open('', '_blank');
    if (!w) return toast(t('Allow pop-ups to print.'), { type: 'error' });
    w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${esc(t('My answers'))}</title>
      <style>body{font-family:Segoe UI,Arial,sans-serif;color:#1b1b26;max-width:760px;margin:24px auto;padding:0 16px}
      h1{font-size:22px}h3{font-size:15px;margin:22px 0 6px;color:#3f3fb0}table{width:100%;border-collapse:collapse}
      th{text-align:left;width:38%;font-weight:600;color:#565670;vertical-align:top}th,td{padding:6px 8px;border-bottom:1px solid #e5e5ee;font-size:13px}
      .muted{color:#8a8aa0}.small{font-size:12px}</style></head><body><h1>${esc(t('My answers'))} — ${esc(state.user.name)}</h1>${html}</body></html>`);
    w.document.close();
    w.focus();
    setTimeout(() => w.print(), 250);
  });
}

export { emit };
