import { t } from './i18n.js';

// ---------- Escaping & templating ----------

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

export function el(html) {
  const tpl = document.createElement('template');
  tpl.innerHTML = html.trim();
  return tpl.content.firstElementChild;
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/** Event delegation: on(root, 'click', '[data-action]', (e, target) => …) */
export function on(root, type, selector, handler) {
  root.addEventListener(type, (e) => {
    const target = e.target.closest(selector);
    if (target && root.contains(target)) handler(e, target);
  });
}

// ---------- Icons (Lucide-style, inline SVG) ----------

const PATHS = {
  home: '<path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  calendar: '<rect x="3" y="4.5" width="18" height="17" rx="3"/><path d="M3 10h18M8 2.5v4M16 2.5v4"/>',
  attestation: '<path d="M14 2.5H6.5a2 2 0 0 0-2 2v15a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V8z"/><path d="M14 2.5V8h5.5"/><path d="m9 14.5 2 2 4-4"/>',
  scan: '<path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2"/><path d="M7 12h10"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20.5 20.5-4.3-4.3"/>',
  settings: '<path d="M12.2 2h-.4a2 2 0 0 0-2 2v.2a2 2 0 0 1-1 1.7l-.4.3a2 2 0 0 1-2 0l-.2-.1a2 2 0 0 0-2.7.7l-.2.4a2 2 0 0 0 .7 2.7l.2.1a2 2 0 0 1 1 1.7v.6a2 2 0 0 1-1 1.7l-.2.1a2 2 0 0 0-.7 2.7l.2.4a2 2 0 0 0 2.7.7l.2-.1a2 2 0 0 1 2 0l.4.3a2 2 0 0 1 1 1.7v.2a2 2 0 0 0 2 2h.4a2 2 0 0 0 2-2v-.2a2 2 0 0 1 1-1.7l.4-.3a2 2 0 0 1 2 0l.2.1a2 2 0 0 0 2.7-.7l.2-.4a2 2 0 0 0-.7-2.7l-.2-.1a2 2 0 0 1-1-1.7v-.6a2 2 0 0 1 1-1.7l.2-.1a2 2 0 0 0 .7-2.7l-.2-.4a2 2 0 0 0-2.7-.7l-.2.1a2 2 0 0 1-2 0l-.4-.3a2 2 0 0 1-1-1.7V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  bell: '<path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.9 1.9 0 0 0 3.4 0"/>',
  bellRing: '<path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.9 1.9 0 0 0 3.4 0M2 8c0-2.2.7-4.3 2-6M22 8a10 10 0 0 0-2-6"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  checkCircle: '<circle cx="12" cy="12" r="9.5"/><path d="m8 12 3 3 5-6"/>',
  clock: '<circle cx="12" cy="12" r="9.5"/><path d="M12 7v5l3 2"/>',
  snooze: '<circle cx="12" cy="13" r="8"/><path d="M5 3 2 6M22 6l-3-3M10 10h4l-4 5h4"/>',
  pin: '<path d="M20 10c0 6-8 12-8 12S4 16 4 10a8 8 0 1 1 16 0"/><circle cx="12" cy="10" r="3"/>',
  repeat: '<path d="m17 2 4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14M7 22l-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/>',
  mail: '<rect x="2.5" y="4.5" width="19" height="15" rx="2.5"/><path d="m3 7 9 6 9-6"/>',
  trash: '<path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6M10 11v6M14 11v6"/>',
  edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
  copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  ban: '<circle cx="12" cy="12" r="9.5"/><path d="m5.3 5.3 13.4 13.4"/>',
  undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
  rotateL: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>',
  rotateR: '<path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/>',
  camera: '<path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3z"/><circle cx="12" cy="13" r="3.5"/>',
  upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>',
  file: '<path d="M14 2.5H6.5a2 2 0 0 0-2 2v15a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V8z"/><path d="M14 2.5V8h5.5"/>',
  fileText: '<path d="M14 2.5H6.5a2 2 0 0 0-2 2v15a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V8z"/><path d="M14 2.5V8h5.5M8 13h8M8 17h5"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="2.5"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21"/>',
  chevronL: '<path d="m15 18-6-6 6-6"/>',
  chevronR: '<path d="m9 18 6-6-6-6"/>',
  chevronD: '<path d="m6 9 6 6 6-6"/>',
  alert: '<path d="m21.7 18-8-14a2 2 0 0 0-3.4 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.7-3"/><path d="M12 9v4M12 17h.01"/>',
  alertCircle: '<circle cx="12" cy="12" r="9.5"/><path d="M12 8v4M12 16h.01"/>',
  info: '<circle cx="12" cy="12" r="9.5"/><path d="M12 16v-4M12 8h.01"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>',
  building: '<rect x="4" y="2.5" width="16" height="19" rx="2"/><path d="M9 22v-4h6v4M8 6.5h.01M12 6.5h.01M16 6.5h.01M8 10.5h.01M12 10.5h.01M16 10.5h.01M8 14.5h.01M12 14.5h.01M16 14.5h.01"/>',
  user: '<circle cx="12" cy="8" r="4.5"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  lock: '<rect x="4" y="11" width="16" height="10.5" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  sparkles: '<path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3z"/>',
  crop: '<path d="M6 2v14a2 2 0 0 0 2 2h14M18 22V8a2 2 0 0 0-2-2H2"/>',
  layers: '<path d="m12 2 10 5-10 5L2 7z"/><path d="m2 17 10 5 10-5M2 12l10 5 10-5"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/>',
  external: '<path d="M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
  hourglass: '<path d="M5 22h14M5 2h14M17 22v-4.2a2 2 0 0 0-.6-1.4L12 12l-4.4 4.4a2 2 0 0 0-.6 1.4V22M7 2v4.2a2 2 0 0 0 .6 1.4L12 12l4.4-4.4a2 2 0 0 0 .6-1.4V2"/>',
  more: '<circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>',
  refresh: '<path d="M21 12a9 9 0 0 1-15 6.7L3 16M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M21 3v5h-5M3 21v-5h5"/>',
  inbox: '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.5 5.1 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.5-6.9A2 2 0 0 0 16.8 4H7.2a2 2 0 0 0-1.7 1.1"/>',
  globe: '<circle cx="12" cy="12" r="9.5"/><path d="M2.5 12h19M12 2.5a14.5 14.5 0 0 1 0 19 14.5 14.5 0 0 1 0-19"/>',
  database: '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14c0 1.7 4 3 9 3s9-1.3 9-3V5M3 12c0 1.7 4 3 9 3s9-1.3 9-3"/>',
  palette: '<circle cx="13.5" cy="6.5" r="1"/><circle cx="17.5" cy="10.5" r="1"/><circle cx="8.5" cy="7.5" r="1"/><circle cx="6.5" cy="12.5" r="1"/><path d="M12 2a10 10 0 0 0 0 20c1 0 1.7-.8 1.7-1.7 0-.4-.2-.8-.4-1.1-.3-.3-.4-.7-.4-1.1 0-.9.8-1.7 1.7-1.7h2A5.6 5.6 0 0 0 22 11c0-5-4.5-9-10-9"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/>',
  arrowR: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  arrowL: '<path d="M19 12H5M11 18l-6-6 6-6"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12"/><circle cx="12" cy="12" r="3"/>',
  printer: '<path d="M6 9V2h12v7M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8" rx="1"/>',
  tag: '<path d="M12.6 2.6A2 2 0 0 0 11.2 2H4a2 2 0 0 0-2 2v7.2a2 2 0 0 0 .6 1.4l8.7 8.7a2.4 2.4 0 0 0 3.4 0l6.6-6.6a2.4 2.4 0 0 0 0-3.4z"/><circle cx="7.5" cy="7.5" r=".5"/>',
  wand: '<path d="m15 4-1-1M20 9l1 1M18 4l1.5-1.5M15 9l-12 12M12 6l6 6"/><path d="M17.8 11.8 19 13M15 3V1M21 9h2"/>',
  chart: '<path d="M3 3v18h18"/><path d="M8 17V10M13 17V6M18 17v-4"/>',
  moon: '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9"/>',
  book: '<path d="M2 4.5h6a4 4 0 0 1 4 4V21a3 3 0 0 0-3-3H2z"/><path d="M22 4.5h-6a4 4 0 0 0-4 4V21a3 3 0 0 1 3-3h7z"/>',
  maximize: '<path d="M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3M16 21h3a2 2 0 0 0 2-2v-3"/>',
  key: '<circle cx="7.5" cy="15.5" r="5.5"/><path d="m21 2-9.6 9.6M15.5 7.5l3 3L22 7l-3-3"/>',
};

export function icon(name, cls = '') {
  return `<svg class="icon ${cls}" viewBox="0 0 24 24" aria-hidden="true">${PATHS[name] || PATHS.info}</svg>`;
}

// ---------- Toasts ----------

export function toast(message, { type = 'info', action, onAction, duration = 4200 } = {}) {
  const root = document.getElementById('toast-root');
  const ic = type === 'error' ? 'alertCircle' : type === 'success' ? 'checkCircle' : 'info';
  const node = el(`<div class="toast ${type}" role="status">${icon(ic)}<span>${esc(message)}</span>${
    action ? `<button class="btn">${esc(action)}</button>` : ''
  }</div>`);
  const close = () => {
    node.classList.add('leaving');
    setTimeout(() => node.remove(), 200);
  };
  if (action) {
    node.querySelector('button').addEventListener('click', () => {
      close();
      onAction?.();
    });
  }
  root.appendChild(node);
  while (root.children.length > 3) root.firstElementChild.remove();
  setTimeout(close, action ? Math.max(duration, 7000) : duration);
}

export function errorToast(err) {
  const msg = err?.message === 'offline' ? t('Cannot reach the app. Is it still running?') : t(err?.message || 'Something went wrong.');
  toast(msg, { type: 'error' });
}

// ---------- Modals ----------

const openStack = [];

/**
 * Opens a modal. `content` is HTML for the body; returns { root, close }.
 * `onClose` may return false to keep the modal open (e.g. unsaved changes).
 */
export function openModal({ title, content, footer = '', size = '', onClose, dismissible = true, headerExtra = '' }) {
  const root = document.getElementById('modal-root');
  const backdrop = el(`
    <div class="modal-backdrop">
      <div class="modal ${size}" role="dialog" aria-modal="true" aria-label="${esc(title)}">
        <div class="modal-header"><h2>${esc(title)}</h2>${headerExtra}
          <button class="btn ghost icon-only sm" data-close aria-label="${esc(t('Close'))}">${icon('x')}</button></div>
        <div class="modal-body">${content}</div>
        ${footer ? `<div class="modal-footer">${footer}</div>` : ''}
      </div>
    </div>`);
  const previousFocus = document.activeElement;
  let closed = false;
  const api = {
    root: backdrop.querySelector('.modal'),
    close: async (force = false) => {
      if (closed) return;
      if (!force && onClose && (await onClose()) === false) return;
      closed = true;
      backdrop.remove();
      const i = openStack.indexOf(api);
      if (i > -1) openStack.splice(i, 1);
      if (!openStack.length) document.body.style.overflow = '';
      previousFocus?.focus?.();
    },
    setTitle: (txt) => (backdrop.querySelector('.modal-header h2').textContent = txt),
    dismissible,
  };
  backdrop.addEventListener('mousedown', (e) => {
    if (e.target === backdrop && dismissible) api.close();
  });
  backdrop.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => api.close()));
  root.appendChild(backdrop);
  openStack.push(api);
  document.body.style.overflow = 'hidden';
  setTimeout(() => {
    const first = backdrop.querySelector('[autofocus]') || backdrop.querySelector('.modal-body input:not([type=hidden]):not([type=checkbox]), .modal-body textarea, .modal-body select');
    (first || backdrop.querySelector('.modal')).focus?.({ preventScroll: true });
  }, 30);
  return api;
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && openStack.length) {
    const top = openStack[openStack.length - 1];
    if (top.dismissible) {
      e.preventDefault();
      e.stopPropagation();
      top.close();
    }
  }
});

