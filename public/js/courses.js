import { api } from './api.js';
import { t, tn, durationLabel, fileSize } from './i18n.js';
import { categoryById, activeCategories, loadCourses, changed } from './store.js';
import { esc, icon, on, openModal, confirmDialog, toast, errorToast, setBusy } from './ui.js';
import { KINDS, openCategoryForm } from './eventForm.js';

// A course is saved once with its usual details, its summary and its files. Planning a session
// from it fills in the whole form, and its support opens in one click during the lesson.

export const DURATIONS = [45, 60, 90, 120, 180, 240];
export const FILE_ACCEPT = '.pdf,.jpg,.jpeg,.png,.webp,.doc,.docx,.ppt,.pptx,.xls,.xlsx,.odt,.odp,.txt';
const MAX_MB = 15;
const FONT_KEY = 'planner.supportFont';

const isPdf = (f) => f.mime === 'application/pdf';
const isImage = (f) => f.mime.startsWith('image/');
const fileUrl = (f) => `/api/documents/${f.id}/file`;

export function fileIcon(f) {
  if (isImage(f)) return 'image';
  return 'fileText';
}

/** Saves files to a course, one after the other. Returns how many were saved. */
export async function uploadCourseFiles(course, files) {
  let saved = 0;
  for (const file of files) {
    if (file.size > MAX_MB * 1024 * 1024) {
      toast(t('“{name}” is larger than 15 MB.', { name: file.name }), { type: 'error' });
      continue;
    }
    const fd = new FormData();
    fd.append('file', file, file.name);
    fd.append('title', file.name.replace(/\.[a-z0-9]+$/i, '').replace(/[_]+/g, ' ').trim() || course.title);
    fd.append('docType', 'support');
    fd.append('courseId', String(course.id));
    if (course.categoryId) fd.append('categoryId', String(course.categoryId));
    try {
      const doc = await api.upload('/api/documents', fd);
      import('./ocr.js').then(({ readTextLater }) => readTextLater(doc, { quiet: true }));
      saved++;
    } catch (err) {
      toast(`${file.name}: ${t(err.message)}`, { type: 'error' });
    }
  }
  return saved;
}

// ---------- Course editor ----------

/**
 * existing: the course to edit, or null for a new one. prefill: values for a new course.
 * Resolves with the saved course, or null.
 */
