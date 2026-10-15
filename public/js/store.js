import { api } from './api.js';
import { setLanguage, t } from './i18n.js';
import { toast } from './ui.js';

const listeners = new Set();

export const state = {
  user: null,
  settings: null,
  categories: [],
  notifications: { unread: 0, pendingAttestations: 0, items: [] },
};

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
export function emit(what) {
  for (const fn of listeners) fn(what);
}

export const categoryById = (id) => state.categories.find((c) => c.id === id) || null;
export const activeCategories = () => state.categories.filter((c) => !c.archived);
export const eventColor = (e) => categoryById(e.categoryId)?.color || '#8a8aa0';

export async function loadCategories() {
  state.categories = await api.get('/api/categories');
  emit('categories');
}

export async function loadSettings() {
  state.settings = await api.get('/api/settings');
  applySettings();
  emit('settings');
}

const media = window.matchMedia('(prefers-color-scheme: dark)');
media.addEventListener('change', () => applyTheme());

export function applyTheme() {
  const pref = state.settings?.theme || 'system';
  const dark = pref === 'dark' || (pref === 'system' && media.matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
}

export function applySettings() {
  setLanguage(state.settings?.language || 'en');
  applyTheme();
}

// ---------- Notifications: polling + browser notifications ----------

const SEEN_KEY = 'planner.lastNotification';
let lastSeen = null;
try {
  lastSeen = localStorage.getItem(SEEN_KEY);
} catch {
  /* storage unavailable */
}
let pollTimer = null;

function browserNotify(n) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  try {
    const notif = new Notification(n.title, { body: n.body, tag: `planner-${n.id}`, icon: '/favicon.svg' });
    notif.onclick = () => {
      window.focus();
      location.hash = n.type === 'attestation' ? '#/attestations' : '#/calendar';
    };
  } catch {
    /* some browsers only allow notifications from a service worker */
  }
}

export async function refreshNotifications({ announce = true } = {}) {
  try {
    const data = await api.get('/api/notifications');
    const fresh = data.items.filter((n) => !n.read && (!lastSeen || `${n.createdAt}#${n.id}` > lastSeen));
    if (data.items.length) {
      const newest = data.items.reduce((max, n) => (`${n.createdAt}#${n.id}` > max ? `${n.createdAt}#${n.id}` : max), lastSeen || '');
      lastSeen = newest;
      try {
        localStorage.setItem(SEEN_KEY, newest);
      } catch {
        /* ignore */
      }
    }
    state.notifications = data;
    emit('notifications');
    if (announce && fresh.length) {
      const top = fresh[0];
      if (document.hidden) fresh.slice(0, 3).forEach(browserNotify);
      else
        toast(top.title, {
          type: top.type === 'attestation' ? 'error' : 'info',
          action: t('View'),
          onAction: () => (location.hash = top.type === 'attestation' ? '#/attestations' : '#/calendar'),
        });
    }
  } catch {
    /* network hiccup: try again on the next tick */
  }
}

export function startPolling() {
  stopPolling();
  refreshNotifications({ announce: false });
  pollTimer = setInterval(refreshNotifications, 30000);
}
export function stopPolling() {
  clearInterval(pollTimer);
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && state.user) refreshNotifications();
});

/** Call after any change that may affect attestations, so badges update immediately. */
export function changed() {
  emit('data');
  refreshNotifications({ announce: false });
}
