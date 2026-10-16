import { api } from './api.js';
import {
  t, tn, fmtDayYear, fmtShort, fmtDate, fmtTime, timeRange, durationLabel, reminderLabel, nowWall, todayStr,
  addMinutesWall, minutesBetween, addDaysStr, fmtWeekdayShort, fmtWeekdayLong, daysAgo, hoursLabel, wallToDate,
} from './i18n.js';
import { state, categoryById, activeCategories, eventColor, changed, loadCategories } from './store.js';
import { esc, icon, openModal, confirmDialog, chooseDialog, toast, errorToast, setBusy, on, el, CATEGORY_COLORS } from './ui.js';

export const KINDS = [
  { value: 'class', label: 'Class', icon: 'users' },
  { value: 'exam', label: 'Exam' },
  { value: 'meeting', label: 'Meeting' },
  { value: 'personal', label: 'Personal' },
  { value: 'other', label: 'Other' },
];
export const kindLabel = (k) => t(KINDS.find((x) => x.value === k)?.label || 'Other');

const REMINDER_OPTIONS = [0, 10, 30, 60, 120, 1440, 2880, 10080];
const PREFS_KEY = 'planner.formPrefs';

function loadPrefs() {
  try {
    return JSON.parse(localStorage.getItem(PREFS_KEY)) || {};
  } catch {
    return {};
  }
}
function savePrefs(p) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(p));
  } catch {
    /* ignore */
  }
}

/** End of the current school year (30 June), used as the default end of a repetition. */
function schoolYearEnd(fromDate) {
  const d = new Date(`${fromDate}T12:00`);
  const year = d.getMonth() >= 6 ? d.getFullYear() + 1 : d.getFullYear();
  return `${year}-06-30`;
}

// ---------- Client-side preview of a repetition (mirrors server/recurrence.js) ----------

function expandPreview(start, rule) {
  const toD = (w) => new Date(w + ':00Z');
  const first = toD(start);
  const limit = new Date(first.getTime() + 3 * 366 * 86400000);
  const untilEnd = rule.until ? new Date(rule.until + 'T23:59:59Z') : limit;
  const stop = untilEnd < limit ? untilEnd : limit;
  const max = rule.count || 500;
  let n = 0;
  let last = null;
  if (rule.freq === 'daily') {
    for (let d = new Date(first); d <= stop && n < max; d.setUTCDate(d.getUTCDate() + rule.interval)) (n++, (last = new Date(d)));
  } else if (rule.freq === 'weekly') {
    const days = rule.byweekday.length ? rule.byweekday : [first.getUTCDay()];
    const anchor = new Date(first);
    anchor.setUTCDate(anchor.getUTCDate() - ((anchor.getUTCDay() + 6) % 7));
    for (let d = new Date(first); d <= stop && n < max; d.setUTCDate(d.getUTCDate() + 1)) {
      const wi = Math.floor((d - anchor) / (7 * 86400000));
      if (wi % rule.interval === 0 && days.includes(d.getUTCDay())) (n++, (last = new Date(d)));
    }
  } else if (rule.freq === 'monthly') {
    const day = first.getUTCDate();
    for (let i = 0; n < max; i += rule.interval) {
      const d = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + i, 1));
      if (d > stop) break;
      const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
      if (day > lastDay) continue;
      d.setUTCDate(day);
      if (d > stop) break;
      n++;
      last = d;
    }
  }
  return { count: n, last: last ? last.toISOString().slice(0, 10) : null };
}

function ruleSummary(rule) {
  if (!rule) return '';
  let s;
  if (rule.freq === 'daily') s = rule.interval > 1 ? t('Every {n} days', { n: rule.interval }) : t('Every day');
  else if (rule.freq === 'monthly') s = rule.interval > 1 ? t('Every {n} months', { n: rule.interval }) : t('Every month');
  else {
    const days = (rule.byweekday || []).slice().sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7)).map((d) => fmtWeekdayLong(d));
    s = (rule.interval > 1 ? t('Every {n} weeks', { n: rule.interval }) : t('Every week')) + (days.length ? ` · ${days.join(', ')}` : '');
  }
  if (rule.until) s += ` · ${t('until {date}', { date: fmtDate(rule.until) })}`;
  else if (rule.count) s += ` · ${tn(rule.count, '{n} session', '{n} sessions')}`;
  return s;
}
export { ruleSummary };

// ---------- Scope question for repeating appointments ----------

export function askScope(action, { allowAll = true } = {}) {
  const verbs = {
    edit: [t('Only this session'), t('This and following sessions'), t('All sessions of the series')],
    move: [t('Only this session'), t('This and following sessions')],
    delete: [t('Only this session'), t('This and following sessions'), t('All sessions of the series')],
    cancel: [t('Only this session'), t('This and following sessions'), t('All sessions of the series')],
  }[action];
  const choices = [
    { value: 'this', label: verbs[0], icon: 'calendar' },
    { value: 'following', label: verbs[1], icon: 'arrowR' },
  ];
  if (allowAll && verbs[2]) choices.push({ value: 'all', label: verbs[2], icon: 'repeat' });
  const titles = {
    edit: t('Apply changes to…'),
    move: t('Move which sessions?'),
    delete: t('Delete which sessions?'),
    cancel: t('Cancel which sessions?'),
  };
  return chooseDialog({ title: titles[action], message: t('This appointment is part of a repeating series.'), choices });
}

// ---------- Institutions ----------

export const RULE_MODES = [
  { value: '', label: 'No automatic rule' },
  { value: 'hours', label: 'Every N teaching hours' },
  { value: 'session', label: 'After each session' },
  { value: 'monthly', label: 'Once a month (last class)' },
];

/** One sentence describing an institution's attestation rule, or '' when it has none. */
export function ruleDescription(cat) {
  if (!cat?.attestationMode) return '';
  if (cat.attestationMode === 'hours') return t('{name}: one attestation every {n} teaching hours.', { name: cat.name, n: cat.attestationEveryHours });
  if (cat.attestationMode === 'session') return t('{name}: one attestation for each session.', { name: cat.name });
  return t('{name}: one attestation each month, at the last class.', { name: cat.name });
}

/** Full payload for saving an institution, so no field is lost when only one changes. */
export function categoryPayload(c, overrides = {}) {
  return {
    name: c.name,
    color: c.color,
    attestationMode: c.attestationMode,
    attestationEveryHours: c.attestationEveryHours,
    attestationOffsetHours: c.attestationOffsetHours,
    attestationSigner: c.attestationSigner,
    notes: c.notes,
    archived: c.archived,
    ...overrides,
  };
}

