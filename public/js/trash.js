import { api } from './api.js';
import { t, tn } from './i18n.js';
import { loadCourses, changed } from './store.js';
import { esc, icon, on, toast, errorToast, setBusy, confirmDialog, openModal, emptyState } from './ui.js';

// Deleted appointments, documents and courses wait 30 days in the trash before being removed for good.

async function restore(id) {
  await api.post(`/api/trash/${id}/restore`);
  await loadCourses();
  changed();
}

/** "Appointment deleted · Undo". */
export function deletedToast(message, trashId) {
  if (!trashId) return toast(message);
  toast(message, {
    action: t('Undo'),
    onAction: async () => {
      try {
        await restore(trashId);
        toast(t('Restored'), { type: 'success' });
      } catch (err) {
        errorToast(err);
      }
    },
  });
}

const KIND = {
  event: { icon: 'calendar', label: 'Appointment' },
  document: { icon: 'file', label: 'Document' },
  course: { icon: 'book', label: 'Course' },
};

function itemHtml(item, days) {
  const age = Math.floor((Date.now() - Date.parse(`${item.deletedAt.replace(' ', 'T')}Z`)) / 86400000);
  const left = Math.max(1, days - age);
  const kind = KIND[item.kind] || KIND.event;
  const extra = item.kind === 'course' && item.files ? ` · ${tn(item.files, '{n} file', '{n} files')}` : '';
  return `<div class="trash-item">
      <span class="trash-ic">${icon(kind.icon, 'sm')}</span>
      <div class="trash-text"><b class="ellipsis">${esc(item.title || t('Untitled'))}</b>
        <span class="small muted">${esc(t(kind.label))}${esc(extra)} · ${esc(age < 1 ? t('Deleted today') : tn(age, 'Deleted {n} day ago', 'Deleted {n} days ago'))} · ${esc(tn(left, '{n} day left', '{n} days left'))}</span></div>
      <button class="btn sm" data-restore="${item.id}">${icon('undo', 'sm')}${esc(t('Restore'))}</button>
      <button class="btn ghost sm icon-only" data-forget="${item.id}" aria-label="${esc(t('Delete permanently'))}" title="${esc(t('Delete permanently'))}">${icon('trash', 'sm')}</button>
    </div>`;
}

/** The trash window, opened from Settings → My data. */
export function openTrash(onChange) {
  const m = openModal({
    title: t('Trash'),
    content: `<p class="small muted" style="margin-bottom:12px"></p><div class="trash-list"></div>`,
    footer: `<button class="btn ghost danger-text" data-empty hidden>${icon('trash', 'sm')}${esc(t('Empty the trash'))}</button><span class="spacer"></span><button class="btn primary" data-close>${esc(t('Close'))}</button>`,
  });
  const list = m.root.querySelector('.trash-list');
  const intro = m.root.querySelector('.modal-body > p');
  const emptyBtn = m.root.querySelector('[data-empty]');
  async function load() {
    try {
      const { days, items } = await api.get('/api/trash');
      intro.textContent = t('Deleted appointments, documents and courses stay here for {n} days, then they are removed for good.', { n: days });
      emptyBtn.hidden = !items.length;
      list.innerHTML = items.length
        ? items.map((i) => itemHtml(i, days)).join('')
        : emptyState({ iconName: 'trash', title: t('The trash is empty'), text: t('Nothing deleted recently.') });
      onChange?.(items.length);
    } catch (err) {
      errorToast(err);
    }
  }
  on(m.root, 'click', '[data-restore]', async (e, b) => {
    setBusy(b, true);
    try {
      await restore(b.dataset.restore);
      toast(t('Restored'), { type: 'success' });
    } catch (err) {
      errorToast(err);
    }
    load();
  });
  on(m.root, 'click', '[data-forget]', async (e, b) => {
    const ok = await confirmDialog({ title: t('Delete permanently?'), message: esc(t('This cannot be undone.')), confirm: t('Delete'), danger: true });
    if (!ok) return;
    try {
      await api.del(`/api/trash/${b.dataset.forget}`);
    } catch (err) {
      errorToast(err);
    }
    load();
  });
  emptyBtn.addEventListener('click', async () => {
    const ok = await confirmDialog({ title: t('Empty the trash?'), message: esc(t('Everything in the trash will be deleted permanently. This cannot be undone.')), confirm: t('Empty the trash'), danger: true });
    if (!ok) return;
    try {
      await api.del('/api/trash');
    } catch (err) {
      errorToast(err);
    }
    load();
  });
  load();
}
