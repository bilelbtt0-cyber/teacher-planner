import { api } from '../api.js';
import { t, tn, fmtDayYear, fmtTime, relativeDay, timeRange, hoursLabel, daysAgo, nowWall, fmtShort, getLanguage } from '../i18n.js';
import { composeDayNote, rememberDayNote } from '../dayNote.js';
import { state, subscribe, categoryById, eventColor } from '../store.js';
import { esc, icon, on, emptyState, toast } from '../ui.js';
import { openEventDetails, openEventForm, markReceivedFlow, attestationAction, attestationChip, kindLabel } from '../eventForm.js';

const TIP_KEY = 'planner.hideEmailTip';
const NOTE_FOLD_KEY = 'planner.dayNoteFolded';

const NOTE_LOOK = {
  morning: { label: 'A word for your morning', icon: 'sun' },
  free: { label: 'A word for your day', icon: 'sun' },
  day: { label: 'Where your day stands', icon: 'clock' },
  evening: { label: 'A word for your evening', icon: 'moon' },
};

function noteHtml(note, folded) {
  const look = NOTE_LOOK[note.phase];
  if (folded) {
    return `<button class="day-note-folded" data-dn-unfold>${icon(look.icon, 'sm')}<span>${esc(t(look.label))}</span>${icon('chevronD', 'sm')}</button>`;
  }
  const fr = getLanguage() === 'fr';
  return `<section class="day-note phase-${note.phase}">
      <div class="dn-head"><span class="dn-ic">${icon(look.icon)}</span><span class="dn-label">${esc(t(look.label))}</span></div>
      <p class="dn-body">${esc(note.body)}</p>
      ${note.tip ? `<p class="dn-tip">${icon('sparkles', 'sm')}<span><strong>${esc(note.tip.label)}</strong> ${esc(note.tip.text)}</span></p>` : ''}
      ${note.closing ? `<p class="dn-closing">${esc(note.closing)}</p>` : ''}
      ${note.quote ? `<blockquote class="dn-quote">${fr ? '« ' : '“'}${esc(note.quote.text)}${fr ? ' »' : '”'}<cite>${esc(note.quote.author)}</cite></blockquote>` : ''}
      <div class="dn-foot"><button class="btn ghost sm" data-dn-fold>${esc(t('Thank you'))} ${icon('check', 'sm')}</button></div>
    </section>`;
}

