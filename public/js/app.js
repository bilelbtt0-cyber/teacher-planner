import { api, setUnauthorizedHandler } from './api.js';
import { t, tn, timeAgo, setLanguage } from './i18n.js';
import { state, subscribe, loadSettings, loadCategories, loadCourses, startPolling, stopPolling, refreshNotifications, applyTheme, appName } from './store.js';
import { esc, el, icon, on, toast, errorToast, setBusy, hasOpenModal, initials } from './ui.js';
import { openEventForm, openEventDetails } from './eventForm.js';

const ROUTES = {
  today: { title: 'Today', icon: 'sun', load: () => import('./views/today.js') },
  calendar: { title: 'Calendar', icon: 'calendar', load: () => import('./views/calendar.js'), wide: true },
  courses: { title: 'My courses', icon: 'book', load: () => import('./views/courses.js') },
  attestations: { title: 'Attestations', icon: 'attestation', load: () => import('./views/attestations.js') },
  documents: { title: 'My documents', icon: 'folder', load: () => import('./views/documents.js') },
  search: { title: 'Search & history', icon: 'search', load: () => import('./views/search.js') },
  settings: { title: 'Settings', icon: 'settings', load: () => import('./views/settings.js') },
  welcome: { title: 'Welcome', icon: 'sparkles', load: () => import('./views/welcome.js') },
};
const NAV = ['today', 'calendar', 'courses', 'attestations', 'documents', 'search'];

const app = document.getElementById('app');
let cleanup = null;
let renderToken = 0;

// ---------- Boot ----------

async function boot() {
  applyTheme();
  setUnauthorizedHandler(() => {
    if (state.user) {
      state.user = null;
      stopPolling();
      toast(t('Your session has expired. Please sign in again.'), { type: 'error' });
      showAuth('login');
    }
  });
  let me;
  try {
    me = await api.get('/api/auth/me');
  } catch {
    app.innerHTML = `<div class="boot"><div class="empty">${icon('alertCircle', 'xl')}<h3>${esc(t('Cannot reach the app. Is it still running?'))}</h3>
      <button class="btn primary" onclick="location.reload()">${esc(t('Try again'))}</button></div></div>`;
    return;
  }
  // Use the browser language until the user's own preference is loaded.
  setLanguage(navigator.language?.startsWith('fr') ? 'fr' : 'en');
  setupCodeRequired = !!me.setupCodeRequired;
  if (me.setupRequired) return showAuth('setup');
  if (!me.authenticated) return showAuth('login');
  state.user = me.user;
  await startApp();
}

async function startApp() {
  try {
    await Promise.all([loadSettings(), loadCategories(), loadCourses()]);
  } catch (err) {
    errorToast(err);
    return;
  }
  renderShell();
  startPolling();
  window.addEventListener('hashchange', route);
  route();
}

// ---------- Auth screens ----------

let setupCodeRequired = false;