export const hasOpenModal = () => openStack.length > 0;

export function confirmDialog({ title, message, confirm = t('Confirm'), cancel = t('Cancel'), danger = false }) {
  return new Promise((resolve) => {
    let result = false;
    const m = openModal({
      title,
      size: 'sm',
      content: `<p style="color:var(--text-2)">${message}</p>`,
      footer: `<span class="spacer"></span><button class="btn" data-close>${esc(cancel)}</button>
               <button class="btn ${danger ? 'danger' : 'primary'}" data-ok autofocus>${esc(confirm)}</button>`,
      onClose: () => resolve(result),
    });
    m.root.querySelector('[data-ok]').addEventListener('click', () => {
      result = true;
      m.close();
    });
  });
}

/** Shows a list of big choices; resolves with the chosen value or null. */
export function chooseDialog({ title, message = '', choices }) {
  return new Promise((resolve) => {
    let result = null;
    const m = openModal({
      title,
      size: 'sm',
      content: `${message ? `<p style="color:var(--text-2);margin-bottom:14px">${message}</p>` : ''}
        <div class="choice-list">${choices
          .map(
            (c, i) => `<button class="choice ${c.danger ? 'danger' : ''}" data-i="${i}">
              <span class="ic">${icon(c.icon || 'arrowR')}</span>
              <span><div class="t">${esc(c.label)}</div>${c.description ? `<div class="d">${esc(c.description)}</div>` : ''}</span>
            </button>`
          )
          .join('')}</div>`,
      onClose: () => resolve(result),
    });
    m.root.querySelectorAll('[data-i]').forEach((b) =>
      b.addEventListener('click', () => {
        result = choices[Number(b.dataset.i)].value;
        m.close();
      })
    );
  });
}

