import { api, qs } from '../api.js';
import { t, getLanguage, dateToWall, nowWall, fmtTime } from '../i18n.js';
import { state, subscribe, activeCategories, eventColor } from '../store.js';
import { esc, icon, on, toast, errorToast, hasOpenModal } from '../ui.js';
import { openEventDetails, openEventForm, askScope, attestationState } from '../eventForm.js';

const VIEW_KEY = 'planner.calView';
const HIDDEN_KEY = 'planner.calHidden';
const CANCELLED_KEY = 'planner.calCancelled';

function read(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : JSON.parse(v);
  } catch {
    return fallback;
  }
}
function write(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* ignore */
  }
}

export async function render(root, params) {
  if (!window.FullCalendar) {
    root.innerHTML = `<div class="empty"><h3>${esc(t('The calendar could not be loaded.'))}</h3></div>`;
    return;
  }
  const mobile = window.matchMedia('(max-width: 860px)').matches;
  const hidden = new Set(read(HIDDEN_KEY, []));
  let showCancelled = read(CANCELLED_KEY, true);
  const settings = state.settings;

  root.innerHTML = `
    <div class="cal-toolbar">
      <div class="flex gap-sm">
        <button class="btn icon-only" data-nav="prev" aria-label="${esc(t('Previous'))}">${icon('chevronL')}</button>
        <button class="btn" data-nav="today">${esc(t('Today'))}</button>
        <button class="btn icon-only" data-nav="next" aria-label="${esc(t('Next'))}">${icon('chevronR')}</button>
      </div>
      <h2 data-cal-title></h2>
      <span class="spacer"></span>
      <input type="date" class="input" data-goto style="width:auto;height:38px" title="${esc(t('Go to date'))}" aria-label="${esc(t('Go to date'))}">
      <div class="segmented" data-views>
        <button data-view="dayGridMonth">${esc(t('Month'))}</button>
        <button data-view="timeGridWeek">${esc(t('Week'))}</button>
        <button data-view="timeGridDay">${esc(t('Day'))}</button>
        <button data-view="listMonth">${esc(t('List'))}</button>
      </div>
    </div>
    <div class="cal-filters" data-filters></div>
    <div class="card cal-card"><div data-cal style="height:${mobile ? 'calc(100vh - 290px)' : 'calc(100vh - 230px)'};min-height:480px"></div></div>
    <p class="small muted" style="margin-top:10px">${icon('info', 'sm')} ${esc(t('Click or drag on the calendar to create an appointment. Drag an appointment to move it.'))}</p>`;

  function drawFilters() {
    const cats = activeCategories();
    root.querySelector('[data-filters]').innerHTML = `
      ${cats
        .map(
          (c) => `<button class="pill ${hidden.has(c.id) ? 'off' : ''}" data-cat="${c.id}" title="${esc(hidden.has(c.id) ? t('Show') : t('Hide'))}">
          <span class="dot" style="background:${c.color}"></span>${esc(c.name)}</button>`
        )
        .join('')}
      ${cats.length ? `<button class="pill ${hidden.has(0) ? 'off' : ''}" data-cat="0"><span class="dot" style="background:#8a8aa0"></span>${esc(t('Other'))}</button>` : ''}
      <span class="spacer"></span>
      <label class="switch small"><input type="checkbox" data-show-cancelled ${showCancelled ? 'checked' : ''}><span class="track"></span>${esc(t('Show cancelled'))}</label>`;
  }
  drawFilters();

  const initialView = params.view || read(VIEW_KEY, mobile ? 'listMonth' : 'timeGridWeek');
  const el = root.querySelector('[data-cal]');

  const calendar = new window.FullCalendar.Calendar(el, {
    initialView,
    initialDate: params.date || undefined,
    locale: getLanguage() === 'fr' ? 'fr' : 'en-gb',
    timeZone: 'local',
    headerToolbar: false,
    height: '100%',
    firstDay: settings.weekStart,
    nowIndicator: true,
    editable: true,
    selectable: true,
    selectMirror: true,
    dayMaxEvents: true,
    navLinks: true,
    weekNumbers: false,
    slotMinTime: '00:00:00',
    slotMaxTime: '24:00:00',
    scrollTime: settings.dayStart + ':00',
    scrollTimeReset: false,
    businessHours: { daysOfWeek: [1, 2, 3, 4, 5, 6], startTime: settings.dayStart, endTime: settings.dayEnd },
    slotDuration: '00:30:00',
    snapDuration: '00:15:00',
    slotLabelFormat: { hour: '2-digit', minute: '2-digit', hour12: false },
    eventTimeFormat: { hour: '2-digit', minute: '2-digit', hour12: false },
    allDayText: t('All day'),
    noEventsText: t('No appointments in this period'),
    longPressDelay: 350,
    views: { listMonth: { listDayFormat: { weekday: 'long', day: 'numeric', month: 'long' }, listDaySideFormat: false } },

    events: async (info, success, failure) => {
      try {
        const [list, holidays] = await Promise.all([
          api.get(`/api/events${qs({ start: dateToWall(info.start), end: dateToWall(info.end) })}`),
          api.get('/api/holidays').catch(() => []),
        ]);
        const holidayEvents = holidays.map((h) => {
          const end = new Date(`${h.end}T12:00`);
          end.setDate(end.getDate() + 1);
          return {
            id: `holiday-${h.id}`,
            title: h.name,
            start: h.start,
            end: dateToWall(end).slice(0, 10),
            allDay: true,
            display: 'background',
            classNames: ['holiday-bg'],
            extendedProps: { holiday: h },
          };
        });
        success(
          holidayEvents.concat(list
            .filter((e) => !hidden.has(e.categoryId || 0) && (showCancelled || e.status !== 'cancelled'))
            .map((e) => ({
              id: String(e.id),
              title: e.title,
              start: e.allDay ? e.start.slice(0, 10) : e.start,
              end: e.allDay ? e.end.slice(0, 10) : e.end,
              allDay: e.allDay,
              editable: e.status !== 'cancelled',
              backgroundColor: eventColor(e),
              borderColor: eventColor(e),
              extendedProps: { ev: e },
            })))
        );
      } catch (err) {
        failure(err);
        errorToast(err);
      }
    },

    eventContent: (arg) => {
      if (arg.event.extendedProps.holiday) return { html: arg.event.display === 'background' ? `<div class="fc-event-title">${esc(arg.event.title)}</div>` : esc(arg.event.title) };
      const e = arg.event.extendedProps.ev;
      const st = attestationState(e);
      const flag =
        st === 'overdue'
          ? `<span class="att-flag overdue" title="${esc(t('Attestation missing'))}">!</span>`
          : st === 'pending'
            ? `<span class="att-flag pending" title="${esc(t('Attestation to ask'))}">!</span>`
            : st === 'received'
              ? `<span class="att-flag received" title="${esc(t('Attestation received'))}">${icon('check')}</span>`
              : '';
      const type = arg.view.type;
      const color = eventColor(e);
      if (type.startsWith('list')) {
        return { html: `<span class="flex gap-sm" style="${e.status === 'cancelled' ? 'text-decoration:line-through;opacity:.6' : ''}">${flag}<b>${esc(e.title)}</b>${e.location ? `<span class="muted">· ${esc(e.location)}</span>` : ''}</span>` };
      }
      const compact = type === 'dayGridMonth' || arg.event.allDay;
      const short = !compact && (arg.event.end - arg.event.start) / 60000 <= 45;
      return {
        html: `<div class="ev ${compact || short ? 'compact' : ''} ${e.status === 'cancelled' ? 'cancelled' : ''}" style="--ev-color:${color}">
          <div class="ev-title">${flag}<span>${esc(e.title)}</span></div>
          ${!arg.event.allDay ? `<div class="ev-time">${fmtTime(e.start)}${compact || short ? '' : ` – ${fmtTime(e.end)}`}</div>` : ''}
          ${!compact && !short && e.location ? `<div class="ev-loc">${esc(e.location)}</div>` : ''}
        </div>`,
      };
    },
    eventDidMount: (arg) => {
      if (arg.event.extendedProps.holiday) return;
      const e = arg.event.extendedProps.ev;
      arg.el.style.setProperty('--ev-color', eventColor(e));
      arg.el.title = `${e.title}${e.location ? ` — ${e.location}` : ''}`;
    },

    eventClick: (info) => {
      info.jsEvent.preventDefault();
      if (info.event.extendedProps.holiday) return;
      openEventDetails(Number(info.event.id));
    },

    select: async (info) => {
      calendar.unselect();
      const allDay = info.allDay && info.view.type !== 'dayGridMonth' ? true : false;
      const multiDay = info.allDay && (info.end - info.start) / 86400000 > 1;
      await openEventForm({
        start: info.allDay ? `${info.startStr.slice(0, 10)}T00:00` : dateToWall(info.start),
        end: info.allDay ? (multiDay ? `${info.endStr.slice(0, 10)}T00:00` : undefined) : dateToWall(info.end),
        allDay: allDay || multiDay,
      });
    },

    eventDrop: (info) => move(info),
    eventResize: (info) => move(info),
    datesSet: (info) => {
      root.querySelector('[data-cal-title]').textContent = info.view.title;
      root.querySelectorAll('[data-view]').forEach((b) => b.classList.toggle('active', b.dataset.view === info.view.type));
      write(VIEW_KEY, info.view.type);
    },
  });

  async function move(info) {
    const e = info.event.extendedProps.ev;
    let scope = 'this';
    if (e.seriesId) {
      scope = await askScope('move');
      if (!scope) return info.revert();
    }
    const allDay = info.event.allDay;
    const start = allDay ? `${info.event.startStr.slice(0, 10)}T00:00` : dateToWall(info.event.start);
    const end = info.event.end ? (allDay ? `${info.event.endStr.slice(0, 10)}T00:00` : dateToWall(info.event.end)) : null;
    try {
      const res = await api.patch(`/api/events/${e.id}/move`, { start, end, allDay, scope });
      calendar.refetchEvents();
      const oldStart = e.start;
      const oldEnd = e.end;
      toast(res.affected > 1 ? t('{n} sessions moved', { n: res.affected }) : t('Appointment moved'), {
        type: 'success',
        action: res.affected === 1 ? t('Undo') : undefined,
        onAction: async () => {
          await api.patch(`/api/events/${e.id}/move`, { start: oldStart, end: oldEnd, allDay: e.allDay, scope: 'this' });
          calendar.refetchEvents();
        },
      });
      import('../store.js').then((m) => m.changed());
    } catch (err) {
      info.revert();
      errorToast(err);
    }
  }

  calendar.render();

  on(root, 'click', '[data-nav]', (e, b) => calendar[b.dataset.nav]());
  on(root, 'click', '[data-view]', (e, b) => calendar.changeView(b.dataset.view));
  root.querySelector('[data-goto]').addEventListener('change', (e) => {
    if (e.target.value) calendar.gotoDate(e.target.value);
  });
  on(root, 'click', '[data-cat]', (e, b) => {
    const id = Number(b.dataset.cat);
    if (hidden.has(id)) hidden.delete(id);
    else hidden.add(id);
    write(HIDDEN_KEY, [...hidden]);
    drawFilters();
    calendar.refetchEvents();
  });
  root.addEventListener('change', (e) => {
    if (e.target.matches('[data-show-cancelled]')) {
      showCancelled = e.target.checked;
      write(CANCELLED_KEY, showCancelled);
      calendar.refetchEvents();
    }
  });

  const onKey = (e) => {
    if (hasOpenModal() || document.querySelector('.drawer') || e.ctrlKey || e.metaKey || e.altKey) return;
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) return;
    if (e.key === 'ArrowLeft') calendar.prev();
    else if (e.key === 'ArrowRight') calendar.next();
    else if (e.key === 't' || e.key === 'T') calendar.today();
    else if (e.key === 'm') calendar.changeView('dayGridMonth');
    else if (e.key === 'w') calendar.changeView('timeGridWeek');
    else if (e.key === 'd') calendar.changeView('timeGridDay');
    else if (e.key === 'l') calendar.changeView('listMonth');
  };
  document.addEventListener('keydown', onKey);

  const unsub = subscribe((what) => {
    if (what === 'data') calendar.refetchEvents();
    if (what === 'categories') {
      drawFilters();
      calendar.refetchEvents();
    }
  });
  const timer = setInterval(() => calendar.refetchEvents(), 5 * 60000);

  return () => {
    unsub();
    clearInterval(timer);
    document.removeEventListener('keydown', onKey);
    calendar.destroy();
  };
}

export { nowWall };