export function openCategoryForm(existing = null) {
  return new Promise((resolve) => {
    let result = null;
    let color = existing?.color || CATEGORY_COLORS[state.categories.length % CATEGORY_COLORS.length];
    let mode = existing?.attestationMode || '';
    const m = openModal({
      title: existing ? t('Edit institution') : t('New institution'),
      size: 'sm',
      content: `<form class="stack" novalidate>
          <div class="field"><label>${esc(t('Name'))}</label>
            <input class="input" name="name" value="${esc(existing?.name || '')}" placeholder="${esc(t('e.g. Lycée Pilote, Training center…'))}" autofocus required></div>
          <div class="field"><label>${esc(t('Colour'))}</label>
            <div class="color-swatches">${CATEGORY_COLORS.map(
              (c) => `<button type="button" class="swatch ${c === color ? 'active' : ''}" data-color="${c}" style="background:${c}" aria-label="${c}"></button>`
            ).join('')}</div></div>
          <div class="field"><label>${esc(t('Attestations'))}</label>
            <select class="select" name="mode">${RULE_MODES.map((r) => `<option value="${r.value}" ${r.value === mode ? 'selected' : ''}>${esc(t(r.label))}</option>`).join('')}</select>
            <span class="hint">${esc(t('The app flags the right sessions automatically and reminds you until you have the attestation.'))}</span></div>
          <div class="grid-2" data-hours ${mode === 'hours' ? '' : 'hidden'}>
            <div class="field"><label>${esc(t('Every … hours'))}</label>
              <input class="input" name="every" type="number" min="0.5" step="0.5" value="${existing?.attestationEveryHours ?? ''}" placeholder="${esc(t('e.g. 30'))}"></div>
            <div class="field"><label>${esc(t('Hours already done'))}</label>
              <input class="input" name="offset" type="number" min="0" step="0.5" value="${existing?.attestationOffsetHours || ''}" placeholder="0"></div>
          </div>
          <div class="field" data-signer ${mode ? '' : 'hidden'}><label>${esc(t('Who gives or signs it?'))}</label>
            <input class="input" name="signer" value="${esc(existing?.attestationSigner || '')}" placeholder="${esc(t('e.g. the director, the secretariat'))}" maxlength="200"></div>
          <div class="field"><label>${esc(t('Notes'))}</label>
            <input class="input" name="notes" value="${esc(existing?.notes || '')}" maxlength="500"></div>
          ${existing?.attestationMode ? `<p class="small muted">${esc(t('Changing the rule applies from today; past sessions keep their status.'))}</p>` : ''}
          <div class="form-error" hidden></div>
        </form>`,
      footer: `<span class="spacer"></span><button class="btn" data-close>${esc(t('Cancel'))}</button>
        <button class="btn primary" data-save>${esc(t('Save'))}</button>`,
      onClose: () => resolve(result),
    });
    const form = m.root.querySelector('form');
    on(form, 'click', '[data-color]', (e, b) => {
      color = b.dataset.color;
      form.querySelectorAll('.swatch').forEach((s) => s.classList.toggle('active', s === b));
    });
    form.mode.addEventListener('change', () => {
      mode = form.mode.value;
      form.querySelector('[data-hours]').hidden = mode !== 'hours';
      form.querySelector('[data-signer]').hidden = !mode;
    });
    const save = async () => {
      const btn = m.root.querySelector('[data-save]');
      const errBox = form.querySelector('.form-error');
      errBox.hidden = true;
      setBusy(btn, true);
      try {
        const body = {
          name: form.name.value,
          color,
          attestationMode: mode || null,
          attestationEveryHours: mode === 'hours' ? form.every.value || null : null,
          attestationOffsetHours: mode === 'hours' ? form.offset.value || 0 : 0,
          attestationSigner: form.signer.value,
          notes: form.notes.value,
        };
        result = existing ? await api.put(`/api/categories/${existing.id}`, { ...body, archived: existing.archived }) : await api.post('/api/categories', body);
        await loadCategories();
        changed();
        m.close(true);
      } catch (err) {
        errBox.textContent = t(err.message);
        errBox.hidden = false;
        setBusy(btn, false);
      }
    };
    m.root.querySelector('[data-save]').addEventListener('click', save);
    form.addEventListener('submit', (e) => (e.preventDefault(), save()));
  });
}

// ---------- Event editor ----------

/**
 * opts: { event } to edit, { start, end, allDay } to prefill a new one, { duplicateOf } to copy.
 * Resolves with the saved event, or null.
 */
