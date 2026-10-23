import { api } from './api.js';
import { t } from './i18n.js';
import { state, changed } from './store.js';
import { toast } from './ui.js';

// Reads the text of documents on this device (nothing is sent to an outside service), so they
// can be found by the words they contain. Runs in the background after a document is saved.

const MAX_PAGES = 12;
let workerPromise = null;
let workerLangs = null;
let idleTimer = null;

function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) return resolve();
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error('Could not load the text reader.'));
    document.head.appendChild(s);
  });
}

/** French always; Arabic too when she said some of her documents are in Arabic. */
function languages() {
  const arabic = state.settings?.onboarding?.answers?.documents?.arabic === 'yes';
  return arabic ? 'fra+ara' : 'fra';
}

async function getWorker() {
  const langs = languages();
  if (workerPromise && workerLangs !== langs) {
    (await workerPromise).terminate();
    workerPromise = null;
  }
  if (!workerPromise) {
    workerLangs = langs;
    workerPromise = (async () => {
      await loadScript('/vendor/tesseract/tesseract.min.js');
      return window.Tesseract.createWorker(langs, 1, {
        workerPath: '/vendor/tesseract/worker.min.js',
        corePath: '/vendor/tesseract-core',
        langPath: '/vendor/tessdata',
        gzip: true,
        // Load the worker straight from this site (not from a temporary blob), as the security policy expects.
        workerBlobURL: false,
      });
    })().catch((err) => {
      workerPromise = null;
      throw err;
    });
  }
  return workerPromise;
}

/** The text reader takes memory: let it go when it has nothing to do. */
function releaseLater() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(async () => {
    if (!workerPromise || running) return;
    const w = await workerPromise.catch(() => null);
    workerPromise = null;
    w?.terminate();
  }, 60000);
}

async function recognizeCanvases(canvases) {
  const worker = await getWorker();
  const parts = [];
  for (const c of canvases.slice(0, MAX_PAGES)) {
    const { data } = await worker.recognize(c);
    parts.push(data.text.trim());
  }
  return parts.filter(Boolean).join('\n\n');
}

let pdfjsPromise = null;
function loadPdfJs() {
  pdfjsPromise ||= import('/vendor/pdfjs/pdf.min.mjs').then((lib) => {
    lib.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.min.mjs';
    return lib;
  });
  return pdfjsPromise;
}

/** A PDF made on a computer already contains its text; a scanned one needs to be read page by page. */
async function textOfPdf(url) {
  const pdfjs = await loadPdfJs();
  const pdf = await pdfjs.getDocument({ url, isEvalSupported: false }).promise;
  const pages = Math.min(pdf.numPages, MAX_PAGES);
  const parts = [];
  for (let i = 1; i <= pages; i++) {
    const content = await (await pdf.getPage(i)).getTextContent();
    parts.push(content.items.map((it) => it.str + (it.hasEOL ? '\n' : ' ')).join('').trim());
  }
  const embedded = parts.filter(Boolean).join('\n\n');
  if (embedded.replace(/\s/g, '').length > 40) return embedded;
  const canvases = [];
  for (let i = 1; i <= pages; i++) {
    const page = await pdf.getPage(i);
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: Math.min(3, 2000 / Math.max(base.width, base.height)) });
    const c = document.createElement('canvas');
    c.width = Math.round(viewport.width);
    c.height = Math.round(viewport.height);
    await page.render({ canvasContext: c.getContext('2d'), viewport }).promise;
    canvases.push(c);
  }
  return recognizeCanvases(canvases);
}

async function textOfImage(url) {
  const img = await createImageBitmap(await (await fetch(url, { credentials: 'same-origin' })).blob());
  const c = document.createElement('canvas');
  const s = Math.min(1, 2400 / Math.max(img.width, img.height));
  c.width = Math.round(img.width * s);
  c.height = Math.round(img.height * s);
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  return recognizeCanvases([c]);
}

/** True when the app can read the text of this kind of file. */
export const canReadText = (mime) => mime === 'application/pdf' || /^image\/(jpeg|png|webp)$/.test(mime);

/** Reads the text now and returns it (used by the "Read the text" button). */
export async function extractText(doc) {
  try {
    const url = `/api/documents/${doc.id}/file`;
    if (doc.canvases) return await recognizeCanvases(doc.canvases);
    if (doc.mime === 'application/pdf') return await textOfPdf(url);
    if (canReadText(doc.mime)) return await textOfImage(url);
    return '';
  } finally {
    releaseLater();
  }
}

async function saveText(id, text) {
  const fd = new FormData();
  fd.append('ocrText', text);
  await api.upload(`/api/documents/${id}`, fd, 'PUT');
}

// ----- background queue -----

const queue = [];
let running = false;

/**
 * Reads a saved document's text in the background. `doc`: { id, mime } or { id, canvases } for
 * pages that were just scanned. `quiet`: no message when it is done (e.g. course files).
 */
export function readTextLater(doc, { quiet = false } = {}) {
  if (!doc?.id || (!doc.canvases && !canReadText(doc.mime))) return;
  queue.push({ doc, quiet });
  run();
}

async function run() {
  if (running) return;
  running = true;
  while (queue.length) {
    const { doc, quiet } = queue.shift();
    try {
      const text = await extractText(doc);
      if (text.trim()) {
        await saveText(doc.id, text);
        changed();
        if (!quiet) toast(t('Text read: you can now find this document by the words it contains.'), { type: 'success' });
      }
    } catch (err) {
      console.warn('[text reader]', err);
    }
  }
  running = false;
  releaseLater();
}

export { saveText };