function showAuth(mode) {
  window.removeEventListener('hashchange', route);
  const setup = mode === 'setup';
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const hour = new Date().getHours();
  const hello = hour < 18 ? t('Hello') : t('Good evening');
  const day = new Date().getDate();
  app.innerHTML = `
    <div class="auth-page">
      <div class="auth-art soft">
        <div class="brand" style="padding:0"><div class="brand-logo">${icon('calendar')}</div><div class="brand-name">Planner</div></div>
        <div class="auth-hero">
          <span class="auth-hello">${esc(hello)} ${hour < 18 ? '☀️' : '🌙'}</span>
          <h1>${esc(t('Your planner, made simple.'))}</h1>
          <p>${esc(t('Your classes, your reminders and your papers, together in one place.'))}</p>
        </div>
        <div class="auth-illus" aria-hidden="true">
          <div class="ill-card ill-cal">
            <div class="ill-cal-head"><span></span><span></span><span></span></div>
            <div class="ill-cal-grid">${Array.from({ length: 21 }, (_, i) => `<i class="${i === 10 ? 'on' : ''}">${i === 10 ? day : ''}</i>`).join('')}</div>
          </div>
          <div class="ill-card ill-event"><span class="dot"></span><div><b>08:00</b><small></small></div></div>
          <div class="ill-card ill-check">${icon('check')}<span></span></div>
        </div>
        <div class="auth-foot">${esc(t('Made with care, just for you.'))}</div>
      </div>
      <div class="auth-form-wrap">
        <form class="auth-form stack" novalidate>
          <div class="auth-mobile-brand"><div class="brand-logo">${icon('calendar')}</div><div class="brand-name">Planner</div></div>
          <div>
            <h2>${esc(setup ? t('Welcome 👋') : t('Welcome back 👋'))}</h2>
            <p>${esc(setup ? t('Let’s create your space. It takes one minute.') : t('Sign in to find your planner.'))}</p>
          </div>
          <div class="form-error" hidden></div>
          ${
            setup && setupCodeRequired
              ? `<div class="field"><label for="a-code">${esc(t('Invitation code'))}</label>
                <input class="input" id="a-code" name="setupCode" autocomplete="off" required autofocus>
                <span class="hint">${esc(t('The code you received with the link.'))}</span></div>`
              : ''
          }
          ${setup ? `<div class="field"><label for="a-name">${esc(t('Your name'))}</label><input class="input" id="a-name" name="name" autocomplete="name" required ${setupCodeRequired ? '' : 'autofocus'}></div>` : ''}
          <div class="field"><label for="a-email">${esc(t('Email'))}</label>
            <input class="input" id="a-email" name="email" type="email" autocomplete="email" required ${setup ? '' : 'autofocus'}>
            ${setup ? `<span class="hint">${esc(t('Reminders will be sent to this address.'))}</span>` : ''}</div>
          <div class="field"><label for="a-pass">${esc(t('Password'))}</label>
            <input class="input" id="a-pass" name="password" type="password" autocomplete="${setup ? 'new-password' : 'current-password'}" required minlength="8">
            ${setup ? `<span class="hint">${esc(t('At least 8 characters.'))}</span>` : ''}</div>
          ${setup ? `<div class="field"><label for="a-lang">${esc(t('Language'))}</label>
            <select class="select" id="a-lang" name="language"><option value="fr">Français</option><option value="en">English</option></select></div>` : ''}
          <button class="btn primary lg block" type="submit">${esc(setup ? t('Create my planner') : t('Sign in'))}</button>
        </form>
      </div>
    </div>`;
  const form = app.querySelector('form');
  if (setup) form.language.value = navigator.language?.startsWith('fr') ? 'fr' : 'en';
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = form.querySelector('button[type=submit]');
    const errBox = form.querySelector('.form-error');
    errBox.hidden = true;
    const body = Object.fromEntries(new FormData(form));
    setBusy(btn, true);
    try {
      await api.post(setup ? '/api/auth/setup' : '/api/auth/login', body);
      if (setup) {
        await api.put('/api/settings', { language: body.language, timezone: tz, notifyEmail: body.email });
      }
      const me = await api.get('/api/auth/me');
      state.user = me.user;
      if (setup) location.hash = '#/welcome';
      await startApp();
    } catch (err) {
      errBox.innerHTML = `${icon('alertCircle')}<span>${esc(err.message === 'offline' ? t('Cannot reach the app. Is it still running?') : t(err.message))}</span>`;
      errBox.hidden = false;
      setBusy(btn, false);
    }
  });
}

// ---------- Shell ----------

function navLink(key, cls = '') {
  const r = ROUTES[key];
  return `<a href="#/${key}" data-route="${key}" class="${cls}">${icon(r.icon)}<span>${esc(t(r.title === 'Search & history' ? 'Search' : r.title))}</span>
    ${key === 'attestations' ? '<span class="badge danger" data-att-badge hidden></span>' : ''}</a>`;
}

let shellLanguage = null;

