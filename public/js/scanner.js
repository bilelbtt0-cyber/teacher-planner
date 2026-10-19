import { api } from './api.js';
import { t, tn, todayStr, nowWall, fmtShort, fmtTime, fmtMonthYear, minutesBetween, hoursLabel, fileSize } from './i18n.js';
import { state, categoryById, activeCategories, changed } from './store.js';
import { esc, icon, openModal, confirmDialog, toast, errorToast, setBusy, on } from './ui.js';
import { detectDocument, warpQuad, enhance, rotateCanvas, downscale, toDisplay, fromDisplay, FULL_QUAD } from './scanTools.js';

export const DOC_TYPES = [
  { value: 'attestation', label: 'Attestation' },
  { value: 'certificate', label: 'Certificate' },
  { value: 'contract', label: 'Contract' },
  { value: 'support', label: 'Course material' },
  { value: 'other', label: 'Other' },
];
export const docTypeLabel = (v) => t(DOC_TYPES.find((d) => d.value === v)?.label || 'Other');

let jsPdfPromise = null;
export function loadJsPdf() {
  if (window.jspdf) return Promise.resolve(window.jspdf.jsPDF);
  if (!jsPdfPromise) {
    jsPdfPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = '/vendor/jspdf/jspdf.umd.min.js';
      s.onload = () => resolve(window.jspdf.jsPDF);
      s.onerror = () => {
        jsPdfPromise = null;
        reject(new Error('Could not load the PDF tool.'));
      };
      document.head.appendChild(s);
    });
  }
  return jsPdfPromise;
}

// ---------- Image processing ----------

/** Draws a page (straightened, rotated, cleaned) to a new canvas no larger than maxDim. */
function renderPage(page, maxDim = 2000, { crop = true, filter = true } = {}) {
  let c = crop ? warpQuad(page.src, page.quad, maxDim) : downscale(page.src, maxDim);
  c = rotateCanvas(c, page.rotation);
  if (filter) enhance(c, page.filter);
  return c;
}

const canvasToBlob = (canvas, type = 'image/jpeg', q = 0.85) => new Promise((res) => canvas.toBlob(res, type, q));

async function loadImageFile(file) {
  try {
    return await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error(t('This image could not be read.')));
      img.src = URL.createObjectURL(file);
    });
  }
}

/** A new page: the sheet is found in the photo right away, so most of the time there is nothing to adjust. */
function newPage(src) {
  const quad = detectDocument(src);
  return { src, rotation: 0, filter: 'clean', quad: quad || FULL_QUAD.map((q) => ({ ...q })), detected: !!quad };
}
const PDF_TYPES = ['application/pdf'];
const IMG_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

// ---------- Scanner modal ----------

/**
 * opts.mode: 'choose' | 'camera' | 'upload' | 'files'
 * opts.files: File[] (for 'files'), opts.events: sessions to link, opts.markReceived: bool,
 * opts.document: an existing document whose file should be replaced,
 * opts.course: a course the scan belongs to (its summary pages or handouts).
 * Resolves with the saved document, or null.
 */
