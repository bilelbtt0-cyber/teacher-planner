import { api } from '../api.js';
import { t, tn, fmtMonthShort, timeRange, relativeDay, daysAgo, hoursLabel, fmtDate, minutesBetween, nowWall, fmtShort, fmtTime } from '../i18n.js';
import { state, subscribe, categoryById, eventColor, changed } from '../store.js';
import { esc, icon, on, emptyState, toast, errorToast, confirmDialog } from '../ui.js';
import { openEventDetails, markReceivedFlow, attestationAction, openCategoryForm, ruleDescription } from '../eventForm.js';

const TABS = [
  { key: 'overdue', label: 'To collect', icon: 'alertCircle' },
  { key: 'upcoming', label: 'Upcoming', icon: 'hourglass' },
  { key: 'received', label: 'Received', icon: 'checkCircle' },
  { key: 'waived', label: 'Not needed', icon: 'ban' },
];

export async function render(root, params) {
  let data = null;
  let tab = TABS.some((x) => x.key === params.tab) ? params.tab : 'overdue';
  const selected = new Set();

  async function load() {
    try {
      data = await api.get('/api/attestations');
      for (const id of [...selected]) if (!data.overdue.some((e) => e.id === id) && !data.upcoming.some((e) => e.id === id)) selected.delete(id);
      draw();
    } catch (err) {
      root.innerHTML = emptyState({ iconName: 'alertCircle', title: t('Could not load attestations.'), text: esc(t(err.message)) });
    }
  }

  function card(e, kind) {
    const cat = categoryById(e.categoryId);
    const d = new Date(`${e.start.slice(0, 10)}T12:00`);
    const days = kind === 'overdue' ? daysAgo(e.end) : 0;
    const hours = e.allDay ? 0 : minutesBetween(e.start, e.end) / 60;
    const now = nowWall();
    const snoozed = e.attestation.snoozedUntil && e.attestation.snoozedUntil > now;
    const selectable = kind === 'overdue' || kind === 'upcoming';
    let actions = '';
    if (kind === 'overdue') {
      actions = `<button class="btn success sm" data-received="${e.id}">${icon('check', 'sm')}${esc(t('Received'))}</button>
        <button class="btn sm" data-snooze="${e.id}" title="${esc(t('Remind me tomorrow'))}">${icon('snooze', 'sm')}<span>${esc(t('Tomorrow'))}</span></button>
        <button class="btn ghost sm" data-waive="${e.id}">${esc(t('Not needed'))}</button>`;
    } else if (kind === 'upcoming') {
      actions = `<button class="btn sm" data-received="${e.id}">${icon('check', 'sm')}${esc(t('Already received'))}</button>
        <button class="btn ghost sm" data-waive="${e.id}">${esc(t('Not needed'))}</button>`;
    } else if (kind === 'received') {
      actions = e.documentCount
        ? `<span class="chip success">${icon('fileText')}${esc(tn(e.documentCount, '{n} document', '{n} documents'))}</span>`
        : `<button class="btn soft sm" data-attach="${e.id}">${icon('scan', 'sm')}${esc(t('Add the scan'))}</button>`;
    } else {
      actions = `<button class="btn ghost sm" data-undo="${e.id}">${icon('undo', 'sm')}${esc(t('Undo'))}</button>`;
    }
    return `<div class="att-card ${kind}">
      ${selectable ? `<input type="checkbox" class="check" data-select="${e.id}" ${selected.has(e.id) ? 'checked' : ''} aria-label="${esc(t('Select'))}">` : ''}
      <div class="date-box"><div class="d">${d.getDate()}</div><div class="m">${esc(fmtMonthShort(e.start))}</div></div>
      <div class="body" data-event="${e.id}">
        <div class="title"><span class="cat-dot" style="background:${eventColor(e)}"></span>${esc(e.title)}
          ${e.attestation.source === 'auto' ? `<span class="chip primary" title="${esc(t('Flagged automatically from the hours rule'))}">${icon('sparkles')}${esc(t('auto'))}</span>` : ''}
          ${days >= 1 ? `<span class="chip danger">${esc(tn(days, '{n} day overdue', '{n} days overdue'))}</span>` : ''}
          ${snoozed ? `<span class="chip">${icon('snooze')}${esc(t('snoozed'))}</span>` : ''}</div>
        <div class="meta"><span>${esc(relativeDay(e.start))} · ${esc(timeRange(e))}</span>
          ${cat ? `<span>${esc(cat.name)}</span>` : ''}${hours ? `<span>${esc(hoursLabel(hours))}</span>` : ''}
          ${kind === 'received' && e.attestation.receivedAt ? `<span>${esc(t('received {d}', { d: fmtDate(e.attestation.receivedAt) }))}</span>` : ''}</div>
        ${e.attestation.note ? `<div class="note">“${esc(e.attestation.note)}”</div>` : ''}
      </div>
      <div class="actions">${actions}</div>
    </div>`;
  }

  function progressPanel() {
    const rules = data.progress.filter((p) => p.mode);
    const without = data.progress.filter((p) => !p.mode);
    const nextLine = (p) =>
      p.nextAttestation
        ? esc(t('Next: {d}', { d: `${fmtShort(p.nextAttestation.start)} ${fmtTime(p.nextAttestation.start)}` }))
        : esc(t('Plan more sessions to see the next one.'));
    return `<div class="card"><div class="card-header"><h3>${esc(t('Attestation rules'))}</h3></div>
      <div class="card-body">
        <p class="small muted" style="margin-bottom:14px">${esc(t('Each institution can give attestations every N hours, after each session or once a month. The app flags the right sessions for you.'))}</p>
        ${rules
          .map((p) => {
            const cat = categoryById(p.id);
            const head = `<div class="top"><span class="cat-dot" style="background:${p.color}"></span>
              <span class="name ellipsis">${esc(p.name)}</span>
              <button class="btn ghost sm icon-only" data-edit-cat="${p.id}" title="${esc(t('Edit'))}">${icon('edit', 'sm')}</button></div>`;
            if (p.mode === 'hours') {
              const pct = Math.min(100, Math.round((p.hoursSinceLast / p.everyHours) * 100));
              return `<div class="progress-item">${head}
                <div class="progress"><div style="width:${pct}%;background:${p.color}"></div></div>
                <div class="sub">${esc(t('{a} of {b} since the last attestation', { a: hoursLabel(p.hoursSinceLast), b: hoursLabel(p.everyHours) }))}<br>
                ${nextLine(p)} · ${esc(t('total {h}', { h: hoursLabel(p.totalHours) }))}</div></div>`;
            }
            return `<div class="progress-item">${head}
              <div class="sub" style="margin-top:0">${esc(ruleDescription(cat))}<br>${nextLine(p)}</div></div>`;
          })
          .join('')}
        ${!rules.length ? `<p class="small" style="margin-bottom:10px">${esc(t('No rule yet.'))}</p>` : ''}
        ${
          without.length
            ? `<div class="stack tight" style="margin-top:16px"><span class="label">${esc(t('Add a rule to'))}</span><div class="pills">${without
                .map((c) => `<button class="pill" data-edit-cat="${c.id}"><span class="dot" style="background:${c.color}"></span>${esc(c.name)}</button>`)
                .join('')}</div></div>`
            : `<button class="btn soft sm" data-new-cat style="margin-top:12px">${icon('plus', 'sm')}${esc(t('New institution'))}</button>`
        }
      </div></div>`;
  }

  // History from past years is easier to read grouped by school year (September → June).
  const schoolYear = (w) => {
    const first = Number(w.slice(0, 4)) - (Number(w.slice(5, 7)) >= 9 ? 0 : 1);
    return `${first}–${first + 1}`;
  };
  function listHtml(list, kind) {
    const years = new Set(list.map((e) => schoolYear(e.start)));
    if (!['received', 'waived'].includes(kind) || years.size < 2) return list.map((e) => card(e, kind)).join('');
    let last = '';
    return list
      .map((e) => {
        const y = schoolYear(e.start);
        const head = y !== last ? `<div class="att-year">${esc(t('School year {y}', { y }))}</div>` : '';
        last = y;
        return head + card(e, kind);
      })
      .join('');
  }

  function draw() {
    const list = data[tab];
    const counts = Object.fromEntries(TABS.map((x) => [x.key, data[x.key].length]));
    const empties = {
      overdue: { iconName: 'checkCircle', title: t('All attestations collected'), text: esc(t('Nothing is missing. Well done!')) },
      upcoming: { iconName: 'hourglass', title: t('No upcoming attestation'), text: esc(t('Turn on “Attestation needed” on an appointment, or set an hours rule for an institution.')) },
      received: { iconName: 'inbox', title: t('No attestation received yet'), text: esc(t('Received attestations will be listed here, with their scans.')) },
      waived: { iconName: 'ban', title: t('Nothing here'), text: esc(t('Sessions marked “not needed” appear here.')) },
    };
    const selectable = tab === 'overdue' || tab === 'upcoming';
    const selCount = [...selected].filter((id) => list.some((e) => e.id === id)).length;
    root.innerHTML = `
      <div class="split">
        <div style="min-width:0">
          <div class="tabs" role="tablist">${TABS.map(
            (x) => `<button role="tab" data-tab="${x.key}" class="${tab === x.key ? 'active' : ''}">${icon(x.icon, 'sm')}${esc(t(x.label))}
              ${counts[x.key] ? `<span class="badge ${x.key === 'overdue' ? 'danger' : ''}">${counts[x.key]}</span>` : ''}</button>`
          ).join('')}</div>
          ${tab === 'overdue' && list.length ? `<div class="tip" style="margin-bottom:14px">${icon('info')}<span>${esc(t('One attestation for several sessions? Tick them and mark them received together with a single scan.'))}</span></div>` : ''}
          ${selectable && list.length > 1 ? `<label class="flex small muted" style="margin:0 0 10px 18px;cursor:pointer"><input type="checkbox" data-select-all ${selCount === list.length ? 'checked' : ''} style="accent-color:var(--primary);width:17px;height:17px">${esc(t('Select all'))}</label>` : ''}
          <div class="att-list">${list.length ? listHtml(list, tab) : emptyState(empties[tab])}</div>
          ${
            selectable && selCount
              ? `<div class="bulk-bar"><b>${esc(tn(selCount, '{n} selected', '{n} selected'))}</b><span class="spacer"></span>
              <button class="btn success sm" data-bulk="received">${icon('check', 'sm')}${esc(t('Mark received'))}</button>
              ${tab === 'overdue' ? `<button class="btn ghost sm" data-bulk="snooze">${icon('snooze', 'sm')}${esc(t('Tomorrow'))}</button>` : ''}
              <button class="btn ghost sm" data-bulk="waived">${esc(t('Not needed'))}</button>
              <button class="btn ghost sm icon-only" data-bulk="clear" aria-label="${esc(t('Clear selection'))}">${icon('x', 'sm')}</button></div>`
              : ''
          }
        </div>
        <div class="stack">${progressPanel()}
          <div class="card card-pad stack tight"><h3 style="font-size:15px">${esc(t('How reminders work'))}</h3>
            <p class="small muted">${esc(t('When a session that needs an attestation ends, you get a notification in the app and an email. It repeats until you mark it as received or not needed.'))}</p>
            <a href="#/settings?s=notifications" class="small strong">${esc(t('Change reminder frequency'))} →</a></div>
        </div>
      </div>`;
  }

  const find = (id) => [...data.overdue, ...data.upcoming, ...data.received, ...data.waived].find((e) => e.id === Number(id));

  on(root, 'click', '[data-tab]', (e, b) => {
    tab = b.dataset.tab;
    selected.clear();
    history.replaceState(null, '', `#/attestations?tab=${tab}`);
    draw();
  });
  on(root, 'click', '[data-event]', (e, n) => openEventDetails(Number(n.dataset.event)));
  on(root, 'change', '[data-select]', (e, c) => {
    const id = Number(c.dataset.select);
    if (c.checked) selected.add(id);
    else selected.delete(id);
    draw();
  });
  on(root, 'change', '[data-select-all]', (e, c) => {
    for (const ev of data[tab]) c.checked ? selected.add(ev.id) : selected.delete(ev.id);
    draw();
  });
  on(root, 'click', '[data-received]', async (e, b) => {
    const ev = find(b.dataset.received);
    if (ev) await markReceivedFlow(ev);
  });
  on(root, 'click', '[data-attach]', async (e, b) => {
    const { openScanner } = await import('../scanner.js');
    await openScanner({ mode: 'choose', events: [find(b.dataset.attach)], markReceived: true });
  });
  on(root, 'click', '[data-snooze]', async (e, b) => {
    if (await attestationAction(Number(b.dataset.snooze), 'snooze', { hours: 24 })) toast(t('OK, I will remind you tomorrow.'));
  });
  on(root, 'click', '[data-waive]', async (e, b) => {
    const ok = await confirmDialog({
      title: t('No attestation needed?'),
      message: t('Reminders for this session will stop. You can undo this at any time.'),
      confirm: t('Not needed'),
    });
    if (ok && (await attestationAction(Number(b.dataset.waive), 'waived'))) {
      toast(t('Marked as not needed'), { action: t('Undo'), onAction: () => attestationAction(Number(b.dataset.waive), 'pending') });
    }
  });
  on(root, 'click', '[data-undo]', (e, b) => attestationAction(Number(b.dataset.undo), 'pending'));
  on(root, 'click', '[data-edit-cat]', (e, b) => {
    const cat = categoryById(Number(b.dataset.editCat));
    if (cat) openCategoryForm(cat);
  });
  on(root, 'click', '[data-new-cat]', () => openCategoryForm());
  on(root, 'click', '[data-bulk]', async (e, b) => {
    const action = b.dataset.bulk;
    const ids = [...selected].filter((id) => data[tab].some((x) => x.id === id));
    if (action === 'clear') {
      selected.clear();
      return draw();
    }
    if (action === 'received') {
      if (await markReceivedFlow(ids.map(find))) selected.clear();
      return;
    }
    try {
      await api.post('/api/events/bulk-attestation', { ids, action, hours: 24 });
      selected.clear();
      changed();
      toast(action === 'snooze' ? t('OK, I will remind you tomorrow.') : tn(ids.length, '{n} session marked as not needed', '{n} sessions marked as not needed'));
    } catch (err) {
      errorToast(err);
    }
  });

  const unsub = subscribe((what) => {
    if (what === 'data' || what === 'categories') load();
  });
  await load();
  return unsub;
}