function renderShell() {
  const u = state.user;
  shellLanguage = state.settings.language;
  app.innerHTML = `
    <div class="app-shell">
      <aside class="sidebar">
        <div class="brand"><div class="brand-logo">${icon('calendar')}</div>
          <div style="min-width:0"><div class="brand-name ellipsis" data-app-name>${esc(appName())}</div><div class="brand-sub">${esc(t('Schedule & attestations'))}</div></div></div>
        <nav class="nav">${NAV.map((k) => navLink(k)).join('')}</nav>
        <div class="sidebar-footer">
          <button class="btn primary sidebar-cta" data-new>${icon('plus')}${esc(t('New appointment'))}</button>
          <nav class="nav">${navLink('settings')}</nav>
          <button class="user-chip" data-route-to="settings">
            <span class="avatar">${esc(initials(u.name))}</span>
            <span style="min-width:0"><div class="name">${esc(u.name)}</div><div class="email">${esc(u.email)}</div></span>
          </button>
        </div>
      </aside>
      <div class="main">
        <header class="topbar">
          <h1 data-title></h1>
          <form class="quick-search input-icon" data-quick-search role="search">
            ${icon('search')}<input class="input" name="q" placeholder="${esc(t('Search everything…'))}" aria-label="${esc(t('Search'))}">
            <span class="kbd">/</span>
          </form>
          <button class="btn ghost icon-only bell" data-bell aria-label="${esc(t('Notifications'))}">${icon('bell')}<span class="dot-count" hidden></span></button>
          <button class="btn primary new-btn" data-new>${icon('plus')}<span>${esc(t('New'))}</span></button>
        </header>
        <main class="content" id="view"></main>
      </div>
    </div>
    <nav class="mobile-nav">${NAV.map((k) => navLink(k)).join('')}</nav>
    <button class="fab" data-new aria-label="${esc(t('New appointment'))}">${icon('plus', 'lg')}</button>`;

  on(app, 'click', '[data-new]', () => openEventForm({}));
  on(app, 'click', '[data-route-to]', (e, b) => (location.hash = `#/${b.dataset.routeTo}`));
  on(app, 'click', '[data-bell]', (e) => {
    e.stopPropagation();
    toggleNotifPanel();
  });
  app.querySelector('[data-quick-search]').addEventListener('submit', (e) => {
    e.preventDefault();
    const q = e.target.q.value.trim();
    location.hash = `#/search${q ? `?q=${encodeURIComponent(q)}` : ''}`;
    e.target.q.value = '';
    e.target.q.blur();
  });
  const topbar = app.querySelector('.topbar');
  window.addEventListener('scroll', () => topbar.classList.toggle('scrolled', window.scrollY > 4), { passive: true });
  updateBadges();
}

subscribe((what) => {
  if (what === 'settings') updateBadges();
  if (what === 'notifications') {
    updateBadges();
    if (panel) renderNotifItems();
  }
  if (what === 'settings' && state.user && app.querySelector('.app-shell') && state.settings.language !== shellLanguage) {
    // Language changed: rebuild the shell so every label is translated.
    const prev = currentRoute;
    renderShell();
    currentRoute = null;
    route(prev);
  }
});

function updateBadges() {
  const { unread, pendingAttestations } = state.notifications;
  app.querySelectorAll('[data-att-badge]').forEach((b) => {
    b.hidden = !pendingAttestations;
    b.textContent = pendingAttestations;
  });
  const dot = app.querySelector('.bell .dot-count');
  if (dot) {
    dot.hidden = !unread;
    dot.textContent = unread > 9 ? '9+' : unread;
  }
  document.title = pendingAttestations ? `(${pendingAttestations}) ${appName()}` : appName();
  app.querySelectorAll('[data-app-name]').forEach((n) => (n.textContent = appName()));
  renderBanner();
}

/** The red banner stays on every page until all overdue attestations are handled. */
function renderBanner() {
  const view = document.getElementById('view');
  if (!view) return;
  let banner = document.querySelector('.att-banner');
  const n = state.notifications.pendingAttestations;
  if (!n || currentRoute === 'attestations' || currentRoute === 'welcome') {
    banner?.remove();
    return;
  }
  const html = `<div class="att-banner" role="alert">
      <span class="pulse">${icon('attestation')}</span>
      <div class="text"><strong>${esc(tn(n, 'You have {n} attestation to collect', 'You have {n} attestations to collect'))}</strong>
      <span>${esc(t('These reminders continue until you mark them as received.'))}</span></div>
      <a class="btn danger sm" href="#/attestations">${esc(t('Review now'))}${icon('arrowR', 'sm')}</a>
    </div>`;
  if (banner) banner.outerHTML = html;
  else view.insertAdjacentHTML('beforebegin', html);
}

// ---------- Notifications panel ----------