export async function openCourseForm(existing = null, prefill = {}) {
  // The library lists courses without their files: load the full course before editing it.
  if (existing && !existing.files) {
    try {
      existing = await api.get(`/api/courses/${existing.id}`);
    } catch (err) {
      errorToast(err);
      return null;
    }
  }
  return new Promise((resolve) => {
    let course = existing ? structuredClone(existing) : null;
    const v = {
      title: existing?.title ?? prefill.title ?? '',
      kind: existing?.kind ?? prefill.kind ?? 'class',
      categoryId: existing?.categoryId ?? prefill.categoryId ?? null,
      location: existing?.location ?? prefill.location ?? '',
      durationMinutes: existing?.durationMinutes ?? prefill.durationMinutes ?? 60,
      summary: existing?.summary ?? '',
    };
    let files = existing?.files || [];
    let dirty = false;
    let result = null;

    const m = openModal({
      title: existing ? t('Edit course') : t('New course'),
      size: 'lg',
      content: `<form class="stack" novalidate autocomplete="off"></form>
        <input type="file" data-file-input accept="${FILE_ACCEPT}" multiple hidden>`,
      footer: `${existing ? `<button class="btn ghost" data-delete style="color:var(--danger-text)">${icon('trash', 'sm')}${esc(t('Delete'))}</button>` : ''}
        <span class="spacer"></span>
        <button class="btn" data-close>${esc(t('Cancel'))}</button>
        <button class="btn primary" data-save>${icon('check')}${esc(t('Save'))}</button>`,
      onClose: async () => {
        if (!dirty) {
          resolve(result);
          return true;
        }
        const ok = await confirmDialog({
          title: t('Discard changes?'),
          message: t('You have unsaved changes. They will be lost.'),
          confirm: t('Discard'),
          danger: true,
        });
        if (ok) resolve(result);
        return ok;
      },
    });
    const form = m.root.querySelector('form');
    const fileInput = m.root.querySelector('[data-file-input]');

    function catOptions() {
      return `<option value="">${esc(t('— None —'))}</option>${activeCategories()
        .map((c) => `<option value="${c.id}" ${c.id === v.categoryId ? 'selected' : ''}>${esc(c.name)}</option>`)
        .join('')}
        ${v.categoryId && categoryById(v.categoryId)?.archived ? `<option value="${v.categoryId}" selected>${esc(categoryById(v.categoryId).name)}</option>` : ''}
        <option value="__new">＋ ${esc(t('New institution…'))}</option>`;
    }

    function filesHtml() {
      return `<div class="course-files">${files
        .map(
          (f) => `<div class="course-file">
            <span class="ic">${f.hasThumb ? `<img src="/api/documents/${f.id}/thumb" alt="">` : icon(fileIcon(f))}</span>
            <a class="name ellipsis" href="${fileUrl(f)}" target="_blank" rel="noopener" title="${esc(f.title)}">${esc(f.title)}</a>
            <span class="small muted nowrap">${esc(fileSize(f.size))}</span>
            <button type="button" class="btn ghost icon-only sm" data-del-file="${f.id}" title="${esc(t('Remove'))}" aria-label="${esc(t('Remove'))}">${icon('trash', 'sm')}</button>
          </div>`
        )
        .join('')}</div>`;
    }

    function render() {
      form.innerHTML = `
        <input class="input title-input" name="title" value="${esc(v.title)}" placeholder="${esc(t('Course name, e.g. Maths — 3rd year A'))}" maxlength="200" autofocus required>
        <div class="field-error-title error-text" hidden></div>
        <div class="segmented" role="radiogroup" aria-label="${esc(t('Type'))}">
          ${KINDS.map((k) => `<button type="button" data-kind="${k.value}" class="${v.kind === k.value ? 'active' : ''}">${esc(t(k.label))}</button>`).join('')}
        </div>
        <div class="grid-2">
          <div class="field"><label>${icon('building', 'sm')} ${esc(t('Institution'))}</label>
            <select class="select" name="categoryId">${catOptions()}</select></div>
          <div class="field"><label>${icon('pin', 'sm')} ${esc(t('Location / room'))}</label>
            <input class="input" name="location" value="${esc(v.location)}" placeholder="${esc(t('e.g. Room 12'))}" maxlength="200"></div>
        </div>
        <div class="field"><span class="label">${icon('clock', 'sm')} ${esc(t('Usual duration'))}</span>
          <div class="flex wrap">
            <div class="duration-chips">${DURATIONS.map((d) => `<button type="button" class="pill ${v.durationMinutes === d ? 'active' : ''}" data-dur="${d}">${esc(durationLabel(d))}</button>`).join('')}</div>
            <span class="flex gap-sm"><input class="input" name="durationMinutes" type="number" min="5" max="1440" step="5" value="${v.durationMinutes}" style="width:90px"><span class="muted small">${esc(t('minutes'))}</span></span>
          </div></div>
        <div class="form-section field">
          <label for="c-summary">${icon('fileText', 'sm')} ${esc(t('Summary of the lesson'))}</label>
          <textarea class="textarea" id="c-summary" name="summary" rows="9" placeholder="${esc(t('What you want at hand while teaching: outline, key points, examples, exercises…'))}">${esc(v.summary)}</textarea>
          <span class="hint">${esc(t('Shown in large print when you open the support during the session.'))}</span>
        </div>
        <div class="form-section stack tight">
          <span class="label">${icon('folder', 'sm')} ${esc(t('Files'))} ${files.length ? `<span class="badge primary">${files.length}</span>` : ''}</span>
          ${files.length ? filesHtml() : `<p class="small muted">${esc(t('Add your lesson files: PDF, photos, Word, PowerPoint or Excel.'))}</p>`}
          <div class="flex wrap">
            <button type="button" class="btn soft" data-add-files>${icon('upload', 'sm')}${esc(t('Add files'))}</button>
            <button type="button" class="btn ghost" data-scan-pages>${icon('camera', 'sm')}${esc(t('Scan paper pages'))}</button>
          </div>
        </div>`;
    }

    function readInputs() {
      const f = form.elements;
      v.title = f.title.value;
      v.location = f.location.value;
      v.summary = f.summary.value;
      v.durationMinutes = parseInt(f.durationMinutes.value, 10) || v.durationMinutes;
    }

    function readAndRender() {
      readInputs();
      render();
    }

    function payload() {
      return {
        title: v.title.trim(),
        kind: v.kind,
        categoryId: v.categoryId,
        location: v.location,
        durationMinutes: v.durationMinutes,
        summary: v.summary,
        archived: course?.archived || false,
      };
    }

    function validate() {
      readInputs();
      if (!v.title.trim()) {
        const err = form.querySelector('.field-error-title');
        err.textContent = t('Please give the course a name.');
        err.hidden = false;
        form.elements.title.classList.add('invalid');
        form.elements.title.focus();
        return false;
      }
      if (!(v.durationMinutes >= 5 && v.durationMinutes <= 1440)) {
        form.elements.durationMinutes.classList.add('invalid');
        form.elements.durationMinutes.focus();
        toast(t('The duration must be between 5 minutes and 24 hours.'), { type: 'error' });
        return false;
      }
      return true;
    }

    async function persist() {
      course = course ? await api.put(`/api/courses/${course.id}`, payload()) : await api.post('/api/courses', payload());
      files = course.files;
      result = course;
      dirty = false;
      m.setTitle(t('Edit course'));
      await loadCourses();
      changed();
    }

    /** Files need the course to exist: a new course is saved first, quietly. */
    async function ensureSaved() {
      if (course) return true;
      if (!validate()) return false;
      try {
        await persist();
        return true;
      } catch (err) {
        errorToast(err);
        return false;
      }
    }

    async function refreshFiles() {
      try {
        course = await api.get(`/api/courses/${course.id}`);
        files = course.files;
        result = course;
        await loadCourses();
        changed();
      } catch (err) {
        errorToast(err);
      }
      readAndRender();
    }

    form.addEventListener('input', (e) => {
      dirty = true;
      if (e.target.name === 'title') form.querySelector('.field-error-title').hidden = true;
      if (e.target.name === 'durationMinutes') {
        const d = parseInt(e.target.value, 10);
        form.querySelectorAll('[data-dur]').forEach((b) => b.classList.toggle('active', Number(b.dataset.dur) === d));
      }
    });
    form.addEventListener('change', async (e) => {
      if (e.target.name !== 'categoryId') return;
      dirty = true;
      readInputs();
      if (e.target.value === '__new') {
        const cat = await openCategoryForm();
        v.categoryId = cat ? cat.id : v.categoryId;
      } else v.categoryId = e.target.value ? Number(e.target.value) : null;
      render();
    });
    form.addEventListener('submit', (e) => (e.preventDefault(), save()));
    on(form, 'click', '[data-kind]', (e, b) => {
      readInputs();
      v.kind = b.dataset.kind;
      dirty = true;
      render();
    });
    on(form, 'click', '[data-dur]', (e, b) => {
      readInputs();
      v.durationMinutes = Number(b.dataset.dur);
      dirty = true;
      render();
    });
    on(form, 'click', '[data-add-files]', async () => {
      if (await ensureSaved()) fileInput.click();
    });
    fileInput.addEventListener('change', async () => {
      const list = [...fileInput.files];
      fileInput.value = '';
      if (!list.length) return;
      readInputs();
      const btn = form.querySelector('[data-add-files]');
      setBusy(btn, true);
      const n = await uploadCourseFiles(course, list);
      if (n) toast(tn(n, '{n} file added', '{n} files added'), { type: 'success' });
      await refreshFiles();
    });
    on(form, 'click', '[data-scan-pages]', async () => {
      if (!(await ensureSaved())) return;
      readInputs();
      const { openScanner } = await import('./scanner.js');
      const doc = await openScanner({ mode: 'choose', course });
      if (doc) await refreshFiles();
    });
    on(form, 'click', '[data-del-file]', async (e, b) => {
      const f = files.find((x) => x.id === Number(b.dataset.delFile));
      const ok = await confirmDialog({
        title: t('Remove “{name}”?', { name: f.title }),
        message: esc(t('The file will be deleted permanently.')),
        confirm: t('Remove'),
        danger: true,
      });
      if (!ok) return;
      readInputs();
      try {
        await api.del(`/api/documents/${f.id}`);
        await refreshFiles();
      } catch (err) {
        errorToast(err);
      }
    });

    async function save() {
      if (!validate()) return;
      const btn = m.root.querySelector('[data-save]');
      setBusy(btn, true);
      try {
        const isNew = !existing && !result;
        await persist();
        toast(isNew ? t('Course saved in My courses') : t('Changes saved'), { type: 'success' });
        m.close(true);
      } catch (err) {
        setBusy(btn, false);
        errorToast(err);
      }
    }
    m.root.querySelector('[data-save]').addEventListener('click', save);
    m.root.querySelector('[data-delete]')?.addEventListener('click', async () => {
      const ok = await confirmDialog({
        title: t('Delete “{name}”?', { name: existing.title }),
        message:
          esc(t('The course, its summary and its files will be deleted.')) +
          (existing.sessionCount ? `<br><br>${esc(tn(existing.sessionCount, 'Its {n} session stays in your calendar.', 'Its {n} sessions stay in your calendar.'))}` : '') +
          `<br><br>${esc(t('Tip: archive it instead to keep it out of the way.'))}`,
        confirm: t('Delete'),
        danger: true,
      });
      if (!ok) return;
      try {
        await api.del(`/api/courses/${existing.id}`);
        await loadCourses();
        changed();
        dirty = false;
        result = null;
        m.close(true);
        toast(t('Course deleted'));
      } catch (err) {
        errorToast(err);
      }
    });
    m.root.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        save();
      }
    });
    render();
  });
}