export function openEventForm(opts = {}) {
  return new Promise((resolve) => {
    const editing = opts.event || null;
    const source = editing || opts.duplicateOf || null;
    const prefs = loadPrefs();
    const settings = state.settings;

    // ----- initial values -----
    let start, end, allDay;
    if (source) {
      ({ start, end, allDay } = source);
    } else {
      allDay = !!opts.allDay;
      if (opts.start) {
        start = opts.start;
        end = opts.end || addMinutesWall(start, prefs.duration || 60);
        // A click on a month cell gives a whole day: turn it into a timed slot at a sensible hour.
        if (!allDay && start.endsWith('T00:00') && (!opts.end || minutesBetween(start, opts.end) >= 1440)) {
          start = `${start.slice(0, 10)}T${prefs.lastTime || '08:00'}`;
          end = addMinutesWall(start, prefs.duration || 60);
        }
      } else {
        const now = new Date();
        now.setMinutes(0, 0, 0);
        now.setHours(now.getHours() + 1);
        const pad = (n) => String(n).padStart(2, '0');
        start = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:00`;
        end = addMinutesWall(start, prefs.duration || 60);
      }
    }
    const v = {
      title: source?.title || '',
      kind: source?.kind || prefs.kind || 'class',
      categoryId: source?.categoryId ?? (opts.categoryId || prefs.categoryId || null),
      location: source?.location || '',
      notes: source?.notes || '',
      date: start.slice(0, 10),
      endDate: allDay ? addDaysStr(end.slice(0, 10), -1) : end.slice(0, 10),
      startTime: allDay ? prefs.lastTime || '08:00' : start.slice(11, 16),
      endTime: allDay ? addMinutesWall(`2000-01-01T${prefs.lastTime || '08:00'}`, 60).slice(11, 16) : end.slice(11, 16),
      allDay,
      reminders: structuredClone(source?.reminders || settings.defaultReminders || []),
      attRequired: source ? !!source.attestation?.required && source.attestation?.status !== 'waived' : false,
      attNote: source?.attestation?.note || '',
      rule: editing ? editing.rule || null : null,
    };
    if (v.categoryId && !categoryById(v.categoryId)) v.categoryId = null;
    const wasAuto = editing?.attestation?.source === 'auto';
    const attLocked = editing && ['received'].includes(editing.attestation?.status);
    const isSeries = !!editing?.seriesId;

    const titleText = editing ? t('Edit appointment') : opts.duplicateOf ? t('Duplicate appointment') : t('New appointment');
    let dirty = false;
    let saved = null;

    const m = openModal({
      title: titleText,
      size: 'lg',
      content: `<form class="stack" novalidate autocomplete="off"></form>`,
      footer: `${isSeries ? `<span class="chip primary">${icon('repeat')}${esc(t('Repeating'))}</span>` : ''}
        <span class="spacer"></span>
        <button class="btn" data-close>${esc(t('Cancel'))}</button>
        <button class="btn primary" data-save>${icon('check')}${esc(editing ? t('Save changes') : t('Create'))}</button>`,
      onClose: async () => {
        if (saved || !dirty) {
          resolve(saved);
          return true;
        }
        const ok = await confirmDialog({
          title: t('Discard changes?'),
          message: t('You have unsaved changes. They will be lost.'),
          confirm: t('Discard'),
          danger: true,
        });
        if (ok) resolve(null);
        return ok;
      },
    });
    const form = m.root.querySelector('form');

    function catOptions() {
      return `<option value="">${esc(t('— None —'))}</option>${activeCategories()
        .map((c) => `<option value="${c.id}" ${c.id === v.categoryId ? 'selected' : ''}>${esc(c.name)}</option>`)
        .join('')}
        ${v.categoryId && categoryById(v.categoryId)?.archived ? `<option value="${v.categoryId}" selected>${esc(categoryById(v.categoryId).name)}</option>` : ''}
        <option value="__new">＋ ${esc(t('New institution…'))}</option>`;
    }

    function recurrenceHtml() {
      const r = v.rule;
      const freq = r?.freq || '';
      const startDay = new Date(`${v.date}T12:00`).getDay();
      const days = r?.byweekday?.length ? r.byweekday : [startDay];
      const order = settings.weekStart === 0 ? [0, 1, 2, 3, 4, 5, 6] : [1, 2, 3, 4, 5, 6, 0];
      const endsCount = !!r?.count && !r?.until;
      return `
        <div class="field">
          <label for="f-freq">${icon('repeat', 'sm')} ${esc(t('Repeat'))}</label>
          <select class="select" id="f-freq" name="freq">
            <option value="" ${!freq ? 'selected' : ''}>${esc(t('Does not repeat'))}</option>
            <option value="weekly" ${freq === 'weekly' ? 'selected' : ''}>${esc(t('Weekly'))}</option>
            <option value="daily" ${freq === 'daily' ? 'selected' : ''}>${esc(t('Daily'))}</option>
            <option value="monthly" ${freq === 'monthly' ? 'selected' : ''}>${esc(t('Monthly'))}</option>
          </select>
        </div>
        ${
          freq
            ? `<div class="recur-box">
            <div class="row" style="align-items:center">
              <span class="label" style="flex:none">${esc(t('Every'))}</span>
              <input class="input" name="interval" type="number" min="1" max="52" value="${r.interval || 1}" style="width:76px;flex:none">
              <span class="muted" style="flex:none">${esc(freq === 'weekly' ? t('week(s)') : freq === 'daily' ? t('day(s)') : t('month(s)'))}</span>
            </div>
            ${
              freq === 'weekly'
                ? `<div class="field"><span class="label">${esc(t('On'))}</span><div class="pills">${order
                    .map(
                      (d) =>
                        `<button type="button" class="pill day-pill ${days.includes(d) ? 'active' : ''}" data-day="${d}" title="${esc(fmtWeekdayLong(d))}">${esc(fmtWeekdayShort(d).slice(0, 2))}</button>`
                    )
                    .join('')}</div></div>`
                : ''
            }
            <div class="field"><span class="label">${esc(t('Ends'))}</span>
              <div class="row" style="align-items:center;flex-wrap:wrap">
                <div class="segmented" style="flex:none">
                  <button type="button" data-ends="until" class="${!endsCount ? 'active' : ''}">${esc(t('On a date'))}</button>
                  <button type="button" data-ends="count" class="${endsCount ? 'active' : ''}">${esc(t('After'))}</button>
                </div>
                ${
                  endsCount
                    ? `<input class="input" name="count" type="number" min="1" max="500" value="${r.count || 10}" style="width:90px;flex:none"><span class="muted" style="flex:none">${esc(t('sessions'))}</span>`
                    : `<input class="input" name="until" type="date" value="${r.until || schoolYearEnd(v.date)}" min="${v.date}" style="max-width:190px">`
                }
              </div></div>
            <div class="recur-summary" data-recur-summary></div>
          </div>`
            : ''
        }`;
    }

    function attestationHtml() {
      const cat = categoryById(v.categoryId);
      const auto = ruleDescription(cat);
      const showToggle = v.kind !== 'personal';
      return `
        <div class="att-toggle-card ${v.attRequired ? 'on' : ''}" ${showToggle ? '' : 'hidden'}>
          <div class="top">
            <span style="color:${v.attRequired ? 'var(--danger)' : 'var(--text-3)'}">${icon('attestation', 'lg')}</span>
            <div class="txt">
              <div class="t">${esc(t('Attestation needed'))}${wasAuto && v.attRequired ? ` <span class="chip primary" style="margin-left:6px">${icon('sparkles')}${esc(t('automatic'))}</span>` : ''}</div>
              <div class="d">${esc(
                attLocked
                  ? t('Already received for this session.')
                  : v.attRequired
                    ? t('You will be reminded until you mark it as received.')
                    : t('Turn on if you must collect an attestation for this session.')
              )}</div>
            </div>
            <label class="switch danger"><input type="checkbox" name="attRequired" ${v.attRequired ? 'checked' : ''} ${attLocked ? 'disabled' : ''}><span class="track"></span></label>
          </div>
          ${
            v.attRequired
              ? `<div class="field" style="margin-top:12px"><input class="input" name="attNote" value="${esc(v.attNote)}" placeholder="${esc(t('Note: who to ask, what to bring… (optional)'))}" maxlength="1000"></div>`
              : ''
          }
          ${
            auto
              ? `<div class="hint" style="margin-top:10px;display:flex;gap:6px;align-items:flex-start">${icon('sparkles', 'sm')}<span>${esc(
                  `${auto} ${t('The right sessions are flagged automatically.')}`
                )}</span></div>`
              : ''
          }
        </div>`;
    }

    function remindersHtml() {
      const used = new Set(v.reminders.map((r) => r.minutes));
      return `
        <div class="field">
          <span class="label">${icon('bell', 'sm')} ${esc(t('Reminders'))}</span>
          <div class="reminder-list">
            ${v.reminders
              .map(
                (r, i) => `<span class="reminder-chip">${esc(reminderLabel(r.minutes))}
                <button type="button" class="${r.email ? 'on' : ''}" data-rem-email="${i}" title="${esc(r.email ? t('Also by email (click to turn off)') : t('In the app only (click to also send an email)'))}">${icon('mail', 'sm')}</button>
                <button type="button" data-rem-del="${i}" title="${esc(t('Remove'))}">${icon('x', 'sm')}</button></span>`
              )
              .join('')}
            ${
              v.reminders.length < 6
                ? `<select class="select" data-rem-add style="width:auto;height:32px;font-size:13px;border-radius:999px">
                <option value="">＋ ${esc(t('Add reminder'))}</option>
                ${REMINDER_OPTIONS.filter((x) => !used.has(x)).map((x) => `<option value="${x}">${esc(reminderLabel(x))}</option>`).join('')}
              </select>`
                : ''
            }
          </div>
          <span class="hint">${icon('mail', 'sm')} ${esc(t('= also sent by email'))}</span>
        </div>`;
    }

    function render() {
      const dur = v.allDay ? 0 : minutesBetween(`${v.date}T${v.startTime}`, `${v.date}T${v.endTime}`);
      form.innerHTML = `
        <input class="input title-input" name="title" value="${esc(v.title)}" placeholder="${esc(t('Title, e.g. Math — 3rd year A'))}" maxlength="200" autofocus required>
        <div class="field-error-title error-text" hidden></div>

        <div class="segmented" role="radiogroup" aria-label="${esc(t('Type'))}">
          ${KINDS.map((k) => `<button type="button" data-kind="${k.value}" class="${v.kind === k.value ? 'active' : ''}">${esc(t(k.label))}</button>`).join('')}
        </div>

        <div class="grid-2">
          <div class="field"><label for="f-cat">${icon('building', 'sm')} ${esc(t('Institution'))}</label>
            <select class="select" id="f-cat" name="categoryId">${catOptions()}</select></div>
          <div class="field"><label for="f-loc">${icon('pin', 'sm')} ${esc(t('Location / room'))}</label>
            <input class="input" id="f-loc" name="location" value="${esc(v.location)}" placeholder="${esc(t('e.g. Room 12'))}" maxlength="200"></div>
        </div>

        <div class="form-section stack tight">
          <div class="flex wrap" style="justify-content:space-between">
            <span class="label">${icon('clock', 'sm')} ${esc(t('When'))}</span>
            <label class="switch small"><input type="checkbox" name="allDay" ${v.allDay ? 'checked' : ''}><span class="track"></span>${esc(t('All day'))}</label>
          </div>
          ${
            v.allDay
              ? `<div class="grid-2">
                <div class="field"><label>${esc(t('From'))}</label><input class="input" type="date" name="date" value="${v.date}" required></div>
                <div class="field"><label>${esc(t('To'))}</label><input class="input" type="date" name="endDate" value="${v.endDate}" min="${v.date}" required></div>
              </div>`
              : `<div class="grid-3">
                <div class="field"><label>${esc(t('Date'))}</label><input class="input" type="date" name="date" value="${v.date}" required></div>
                <div class="field"><label>${esc(t('Start'))}</label><input class="input" type="time" name="startTime" value="${v.startTime}" step="60" required></div>
                <div class="field"><label>${esc(t('End'))}</label><input class="input" type="time" name="endTime" value="${v.endTime}" step="60" required></div>
              </div>
              <div class="flex wrap" style="justify-content:space-between">
                <div class="duration-chips">${[45, 60, 90, 120, 180, 240]
                  .map((d) => `<button type="button" class="pill ${dur === d ? 'active' : ''}" data-dur="${d}">${esc(durationLabel(d))}</button>`)
                  .join('')}</div>
                <span class="small ${dur <= 0 ? 'error-text' : 'muted'}" data-dur-label>${dur > 0 ? esc(t('Duration: {d}', { d: durationLabel(dur) })) : esc(t('The end time must be after the start time.'))}</span>
              </div>`
          }
          ${v.date < todayStr() && !editing ? `<div class="tip warning">${icon('info')}<span>${esc(t('This date is in the past. That is fine for keeping your history complete.'))}</span></div>` : ''}
        </div>

        <div class="form-section stack tight">${recurrenceHtml()}</div>

        <div class="form-section">${attestationHtml()}</div>

        <div class="form-section">${remindersHtml()}</div>

        <div class="form-section field">
          <label for="f-notes">${esc(t('Notes'))}</label>
          <textarea class="textarea" id="f-notes" name="notes" rows="3" placeholder="${esc(t('Anything useful: topic, material, contact…'))}" maxlength="5000">${esc(v.notes)}</textarea>
        </div>`;
      updateRecurSummary();
    }

    function updateRecurSummary() {
      const box = form.querySelector('[data-recur-summary]');
      if (!box || !v.rule) return;
      const startWall = `${v.date}T${v.allDay ? '00:00' : v.startTime}`;
      const { count, last } = expandPreview(startWall, v.rule);
      box.classList.toggle('warn', count === 0);
      box.innerHTML = count
        ? `${icon('calendar', 'sm')} ${esc(tn(count, '{n} session will be created', '{n} sessions will be created'))}${last ? ` · ${esc(t('last on {date}', { date: fmtDate(last) }))}` : ''}`
        : `${icon('alert', 'sm')} ${esc(t('No session matches. Check the days and the end date.'))}`;
    }

    function readInputs() {
      const f = form.elements;
      v.title = f.title.value;
      v.location = f.location.value;
      v.notes = f.notes.value;
      v.date = f.date.value || v.date;
      if (v.allDay) v.endDate = f.endDate.value || v.date;
      else {
        v.startTime = f.startTime.value || v.startTime;
        v.endTime = f.endTime.value || v.endTime;
      }
      if (f.attNote) v.attNote = f.attNote.value;
      if (v.rule) {
        if (f.interval) v.rule.interval = Math.max(1, parseInt(f.interval.value, 10) || 1);
        if (f.until) v.rule.until = f.until.value || null;
        if (f.count) v.rule.count = Math.max(1, parseInt(f.count.value, 10) || 1);
      }
    }

    // ----- interactions -----
    form.addEventListener('input', (e) => {
      dirty = true;
      readInputs();
      if (['startTime', 'endTime', 'date'].includes(e.target.name) && !v.allDay) {
        const dur = minutesBetween(`${v.date}T${v.startTime}`, `${v.date}T${v.endTime}`);
        const label = form.querySelector('[data-dur-label]');
        if (label) {
          label.className = `small ${dur <= 0 ? 'error-text' : 'muted'}`;
          label.textContent = dur > 0 ? t('Duration: {d}', { d: durationLabel(dur) }) : t('The end time must be after the start time.');
        }
        form.querySelectorAll('[data-dur]').forEach((b) => b.classList.toggle('active', Number(b.dataset.dur) === dur));
      }
      if (['interval', 'until', 'count', 'date', 'startTime'].includes(e.target.name)) updateRecurSummary();
      if (e.target.name === 'title') form.querySelector('.field-error-title').hidden = true;
    });

    let lastStartTime = v.startTime;
    form.addEventListener('change', async (e) => {
      const n = e.target.name;
      dirty = true;
      if (n === 'startTime') {
        // Keep the duration when the start moves, like every good calendar.
        const dur = minutesBetween(`${v.date}T${lastStartTime}`, `${v.date}T${v.endTime}`);
        if (dur > 0) {
          const newEnd = addMinutesWall(`${v.date}T${v.startTime}`, dur);
          if (newEnd.slice(0, 10) === v.date) v.endTime = newEnd.slice(11, 16);
        }
        lastStartTime = v.startTime;
        readAndRender();
      } else if (n === 'date') {
        if (v.allDay && v.endDate < v.date) v.endDate = v.date;
        if (v.rule?.freq === 'weekly' && v.rule.byweekday.length <= 1) v.rule.byweekday = [new Date(`${v.date}T12:00`).getDay()];
        readAndRender();
      } else if (n === 'allDay') {
        v.allDay = e.target.checked;
        if (v.allDay) v.endDate = v.date;
        readAndRender(false);
      } else if (n === 'categoryId') {
        if (e.target.value === '__new') {
          const cat = await openCategoryForm();
          v.categoryId = cat ? cat.id : v.categoryId;
        } else v.categoryId = e.target.value ? Number(e.target.value) : null;
        readAndRender();
      } else if (n === 'freq') {
        const freq = e.target.value;
        v.rule = freq
          ? {
              freq,
              interval: 1,
              byweekday: freq === 'weekly' ? [new Date(`${v.date}T12:00`).getDay()] : [],
              until: v.rule?.until || schoolYearEnd(v.date),
              count: null,
            }
          : null;
        readAndRender();
      } else if (n === 'attRequired') {
        v.attRequired = e.target.checked;
        readAndRender();
        if (v.attRequired) form.elements.attNote?.focus();
      } else if (e.target.matches('[data-rem-add]') && e.target.value !== '') {
        v.reminders.push({ minutes: Number(e.target.value), email: Number(e.target.value) >= 1440 });
        v.reminders.sort((a, b) => a.minutes - b.minutes);
        readAndRender();
      }
    });

    function readAndRender(read = true) {
      if (read) readInputs();
      const focusName = document.activeElement?.name;
      render();
      if (focusName && form.elements[focusName] && focusName !== 'title') form.elements[focusName].focus?.();
    }

    on(form, 'click', '[data-kind]', (e, b) => {
      readInputs();
      v.kind = b.dataset.kind;
      dirty = true;
      readAndRender(false);
    });
    on(form, 'click', '[data-dur]', (e, b) => {
      readInputs();
      const end = addMinutesWall(`${v.date}T${v.startTime}`, Number(b.dataset.dur));
      if (end.slice(0, 10) !== v.date) return toast(t('That duration would go past midnight.'), { type: 'error' });
      v.endTime = end.slice(11, 16);
      dirty = true;
      readAndRender(false);
    });
    on(form, 'click', '[data-day]', (e, b) => {
      readInputs();
      const d = Number(b.dataset.day);
      const set = new Set(v.rule.byweekday);
      if (set.has(d)) {
        if (set.size === 1) return toast(t('Keep at least one day.'));
        set.delete(d);
      } else set.add(d);
      v.rule.byweekday = [...set];
      dirty = true;
      readAndRender(false);
    });
    on(form, 'click', '[data-ends]', (e, b) => {
      readInputs();
      if (b.dataset.ends === 'count') v.rule = { ...v.rule, count: v.rule.count || 10, until: null };
      else v.rule = { ...v.rule, until: schoolYearEnd(v.date), count: null };
      dirty = true;
      readAndRender(false);
    });
    on(form, 'click', '[data-rem-del]', (e, b) => {
      readInputs();
      v.reminders.splice(Number(b.dataset.remDel), 1);
      dirty = true;
      readAndRender(false);
    });
    on(form, 'click', '[data-rem-email]', (e, b) => {
      readInputs();
      const r = v.reminders[Number(b.dataset.remEmail)];
      r.email = !r.email;
      dirty = true;
      readAndRender(false);
    });

    // ----- save -----
    async function save() {
      readInputs();
      const btn = m.root.querySelector('[data-save]');
      if (!v.title.trim()) {
        const err = form.querySelector('.field-error-title');
        err.textContent = t('Please give the appointment a title.');
        err.hidden = false;
        form.elements.title.classList.add('invalid');
        form.elements.title.focus();
        return;
      }
      form.elements.title.classList.remove('invalid');
      let startW, endW;
      if (v.allDay) {
        if (v.endDate < v.date) return toast(t('The end date must be on or after the start date.'), { type: 'error' });
        startW = `${v.date}T00:00`;
        endW = `${addDaysStr(v.endDate, 1)}T00:00`;
      } else {
        startW = `${v.date}T${v.startTime}`;
        endW = `${v.date}T${v.endTime}`;
        if (endW <= startW) {
          form.elements.endTime.classList.add('invalid');
          form.elements.endTime.focus();
          return toast(t('The end time must be after the start time.'), { type: 'error' });
        }
      }
      if (v.rule && expandPreview(startW, v.rule).count === 0) {
        return toast(t('No session matches this repetition. Check the days and the end date.'), { type: 'error' });
      }
      const payload = {
        title: v.title.trim(),
        kind: v.kind,
        categoryId: v.categoryId,
        location: v.location,
        notes: v.notes,
        start: startW,
        end: endW,
        allDay: v.allDay,
        reminders: v.reminders,
        attestation: { required: v.attRequired, note: v.attNote },
        recurrence: v.rule,
      };

      let scope = 'this';
      if (isSeries) {
        const ruleChanged = JSON.stringify(normalizeForCompare(v.rule)) !== JSON.stringify(normalizeForCompare(editing.rule));
        if (ruleChanged) {
          const ok = await confirmDialog({
            title: t('Change the repetition?'),
            message: t('The new repetition will apply to this session and the following ones. Past sessions and those with a received attestation are kept.'),
            confirm: t('Apply'),
          });
          if (!ok) return;
          scope = 'following';
        } else {
          scope = await askScope('edit');
          if (!scope) return;
        }
      }
      if (editing && !isSeries && !v.rule) delete payload.recurrence;
      setBusy(btn, true);
      try {
        let result;
        if (editing) result = await api.put(`/api/events/${editing.id}`, { ...payload, scope });
        else result = await api.post('/api/events', payload);
        savePrefs({
          kind: v.kind,
          categoryId: v.categoryId,
          duration: v.allDay ? prefs.duration : minutesBetween(startW, endW),
          lastTime: v.allDay ? prefs.lastTime : v.startTime,
        });
        saved = result.event;
        changed();
        m.close(true);
        if (editing) toast(result.affected > 1 ? tn(result.affected, '{n} session updated', '{n} sessions updated') : t('Changes saved'), { type: 'success' });
        else
          toast(result.count > 1 ? tn(result.count, '{n} session created', '{n} sessions created') : t('Appointment created'), {
            type: 'success',
            action: t('View'),
            onAction: () => openEventDetails(result.event.id),
          });
      } catch (err) {
        setBusy(btn, false);
        errorToast(err);
      }
    }

    m.root.querySelector('[data-save]').addEventListener('click', save);
    form.addEventListener('submit', (e) => (e.preventDefault(), save()));
    m.root.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        save();
      }
    });
    render();
  });
}

function normalizeForCompare(r) {
  if (!r) return null;
  return {
    freq: r.freq,
    interval: Number(r.interval) || 1,
    byweekday: r.freq === 'weekly' ? [...(r.byweekday || [])].map(Number).sort() : [],
    until: r.until || null,
    count: r.until ? null : r.count ? Number(r.count) : null,
  };
}

// ---------- Attestation actions (shared by drawer, today and attestations pages) ----------

export async function attestationAction(eventId, action, extra = {}) {
  try {
    const res = await api.post(`/api/events/${eventId}/attestation`, { action, ...extra });
    changed();
    return res.event;
  } catch (err) {
    errorToast(err);
    return null;
  }
}

/** "Mark as received" with the option to attach the attestation right away. */
export async function markReceivedFlow(events) {
  const list = Array.isArray(events) ? events : [events];
  const choice = await chooseDialog({
    title: list.length > 1 ? tn(list.length, 'Attestation for {n} session', 'Attestation for {n} sessions') : t('Attestation received'),
    message: t('Great! Save a copy now so you will always find it again.'),
    choices: [
      { value: 'scan', label: t('Scan it now'), description: t('Use the camera of this device'), icon: 'camera' },
      { value: 'upload', label: t('Upload a file'), description: t('PDF or photo already on this device'), icon: 'upload' },
      { value: 'link', label: t('Choose from my documents'), description: t('Already scanned earlier'), icon: 'folder' },
      { value: 'plain', label: t('Just mark as received'), description: t('I will add the document later'), icon: 'check' },
    ],
  });
  if (!choice) return false;
  if (choice === 'plain') {
    if (list.length > 1) {
      try {
        await api.post('/api/events/bulk-attestation', { ids: list.map((e) => e.id), action: 'received' });
        changed();
      } catch (err) {
        errorToast(err);
        return false;
      }
    } else if (!(await attestationAction(list[0].id, 'received'))) return false;
    toast(list.length > 1 ? tn(list.length, '{n} attestation marked as received', '{n} attestations marked as received') : t('Marked as received. Reminders stopped.'), {
      type: 'success',
    });
    return true;
  }
  if (choice === 'link') return linkExistingDocument(list);
  const { openScanner } = await import('./scanner.js');
  const doc = await openScanner({ mode: choice === 'scan' ? 'camera' : 'upload', events: list, markReceived: true });
  return !!doc;
}

async function linkExistingDocument(events) {
  let docs;
  try {
    docs = await api.get('/api/documents?sort=added');
  } catch (err) {
    errorToast(err);
    return false;
  }
  if (!docs.length) {
    toast(t('You have no documents yet. Scan or upload one instead.'));
    return false;
  }
  return new Promise((resolve) => {
    let done = false;
    const m = openModal({
      title: t('Choose a document'),
      content: `<div class="input-icon" style="margin-bottom:12px">${icon('search')}<input class="input" data-filter placeholder="${esc(t('Filter…'))}" autofocus></div>
        <div class="session-pick" style="max-height:50vh">${docs
          .map(
            (d) => `<label data-name="${esc(d.title.toLowerCase())}"><input type="radio" name="doc" value="${d.id}">
            <span style="flex:1;min-width:0"><div class="strong ellipsis">${esc(d.title)}</div>
            <div class="small muted">${esc(d.docDate ? fmtDate(d.docDate) : fmtDate(d.createdAt.slice(0, 10)))}${d.categoryName ? ` · ${esc(d.categoryName)}` : ''}</div></span></label>`
          )
          .join('')}</div>`,
      footer: `<span class="spacer"></span><button class="btn" data-close>${esc(t('Cancel'))}</button><button class="btn primary" data-ok disabled>${esc(t('Link and mark received'))}</button>`,
      onClose: () => resolve(done),
    });
    const ok = m.root.querySelector('[data-ok]');
    m.root.addEventListener('change', () => (ok.disabled = !m.root.querySelector('input[name=doc]:checked')));
    m.root.querySelector('[data-filter]').addEventListener('input', (e) => {
      const q = e.target.value.toLowerCase();
      m.root.querySelectorAll('[data-name]').forEach((l) => (l.hidden = !l.dataset.name.includes(q)));
    });
    ok.addEventListener('click', async () => {
      const docId = Number(m.root.querySelector('input[name=doc]:checked').value);
      setBusy(ok, true);
      try {
        const doc = docs.find((d) => d.id === docId);
        const ids = [...new Set([...doc.events.map((e) => e.id), ...events.map((e) => e.id)])];
        await api.upload(`/api/documents/${docId}`, formData({ eventIds: JSON.stringify(ids), markReceived: 'true' }), 'PUT');
        changed();
        done = true;
        toast(t('Document linked. Reminders stopped.'), { type: 'success' });
        m.close(true);
      } catch (err) {
        setBusy(ok, false);
        errorToast(err);
      }
    });
  });
}

function formData(obj) {
  const fd = new FormData();
  for (const [k, val] of Object.entries(obj)) fd.append(k, val);
  return fd;
}

export function attestationState(e, now = nowWall()) {
  const a = e.attestation;
  if (!a?.required) return 'none';
  if (a.status === 'received') return 'received';
  if (a.status === 'waived') return 'waived';
  return e.end <= now ? 'overdue' : 'pending';
}

export function attestationChip(e) {
  const s = attestationState(e);
  if (s === 'overdue') return `<span class="chip danger">${icon('alertCircle')}${esc(t('Attestation missing'))}</span>`;
  if (s === 'pending') return `<span class="chip warning">${icon('attestation')}${esc(t('Attestation to ask'))}</span>`;
  if (s === 'received') return `<span class="chip success">${icon('check')}${esc(t('Attestation received'))}</span>`;
  if (s === 'waived') return `<span class="chip muted">${esc(t('Attestation not needed'))}</span>`;
  return '';
}

// ---------- Details drawer ----------

let drawer = null;

let openToken = 0;
export async function openEventDetails(id) {
  closeDrawer();
  const token = ++openToken;
  let e;
  try {
    e = await api.get(`/api/events/${id}`);
  } catch (err) {
    errorToast(err);
    return;
  }
  if (token !== openToken) return;
  closeDrawer();
  const backdrop = el('<div class="drawer-backdrop"></div>');
  const node = el('<aside class="drawer" role="dialog" aria-modal="true"></aside>');
  document.body.append(backdrop, node);
  drawer = { node, backdrop, id };
  backdrop.addEventListener('click', closeDrawer);
  renderDrawer(e);
  node.focus?.();
}

function closeDrawer() {
  if (!drawer) return;
  drawer.node.remove();
  drawer.backdrop.remove();
  drawer = null;
}

document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape' && drawer && !document.querySelector('.modal-backdrop')) closeDrawer();
});

async function reloadDrawer() {
  if (!drawer) return;
  try {
    const e = await api.get(`/api/events/${drawer.id}`);
    renderDrawer(e);
  } catch {
    closeDrawer();
  }
}

function renderDrawer(e) {
  const node = drawer.node;
  const cat = categoryById(e.categoryId);
  const s = attestationState(e);
  const now = nowWall();
  const isPast = e.end <= now;
  const overdueDays = s === 'overdue' ? daysAgo(e.end) : 0;
  const hours = e.allDay ? 0 : minutesBetween(e.start, e.end) / 60;

  let attBox = '';
  if (s === 'none') {
    attBox = `<div class="att-box"><div class="head">${icon('attestation')}${esc(t('No attestation needed'))}</div>
      <div class="actions"><button class="btn sm" data-att="require">${icon('plus', 'sm')}${esc(t('Require an attestation'))}</button></div></div>`;
  } else if (s === 'pending' || s === 'overdue') {
    attBox = `<div class="att-box ${s}">
      <div class="head">${icon(s === 'overdue' ? 'alertCircle' : 'attestation')}
        ${esc(s === 'overdue' ? (overdueDays >= 1 ? tn(overdueDays, 'Attestation missing for {n} day', 'Attestation missing for {n} days') : t('Attestation missing')) : t('Attestation to ask for at this session'))}
        ${e.attestation.source === 'auto' ? `<span class="chip primary">${icon('sparkles')}${esc(t('automatic'))}</span>` : ''}</div>
      ${e.attestation.note ? `<div class="desc">“${esc(e.attestation.note)}”</div>` : ''}
      ${e.attestation.source === 'auto' && ruleDescription(cat) ? `<div class="desc">${esc(ruleDescription(cat))}</div>` : ''}
      ${cat?.attestationSigner ? `<div class="desc">${esc(t('Given by: {who}', { who: cat.attestationSigner }))}</div>` : ''}
      ${e.attestation.snoozedUntil && e.attestation.snoozedUntil > now ? `<div class="desc">${icon('snooze', 'sm')} ${esc(t('Snoozed until {d}', { d: `${fmtShort(e.attestation.snoozedUntil)} ${fmtTime(e.attestation.snoozedUntil)}` }))}</div>` : ''}
      <div class="actions">
        <button class="btn success sm" data-att="received">${icon('check', 'sm')}${esc(t('Mark as received'))}</button>
        ${s === 'overdue' ? `<button class="btn sm" data-att="snooze">${icon('snooze', 'sm')}${esc(t('Remind me tomorrow'))}</button>` : ''}
        <button class="btn ghost sm" data-att="waived">${esc(t('Not needed'))}</button>
      </div></div>`;
  } else if (s === 'received') {
    attBox = `<div class="att-box received"><div class="head">${icon('checkCircle')}${esc(t('Attestation received'))}</div>
      ${e.attestation.receivedAt ? `<div class="desc">${esc(t('On {d}', { d: fmtDate(e.attestation.receivedAt) }))}</div>` : ''}
      <div class="actions">
        ${!e.documents.length ? `<button class="btn sm" data-att="attach">${icon('scan', 'sm')}${esc(t('Add the scan'))}</button>` : ''}
        <button class="btn ghost sm" data-att="pending">${icon('undo', 'sm')}${esc(t('Undo'))}</button>
      </div></div>`;
  } else if (s === 'waived') {
    attBox = `<div class="att-box"><div class="head">${icon('ban')}${esc(t('Attestation marked as not needed'))}</div>
      <div class="actions"><button class="btn ghost sm" data-att="pending">${icon('undo', 'sm')}${esc(t('Undo'))}</button>
      ${e.attestation.source !== 'auto' ? `<button class="btn ghost sm" data-att="remove">${esc(t('Remove'))}</button>` : ''}</div></div>`;
  }

  node.innerHTML = `
    <div class="drawer-head">
      <span class="color" style="background:${eventColor(e)}"></span>
      <div style="flex:1;min-width:0">
        <div class="flex wrap gap-sm" style="margin-bottom:6px">
          <span class="chip">${esc(kindLabel(e.kind))}</span>
          ${e.status === 'cancelled' ? `<span class="chip danger">${icon('ban')}${esc(e.cancelReason?.startsWith('holiday:') ? t('Cancelled — holiday') : t('Cancelled'))}</span>` : ''}
          ${isPast && e.status !== 'cancelled' ? `<span class="chip muted">${esc(t('Past'))}</span>` : ''}
        </div>
        <h2 style="${e.status === 'cancelled' ? 'text-decoration:line-through' : ''}">${esc(e.title)}</h2>
      </div>
      <button class="btn ghost icon-only sm" data-close aria-label="${esc(t('Close'))}">${icon('x')}</button>
    </div>
    <div class="drawer-body">
      <div class="stack tight">
        <div class="detail-row">${icon('calendar')}<div><div class="strong cap" style="color:var(--text)">${esc(fmtDayYear(e.start))}</div>
          <div>${esc(timeRange(e))}${hours ? ` · ${esc(hoursLabel(hours))}` : ''}</div></div></div>
        ${e.rule ? `<div class="detail-row">${icon('repeat')}<div>${esc(ruleSummary(e.rule))}<div class="small muted">${esc(tn(e.seriesCount, '{n} session in this series', '{n} sessions in this series'))}</div></div></div>` : ''}
        ${cat ? `<div class="detail-row">${icon('building')}<div class="flex gap-sm"><span class="cat-dot" style="background:${cat.color}"></span>${esc(cat.name)}</div></div>` : ''}
        ${e.location ? `<div class="detail-row">${icon('pin')}<div>${esc(e.location)}</div></div>` : ''}
        ${e.reminders.length ? `<div class="detail-row">${icon('bell')}<div>${e.reminders.map((r) => `${esc(reminderLabel(r.minutes))}${r.email ? ` ${icon('mail', 'sm')}` : ''}`).join('<br>')}</div></div>` : ''}
        ${e.notes ? `<div class="detail-row">${icon('fileText')}<div class="notes">${esc(e.notes)}</div></div>` : ''}
      </div>
      ${e.status !== 'cancelled' ? attBox : ''}
      ${
        e.documents.length
          ? `<div class="stack tight"><span class="label">${esc(t('Documents'))}</span>${e.documents
              .map(
                (d) => `<a class="doc-mini" href="/api/documents/${d.id}/file" target="_blank" rel="noopener">
              ${d.has_thumb || d.mime.startsWith('image/') ? `<img src="/api/documents/${d.id}/thumb" alt="">` : `<span class="ic">${icon('fileText')}</span>`}
              <span style="flex:1;min-width:0" class="ellipsis strong">${esc(d.title)}</span>${icon('external', 'sm')}</a>`
              )
              .join('')}</div>`
          : ''
      }
    </div>
    <div class="drawer-foot">
      <button class="btn primary" data-act="edit">${icon('edit', 'sm')}${esc(t('Edit'))}</button>
      <button class="btn icon-only" data-act="duplicate" title="${esc(t('Duplicate'))}" aria-label="${esc(t('Duplicate'))}">${icon('copy', 'sm')}</button>
      <span class="spacer"></span>
      ${
        e.status === 'cancelled'
          ? `<button class="btn" data-act="restore">${icon('undo', 'sm')}${esc(t('Restore'))}</button>`
          : `<button class="btn ghost" data-act="cancel" title="${esc(t('Cancel this session but keep it in the history'))}">${icon('ban', 'sm')}${esc(t('Cancel session'))}</button>`
      }
      <button class="btn ghost icon-only" data-act="delete" title="${esc(t('Delete'))}" aria-label="${esc(t('Delete'))}" style="color:var(--danger-text)">${icon('trash')}</button>
    </div>`;

  node.querySelector('[data-close]').addEventListener('click', closeDrawer);
  node.querySelectorAll('[data-att]').forEach((b) =>
    b.addEventListener('click', async () => {
      const act = b.dataset.att;
      if (act === 'received') {
        if (await markReceivedFlow(e)) reloadDrawer();
        return;
      }
      if (act === 'attach') {
        const { openScanner } = await import('./scanner.js');
        if (await openScanner({ mode: 'choose', events: [e], markReceived: true })) reloadDrawer();
        return;
      }
      if (act === 'snooze') {
        if (await attestationAction(e.id, 'snooze', { hours: 24 })) {
          toast(t('OK, I will remind you tomorrow.'));
          reloadDrawer();
        }
        return;
      }
      if (act === 'waived') {
        const ok = await confirmDialog({
          title: t('No attestation needed?'),
          message: t('Reminders for this session will stop. You can undo this at any time.'),
          confirm: t('Not needed'),
        });
        if (!ok) return;
      }
      setBusy(b, true);
      if (await attestationAction(e.id, act)) reloadDrawer();
      else setBusy(b, false);
    })
  );
  node.querySelectorAll('[data-act]').forEach((b) =>
    b.addEventListener('click', async () => {
      const act = b.dataset.act;
      if (act === 'edit') {
        const res = await openEventForm({ event: e });
        if (res) reloadDrawer();
      } else if (act === 'duplicate') {
        closeDrawer();
        openEventForm({ duplicateOf: e });
      } else if (act === 'cancel') {
        let scope = 'this';
        if (e.seriesId) {
          scope = await askScope('cancel');
          if (!scope) return;
        }
        try {
          const res = await api.del(`/api/events/${e.id}?mode=cancel&scope=${scope}`);
          changed();
          toast(res.affected > 1 ? tn(res.affected, '{n} session cancelled', '{n} sessions cancelled') : t('Session cancelled. It stays in your history.'), {
            action: res.affected === 1 ? t('Undo') : undefined,
            onAction: async () => {
              await api.put(`/api/events/${e.id}`, { ...editablePayload(e), status: 'scheduled', scope: 'this' });
              changed();
            },
          });
          reloadDrawer();
        } catch (err) {
          errorToast(err);
        }
      } else if (act === 'restore') {
        try {
          await api.put(`/api/events/${e.id}`, { ...editablePayload(e), status: 'scheduled', scope: 'this' });
          changed();
          toast(t('Session restored'), { type: 'success' });
          reloadDrawer();
        } catch (err) {
          errorToast(err);
        }
      } else if (act === 'delete') {
        let scope = 'this';
        if (e.seriesId) {
          scope = await askScope('delete');
          if (!scope) return;
        }
        const hasHistory = e.attestation.status === 'received' || e.documents.length;
        const ok = await confirmDialog({
          title: t('Delete permanently?'),
          message:
            esc(t('This cannot be undone.')) +
            (hasHistory ? `<br><br><b>${esc(t('This session has a received attestation or documents. The documents are kept in My documents.'))}</b>` : '') +
            `<br><br>${esc(t('Tip: “Cancel session” keeps it in your history instead.'))}`,
          confirm: t('Delete'),
          danger: true,
        });
        if (!ok) return;
        try {
          const res = await api.del(`/api/events/${e.id}?mode=delete&scope=${scope}`);
          closeDrawer();
          changed();
          toast(tn(res.affected, '{n} session deleted', '{n} sessions deleted'));
        } catch (err) {
          errorToast(err);
        }
      }
    })
  );
}

function editablePayload(e) {
  return {
    title: e.title,
    kind: e.kind,
    categoryId: e.categoryId,
    location: e.location,
    notes: e.notes,
    start: e.start,
    end: e.end,
    allDay: e.allDay,
    reminders: e.reminders,
  };
}