let panel = null;
function toggleNotifPanel() {
  if (panel) return closeNotifPanel();
  panel = el(`<div class="notif-panel" role="dialog" aria-label="${esc(t('Notifications'))}">
    <div class="head"><h3>${esc(t('Notifications'))}</h3>
      <button class="btn ghost sm" data-read-all>${esc(t('Mark all as read'))}</button></div>
    <div class="items"></div></div>`);
  document.body.appendChild(panel);
  renderNotifItems();
  refreshNotifications({ announce: false });
  panel.querySelector('[data-read-all]').addEventListener('click', async () => {
    await api.post('/api/notifications/read-all');
    refreshNotifications({ announce: false });
  });
  on(panel, 'click', '[data-notif]', async (e, item) => {
    const id = Number(item.dataset.notif);
    const n = state.notifications.items.find((x) => x.id === id);
    closeNotifPanel();
    if (n && !n.read) api.post(`/api/notifications/${id}/read`).then(() => refreshNotifications({ announce: false }));
    if (n?.eventId) openEventDetails(n.eventId);
  });
  setTimeout(() => document.addEventListener('click', outsideClose), 0);
}
function outsideClose(e) {
  if (panel && !panel.contains(e.target)) closeNotifPanel();
}
function closeNotifPanel() {
  panel?.remove();
  panel = null;
  document.removeEventListener('click', outsideClose);
}
function renderNotifItems() {
  const box = panel.querySelector('.items');
  const items = state.notifications.items;
  if (!items.length) {
    box.innerHTML = `<div class="empty">${icon('bell', 'xl')}<p style="margin-top:8px">${esc(t('No notifications yet.'))}</p></div>`;
    return;
  }
  box.innerHTML = items
    .map(
      (n) => `<div class="notif ${n.type} ${n.read ? '' : 'unread'}" data-notif="${n.id}">
        <span class="ic">${icon(n.type === 'attestation' ? 'attestation' : 'bell')}</span>
        <div style="min-width:0;padding-right:14px"><div class="t">${esc(n.title)}</div>${n.body ? `<div class="b">${esc(n.body)}</div>` : ''}
        <div class="time">${esc(timeAgo(n.createdAt))}</div></div></div>`
    )
    .join('');
}

// ---------- Router ----------

let currentRoute = null;

function parseHash() {
  const raw = location.hash.replace(/^#\/?/, '');
  const [path, query = ''] = raw.split('?');
  return { name: ROUTES[path] ? path : 'today', params: Object.fromEntries(new URLSearchParams(query)) };
}

async function route(force) {
  if (!state.user) return;
  const { name, params } = parseHash();
  // The welcome form is mandatory: until it is finished, every page leads back to it.
  const locked = !state.settings?.onboarding?.completed;
  document.body.classList.toggle('onboarding-lock', locked);
  if (locked && name !== 'welcome') {
    location.hash = '#/welcome';
    return;
  }
  if (typeof force !== 'string' && name === currentRoute && !params._r) {
    // Same page, different query (e.g. a new search): let the view react if it can.
    window.dispatchEvent(new CustomEvent('route-params', { detail: params }));
    return;
  }
  currentRoute = name;
  document.body.classList.toggle('route-welcome', name === 'welcome');
  const token = ++renderToken;
  const r = ROUTES[name];
  closeNotifPanel();
  app.querySelectorAll('[data-route]').forEach((a) => a.classList.toggle('active', a.dataset.route === name));
  app.querySelector('[data-title]').textContent = t(r.title);
  // A fresh container per page, so listeners attached by the previous page can never pile up.
  const oldView = document.getElementById('view');
  const view = oldView.cloneNode(false);
  oldView.replaceWith(view);
  view.classList.toggle('wide', !!r.wide);
  if (cleanup) {
    try {
      cleanup();
    } catch {
      /* ignore */
    }
    cleanup = null;
  }
  view.innerHTML = '<div class="boot" style="height:40vh"><div class="spinner"></div></div>';
  renderBanner();
  try {
    const mod = await r.load();
    if (token !== renderToken) return;
    view.innerHTML = '';
    cleanup = (await mod.render(view, params)) || null;
  } catch (err) {
    console.error(err);
    if (token === renderToken) {
      view.innerHTML = `<div class="empty">${icon('alertCircle', 'xl')}<h3>${esc(t('This page could not be loaded.'))}</h3>
        <p>${esc(t(err.message || ''))}</p><button class="btn primary" onclick="location.reload()">${esc(t('Reload'))}</button></div>`;
    }
  }
  window.scrollTo(0, 0);
}

// ---------- Keyboard shortcuts ----------

document.addEventListener('keydown', (e) => {
  if (!state.user || hasOpenModal() || e.ctrlKey || e.metaKey || e.altKey) return;
  const tag = document.activeElement?.tagName;
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(tag) || document.activeElement?.isContentEditable) return;
  if (e.key === '/') {
    const input = app.querySelector('[data-quick-search] input');
    if (input && input.offsetParent) {
      e.preventDefault();
      input.focus();
    } else location.hash = '#/search';
  } else if (e.key === 'n' || e.key === 'N') {
    e.preventDefault();
    openEventForm({});
  }
});

export function logout() {
  api.post('/api/auth/logout').finally(() => {
    state.user = null;
    stopPolling();
    location.hash = '';
    showAuth('login');
  });
}

boot();
