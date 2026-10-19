import { api } from '../api.js';
import { t, tn, relativeDay, fmtShort } from '../i18n.js';
import { state, subscribe, activeCategories, categoryById, loadCourses, changed } from '../store.js';
import { esc, icon, on, emptyState, toast, errorToast, debounce } from '../ui.js';
import { openEventForm, kindLabel } from '../eventForm.js';
import { openCourseForm, openCourseSupport, courseMeta } from '../courses.js';

const ARCHIVED_KEY = 'planner.coursesArchived';

export async function render(root, params) {
  const filters = { q: params.q || '', categoryId: '', archived: false };
  try {
    filters.archived = localStorage.getItem(ARCHIVED_KEY) === '1';
  } catch {
    /* ignore */
  }

  root.innerHTML = `
    <div class="hero" style="margin-bottom:16px">
      <div style="flex:1;min-width:0"><h2>${esc(t('My courses'))}</h2>
        <p>${esc(t('Save each course once, with its summary and files. Then plan a session in two clicks.'))}</p></div>
      <button class="btn primary" data-new-course>${icon('plus')}${esc(t('New course'))}</button>
    </div>
    <div class="doc-toolbar course-toolbar">
      <div class="input-icon">${icon('search')}<input class="input" data-q placeholder="${esc(t('Search a course, a word in a summary…'))}" value="${esc(filters.q)}"></div>
      <select class="select" data-f="categoryId"><option value="">${esc(t('All institutions'))}</option>${activeCategories().map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select>
      <label class="switch small"><input type="checkbox" data-archived ${filters.archived ? 'checked' : ''}><span class="track"></span>${esc(t('Show archived'))}</label>
    </div>
    <div data-list></div>`;
  const list = root.querySelector('[data-list]');

  function matches(c) {
    if (!filters.archived && c.archived) return false;
    if (filters.categoryId && c.categoryId !== Number(filters.categoryId)) return false;
    if (!filters.q) return true;
    const q = filters.q.toLowerCase();
    return [c.title, c.location, c.summary, categoryById(c.categoryId)?.name].some((x) => (x || '').toLowerCase().includes(q));
  }

  function cardHtml(c) {
    const cat = categoryById(c.categoryId);
    const snippet = c.summary.trim().replace(/\s+/g, ' ');
    return `<div class="course-card ${c.archived ? 'archived' : ''}" style="--c:${cat?.color || 'var(--border-strong)'}">
      <div class="course-top">
        <span class="chip">${esc(kindLabel(c.kind))}</span>
        ${c.archived ? `<span class="chip muted">${esc(t('Archived'))}</span>` : ''}
        <span class="spacer"></span>
        <button class="btn ghost icon-only sm" data-edit="${c.id}" title="${esc(t('Edit'))}" aria-label="${esc(t('Edit'))}">${icon('edit', 'sm')}</button>
        <button class="btn ghost icon-only sm" data-archive="${c.id}" title="${esc(c.archived ? t('Restore') : t('Archive'))}" aria-label="${esc(c.archived ? t('Restore') : t('Archive'))}">${icon(c.archived ? 'undo' : 'inbox', 'sm')}</button>
      </div>
      <h3 class="course-title" data-support="${c.id}">${esc(c.title)}</h3>
      <div class="course-meta">${cat ? `<span class="cat-dot" style="background:${cat.color}"></span>` : ''}<span class="ellipsis">${esc(courseMeta(c))}</span></div>
      <p class="course-snippet ${snippet ? '' : 'muted'}" data-support="${c.id}">${esc(snippet ? (snippet.length > 170 ? `${snippet.slice(0, 170)}…` : snippet) : t('No summary yet'))}</p>
      <div class="course-facts">
        <span>${icon('folder', 'sm')} ${esc(tn(c.fileCount, '{n} file', '{n} files'))}</span>
        <span>${icon('calendar', 'sm')} ${esc(
          c.nextSession
            ? t('Next: {d}', { d: `${relativeDay(c.nextSession)} ${c.nextSession.slice(11, 16)}` })
            : c.lastSession
              ? t('Last: {d}', { d: fmtShort(c.lastSession) })
              : t('Not planned yet')
        )}</span>
      </div>
      <div class="course-actions">
        <button class="btn primary sm" data-plan="${c.id}">${icon('plus', 'sm')}${esc(t('Plan a session'))}</button>
        <button class="btn sm" data-support="${c.id}">${icon('book', 'sm')}${esc(t('Open the support'))}</button>
      </div>
    </div>`;
  }

  function draw() {
    const all = state.courses;
    const shown = all.filter(matches);
    if (!all.length) {
      list.innerHTML = emptyState({
        iconName: 'book',
        title: t('No course yet'),
        text: esc(t('Add the courses you teach: name, institution, room, usual duration, and the summary you want at hand during the lesson.')),
        action: `<button class="btn primary" data-new-course>${icon('plus')}${esc(t('Add my first course'))}</button>`,
      });
      return;
    }
    if (!shown.length) {
      list.innerHTML = emptyState({ iconName: 'search', title: t('No course matches'), text: esc(t('Try other words or remove a filter.')) });
      return;
    }
    list.innerHTML = `<p class="small muted" style="margin-bottom:10px">${esc(tn(shown.length, '{n} course', '{n} courses'))}</p>
      <div class="course-grid">${shown.map(cardHtml).join('')}</div>`;
  }

  const byId = (id) => state.courses.find((c) => c.id === Number(id));
  on(root, 'click', '[data-new-course]', () => openCourseForm());
  on(root, 'click', '[data-edit]', (e, b) => openCourseForm(byId(b.dataset.edit)));
  on(root, 'click', '[data-support]', (e, b) => openCourseSupport(Number(b.dataset.support)));
  on(root, 'click', '[data-plan]', (e, b) => openEventForm({ course: byId(b.dataset.plan) }));
  on(root, 'click', '[data-archive]', async (e, b) => {
    const c = byId(b.dataset.archive);
    try {
      await api.put(`/api/courses/${c.id}`, { ...c, archived: !c.archived });
      await loadCourses();
      changed();
      toast(c.archived ? t('Course restored') : t('Course archived. You can find it with “Show archived”.'));
    } catch (err) {
      errorToast(err);
    }
  });
  const redraw = debounce(draw, 150);
  root.querySelector('[data-q]').addEventListener('input', (e) => {
    filters.q = e.target.value.trim();
    redraw();
  });
  root.querySelector('[data-f="categoryId"]').addEventListener('change', (e) => {
    filters.categoryId = e.target.value;
    draw();
  });
  root.querySelector('[data-archived]').addEventListener('change', (e) => {
    filters.archived = e.target.checked;
    try {
      localStorage.setItem(ARCHIVED_KEY, filters.archived ? '1' : '0');
    } catch {
      /* ignore */
    }
    draw();
  });

  const unsub = subscribe((what) => {
    if (what === 'courses' || what === 'categories') draw();
    // Sessions planned or moved change the "next session" of each course.
    if (what === 'data') loadCourses().catch(() => {});
  });
  try {
    await loadCourses();
  } catch (err) {
    errorToast(err);
  }
  draw();
  return unsub;
}