export async function render(root) {
  let data = null;
  let lastNote = null;

  async function load() {
    try {
      data = await api.get('/api/dashboard');
      draw();
    } catch (err) {
      root.innerHTML = emptyState({ iconName: 'alertCircle', title: t('Could not load your day.'), text: esc(t(err.message)) });
    }
  }

  function greeting() {
    const h = new Date().getHours();
    const first = (state.user?.name || '').split(' ')[0];
    const g = h < 12 ? t('Good morning') : h < 18 ? t('Good afternoon') : t('Good evening');
    return `${g}${first ? `, ${first}` : ''}`;
  }

  function eventItem(e, now) {
    const cat = categoryById(e.categoryId);
    const past = e.end <= now;
    const current = e.start <= now && e.end > now;
    return `<div class="tl-item ${past ? 'past' : ''} ${current ? 'now' : ''} ${e.status === 'cancelled' ? 'cancelled' : ''}" data-event="${e.id}" tabindex="0">
      <div class="tl-time">${e.allDay ? `<div class="t1">${esc(t('All day'))}</div>` : `<div class="t1">${fmtTime(e.start)}</div><div class="t2">${fmtTime(e.end)}</div>`}</div>
      <div class="tl-bar" style="background:${eventColor(e)}"></div>
      <div class="tl-body">
        <div class="title"><span>${esc(e.title)}</span>${current ? `<span class="chip primary">${esc(t('Now'))}</span>` : ''}
          ${e.status === 'cancelled' ? `<span class="chip danger">${esc(t('Cancelled'))}</span>` : attestationChip(e)}</div>
        <div class="meta">${cat ? `<span class="flex gap-sm"><span class="cat-dot" style="background:${cat.color}"></span>${esc(cat.name)}</span>` : `<span>${esc(kindLabel(e.kind))}</span>`}
          ${e.location ? `<span>${icon('pin', 'sm')} ${esc(e.location)}</span>` : ''}</div>
        ${e.courseId && e.status !== 'cancelled' ? `<button class="btn ${current ? 'primary' : 'soft'} sm tl-support" data-support="${e.courseId}">${icon('book', 'sm')}${esc(t('Open the support'))}</button>` : ''}
      </div></div>`;
  }

  function draw() {
    const now = data.now;
    const s = data.stats;
    const pending = data.pendingAttestations;

    // Today timeline with a "now" marker between past and upcoming items.
    let timeline = '';
    if (data.today.length) {
      let markerPlaced = false;
      for (const e of data.today) {
        if (!markerPlaced && !e.allDay && e.start > now) {
          if (data.today.some((x) => !x.allDay && x.end <= now)) timeline += `<div class="now-line">${fmtTime(now)}</div>`;
          markerPlaced = true;
        }
        timeline += eventItem(e, now);
      }
    } else {
      timeline = emptyState({
        iconName: 'sun',
        title: t('Nothing scheduled today'),
        text: esc(t('Enjoy your free day, or add something new.')),
        action: `<button class="btn soft" data-new-today>${icon('plus')}${esc(t('Add an appointment'))}</button>`,
      });
    }

    // Upcoming days, grouped by day.
    const groups = new Map();
    for (const e of data.upcoming) {
      const d = e.start.slice(0, 10);
      if (!groups.has(d)) groups.set(d, []);
      groups.get(d).push(e);
    }
    const upcoming = groups.size
      ? [...groups.entries()]
          .map(
            ([d, list]) => `<div class="day-group"><div class="day-label">${esc(relativeDay(d + 'T00:00'))}</div>${list
              .map(
                (e) => `<div class="list-item" data-event="${e.id}" tabindex="0"><span class="bar" style="background:${eventColor(e)}"></span>
                <div class="body"><div class="title">${esc(e.title)}</div><div class="meta">${esc(timeRange(e))}${
                  categoryById(e.categoryId) ? ` · ${esc(categoryById(e.categoryId).name)}` : ''
                }</div></div>${e.attestation.required && e.attestation.status === 'pending' ? `<span class="att-flag pending" title="${esc(t('Attestation to ask'))}">!</span>` : ''}</div>`
              )
              .join('')}</div>`
          )
          .join('')
      : `<p class="muted small" style="padding:6px">${esc(t('Nothing planned in the next 7 days.'))}</p>`;

    const pendingHtml = pending.length
      ? `<div class="card" style="border-color:color-mix(in srgb,var(--danger) 30%,transparent)">
          <div class="card-header"><span style="color:var(--danger)">${icon('alertCircle')}</span>
            <h2 style="color:var(--danger-text)">${esc(tn(pending.length, '{n} attestation to collect', '{n} attestations to collect'))}</h2>
            <a href="#/attestations" class="btn ghost sm">${esc(t('See all'))}</a></div>
          <div class="card-body att-list">${pending
            .slice(0, 4)
            .map((e) => {
              const days = daysAgo(e.end);
              return `<div class="att-card overdue" style="box-shadow:none">
                <div class="body" data-event="${e.id}"><div class="title">${esc(e.title)}</div>
                <div class="meta">${esc(fmtShort(e.start))} · ${esc(timeRange(e))}${days >= 1 ? ` · <b style="color:var(--danger-text)">${esc(tn(days, '{n} day ago', '{n} days ago'))}</b>` : ''}</div>
                ${e.attestation.note ? `<div class="note">“${esc(e.attestation.note)}”</div>` : ''}</div>
                <div class="actions"><button class="btn success sm" data-received="${e.id}">${icon('check', 'sm')}${esc(t('Received'))}</button>
                <button class="btn ghost sm icon-only" data-snooze="${e.id}" title="${esc(t('Remind me tomorrow'))}">${icon('snooze', 'sm')}</button></div>
              </div>`;
            })
            .join('')}
            ${pending.length > 4 ? `<a href="#/attestations" class="small strong">${esc(tn(pending.length - 4, '+ {n} more', '+ {n} more'))}</a>` : ''}
          </div></div>`
      : '';

    const nextAtt = data.upcomingAttestations.length
      ? data.upcomingAttestations
          .map(
            (e) => `<div class="list-item" data-event="${e.id}" tabindex="0"><span class="att-flag pending">!</span>
            <div class="body"><div class="title">${esc(e.title)}</div><div class="meta">${esc(relativeDay(e.start))} · ${esc(timeRange(e))}</div></div></div>`
          )
          .join('')
      : `<p class="muted small" style="padding:6px">${esc(t('No attestation expected in the next 2 weeks.'))}</p>`;

    const progress = data.progress.length
      ? data.progress
          .map((p) => {
            const pct = Math.min(100, Math.round((p.hoursSinceLast / p.everyHours) * 100));
            return `<div class="progress-item"><div class="top"><span class="cat-dot" style="background:${p.color}"></span>
              <span class="name ellipsis">${esc(p.name)}</span><span class="small strong">${esc(hoursLabel(p.hoursSinceLast))} / ${esc(hoursLabel(p.everyHours))}</span></div>
              <div class="progress"><div style="width:${pct}%;background:${p.color}"></div></div>
              <div class="sub">${p.nextAttestation ? esc(t('Next attestation: {d}', { d: relativeDay(p.nextAttestation.start) })) : esc(t('Not enough sessions planned to reach the next attestation.'))}</div></div>`;
          })
          .join('')
      : `<p class="muted small">${esc(t('Tip: in Settings → Institutions, set “attestation every N hours” and the app will track it for you.'))}</p>`;

    let hideTip = false;
    try {
      hideTip = localStorage.getItem(TIP_KEY) === '1';
    } catch {
      /* ignore */
    }
    const emailTip =
      !data.emailReady && !hideTip
        ? `<div class="tip warning" style="margin-bottom:18px">${icon('mail')}<span>${esc(t('Email reminders are not set up yet. Reminders currently appear only in the app.'))}
            <a href="#/settings?s=email" class="strong">${esc(t('Set up email'))}</a></span>
            <button class="btn ghost sm icon-only close" data-hide-tip aria-label="${esc(t('Close'))}">${icon('x', 'sm')}</button></div>`
        : '';

    const ob = state.settings.onboarding || {};
    const onboard = ob.completed
      ? ''
      : `<div class="onboard-card"><span class="ic">${icon('sparkles')}</span>
          <div class="txt"><strong>${esc(ob.step > 1 ? t('Finish personalising your planner') : t('Make this planner yours'))}</strong>
          <span>${esc(ob.step > 1 ? t('You stopped at step {a} of {b}. Your answers are saved.', { a: ob.step, b: 6 }) : t('Add your institutions, courses and reminders in about 5 minutes.'))}</span></div>
          <a class="btn primary" href="#/welcome">${esc(ob.step > 1 ? t('Continue') : t('Start'))}${icon('arrowR', 'sm')}</a></div>`;
    let noteBlock = '';
    try {
      const note = composeDayNote(data);
      rememberDayNote(note);
      let folded = false;
      try {
        folded = localStorage.getItem(NOTE_FOLD_KEY) === note.key;
      } catch {
        /* ignore */
      }
      noteBlock = `<div data-day-note data-key="${esc(note.key)}">${noteHtml(note, folded)}</div>`;
      lastNote = note;
    } catch (err) {
      console.warn('[day note]', err);
    }
    root.innerHTML = `
      ${onboard}
      <div class="hero">
        <div style="flex:1;min-width:0"><h2>${esc(greeting())}</h2><p class="cap">${esc(fmtDayYear(now))}</p></div>
        <a class="btn" href="#/calendar">${icon('calendar')}${esc(t('Open calendar'))}</a>
      </div>
      ${noteBlock}
      ${emailTip}
      <div class="stats">
        <div class="card stat"><div class="label">${icon('clock', 'sm')}${esc(t('This week'))}</div>
          <div class="value">${esc(hoursLabel(s.weekHoursDone).replace(' h', ''))}<small>/ ${esc(hoursLabel(s.weekHoursPlanned))}</small></div>
          <div class="sub">${esc(t('teaching hours done / planned'))}</div></div>
        <div class="card stat"><div class="label">${icon('calendar', 'sm')}${esc(t('This month'))}</div>
          <div class="value">${esc(hoursLabel(s.monthHoursDone).replace(' h', ''))}<small>/ ${esc(hoursLabel(s.monthHoursPlanned))}</small></div>
          <div class="sub">${esc(t('teaching hours done / planned'))}</div></div>
        <div class="card stat ${pending.length ? 'alert' : ''}" ${pending.length ? 'data-go="attestations"' : ''}>
          <div class="label">${icon('attestation', 'sm')}${esc(t('To collect'))}</div>
          <div class="value">${pending.length}</div><div class="sub">${esc(pending.length ? t('attestations missing') : t('all attestations collected 🎉'))}</div></div>
        <div class="card stat" data-go="documents" style="cursor:pointer"><div class="label">${icon('folder', 'sm')}${esc(t('Documents'))}</div>
          <div class="value">${s.documents}</div><div class="sub">${esc(tn(s.receivedThisYear, '{n} attestation received this year', '{n} attestations received this year'))}</div></div>
      </div>
      <div class="dash-grid">
        <div class="dash-col">
          ${pendingHtml}
          <div class="card"><div class="card-header"><h2>${esc(t('Today'))}</h2>
            <span class="muted small">${esc(tn(data.today.filter((e) => e.status !== 'cancelled').length, '{n} appointment', '{n} appointments'))}</span></div>
            <div class="card-body timeline">${timeline}</div></div>
          <div class="card"><div class="card-header"><h2>${esc(t('Coming up'))}</h2><a href="#/calendar" class="btn ghost sm">${esc(t('Calendar'))}${icon('arrowR', 'sm')}</a></div>
            <div class="card-body">${upcoming}</div></div>
        </div>
        <div class="dash-col">
          <div class="card"><div class="card-header"><h3>${esc(t('Upcoming attestations'))}</h3></div><div class="card-body">${nextAtt}</div></div>
          <div class="card"><div class="card-header"><h3>${esc(t('Hours until next attestation'))}</h3></div><div class="card-body">${progress}</div></div>
          <div class="card card-pad stack tight">
            <h3 style="font-size:15px">${esc(t('Quick actions'))}</h3>
            <button class="btn block" data-scan style="justify-content:flex-start">${icon('scan')}${esc(t('Scan an attestation'))}</button>
            <button class="btn block" data-new-today style="justify-content:flex-start">${icon('plus')}${esc(t('New appointment'))}</button>
            <a class="btn block" href="#/courses" style="justify-content:flex-start">${icon('book')}${esc(t('Plan a session from my courses'))}</a>
            <button class="btn block" data-export-pdf style="justify-content:flex-start">${icon('download')}${esc(t('Download my schedule (PDF)'))}</button>
            <a class="btn block" href="#/search" style="justify-content:flex-start">${icon('search')}${esc(t('Search my history'))}</a>
          </div>
        </div>
      </div>`;
  }

  on(root, 'click', '[data-support]', async (e, b) => {
    e.stopPropagation();
    const { openCourseSupport } = await import('../courses.js');
    openCourseSupport(Number(b.dataset.support));
  });
  on(root, 'click', '[data-event]', (e, n) => {
    if (!e.target.closest('[data-support]')) openEventDetails(Number(n.dataset.event));
  });
  on(root, 'keydown', '[data-event]', (e, n) => e.key === 'Enter' && openEventDetails(Number(n.dataset.event)));
  on(root, 'click', '[data-new-today]', () => openEventForm({}));
  on(root, 'click', '[data-dn-fold], [data-dn-unfold]', (e, b) => {
    const folded = b.matches('[data-dn-fold]');
    try {
      if (folded) localStorage.setItem(NOTE_FOLD_KEY, lastNote.key);
      else localStorage.removeItem(NOTE_FOLD_KEY);
    } catch {
      /* ignore */
    }
    root.querySelector('[data-day-note]').innerHTML = noteHtml(lastNote, folded);
  });
  on(root, 'click', '[data-export-pdf]', async () => {
    const { exportSchedulePdf } = await import('../exportPdf.js');
    exportSchedulePdf();
  });
  on(root, 'click', '[data-go]', (e, n) => (location.hash = `#/${n.dataset.go}`));
  on(root, 'click', '[data-scan]', async () => {
    const { openScanner } = await import('../scanner.js');
    openScanner({ mode: 'choose' });
  });
  on(root, 'click', '[data-hide-tip]', (e, n) => {
    try {
      localStorage.setItem(TIP_KEY, '1');
    } catch {
      /* ignore */
    }
    n.closest('.tip').remove();
  });
  on(root, 'click', '[data-received]', async (e, b) => {
    e.stopPropagation();
    const ev = data.pendingAttestations.find((x) => x.id === Number(b.dataset.received));
    if (ev) await markReceivedFlow(ev);
  });
  on(root, 'click', '[data-snooze]', async (e, b) => {
    e.stopPropagation();
    if (await attestationAction(Number(b.dataset.snooze), 'snooze', { hours: 24 })) toast(t('OK, I will remind you tomorrow.'));
  });

  const unsub = subscribe((what) => {
    if (what === 'data' || what === 'categories') load();
  });
  // Refresh every few minutes so "now" and overdue states stay correct if the page stays open.
  const timer = setInterval(load, 5 * 60000);
  await load();
  return () => {
    unsub();
    clearInterval(timer);
  };
}