// ---------- Lesson support viewer ----------

function readFont() {
  try {
    return Math.min(32, Math.max(14, Number(localStorage.getItem(FONT_KEY)) || 19));
  } catch {
    return 19;
  }
}

/** Opens a course's summary and files, readable at a glance during the lesson. */
export async function openCourseSupport(courseId) {
  let course;
  try {
    course = await api.get(`/api/courses/${courseId}`);
  } catch (err) {
    errorToast(err);
    return;
  }
  let tab = course.summary.trim() ? 'summary' : course.files[0] ? `file:${course.files[0].id}` : 'summary';
  let font = readFont();
  const cat = categoryById(course.categoryId);

  const m = openModal({
    title: course.title,
    size: 'xl',
    headerExtra: `<button class="btn ghost sm" data-fullscreen title="${esc(t('Full screen'))}">${icon('maximize', 'sm')}<span class="hide-sm">${esc(t('Full screen'))}</span></button>`,
    content: `<div class="support-view"><nav class="support-tabs" data-tabs></nav><div class="support-stage" data-stage></div></div>`,
    footer: `<span class="small muted">${cat ? `<span class="cat-dot" style="background:${cat.color}"></span> ${esc(cat.name)}` : ''}</span>
      <span class="spacer"></span>
      <button class="btn" data-edit>${icon('edit', 'sm')}${esc(t('Edit the course'))}</button>
      <button class="btn primary" data-close>${esc(t('Close'))}</button>`,
  });
  m.root.classList.add('support-modal');

  function drawTabs() {
    m.root.querySelector('[data-tabs]').innerHTML = [
      `<button class="${tab === 'summary' ? 'active' : ''}" data-tab="summary">${icon('fileText', 'sm')}<span class="ellipsis">${esc(t('Summary'))}</span></button>`,
      ...course.files.map(
        (f) => `<button class="${tab === `file:${f.id}` ? 'active' : ''}" data-tab="file:${f.id}" title="${esc(f.title)}">${icon(fileIcon(f), 'sm')}<span class="ellipsis">${esc(f.title)}</span></button>`
      ),
    ].join('');
  }

  function drawStage() {
    const stage = m.root.querySelector('[data-stage]');
    if (tab === 'summary') {
      stage.innerHTML = course.summary.trim()
        ? `<div class="support-tools"><button class="btn ghost sm" data-font="-2" aria-label="${esc(t('Smaller text'))}">A−</button><button class="btn ghost sm" data-font="2" aria-label="${esc(t('Larger text'))}">A+</button></div>
           <div class="support-text" style="font-size:${font}px">${esc(course.summary)}</div>`
        : `<div class="empty"><div class="icon-wrap">${icon('fileText', 'lg')}</div><h3>${esc(t('No summary yet'))}</h3>
           <p>${esc(t('Write the key points of this lesson so they are at hand while you teach.'))}</p>
           <button class="btn primary" data-edit>${icon('edit', 'sm')}${esc(t('Write the summary'))}</button></div>`;
      return;
    }
    const f = course.files.find((x) => `file:${x.id}` === tab);
    if (!f) return;
    const url = `${fileUrl(f)}?v=${encodeURIComponent(f.updatedAt)}`;
    const actions = `<div class="flex wrap support-file-actions"><a class="btn sm" href="${url}" target="_blank" rel="noopener">${icon('external', 'sm')}${esc(t('Open in a new tab'))}</a>
      <a class="btn ghost sm" href="${fileUrl(f)}?download=1">${icon('download', 'sm')}${esc(t('Download'))}</a></div>`;
    if (isPdf(f) || f.mime === 'text/plain') stage.innerHTML = `${actions}<iframe class="support-frame" src="${url}" title="${esc(f.title)}"></iframe>`;
    else if (isImage(f)) stage.innerHTML = `${actions}<img class="support-img" src="${url}" alt="${esc(f.title)}">`;
    else
      stage.innerHTML = `<div class="empty"><div class="icon-wrap">${icon('fileText', 'lg')}</div><h3>${esc(f.title)}</h3>
        <p>${esc(t('This file opens in its own application (Word, PowerPoint…).'))}</p>
        <div class="flex wrap" style="justify-content:center"><a class="btn primary" href="${url}" target="_blank" rel="noopener">${icon('external', 'sm')}${esc(t('Open'))}</a>
        <a class="btn" href="${fileUrl(f)}?download=1">${icon('download', 'sm')}${esc(t('Download'))}</a></div></div>`;
  }

  on(m.root, 'click', '[data-tab]', (e, b) => {
    tab = b.dataset.tab;
    drawTabs();
    drawStage();
  });
  on(m.root, 'click', '[data-font]', (e, b) => {
    font = Math.min(32, Math.max(14, font + Number(b.dataset.font)));
    try {
      localStorage.setItem(FONT_KEY, String(font));
    } catch {
      /* ignore */
    }
    m.root.querySelector('.support-text').style.fontSize = `${font}px`;
  });
  on(m.root, 'click', '[data-fullscreen]', () => {
    if (document.fullscreenElement) document.exitFullscreen?.();
    else m.root.requestFullscreen?.().catch(() => toast(t('Full screen is not available in this browser.'), { type: 'error' }));
  });
  on(m.root, 'click', '[data-edit]', async () => {
    if (document.fullscreenElement) await document.exitFullscreen?.().catch(() => {});
    m.close(true);
    const saved = await openCourseForm(course);
    if (saved) openCourseSupport(saved.id);
  });
  drawTabs();
  drawStage();
}

/** Short description of a course: institution · duration · room. */
export function courseMeta(c) {
  return [categoryById(c.categoryId)?.name, durationLabel(c.durationMinutes), c.location].filter(Boolean).join(' · ');
}
