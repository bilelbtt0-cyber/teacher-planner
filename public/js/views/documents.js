import { api, qs } from '../api.js';
import { t, tn, fmtDate, fmtMonthYear, fmtShort, fmtTime, fileSize, hoursLabel } from '../i18n.js';
import { state, subscribe, activeCategories, categoryById, changed } from '../store.js';
import { esc, icon, on, emptyState, openModal, confirmDialog, toast, errorToast, setBusy, debounce } from '../ui.js';
import { openScanner, DOC_TYPES, docTypeLabel } from '../scanner.js';
import { openEventDetails } from '../eventForm.js';

export async function render(root, params) {
  const filters = { q: params.q || '', type: '', categoryId: '', year: '', sort: 'date' };
  let docs = [];

  root.innerHTML = `
    <div class="hero" style="margin-bottom:16px">
      <div style="flex:1;min-width:0"><h2>${esc(t('My documents'))}</h2>
        <p>${esc(t('All your attestations and papers, named and searchable.'))}</p></div>
      <button class="btn" data-upload>${icon('upload')}${esc(t('Upload'))}</button>
      <button class="btn primary" data-scan>${icon('scan')}${esc(t('Scan a document'))}</button>
    </div>
    <div class="doc-toolbar">
      <div class="input-icon">${icon('search')}<input class="input" data-q placeholder="${esc(t('Search by name, institution, tag, note…'))}" value="${esc(filters.q)}"></div>
      <select class="select" data-f="type"><option value="">${esc(t('All types'))}</option>${DOC_TYPES.map((d) => `<option value="${d.value}">${esc(t(d.label))}</option>`).join('')}</select>
      <select class="select" data-f="categoryId"><option value="">${esc(t('All institutions'))}</option>${activeCategories().map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select>
      <select class="select" data-f="year"><option value="">${esc(t('All years'))}</option></select>
      <select class="select" data-f="sort"><option value="date">${esc(t('Sort: document date'))}</option><option value="added">${esc(t('Sort: recently added'))}</option><option value="name">${esc(t('Sort: name'))}</option></select>
    </div>
    <div data-list></div>`;
  const list = root.querySelector('[data-list]');

  async function load() {
    const year = filters.year;
    try {
      docs = await api.get(
        `/api/documents${qs({ q: filters.q, type: filters.type, categoryId: filters.categoryId, sort: filters.sort, from: year ? `${year}-01-01` : '', to: year ? `${year}-12-31` : '' })}`
      );
      draw();
    } catch (err) {
      list.innerHTML = emptyState({ iconName: 'alertCircle', title: t('Could not load documents.'), text: esc(t(err.message)) });
    }
  }

  async function fillYears() {
    try {
      const all = await api.get('/api/documents');
      const years = [...new Set(all.map((d) => (d.docDate || d.createdAt).slice(0, 4)))].sort().reverse();
      const sel = root.querySelector('[data-f="year"]');
      sel.innerHTML = `<option value="">${esc(t('All years'))}</option>${years.map((y) => `<option ${y === filters.year ? 'selected' : ''}>${y}</option>`).join('')}`;
    } catch {
      /* not critical */
    }
  }

  function cardHtml(d) {
    return `<div class="doc-card" data-doc="${d.id}" tabindex="0">
      <div class="doc-thumb">${d.hasThumb ? `<img src="/api/documents/${d.id}/thumb?v=${encodeURIComponent(d.updatedAt)}" alt="" loading="lazy">` : icon('fileText', 'xl')}
        <span class="chip type-tag ${d.docType === 'attestation' ? 'primary' : ''}">${esc(docTypeLabel(d.docType))}</span>
        ${d.pages > 1 ? `<span class="pages">${esc(tn(d.pages, '{n} page', '{n} pages'))}</span>` : ''}</div>
      <div class="doc-info"><div class="title" title="${esc(d.title)}">${esc(d.title)}</div>
        <div class="meta">${d.categoryColor ? `<span class="cat-dot" style="background:${d.categoryColor}"></span>` : ''}
          <span class="ellipsis">${esc(d.docDate ? fmtDate(d.docDate) : fmtDate(d.createdAt.slice(0, 10)))}${d.categoryName ? ` · ${esc(d.categoryName)}` : ''}</span></div>
        ${d.courseTitle ? `<div class="meta">${icon('book', 'sm')} <span class="ellipsis">${esc(d.courseTitle)}</span></div>` : ''}
        ${d.events.length || d.hours ? `<div class="meta">${d.events.length ? `${icon('link', 'sm')} ${esc(tn(d.events.length, '{n} session', '{n} sessions'))}` : ''}${d.hours ? ` · ${esc(hoursLabel(d.hours))}` : ''}</div>` : ''}
      </div></div>`;
  }

  function draw() {
    if (!docs.length) {
      const filtered = filters.q || filters.type || filters.categoryId || filters.year;
      list.innerHTML = filtered
        ? emptyState({ iconName: 'search', title: t('No document matches'), text: esc(t('Try other words or remove a filter.')) })
        : emptyState({
            iconName: 'scan',
            title: t('No documents yet'),
            text: esc(t('Scan your first attestation with your phone or computer camera, or drop a PDF anywhere on this page.')),
            action: `<button class="btn primary" data-scan>${icon('scan')}${esc(t('Scan a document'))}</button>`,
          });
      return;
    }
    if (filters.sort === 'name') {
      list.innerHTML = `<div class="doc-grid">${docs.map(cardHtml).join('')}</div>`;
      return;
    }
    const groups = new Map();
    for (const d of docs) {
      const key = (filters.sort === 'added' ? d.createdAt : d.docDate || d.createdAt).slice(0, 7);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(d);
    }
    list.innerHTML =
      `<p class="small muted" style="margin-bottom:6px">${esc(tn(docs.length, '{n} document', '{n} documents'))}</p>` +
      [...groups.entries()]
        .map(([k, items]) => `<div class="month-label">${esc(fmtMonthYear(`${k}-01T00:00`))}</div><div class="doc-grid">${items.map(cardHtml).join('')}</div>`)
        .join('');
  }

  const reload = debounce(load, 250);
  root.querySelector('[data-q]').addEventListener('input', (e) => {
    filters.q = e.target.value.trim();
    reload();
  });
  root.querySelectorAll('[data-f]').forEach((s) =>
    s.addEventListener('change', () => {
      filters[s.dataset.f] = s.value;
      load();
    })
  );
  on(root, 'click', '[data-scan]', () => openScanner({ mode: 'choose' }));
  on(root, 'click', '[data-upload]', () => openScanner({ mode: 'upload' }));
  on(root, 'click', '[data-doc]', (e, c) => openDocument(Number(c.dataset.doc)));
  on(root, 'keydown', '[data-doc]', (e, c) => e.key === 'Enter' && openDocument(Number(c.dataset.doc)));

  // Drop files anywhere on the page to start a new document.
  let overlay = null;
  let depth = 0;
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  const onEnter = (e) => {
    if (!hasFiles(e) || document.querySelector('.modal-backdrop')) return;
    e.preventDefault();
    depth++;
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.className = 'page-drop-overlay';
      overlay.textContent = t('Drop to add a document');
      document.body.appendChild(overlay);
    }
  };
  const onOver = (e) => hasFiles(e) && !document.querySelector('.modal-backdrop') && e.preventDefault();
  const onLeave = () => {
    depth = Math.max(0, depth - 1);
    if (!depth) {
      overlay?.remove();
      overlay = null;
    }
  };
  const onDrop = (e) => {
    if (!overlay) return;
    e.preventDefault();
    depth = 0;
    overlay.remove();
    overlay = null;
    const files = [...e.dataTransfer.files];
    if (files.length) openScanner({ mode: 'files', files });
  };
  window.addEventListener('dragenter', onEnter);
  window.addEventListener('dragover', onOver);
  window.addEventListener('dragleave', onLeave);
  window.addEventListener('drop', onDrop);

  const unsub = subscribe((what) => {
    if (what === 'data') {
      load();
      fillYears();
    }
  });
  await Promise.all([load(), fillYears()]);
  return () => {
    unsub();
    window.removeEventListener('dragenter', onEnter);
    window.removeEventListener('dragover', onOver);
    window.removeEventListener('dragleave', onLeave);
    window.removeEventListener('drop', onDrop);
    overlay?.remove();
  };
}