export function openScanner(opts = {}) {
  return new Promise((resolve) => {
    const replacing = opts.document || null;
    const course = opts.course || null;
    let step = 'capture';
    let pages = [];
    let pdfFile = null;
    let active = 0;
    let stream = null;
    let saved = null;
    let candidates = null; // sessions that can be linked
    const linked = new Set((opts.events || []).filter(Boolean).map((e) => e.id));
    const knownEvents = new Map((opts.events || []).filter(Boolean).map((e) => [e.id, e]));
    const firstEvent = (opts.events || []).filter(Boolean)[0];
    const meta = {
      title: replacing?.title || (course ? course.title : ''),
      docType: replacing?.docType || (course ? 'support' : 'attestation'),
      docDate: replacing?.docDate || todayStr(),
      categoryId: replacing?.categoryId ?? firstEvent?.categoryId ?? course?.categoryId ?? null,
      periodFrom: replacing?.periodFrom || '',
      periodTo: replacing?.periodTo || '',
      hours: replacing?.hours ?? '',
      tags: (replacing?.tags || []).join(', '),
      notes: replacing?.notes || '',
      markReceived: opts.markReceived !== false,
    };
    let titleTouched = !!replacing || !!course;

    const m = openModal({
      title: replacing ? t('Replace the file') : t('Scan or add a document'),
      size: 'xl',
      headerExtra: `<div class="scan-steps" data-steps></div>`,
      content: `<div data-stage></div>
        <input type="file" data-file-input accept="application/pdf,image/jpeg,image/png,image/webp" multiple hidden>
        <input type="file" data-camera-input accept="image/*" capture="environment" hidden>`,
      footer: `<div data-footer style="display:contents"></div>`,
      onClose: async () => {
        if (saved || (!pages.length && !pdfFile)) {
          stopCamera();
          resolve(saved);
          return true;
        }
        const ok = await confirmDialog({ title: t('Discard this scan?'), message: t('The pages you captured will be lost.'), confirm: t('Discard'), danger: true });
        if (ok) {
          stopCamera();
          resolve(null);
        }
        return ok;
      },
    });
    const stage = m.root.querySelector('[data-stage]');
    const footer = m.root.querySelector('[data-footer]');
    const fileInput = m.root.querySelector('[data-file-input]');
    const cameraInput = m.root.querySelector('[data-camera-input]');

    function drawSteps() {
      const steps = [
        ['capture', t('Capture')],
        ['adjust', t('Adjust')],
        ['details', t('Name & save')],
      ];
      const idx = steps.findIndex((s) => s[0] === step);
      m.root.querySelector('[data-steps]').innerHTML = steps
        .filter((s) => !(pdfFile && s[0] === 'adjust'))
        .map(([k, label], i, arr) => {
          const real = steps.findIndex((s) => s[0] === k);
          return `<span class="s ${k === step ? 'active' : real < idx ? 'done' : ''}"><span class="n">${real < idx ? '✓' : i + 1}</span><span class="hide-sm">${esc(label)}</span></span>${i < arr.length - 1 ? '<span class="sep"></span>' : ''}`;
        })
        .join('');
    }

    function go(next) {
      if (next !== 'camera') stopCamera();
      step = next === 'camera' ? 'capture' : next;
      drawSteps();
      if (next === 'capture') drawCapture();
      else if (next === 'camera') drawCamera();
      else if (next === 'adjust') drawAdjust();
      else if (next === 'details') drawDetails();
    }

    // ----- Step 1: capture -----
    function drawCapture() {
      stage.innerHTML = `
        ${course ? `<div class="tip" style="margin-bottom:16px">${icon('book')}<span>${esc(t('These pages will be added to the course “{name}”.', { name: course.title }))}</span></div>` : ''}
        ${firstEvent ? `<div class="tip" style="margin-bottom:16px">${icon('link')}<span>${esc(tn(linked.size, 'This document will be linked to {n} session.', 'This document will be linked to {n} sessions.'))}</span></div>` : ''}
        <div class="capture-options">
          <button class="capture-opt" data-opt="camera"><span class="ic">${icon('camera', 'lg')}</span><span><div class="t">${esc(t('Use the camera'))}</div><div class="d">${esc(t('Take a photo of each page'))}</div></span></button>
          <button class="capture-opt" data-opt="upload"><span class="ic">${icon('upload', 'lg')}</span><span><div class="t">${esc(t('Choose files'))}</div><div class="d">${esc(t('A PDF, or photos (JPG, PNG)'))}</div></span></button>
          <div class="capture-opt dropzone" data-drop><span class="ic">${icon('download', 'lg')}</span><span><div class="t">${esc(t('Drop files here'))}</div><div class="d">${esc(t('Drag from your computer'))}</div></span></div>
        </div>
        ${pages.length ? `<p class="small muted" style="margin-top:14px">${esc(tn(pages.length, '{n} page captured', '{n} pages captured'))}</p>` : ''}`;
      footer.innerHTML = `<span class="spacer"></span><button class="btn" data-close-btn>${esc(t('Cancel'))}</button>
        ${pages.length ? `<button class="btn primary" data-next="adjust">${esc(t('Continue'))}${icon('arrowR', 'sm')}</button>` : ''}`;
      const drop = stage.querySelector('[data-drop]');
      drop.addEventListener('click', () => fileInput.click());
      ['dragenter', 'dragover'].forEach((ev) =>
        drop.addEventListener(ev, (e) => {
          e.preventDefault();
          drop.classList.add('over');
        })
      );
      ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, () => drop.classList.remove('over')));
      drop.addEventListener('drop', (e) => {
        e.preventDefault();
        addFiles([...e.dataTransfer.files]);
      });
    }

    async function addFiles(files) {
      if (!files.length) return;
      const pdfs = files.filter((f) => PDF_TYPES.includes(f.type));
      const imgs = files.filter((f) => IMG_TYPES.includes(f.type));
      const other = files.length - pdfs.length - imgs.length;
      if (other) toast(t('Some files were skipped: only PDF, JPG, PNG or WebP are accepted.'), { type: 'error' });
      if (pdfs.length && (imgs.length || pages.length || pdfs.length > 1)) {
        return toast(t('Add either one PDF, or one or more photos — not both.'), { type: 'error' });
      }
      const tooBig = files.find((f) => f.size > 15 * 1024 * 1024);
      if (tooBig) return toast(t('This file is larger than 15 MB.'), { type: 'error' });
      if (pdfs.length) {
        pdfFile = pdfs[0];
        if (!titleTouched && !meta.title) meta.title = suggestTitle(pdfFile.name);
        return go('details');
      }
      stage.insertAdjacentHTML('beforeend', `<div class="flex" style="margin-top:12px"><span class="spinner sm"></span>${esc(t('Reading images…'))}</div>`);
      for (const f of imgs) {
        try {
          pages.push(newPage(await loadImageFile(f)));
        } catch (err) {
          errorToast(err);
        }
      }
      if (pages.length) {
        active = pages.length - 1;
        go('adjust');
      } else drawCapture();
    }

    fileInput.addEventListener('change', () => {
      addFiles([...fileInput.files]);
      fileInput.value = '';
    });
    cameraInput.addEventListener('change', () => {
      addFiles([...cameraInput.files]);
      cameraInput.value = '';
    });

    // ----- Camera -----
    async function drawCamera() {
      if (!navigator.mediaDevices?.getUserMedia) {
        // Without a secure connection the browser hides the camera API: fall back to the phone's camera app.
        cameraInput.click();
        return go(pages.length ? 'adjust' : 'capture');
      }
      stage.innerHTML = `<div class="camera-view"><video autoplay playsinline muted></video><div class="guide"></div><canvas class="cam-overlay"></canvas></div>
        <div class="camera-controls">
          <button class="btn" data-cam-done ${pages.length ? '' : 'disabled'}>${esc(t('Done'))} (${pages.length})</button>
          <button class="shutter" data-shutter aria-label="${esc(t('Take photo'))}"></button>
          <button class="btn ghost" data-cam-cancel>${esc(t('Cancel'))}</button>
        </div>
        <p class="small muted" style="text-align:center;margin-top:10px">${esc(t('Place the sheet on a darker surface, in good light. When its outline turns green, take the photo. One photo per page.'))}</p>`;
      footer.innerHTML = '';
      const video = stage.querySelector('video');
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' }, width: { ideal: 2560 }, height: { ideal: 1920 } },
          audio: false,
        });
        video.srcObject = stream;
        watchSheet(video, stage.querySelector('.cam-overlay'), stage.querySelector('.guide'));
      } catch (err) {
        stopCamera();
        toast(err.name === 'NotAllowedError' ? t('Camera access was refused. You can allow it in the browser settings, or choose files instead.') : t('No camera found. Choose files instead.'), { type: 'error' });
        return go(pages.length ? 'adjust' : 'capture');
      }
      stage.querySelector('[data-shutter]').addEventListener('click', () => {
        if (!video.videoWidth) return;
        const c = document.createElement('canvas');
        c.width = video.videoWidth;
        c.height = video.videoHeight;
        c.getContext('2d').drawImage(video, 0, 0);
        pages.push(newPage(c));
        active = pages.length - 1;
        const flash = document.createElement('div');
        flash.className = 'flash';
        stage.querySelector('.camera-view').appendChild(flash);
        setTimeout(() => flash.remove(), 300);
        const done = stage.querySelector('[data-cam-done]');
        done.disabled = false;
        done.textContent = `${t('Done')} (${pages.length})`;
      });
      stage.querySelector('[data-cam-done]').addEventListener('click', () => go('adjust'));
      stage.querySelector('[data-cam-cancel]').addEventListener('click', () => go(pages.length ? 'adjust' : 'capture'));
    }

    function stopCamera() {
      clearInterval(liveTimer);
      stream?.getTracks().forEach((tr) => tr.stop());
      stream = null;
    }

    // Outlines the sheet on the live picture, a few times per second.
    let liveTimer = null;
    function watchSheet(video, overlay, guide) {
      clearInterval(liveTimer);
      liveTimer = setInterval(() => {
        if (!video.videoWidth || !overlay.isConnected) return;
        const box = video.getBoundingClientRect();
        overlay.width = box.width;
        overlay.height = box.height;
        const ctx = overlay.getContext('2d');
        ctx.clearRect(0, 0, box.width, box.height);
        const q = detectDocument(video);
        const found = q && q.some((p) => p.x > 0.01 && p.x < 0.99);
        guide.hidden = !!found;
        if (!found) return;
        // The video is letterboxed inside its box (object-fit: contain).
        const s = Math.min(box.width / video.videoWidth, box.height / video.videoHeight);
        const w = video.videoWidth * s;
        const h = video.videoHeight * s;
        const ox = (box.width - w) / 2;
        const oy = (box.height - h) / 2;
        ctx.beginPath();
        q.forEach((p, i) => ctx[i ? 'lineTo' : 'moveTo'](ox + p.x * w, oy + p.y * h));
        ctx.closePath();
        ctx.fillStyle = 'rgba(48, 164, 108, 0.18)';
        ctx.fill();
        ctx.lineWidth = 3;
        ctx.strokeStyle = '#30a46c';
        ctx.stroke();
      }, 350);
    }

    // ----- Step 2: adjust -----
    function drawAdjust() {
      if (!pages.length) return go('capture');
      active = Math.min(active, pages.length - 1);
      const p = pages[active];
      stage.innerHTML = `
        <div class="editor">
          <div class="editor-stage"><div class="crop-wrap" data-crop-wrap></div></div>
          <div class="editor-tools">
            <div class="tool-group"><span class="label">${esc(t('Page {a} of {b}', { a: active + 1, b: pages.length }))}</span>
              <div class="flex gap-sm wrap">
                <button class="btn sm" data-rot="-90" title="${esc(t('Rotate left'))}">${icon('rotateL', 'sm')}</button>
                <button class="btn sm" data-rot="90" title="${esc(t('Rotate right'))}">${icon('rotateR', 'sm')}</button>
              </div></div>
            <div class="tool-group"><span class="label">${esc(t('Edges of the page'))}</span>
              <div class="flex gap-sm wrap">
                <button class="btn sm" data-quad="auto" title="${esc(t('Find the page automatically'))}">${icon('wand', 'sm')}${esc(t('Detect'))}</button>
                <button class="btn sm" data-quad="full" title="${esc(t('Keep the whole photo'))}">${icon('crop', 'sm')}${esc(t('Whole photo'))}</button>
              </div></div>
            <div class="tool-group"><span class="label">${esc(t('Look'))}</span>
              <div class="filter-opts">
                <button data-filter="clean" class="${p.filter === 'clean' ? 'active' : ''}" title="${esc(t('White paper without shadows, colours kept (stamps, signatures)'))}">${esc(t('Clean'))}</button>
                <button data-filter="bw" class="${p.filter === 'bw' ? 'active' : ''}">${esc(t('B&W'))}</button>
                <button data-filter="original" class="${p.filter === 'original' ? 'active' : ''}">${esc(t('Original'))}</button>
              </div></div>
            <div class="tool-group"><span class="label">${esc(t('Order'))}</span>
              <div class="flex gap-sm wrap">
                <button class="btn sm icon-only" data-move="-1" ${active === 0 ? 'disabled' : ''} title="${esc(t('Move left'))}">${icon('chevronL', 'sm')}</button>
                <button class="btn sm icon-only" data-move="1" ${active === pages.length - 1 ? 'disabled' : ''} title="${esc(t('Move right'))}">${icon('chevronR', 'sm')}</button>
                <button class="btn sm soft-danger" data-del-page>${icon('trash', 'sm')}${esc(t('Delete page'))}</button>
              </div></div>
            <div class="tool-group"><span class="label">${esc(t('Result'))}</span><img class="scan-result" data-result alt=""></div>
            <p class="small muted">${esc(p.detected ? t('The page was found automatically and will be straightened. Drag a corner if it is not quite right.') : t('Drag the four corners onto the corners of the page: it will be straightened.'))}</p>
          </div>
        </div>
        <div class="page-strip" style="margin-top:14px">
          ${pages.map((pg, i) => `<div class="page-thumb ${i === active ? 'active' : ''}" data-page="${i}"><img alt="" data-thumb="${i}"><span class="num">${i + 1}</span></div>`).join('')}
          <div class="page-thumb add" data-add-camera title="${esc(t('Add a page with the camera'))}">${icon('camera')}</div>
          <div class="page-thumb add" data-add-file title="${esc(t('Add pages from files'))}">${icon('plus')}</div>
        </div>`;
      footer.innerHTML = `<button class="btn ghost" data-back="capture">${icon('arrowL', 'sm')}${esc(t('Back'))}</button><span class="spacer"></span>
        <button class="btn primary" data-next="details">${esc(t('Continue'))}${icon('arrowR', 'sm')}</button>`;
      drawEditorCanvas();
      pages.forEach((pg, i) => {
        const c = renderPage(pg, 200);
        stage.querySelector(`[data-thumb="${i}"]`).src = c.toDataURL('image/jpeg', 0.7);
      });
    }

    function refreshResult() {
      const p = pages[active];
      const img = stage.querySelector('[data-result]');
      const out = renderPage(p, 700);
      if (img) img.src = out.toDataURL('image/jpeg', 0.8);
      const thumb = stage.querySelector(`[data-thumb="${active}"]`);
      if (thumb) thumb.src = renderPage(p, 200).toDataURL('image/jpeg', 0.7);
    }

    /** The photo with the four corners of the page, which she can drag (with a magnifier). */
    function drawEditorCanvas() {
      const p = pages[active];
      const wrap = stage.querySelector('[data-crop-wrap]');
      const canvas = renderPage(p, 1100, { crop: false, filter: false });
      wrap.innerHTML = '';
      wrap.appendChild(canvas);
      const svgNS = 'http://www.w3.org/2000/svg';
      const svg = document.createElementNS(svgNS, 'svg');
      svg.setAttribute('class', 'quad-svg');
      svg.setAttribute('viewBox', '0 0 100 100');
      svg.setAttribute('preserveAspectRatio', 'none');
      const shade = document.createElementNS(svgNS, 'path');
      shade.setAttribute('class', 'quad-shade');
      shade.setAttribute('fill-rule', 'evenodd');
      const line = document.createElementNS(svgNS, 'polygon');
      line.setAttribute('class', 'quad-line');
      svg.append(shade, line);
      wrap.appendChild(svg);
      const handles = p.quad.map((_, i) => {
        const h = document.createElement('span');
        h.className = 'quad-handle';
        h.dataset.corner = i;
        wrap.appendChild(h);
        return h;
      });
      const loupe = document.createElement('canvas');
      loupe.className = 'quad-loupe';
      loupe.width = loupe.height = 120;
      loupe.hidden = true;
      wrap.appendChild(loupe);

      const place = () => {
        const pts = p.quad.map((q) => toDisplay(q, p.rotation));
        const poly = pts.map((d) => `${d.x * 100},${d.y * 100}`).join(' ');
        line.setAttribute('points', poly);
        shade.setAttribute('d', `M0,0H100V100H0Z M${pts.map((d) => `${d.x * 100},${d.y * 100}`).join(' L')}Z`);
        pts.forEach((d, i) => {
          handles[i].style.left = `${d.x * 100}%`;
          handles[i].style.top = `${d.y * 100}%`;
        });
      };
      const showLoupe = (d) => {
        const z = 2.5;
        const cx = d.x * canvas.width;
        const cy = d.y * canvas.height;
        const scale = canvas.width / canvas.getBoundingClientRect().width;
        const r = loupe.width / 2 / z * scale;
        const lctx = loupe.getContext('2d');
        lctx.fillStyle = '#000';
        lctx.fillRect(0, 0, loupe.width, loupe.height);
        lctx.drawImage(canvas, cx - r, cy - r, 2 * r, 2 * r, 0, 0, loupe.width, loupe.height);
        lctx.strokeStyle = '#fff';
        lctx.lineWidth = 1.5;
        lctx.beginPath();
        lctx.moveTo(loupe.width / 2 - 10, loupe.height / 2);
        lctx.lineTo(loupe.width / 2 + 10, loupe.height / 2);
        lctx.moveTo(loupe.width / 2, loupe.height / 2 - 10);
        lctx.lineTo(loupe.width / 2, loupe.height / 2 + 10);
        lctx.stroke();
        // Shown on the other side of the finger, so it is never hidden by it.
        loupe.style.left = d.x < 0.5 ? 'auto' : '8px';
        loupe.style.right = d.x < 0.5 ? '8px' : 'auto';
        loupe.style.top = '8px';
        loupe.hidden = false;
      };
      place();
      let drag = null;
      wrap.addEventListener('pointerdown', (e) => {
        const h = e.target.closest('.quad-handle');
        if (!h) return;
        e.preventDefault();
        h.setPointerCapture(e.pointerId);
        drag = { i: Number(h.dataset.corner), rect: canvas.getBoundingClientRect() };
        h.classList.add('active');
      });
      wrap.addEventListener('pointermove', (e) => {
        if (!drag) return;
        const d = {
          x: Math.min(1, Math.max(0, (e.clientX - drag.rect.left) / drag.rect.width)),
          y: Math.min(1, Math.max(0, (e.clientY - drag.rect.top) / drag.rect.height)),
        };
        p.quad[drag.i] = fromDisplay(d, p.rotation);
        place();
        showLoupe(d);
      });
      const end = () => {
        if (!drag) return;
        handles[drag.i].classList.remove('active');
        drag = null;
        loupe.hidden = true;
        refreshResult();
      };
      wrap.addEventListener('pointerup', end);
      wrap.addEventListener('pointercancel', end);
      refreshResult();
    }

    // ----- Step 3: details -----
    function suggestTitle(fileName = '') {
      const cat = categoryById(meta.categoryId);
      const typeL = docTypeLabel(meta.docType);
      const evs = [...linked].map((id) => knownEvents.get(id)).filter(Boolean).sort((a, b) => (a.start < b.start ? -1 : 1));
      if (evs.length) {
        const first = evs[0].start;
        return [typeL, cat?.name, fmtMonthYear(first)].filter(Boolean).join(' — ');
      }
      if (fileName) return fileName.replace(/\.[a-z0-9]+$/i, '').replace(/[_-]+/g, ' ').trim();
      return [typeL, cat?.name, fmtMonthYear(`${meta.docDate}T00:00`)].filter(Boolean).join(' — ');
    }

    function updateFromLinks() {
      const evs = [...linked].map((id) => knownEvents.get(id)).filter(Boolean);
      if (evs.length) {
        const starts = evs.map((e) => e.start.slice(0, 10)).sort();
        meta.periodFrom = starts[0];
        meta.periodTo = starts[starts.length - 1];
        meta.hours = Math.round(evs.reduce((s, e) => s + (e.allDay ? 0 : minutesBetween(e.start, e.end) / 60), 0) * 100) / 100 || '';
        if (!meta.categoryId) meta.categoryId = evs[0].categoryId;
      }
      if (!titleTouched) meta.title = suggestTitle(pdfFile?.name);
    }

    async function loadCandidates() {
      if (candidates) return;
      try {
        const res = await api.get('/api/attestations');
        candidates = [...res.overdue, ...res.upcoming, ...res.received.slice(0, 30)];
        for (const e of candidates) if (!knownEvents.has(e.id)) knownEvents.set(e.id, e);
      } catch {
        candidates = [];
      }
    }

    async function drawDetails() {
      if (!candidates && !course) {
        stage.innerHTML = '<div class="boot" style="height:200px"><div class="spinner"></div></div>';
        await loadCandidates();
        if (step !== 'details') return;
      }
      if (!titleTouched) updateFromLinks();
      const list = [...knownEvents.values()].sort((a, b) => (a.start < b.start ? 1 : -1));
      const preview = pdfFile
        ? `<div class="card card-pad flex">${icon('fileText', 'xl')}<div style="min-width:0"><div class="strong ellipsis">${esc(pdfFile.name)}</div><div class="small muted">PDF · ${esc(fileSize(pdfFile.size))}</div></div></div>`
        : `<div class="page-strip">${pages.map((pg, i) => `<div class="page-thumb" style="cursor:default"><img alt="" data-thumb="${i}"><span class="num">${i + 1}</span></div>`).join('')}</div>`;
      stage.innerHTML = `
        <div class="doc-detail">
          <form class="stack" novalidate data-meta>
            <div class="field"><label>${esc(t('Name'))}</label>
              <input class="input" name="title" value="${esc(meta.title)}" maxlength="200" autofocus placeholder="${esc(t('e.g. Attestation — Lycée Pilote — October 2026'))}">
              <span class="hint">${esc(t('Choose a name you will easily search for later.'))}</span></div>
            <div class="grid-2">
              <div class="field"><label>${esc(t('Type'))}</label><select class="select" name="docType">${DOC_TYPES.map((d) => `<option value="${d.value}" ${d.value === meta.docType ? 'selected' : ''}>${esc(t(d.label))}</option>`).join('')}</select></div>
              <div class="field"><label>${esc(t('Document date'))}</label><input class="input" type="date" name="docDate" value="${esc(meta.docDate)}"></div>
            </div>
            <div class="field"><label>${esc(t('Institution'))}</label><select class="select" name="categoryId">
              <option value="">${esc(t('— None —'))}</option>${activeCategories().map((c) => `<option value="${c.id}" ${c.id === meta.categoryId ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></div>
            <div class="grid-3">
              <div class="field"><label>${esc(t('Period from'))}</label><input class="input" type="date" name="periodFrom" value="${esc(meta.periodFrom)}"></div>
              <div class="field"><label>${esc(t('to'))}</label><input class="input" type="date" name="periodTo" value="${esc(meta.periodTo)}"></div>
              <div class="field"><label>${esc(t('Hours'))}</label><input class="input" type="number" min="0" step="0.25" name="hours" value="${esc(meta.hours)}"></div>
            </div>
            <div class="field"><label>${esc(t('Tags'))}</label><input class="input" name="tags" value="${esc(meta.tags)}" placeholder="${esc(t('separate with commas, e.g. 2026, signed'))}"></div>
            <div class="field"><label>${esc(t('Notes'))}</label><textarea class="textarea" name="notes" rows="2">${esc(meta.notes)}</textarea></div>
          </form>
          <div class="stack">
            <div class="stack tight"><span class="label">${esc(t('Preview'))}</span>${preview}</div>
            ${course ? `<div class="tip">${icon('book')}<span>${esc(t('Saved with the course “{name}”.', { name: course.title }))}</span></div>` : `<div class="stack tight"><span class="label">${esc(t('Linked sessions'))} ${linked.size ? `<span class="badge primary">${linked.size}</span>` : ''}</span>
              ${
                list.length
                  ? `<div class="session-pick">${list
                      .map(
                        (e) => `<label><input type="checkbox" data-link="${e.id}" ${linked.has(e.id) ? 'checked' : ''}>
                        <span style="flex:1;min-width:0"><div class="strong ellipsis">${esc(e.title)}</div>
                        <div class="small muted">${esc(fmtShort(e.start))} · ${e.allDay ? esc(t('All day')) : `${fmtTime(e.start)}–${fmtTime(e.end)}`}${categoryById(e.categoryId) ? ` · ${esc(categoryById(e.categoryId).name)}` : ''}</div></span>
                        ${e.attestation?.status === 'received' ? `<span class="chip success">${icon('check')}</span>` : e.attestation?.required ? `<span class="att-flag ${e.end <= nowWall() ? 'overdue' : 'pending'}">!</span>` : ''}</label>`
                      )
                      .join('')}</div>`
                  : `<p class="small muted">${esc(t('No session waiting for an attestation.'))}</p>`
              }
              ${linked.size ? `<label class="flex small" style="cursor:pointer;margin-top:4px"><input type="checkbox" data-mark ${meta.markReceived ? 'checked' : ''} style="accent-color:var(--success);width:17px;height:17px">${esc(t('Mark the linked sessions as received (stops reminders)'))}</label>` : ''}
            </div>`}
          </div>
        </div>`;
      footer.innerHTML = `${pdfFile ? `<button class="btn ghost" data-back="capture">${icon('arrowL', 'sm')}${esc(t('Change file'))}</button>` : `<button class="btn ghost" data-back="adjust">${icon('arrowL', 'sm')}${esc(t('Back'))}</button>`}
        <span class="spacer"></span><button class="btn primary" data-save>${icon('check', 'sm')}${esc(t('Save document'))}</button>`;
      pages.forEach((pg, i) => {
        const img = stage.querySelector(`[data-thumb="${i}"]`);
        if (img) img.src = renderPage(pg, 200).toDataURL('image/jpeg', 0.7);
      });
      const form = stage.querySelector('[data-meta]');
      form.addEventListener('input', (e) => {
        if (e.target.name === 'title') titleTouched = true;
        readMeta();
      });
      form.addEventListener('change', (e) => {
        readMeta();
        if ((e.target.name === 'docType' || e.target.name === 'categoryId') && !titleTouched) {
          meta.title = suggestTitle(pdfFile?.name);
          form.title.value = meta.title;
        }
      });
      form.addEventListener('submit', (e) => (e.preventDefault(), save()));
    }

    function readMeta() {
      const f = stage.querySelector('[data-meta]');
      if (!f) return;
      meta.title = f.title.value;
      meta.docType = f.docType.value;
      meta.docDate = f.docDate.value;
      meta.categoryId = f.categoryId.value ? Number(f.categoryId.value) : null;
      meta.periodFrom = f.periodFrom.value;
      meta.periodTo = f.periodTo.value;
      meta.hours = f.hours.value;
      meta.tags = f.tags.value;
      meta.notes = f.notes.value;
    }

    async function save() {
      readMeta();
      const btn = footer.querySelector('[data-save]');
      if (!meta.title.trim()) {
        const input = stage.querySelector('[name=title]');
        input.classList.add('invalid');
        input.focus();
        return toast(t('Please give the document a name.'), { type: 'error' });
      }
      if (meta.periodFrom && meta.periodTo && meta.periodTo < meta.periodFrom) return toast(t('The end of the period must be after its start.'), { type: 'error' });
      setBusy(btn, true);
      let scanned = null;
      try {
        const fd = new FormData();
        let pageCount = 1;
        if (pdfFile) {
          fd.append('file', pdfFile, pdfFile.name);
        } else {
          const JsPDF = await loadJsPdf();
          let pdf = null;
          scanned = [];
          for (const pg of pages) {
            const c = renderPage(pg, 2000);
            scanned.push(c);
            const landscape = c.width > c.height;
            const pw = landscape ? 297 : 210;
            const ph = landscape ? 210 : 297;
            if (!pdf) pdf = new JsPDF({ orientation: landscape ? 'l' : 'p', unit: 'mm', format: 'a4', compress: true });
            else pdf.addPage('a4', landscape ? 'l' : 'p');
            const ratio = Math.min(pw / c.width, ph / c.height);
            const w = c.width * ratio;
            const h = c.height * ratio;
            pdf.addImage(c.toDataURL('image/jpeg', 0.82), 'JPEG', (pw - w) / 2, (ph - h) / 2, w, h, undefined, 'FAST');
          }
          pageCount = pages.length;
          const safe = meta.title.replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'scan';
          fd.append('file', pdf.output('blob'), `${safe}.pdf`);
          const thumb = await canvasToBlob(renderPage(pages[0], 480), 'image/jpeg', 0.78);
          if (thumb) fd.append('thumb', thumb, 'thumb.jpg');
        }
        fd.append('title', meta.title.trim());
        fd.append('docType', meta.docType);
        fd.append('docDate', meta.docDate || '');
        fd.append('categoryId', meta.categoryId || '');
        fd.append('periodFrom', meta.periodFrom || '');
        fd.append('periodTo', meta.periodTo || '');
        fd.append('hours', meta.hours === '' ? '' : String(meta.hours));
        fd.append('tags', meta.tags);
        fd.append('notes', meta.notes);
        fd.append('pages', String(pageCount));
        fd.append('eventIds', JSON.stringify([...linked]));
        if (course) fd.append('courseId', String(course.id));
        fd.append('markReceived', linked.size && meta.markReceived ? 'true' : 'false');
        saved = replacing ? await api.upload(`/api/documents/${replacing.id}`, fd, 'PUT') : await api.upload('/api/documents', fd);
        changed();
        // Read the text in the background, so the document can be found by its content.
        import('./ocr.js').then(({ readTextLater }) => readTextLater(scanned ? { id: saved.id, canvases: scanned } : saved, { quiet: !!course }));
        stopCamera();
        m.close(true);
        toast(linked.size && meta.markReceived ? t('Document saved. Attestation marked as received.') : t('Document saved'), { type: 'success' });
      } catch (err) {
        setBusy(btn, false);
        errorToast(err);
      }
    }

    // ----- shared interactions -----
    on(m.root, 'click', '[data-opt]', (e, b) => {
      if (b.dataset.opt === 'camera') go('camera');
      else fileInput.click();
    });
    on(m.root, 'click', '[data-next]', (e, b) => go(b.dataset.next));
    on(m.root, 'click', '[data-back]', (e, b) => {
      if (b.dataset.back === 'capture') pdfFile = null;
      go(b.dataset.back);
    });
    on(m.root, 'click', '[data-close-btn]', () => m.close());
    on(m.root, 'click', '[data-save]', () => save());
    on(m.root, 'click', '[data-page]', (e, b) => {
      active = Number(b.dataset.page);
      drawAdjust();
    });
    on(m.root, 'click', '[data-add-camera]', () => go('camera'));
    on(m.root, 'click', '[data-add-file]', () => fileInput.click());
    on(m.root, 'click', '[data-rot]', (e, b) => {
      const p = pages[active];
      p.rotation += Number(b.dataset.rot);
      drawAdjust();
    });
    on(m.root, 'click', '[data-quad]', (e, b) => {
      const p = pages[active];
      if (b.dataset.quad === 'full') p.quad = FULL_QUAD.map((q) => ({ ...q }));
      else {
        const q = detectDocument(p.src);
        if (!q) toast(t('The page could not be found automatically. Drag the corners onto it.'));
        p.quad = q || FULL_QUAD.map((x) => ({ ...x }));
        p.detected = !!q;
      }
      drawAdjust();
    });
    on(m.root, 'click', '[data-filter]', (e, b) => {
      pages[active].filter = b.dataset.filter;
      drawAdjust();
    });
    on(m.root, 'click', '[data-move]', (e, b) => {
      const to = active + Number(b.dataset.move);
      [pages[active], pages[to]] = [pages[to], pages[active]];
      active = to;
      drawAdjust();
    });
    on(m.root, 'click', '[data-del-page]', () => {
      pages.splice(active, 1);
      if (!pages.length) go('capture');
      else drawAdjust();
    });
    on(m.root, 'change', '[data-link]', (e, c) => {
      readMeta();
      const id = Number(c.dataset.link);
      if (c.checked) linked.add(id);
      else linked.delete(id);
      const cat = knownEvents.get(id)?.categoryId;
      if (c.checked && !meta.categoryId && cat) meta.categoryId = cat;
      updateFromLinks();
      drawDetails();
    });
    on(m.root, 'change', '[data-mark]', (e, c) => (meta.markReceived = c.checked));

    drawSteps();
    if (opts.mode === 'files' && opts.files?.length) {
      drawCapture();
      addFiles(opts.files);
    } else if (opts.mode === 'camera') go('camera');
    else {
      drawCapture();
      if (opts.mode === 'upload') setTimeout(() => fileInput.click(), 50);
    }
  });
}

export { hoursLabel };
