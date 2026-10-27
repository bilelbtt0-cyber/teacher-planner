import { api, qs } from './api.js';
import { deletedToast } from './trash.js';
import {
  t, tn, fmtDayYear, fmtShort, fmtDate, fmtTime, timeRange, durationLabel, reminderLabel, nowWall, todayStr,
  addMinutesWall, minutesBetween, addDaysStr, daysAgo, hoursLabel,
} from './i18n.js';
import { state, categoryById, activeCategories, activeCourses, courseById, eventColor, changed, loadCategories, loadCourses } from './store.js';
import { esc, icon, openModal, confirmDialog, chooseDialog, toast, errorToast, setBusy, on, el, CATEGORY_COLORS } from './ui.js';

/** 30 June of the school year a date belongs to (September → June). */
function schoolYearEnd(date) {
  const y = Number(date.slice(0, 4)) + (Number(date.slice(5, 7)) >= 9 ? 1 : 0);
  return `${y}-06-30`;
}

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
 * opts: { event } to edit, { start, end, allDay } to prefill a new one, { duplicateOf } to copy,
 * { course } to plan a session of a saved course. Resolves with the saved event, or null.
 */
export function openEventForm(opts = {}) {
  return new Promise((resolve) => {
    const editing = opts.event || null;
    const source = editing || opts.duplicateOf || null;
    const prefs = loadPrefs();
    const settings = state.settings;
    const startCourse = !source && opts.course ? opts.course : null;

    // ----- initial values -----
    const defaultDuration = startCourse?.durationMinutes || prefs.duration || 60;
    let start, end, allDay;
    if (source) {
      ({ start, end, allDay } = source);
    } else {
      allDay = !!opts.allDay;
      if (opts.start) {
        start = opts.start;
        end = opts.end || addMinutesWall(start, defaultDuration);
        // A click on a month cell gives a whole day: turn it into a timed slot at a sensible hour.
        if (!allDay && start.endsWith('T00:00') && (!opts.end || minutesBetween(start, opts.end) >= 1440)) {
          start = `${start.slice(0, 10)}T${prefs.lastTime || '08:00'}`;
          end = addMinutesWall(start, defaultDuration);
        }
      } else {
        const now = new Date();
        now.setMinutes(0, 0, 0);
        now.setHours(now.getHours() + 1);
        const pad = (n) => String(n).padStart(2, '0');
        start = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:00`;
        end = addMinutesWall(start, defaultDuration);
      }
    }
    const v = {
      courseId: source?.courseId ?? startCourse?.id ?? null,
      title: source?.title || startCourse?.title || '',
      kind: source?.kind || startCourse?.kind || prefs.kind || 'class',
      categoryId: source?.categoryId ?? startCourse?.categoryId ?? (opts.categoryId || prefs.categoryId || null),
      location: source?.location || startCourse?.location || '',
      notes: source?.notes || '',
      date: start.slice(0, 10),
      endDate: allDay ? addDaysStr(end.slice(0, 10), -1) : end.slice(0, 10),
      startTime: allDay ? prefs.lastTime || '08:00' : start.slice(11, 16),
      endTime: allDay ? addMinutesWall(`2000-01-01T${prefs.lastTime || '08:00'}`, 60).slice(11, 16) : end.slice(11, 16),
      allDay,
      reminders: structuredClone(source?.reminders || settings.defaultReminders || []),
      attRequired: source ? !!source.attestation?.required && source.attestation?.status !== 'waived' : false,
      attNote: source?.attestation?.note || '',
      // For a session already over: was the attestation already received? (her history)
      attReceived: start.slice(0, 10) < addDaysStr(todayStr(), -14),
      saveAsCourse: false,
      repeat: false,
      repeatUntil: schoolYearEnd(start.slice(0, 10)),
    };
    if (v.categoryId && !categoryById(v.categoryId)) v.categoryId = null;
    if (v.courseId && !courseById(v.courseId)) v.courseId = null;
    // A long course planned late in the evening must still end on the same day.
    if (!allDay && end.slice(0, 10) !== v.date) v.endTime = '23:59';
    const wasAuto = editing?.attestation?.source === 'auto';
    const attLocked = editing && ['received'].includes(editing.attestation?.status);

    const titleText = editing ? t('Edit appointment') : opts.duplicateOf ? t('Duplicate appointment') : t('New appointment');
    let dirty = false;
    let saved = null;

    const m = openModal({
      title: titleText,
      size: 'lg',
      content: `<form class="stack" novalidate autocomplete="off"></form>`,
      footer: `<span class="spacer"></span>
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

    function courseHtml() {
      const courses = activeCourses();
      const current = courseById(v.courseId);
      const options = `<option value="">${esc(t('— Without a course —'))}</option>${courses
        .map((c) => `<option value="${c.id}" ${c.id === v.courseId ? 'selected' : ''}>${esc(c.title)}${categoryById(c.categoryId) ? ` · ${esc(categoryById(c.categoryId).name)}` : ''}</option>`)
        .join('')}
        ${current?.archived ? `<option value="${current.id}" selected>${esc(current.title)}</option>` : ''}
        <option value="__new">＋ ${esc(t('New course…'))}</option>`;
      const canSave = !v.courseId && !editing && ['class', 'exam'].includes(v.kind);
      return `<div class="course-pick ${v.courseId ? 'on' : ''}">
          <span class="ic">${icon('book')}</span>
          <div class="field" style="flex:1">
            <label for="f-course">${esc(t('Course'))}</label>
            <select class="select" id="f-course" name="courseId">${options}</select>
            <span class="hint">${esc(
              v.courseId
                ? t('Its summary and files will be one click away during the session.')
                : courses.length
                  ? t('Pick a saved course to fill in this form automatically.')
                  : t('Save your courses in My courses, then pick one here to fill in this form automatically.')
            )}</span>
          </div>
        </div>
        ${canSave ? `<label class="switch small"><input type="checkbox" name="saveAsCourse" ${v.saveAsCourse ? 'checked' : ''}><span class="track"></span>${esc(t('Also save it in My courses, to plan it again in two clicks'))}</label>` : ''}`;
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
              <div class="t">${esc(v.attRequired && askReceived() && v.attReceived ? t('Attestation received') : t('Attestation needed'))}${wasAuto && v.attRequired ? ` <span class="chip primary" style="margin-left:6px">${icon('sparkles')}${esc(t('automatic'))}</span>` : ''}</div>
              <div class="d">${esc(
                attLocked
                  ? t('Already received for this session.')
                  : v.attRequired
                    ? askReceived() ? t('This session is already over.') : t('You will be reminded until you mark it as received.')
                    : t('Turn on if you must collect an attestation for this session.')
              )}</div>
            </div>
            <label class="switch danger"><input type="checkbox" name="attRequired" ${v.attRequired ? 'checked' : ''} ${attLocked ? 'disabled' : ''}><span class="track"></span></label>
          </div>
          ${
            v.attRequired && askReceived()
              ? `<div class="segmented" role="radiogroup" style="margin-top:12px" aria-label="${esc(t('Attestation'))}">
                  <button type="button" data-att-received="1" class="${v.attReceived ? 'active' : ''}">${icon('check', 'sm')}${esc(t('Already received'))}</button>
                  <button type="button" data-att-received="0" class="${v.attReceived ? '' : 'active'}">${esc(t('Still to collect'))}</button>
                </div>
                <div class="hint" style="margin-top:6px">${esc(v.attReceived ? t('This session is over: it is saved as received, with no reminder.') : t('You will be reminded until you mark it as received.'))}</div>`
              : ''
          }
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

    // The session is already over: she is entering her history.
    function askReceived() {
      if (editing?.attestation?.required) return false;
      const endW = v.allDay ? `${addDaysStr(v.endDate, 1)}T00:00` : `${v.date}T${v.endTime}`;
      return endW <= nowWall();
    }

    // Reminders make no sense for history: hidden when every session entered is already over.
    const allInPast = () => askReceived() && (!(canRepeat() && v.repeat) || v.repeatUntil < todayStr());

    const canRepeat = () => !editing && !v.allDay;
    function repeatCount() {
      if (!v.repeat || !v.repeatUntil || v.repeatUntil < v.date) return 0;
      return Math.floor((new Date(`${v.repeatUntil}T12:00`) - new Date(`${v.date}T12:00`)) / (7 * 86400000)) + 1;
    }
    function repeatLabel(n) {
      if (n > 200) return t('Too many sessions at once: at most 200.');
      if (!n) return t('The repeat must end on or after the first session.');
      return ['class', 'exam'].includes(v.kind)
        ? tn(n, '{n} session, holidays skipped', 'Up to {n} sessions, holidays skipped')
        : tn(n, '{n} appointment', '{n} appointments');
    }
    function repeatHtml() {
      const n = repeatCount();
      return `<div class="repeat-box">
          <label class="switch small"><input type="checkbox" name="repeat" ${v.repeat ? 'checked' : ''}><span class="track"></span>${esc(t('Repeat every week'))}</label>
          ${
            v.repeat
              ? `<div class="flex wrap gap-sm" style="align-items:center;margin-top:8px">
                  <label for="f-until" class="small">${esc(t('until'))}</label>
                  <input class="input" type="date" id="f-until" name="repeatUntil" value="${v.repeatUntil}" min="${v.date}" style="width:auto">
                  <span class="small ${n > 200 || !n ? 'error-text' : 'muted'}" data-repeat-count>${esc(repeatLabel(n))}</span>
                </div>`
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
        ${courseHtml()}

        <input class="input title-input" name="title" value="${esc(v.title)}" placeholder="${esc(t('Title, e.g. Math — 3rd year A'))}" maxlength="200" ${v.courseId ? '' : 'autofocus'} required>
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
                <div class="field"><label>${esc(t('Date'))}</label><input class="input" type="date" name="date" value="${v.date}" required ${v.courseId && !editing ? 'autofocus' : ''}></div>
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
          ${canRepeat() ? repeatHtml() : ''}
          ${v.date < todayStr() && !editing ? `<div class="tip warning">${icon('info')}<span>${esc(t('This date is in the past. That is fine for keeping your history complete.'))}</span></div>` : ''}
        </div>

        <div class="form-section">${attestationHtml()}</div>

        ${allInPast() ? '' : `<div class="form-section">${remindersHtml()}</div>`}

        <div class="form-section field">
          <label for="f-notes">${esc(t('Notes'))}</label>
          <textarea class="textarea" id="f-notes" name="notes" rows="3" placeholder="${esc(t('Anything useful for this session: homework given, what to bring…'))}" maxlength="5000">${esc(v.notes)}</textarea>
        </div>`;
    }

    /** Picking a course fills in everything it knows; the date and the start time stay as chosen. */
    function applyCourse(c) {
      v.courseId = c.id;
      v.title = c.title;
      v.kind = c.kind;
      if (c.categoryId && categoryById(c.categoryId)) v.categoryId = c.categoryId;
      v.location = c.location;
      if (!v.allDay) {
        const endW = addMinutesWall(`${v.date}T${v.startTime}`, c.durationMinutes);
        v.endTime = endW.slice(0, 10) === v.date ? endW.slice(11, 16) : '23:59';
      }
      v.saveAsCourse = false;
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
      if (f.saveAsCourse) v.saveAsCourse = f.saveAsCourse.checked;
      if (f.repeatUntil) v.repeatUntil = f.repeatUntil.value || v.repeatUntil;
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
      if (e.target.name === 'title') form.querySelector('.field-error-title').hidden = true;
      if (e.target.name === 'repeatUntil') {
        const label = form.querySelector('[data-repeat-count]');
        if (label) {
          const n = repeatCount();
          label.textContent = repeatLabel(n);
          label.className = `small ${n > 200 || !n ? 'error-text' : 'muted'}`;
        }
      }
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
      } else if (n === 'courseId') {
        readInputs();
        if (e.target.value === '__new') {
          const { openCourseForm } = await import('./courses.js');
          const course = await openCourseForm(null, {
            title: v.title.trim(),
            kind: v.kind,
            categoryId: v.categoryId,
            location: v.location,
            durationMinutes: v.allDay ? 60 : Math.max(5, minutesBetween(`${v.date}T${v.startTime}`, `${v.date}T${v.endTime}`) || 60),
          });
          if (course) applyCourse(course);
        } else if (e.target.value) applyCourse(courseById(Number(e.target.value)));
        else v.courseId = null;
        lastStartTime = v.startTime;
        render();
      } else if (n === 'repeat') {
        v.repeat = e.target.checked;
        if (v.repeatUntil < v.date) v.repeatUntil = schoolYearEnd(v.date);
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
    on(form, 'click', '[data-att-received]', (e, b) => {
      readInputs();
      v.attReceived = b.dataset.attReceived === '1';
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
      const repeating = canRepeat() && v.repeat;
      if (repeating && (repeatCount() < 1 || repeatCount() > 200)) return toast(repeatLabel(repeatCount()), { type: 'error' });
      setBusy(btn, true);
      // Something already planned at the same time is usually a duplicate: ask first.
      if (!v.allDay) {
        try {
          const same = (await api.get(`/api/events${qs({ start: startW, end: endW })}`)).filter(
            (x) => x.id !== editing?.id && x.status !== 'cancelled' && !x.allDay
          );
          if (same.length) {
            setBusy(btn, false);
            const ok = await confirmDialog({
              title: t('Something is already planned at that time'),
              message:
                same.map((x) => `<b>${esc(x.title)}</b> · ${esc(timeRange(x))}`).join('<br>') +
                `<br><br>${esc(t('Save anyway? Choose Cancel if it is the same appointment entered twice.'))}`,
              confirm: t('Save anyway'),
            });
            if (!ok) return;
            setBusy(btn, true);
          }
        } catch {
          /* the check is only a help: it never blocks saving */
        }
      }
      try {
        let newCourse = false;
        if (!v.courseId && v.saveAsCourse && !editing) {
          const course = await api.post('/api/courses', {
            title: v.title.trim(),
            kind: v.kind,
            categoryId: v.categoryId,
            location: v.location,
            durationMinutes: v.allDay ? 60 : minutesBetween(startW, endW),
          });
          v.courseId = course.id;
          v.saveAsCourse = false;
          newCourse = true;
          await loadCourses();
        }
        const payload = {
          courseId: v.courseId,
          title: v.title.trim(),
          kind: v.kind,
          categoryId: v.categoryId,
          location: v.location,
          notes: v.notes,
          start: startW,
          end: endW,
          allDay: v.allDay,
          reminders: v.reminders,
          attestation: { required: v.attRequired, note: v.attNote, received: v.attRequired && askReceived() && v.attReceived },
          repeat: repeating ? { until: v.repeatUntil } : undefined,
        };
        const result = editing ? await api.put(`/api/events/${editing.id}`, payload) : await api.post('/api/events', payload);
        savePrefs({
          kind: v.kind,
          categoryId: v.categoryId,
          duration: v.allDay ? prefs.duration : minutesBetween(startW, endW),
          lastTime: v.allDay ? prefs.lastTime : v.startTime,
        });
        saved = result.event;
        changed();
        m.close(true);
        if (editing) toast(t('Changes saved'), { type: 'success' });
        else if (result.created > 1)
          toast(
            tn(result.created, '{n} session created', '{n} sessions created') +
              (result.skipped ? ` · ${tn(result.skipped, '{n} week skipped (holidays)', '{n} weeks skipped (holidays)')}` : ''),
            { type: 'success', duration: 7000 }
          );
        else
          toast(newCourse ? t('Appointment created and course saved in My courses') : t('Appointment created'), {
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

  const c = e.course;
  const snippet = c ? c.summary.trim().replace(/\s+/g, ' ') : '';
  const supportBox = c
    ? `<div class="support-box">
        <div class="head">${icon('book')}<span class="ellipsis">${esc(c.title)}</span></div>
        ${snippet ? `<div class="desc">${esc(snippet.length > 220 ? `${snippet.slice(0, 220)}…` : snippet)}</div>` : `<div class="desc muted">${esc(t('No summary yet'))}</div>`}
        ${c.files.length ? `<div class="desc small">${icon('folder', 'sm')} ${esc(tn(c.files.length, '{n} file', '{n} files'))}</div>` : ''}
        <div class="actions"><button class="btn primary sm" data-support="${c.id}">${icon('book', 'sm')}${esc(t('Open the support'))}</button></div>
      </div>`
    : // Classes, exams and meetings can all have a support (lesson notes, an agenda, documents…).
      ['class', 'exam', 'meeting'].includes(e.kind) && e.status !== 'cancelled'
      ? `<div class="support-box empty">
          <div class="head">${icon('book')}<span>${esc(t('No support yet'))}</span></div>
          <div class="desc">${esc(e.kind === 'meeting' ? t('Add an agenda, notes or documents to have them at hand during the meeting.') : t('Add the summary and the files of this session to have them at hand.'))}</div>
          <div class="actions"><button class="btn soft sm" data-add-support>${icon('plus', 'sm')}${esc(t('Add a support'))}</button></div>
        </div>`
      : '';

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
        ${cat ? `<div class="detail-row">${icon('building')}<div class="flex gap-sm"><span class="cat-dot" style="background:${cat.color}"></span>${esc(cat.name)}</div></div>` : ''}
        ${e.location ? `<div class="detail-row">${icon('pin')}<div>${esc(e.location)}</div></div>` : ''}
        ${e.reminders.length ? `<div class="detail-row">${icon('bell')}<div>${e.reminders.map((r) => `${esc(reminderLabel(r.minutes))}${r.email ? ` ${icon('mail', 'sm')}` : ''}`).join('<br>')}</div></div>` : ''}
        ${e.notes ? `<div class="detail-row">${icon('fileText')}<div class="notes">${esc(e.notes)}</div></div>` : ''}
      </div>
      ${supportBox}
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
  node.querySelector('[data-support]')?.addEventListener('click', async () => {
    const { openCourseSupport } = await import('./courses.js');
    openCourseSupport(e.course.id);
  });
  node.querySelector('[data-add-support]')?.addEventListener('click', async () => {
    const { openCourseForm } = await import('./courses.js');
    // Reuse a saved support (the same course or meeting often comes back), or create a new one.
    const saved = activeCourses();
    let course = null;
    if (saved.length) {
      const sameKind = saved.filter((x) => x.kind === e.kind);
      const others = saved.filter((x) => x.kind !== e.kind);
      const choice = await chooseDialog({
        title: t('Add a support'),
        message: t('Create a new support for this appointment, or reuse one you already saved.'),
        choices: [
          { value: 'new', label: t('New support'), description: t('Summary and files, saved in My courses'), icon: 'plus' },
          ...[...sameKind, ...others].slice(0, 8).map((x) => ({
            value: String(x.id),
            label: x.title,
            description: [kindLabel(x.kind), categoryById(x.categoryId)?.name].filter(Boolean).join(' · '),
            icon: 'book',
          })),
        ],
      });
      if (!choice) return;
      if (choice !== 'new') course = courseById(Number(choice));
    }
    if (!course) {
      course = await openCourseForm(null, {
        title: e.title,
        kind: e.kind,
        categoryId: e.categoryId,
        location: e.location,
        durationMinutes: e.allDay ? 60 : Math.max(5, minutesBetween(e.start, e.end)),
      });
    }
    if (!course) return;
    try {
      await api.put(`/api/events/${e.id}`, { ...editablePayload(e), courseId: course.id });
      await loadCourses();
      changed();
      toast(t('Support added to this appointment'), { type: 'success' });
      reloadDrawer();
    } catch (err) {
      errorToast(err);
    }
  });
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
        try {
          await api.del(`/api/events/${e.id}?mode=cancel`);
          changed();
          toast(t('Session cancelled. It stays in your history.'), {
            action: t('Undo'),
            onAction: async () => {
              await api.put(`/api/events/${e.id}`, { ...editablePayload(e), status: 'scheduled' });
              changed();
            },
          });
          reloadDrawer();
        } catch (err) {
          errorToast(err);
        }
      } else if (act === 'restore') {
        try {
          await api.put(`/api/events/${e.id}`, { ...editablePayload(e), status: 'scheduled' });
          changed();
          toast(t('Session restored'), { type: 'success' });
          reloadDrawer();
        } catch (err) {
          errorToast(err);
        }
      } else if (act === 'delete') {
        const hasHistory = e.attestation.status === 'received' || e.documents.length;
        const ok = await confirmDialog({
          title: t('Delete this appointment?'),
          message:
            esc(t('It stays 30 days in the trash (Settings → My data), in case you change your mind.')) +
            (hasHistory ? `<br><br><b>${esc(t('This session has a received attestation or documents. The documents are kept in My documents.'))}</b>` : '') +
            `<br><br>${esc(t('Tip: “Cancel session” keeps it in your history instead.'))}`,
          confirm: t('Delete'),
          danger: true,
        });
        if (!ok) return;
        try {
          const res = await api.del(`/api/events/${e.id}?mode=delete`);
          closeDrawer();
          changed();
          deletedToast(t('Appointment deleted'), res.trashId);
        } catch (err) {
          errorToast(err);
        }
      }
    })
  );
}

function editablePayload(e) {
  return {
    courseId: e.courseId,
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