/** Document viewer + editor. Exported so search results can open it too. */
export async function openDocument(id) {
  let d;
  try {
    d = await api.get(`/api/documents/${id}`);
  } catch (err) {
    return errorToast(err);
  }
  const isPdf = d.mime === 'application/pdf';
  const fileUrl = `/api/documents/${d.id}/file?v=${encodeURIComponent(d.updatedAt)}`;
  let dirty = false;
  const m = openModal({
    title: d.title,
    size: 'xl',
    content: `<div class="doc-detail">
        <div>${
          isPdf
            ? `<iframe class="preview-frame" src="${fileUrl}" title="${esc(d.title)}"></iframe>`
            : d.mime.startsWith('image/')
              ? `<img class="preview-img" src="${fileUrl}" alt="${esc(d.title)}">`
              : `<div class="empty">${icon('fileText', 'xl')}<p>${esc(t('This file opens in its own application (Word, PowerPoint…).'))}</p></div>`
        }</div>
        <form class="stack" novalidate>
          <div class="field"><label>${esc(t('Name'))}</label><input class="input" name="title" value="${esc(d.title)}" maxlength="200"></div>
          <div class="grid-2">
            <div class="field"><label>${esc(t('Type'))}</label><select class="select" name="docType">${DOC_TYPES.map((x) => `<option value="${x.value}" ${x.value === d.docType ? 'selected' : ''}>${esc(t(x.label))}</option>`).join('')}</select></div>
            <div class="field"><label>${esc(t('Document date'))}</label><input class="input" type="date" name="docDate" value="${esc(d.docDate || '')}"></div>
          </div>
          <div class="field"><label>${esc(t('Institution'))}</label><select class="select" name="categoryId"><option value="">${esc(t('— None —'))}</option>
            ${state.categories.map((c) => `<option value="${c.id}" ${c.id === d.categoryId ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></div>
          <div class="grid-3">
            <div class="field"><label>${esc(t('Period from'))}</label><input class="input" type="date" name="periodFrom" value="${esc(d.periodFrom || '')}"></div>
            <div class="field"><label>${esc(t('to'))}</label><input class="input" type="date" name="periodTo" value="${esc(d.periodTo || '')}"></div>
            <div class="field"><label>${esc(t('Hours'))}</label><input class="input" type="number" min="0" step="0.25" name="hours" value="${d.hours ?? ''}"></div>
          </div>
          <div class="field"><label>${esc(t('Tags'))}</label><input class="input" name="tags" value="${esc(d.tags.join(', '))}"></div>
          <div class="field"><label>${esc(t('Notes'))}</label><textarea class="textarea" name="notes" rows="2">${esc(d.notes)}</textarea></div>
          <div data-ocr></div>
          ${
            d.events.length
              ? `<div class="stack tight"><span class="label">${esc(t('Linked sessions'))}</span>${d.events
                  .map(
                    (e) => `<button type="button" class="doc-mini" data-open-event="${e.id}" style="border:0;cursor:pointer;text-align:left">
                    <span class="ic" style="color:var(--primary-text)">${icon('calendar')}</span>
                    <span style="flex:1;min-width:0"><div class="strong ellipsis">${esc(e.title)}</div><div class="small muted">${esc(fmtShort(e.start))} · ${fmtTime(e.start)}</div></span>
                    ${e.attestationStatus === 'received' ? `<span class="chip success">${icon('check')}</span>` : ''}</button>`
                  )
                  .join('')}</div>`
              : ''
          }
          ${d.courseTitle ? `<div class="tip">${icon('book')}<span>${esc(t('File of the course “{name}”.', { name: d.courseTitle }))} <a href="#/courses" data-close>${esc(t('My courses'))}</a></span></div>` : ''}
          <p class="small muted">${esc(isPdf ? 'PDF' : d.mime.startsWith('image/') ? d.mime.replace('image/', '').toUpperCase() : (d.originalName.split('.').pop() || '').toUpperCase())} · ${esc(fileSize(d.size))} · ${esc(t('added {d}', { d: fmtDate(d.createdAt.slice(0, 10)) }))}</p>
        </form>
      </div>`,
    footer: `<button class="btn ghost" data-delete style="color:var(--danger-text)">${icon('trash', 'sm')}${esc(t('Delete'))}</button>
      <button class="btn ghost" data-replace>${icon('refresh', 'sm')}${esc(t('Replace file'))}</button>
      <span class="spacer"></span>
      <a class="btn" href="/api/documents/${d.id}/file?download=1">${icon('download', 'sm')}${esc(t('Download'))}</a>
      <a class="btn" href="${fileUrl}" target="_blank" rel="noopener">${icon('printer', 'sm')}${esc(t('Open / print'))}</a>
      <button class="btn primary" data-save disabled>${icon('check', 'sm')}${esc(t('Save'))}</button>`,
    onClose: async () => {
      if (!dirty) return true;
      return confirmDialog({ title: t('Discard changes?'), message: t('You have unsaved changes. They will be lost.'), confirm: t('Discard'), danger: true });
    },
  });
  const form = m.root.querySelector('form');
  const saveBtn = m.root.querySelector('[data-save]');
  const { canReadText, extractText, saveText } = await import('../ocr.js');
  let ocrText = d.ocrText || '';
  function drawOcr() {
    const box = m.root.querySelector('[data-ocr]');
    if (ocrText) {
      box.innerHTML = `<details class="ocr-box"><summary>${icon('fileText', 'sm')} ${esc(t('Text of the document'))}</summary>
        <div class="ocr-text">${esc(ocrText)}</div>
        <div class="flex wrap"><button type="button" class="btn sm" data-copy-text>${icon('copy', 'sm')}${esc(t('Copy the text'))}</button>
        <span class="small muted">${esc(t('Read automatically: there may be a few mistakes.'))}</span></div></details>`;
    } else if (canReadText(d.mime)) {
      box.innerHTML = `<div class="flex wrap"><button type="button" class="btn sm" data-read-text>${icon('fileText', 'sm')}${esc(t('Read the text of the document'))}</button>
        <span class="small muted">${esc(t('So you can find it by the words it contains.'))}</span></div>`;
    } else box.innerHTML = '';
  }
  drawOcr();
  on(form, 'click', '[data-copy-text]', async () => {
    try {
      await navigator.clipboard.writeText(ocrText);
      toast(t('Text copied'), { type: 'success' });
    } catch {
      toast(t('Copying is not allowed by this browser.'), { type: 'error' });
    }
  });
  on(form, 'click', '[data-read-text]', async (e, b) => {
    setBusy(b, true);
    b.insertAdjacentHTML('afterend', `<span class="small muted" data-reading>${esc(t('Reading… this can take a little while.'))}</span>`);
    try {
      const text = await extractText(d);
      if (!text.trim()) {
        toast(t('No text was found in this document.'));
        setBusy(b, false);
        form.querySelector('[data-reading]')?.remove();
        return;
      }
      await saveText(d.id, text);
      ocrText = text;
      changed();
      drawOcr();
      toast(t('Text read: you can now find this document by the words it contains.'), { type: 'success' });
    } catch (err) {
      setBusy(b, false);
      form.querySelector('[data-reading]')?.remove();
      errorToast(err);
    }
  });
  form.addEventListener('input', () => {
    dirty = true;
    saveBtn.disabled = false;
  });
  form.addEventListener('change', () => {
    dirty = true;
    saveBtn.disabled = false;
  });
  on(form, 'click', '[data-open-event]', (e, b) => {
    m.close();
    openEventDetails(Number(b.dataset.openEvent));
  });
  saveBtn.addEventListener('click', async () => {
    const f = form.elements;
    if (!f.title.value.trim()) {
      f.title.classList.add('invalid');
      return f.title.focus();
    }
    const fd = new FormData();
    for (const k of ['title', 'docType', 'docDate', 'categoryId', 'periodFrom', 'periodTo', 'hours', 'tags', 'notes']) fd.append(k, f[k].value);
    setBusy(saveBtn, true);
    try {
      await api.upload(`/api/documents/${d.id}`, fd, 'PUT');
      dirty = false;
      changed();
      toast(t('Document updated'), { type: 'success' });
      m.close(true);
    } catch (err) {
      setBusy(saveBtn, false);
      errorToast(err);
    }
  });
  m.root.querySelector('[data-delete]').addEventListener('click', async () => {
    const ok = await confirmDialog({
      title: t('Delete this document?'),
      message: esc(t('The file will be removed permanently. Linked sessions keep their “received” status.')),
      confirm: t('Delete'),
      danger: true,
    });
    if (!ok) return;
    try {
      await api.del(`/api/documents/${d.id}`);
      dirty = false;
      changed();
      m.close(true);
      toast(t('Document deleted'));
    } catch (err) {
      errorToast(err);
    }
  });
  m.root.querySelector('[data-replace]').addEventListener('click', async () => {
    dirty = false;
    m.close(true);
    await openScanner({ mode: 'choose', document: d, events: d.events.map((e) => ({ ...e, attestation: { status: e.attestationStatus } })), markReceived: false });
  });
}