export function setBusy(button, busy) {
  if (!button) return;
  if (busy) {
    button.dataset.label = button.innerHTML;
    button.disabled = true;
    button.innerHTML = `<span class="spinner sm"></span>`;
  } else {
    button.disabled = false;
    if (button.dataset.label) button.innerHTML = button.dataset.label;
  }
}

export function emptyState({ iconName = 'inbox', title, text = '', action = '' }) {
  return `<div class="empty"><div class="icon-wrap">${icon(iconName, 'lg')}</div><h3>${esc(title)}</h3>${
    text ? `<p>${text}</p>` : ''
  }${action}</div>`;
}

// Colour themes: a main colour plus soft backgrounds (light mode). Pink first: it is the default.
export const PALETTES = [
  { id: 'rose', name: 'Rose', accent: '#e0457b', bg: '#fff5f8' },
  { id: 'red', name: 'Coral red', accent: '#e5484d', bg: '#fff6f5' },
  { id: 'mint', name: 'Mint green', accent: '#2a9d6f', bg: '#f1faf5' },
  { id: 'lavender', name: 'Lavender', accent: '#8e4ec6', bg: '#f8f4fd' },
  { id: 'peach', name: 'Peach', accent: '#f0702e', bg: '#fff6ef' },
  { id: 'sky', name: 'Sky blue', accent: '#0a84e0', bg: '#f1f7fe' },
  { id: 'classic', name: 'Classic', accent: '#5b5bd6', bg: '#f6f6f9' },
];

export const CATEGORY_COLORS = ['#5b5bd6', '#e5484d', '#f76b15', '#f5a524', '#30a46c', '#12a594', '#0090ff', '#8e4ec6', '#d6409f', '#6e6e82'];

export function debounce(fn, ms = 250) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

export function initials(name = '') {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0].toUpperCase())
    .join('') || '?';
}

/** Theme picker: one card per colour theme, with a small preview. */
export function paletteGrid(current) {
  return `<div class="palette-grid">${PALETTES.map(
    (p) => `<button type="button" class="palette-opt ${p.id === current ? 'active' : ''}" data-palette-opt="${p.id}" aria-pressed="${p.id === current}">
      <span class="palette-swatch" style="background:${p.bg}"><b style="background:${p.accent}"></b><i style="background:${p.accent}"></i></span>
      <span class="nm">${esc(t(p.name))}</span></button>`
  ).join('')}</div>`;
}
