import { api, qs } from '../api.js';
import { t, tn, fmtShort, fmtMonthYear, timeRange, hoursLabel, minutesBetween, todayStr, addDaysStr, fmtDate } from '../i18n.js';
import { state, subscribe, categoryById, eventColor } from '../store.js';
import { esc, icon, on, emptyState, debounce } from '../ui.js';
import { openEventDetails, attestationChip, kindLabel, KINDS } from '../eventForm.js';
import { docTypeLabel } from '../scanner.js';

function schoolYear(offset = 0) {
  const today = new Date();
  const startYear = (today.getMonth() >= 8 ? today.getFullYear() : today.getFullYear() - 1) + offset;
  return { from: `${startYear}-09-01`, to: `${startYear + 1}-08-31` };
}

export async function render(root, params) {
  const f = {
    q: params.q || '',
    from: params.from || '',
    to: params.to || '',
    categoryId: params.categoryId || '',
    kind: params.kind || '',
    attestation: params.attestation || '',
    status: params.status || '',
  };
  let result = null;

  const presets = () => {
    const today = todayStr();
    const y = Number(today.slice(0, 4));
    const mo = Number(today.slice(5, 7));
    const first = (yy, mm) => `${yy + Math.floor((mm - 1) / 12)}-${String(((mm - 1 + 120) % 12) + 1).padStart(2, '0')}-01`;
    const m0 = first(y, mo);
    const next = first(y, mo + 1);
    const prev = mo === 1 ? `${y - 1}-12-01` : first(y, mo - 1);
    return [
      { label: t('This month'), from: m0, to: addDaysStr(next, -1) },
      { label: t('Last month'), from: prev, to: addDaysStr(m0, -1) },
      { label: t('This school year'), ...schoolYear(0) },
      { label: t('Last school year'), ...schoolYear(-1) },
      { label: t('All time'), from: '', to: '' },
    ];
  };

  root.innerHTML = `
    <form class="search-hero input-icon" data-form role="search">${icon('search')}
      <input class="input" name="q" value="${esc(f.q)}" placeholder="${esc(t('Search appointments, institutions, notes, documents…'))}" autofocus autocomplete="off"></form>
    <div class="pills" style="margin-bottom:14px" data-presets></div>
    <div class="filters">
      <div class="field"><label>${esc(t('From'))}</label><input class="input" type="date" name="from" value="${esc(f.from)}"></div>
      <div class="field"><label>${esc(t('To'))}</label><input class="input" type="date" name="to" value="${esc(f.to)}"></div>
      <div class="field"><label>${esc(t('Institution'))}</label><select class="select" name="categoryId"><option value="">${esc(t('All'))}</option>
        ${state.categories.map((c) => `<option value="${c.id}" ${String(c.id) === f.categoryId ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></div>
      <div class="field"><label>${esc(t('Type'))}</label><select class="select" name="kind"><option value="">${esc(t('All'))}</option>
        ${KINDS.map((k) => `<option value="${k.value}" ${k.value === f.kind ? 'selected' : ''}>${esc(t(k.label))}</option>`).join('')}</select></div>
      <div class="field"><label>${esc(t('Attestation'))}</label><select class="select" name="attestation">
        <option value="">${esc(t('All'))}</option>
        <option value="required" ${f.attestation === 'required' ? 'selected' : ''}>${esc(t('Needed'))}</option>
        <option value="pending" ${f.attestation === 'pending' ? 'selected' : ''}>${esc(t('Missing / to ask'))}</option>
        <option value="received" ${f.attestation === 'received' ? 'selected' : ''}>${esc(t('Received'))}</option>
        <option value="waived" ${f.attestation === 'waived' ? 'selected' : ''}>${esc(t('Not needed'))}</option>
        <option value="none" ${f.attestation === 'none' ? 'selected' : ''}>${esc(t('No attestation'))}</option></select></div>
      <div class="field"><label>${esc(t('Status'))}</label><select class="select" name="status">
        <option value="">${esc(t('All'))}</option>
        <option value="scheduled" ${f.status === 'scheduled' ? 'selected' : ''}>${esc(t('Held / planned'))}</option>
        <option value="cancelled" ${f.status === 'cancelled' ? 'selected' : ''}>${esc(t('Cancelled'))}</option></select></div>
      <button class="btn ghost" data-reset type="button">${esc(t('Reset'))}</button>
    </div>
    <div data-results></div>`;

  const out = root.querySelector('[data-results]');

  function drawPresets() {
    root.querySelector('[data-presets]').innerHTML = presets()
      .map((p, i) => `<button type="button" class="pill ${p.from === f.from && p.to === f.to && (p.from || f.q || f.categoryId || f.kind || f.attestation || f.status) ? 'active' : ''}" data-preset="${i}">${esc(p.label)}</button>`)
      .join('');
  }

  const anyFilter = () => Object.values(f).some(Boolean);

  async function load() {
    drawPresets();
    history.replaceState(null, '', `#/search${qs(f)}`);
    if (!anyFilter()) {
      out.innerHTML = emptyState({
        iconName: 'search',
        title: t('Search your whole history'),
        text: esc(t('Type a word (a class, an institution, a room…) or pick a period above. Everything you ever planned is kept here.')),
      });
      return;
    }
    out.innerHTML = '<div class="boot" style="height:120px"><div class="spinner"></div></div>';
    try {
      result = await api.get(`/api/search${qs(f)}`);
      draw();
    } catch (err) {
      out.innerHTML = emptyState({ iconName: 'alertCircle', title: t('Search failed.'), text: esc(t(err.message)) });
    }
  }

  function draw() {
    const { events, documents, totalHours, truncated } = result;
    if (!events.length && !documents.length) {
      out.innerHTML = emptyState({ iconName: 'search', title: t('No results'), text: esc(t('Try another word or a wider period.')) });
      return;
    }
    const groups = new Map();
    for (const e of events) {
      const k = e.start.slice(0, 7);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(e);
    }
    const hoursOf = (list) => list.reduce((s, e) => s + (e.allDay || e.status === 'cancelled' || !['class', 'exam'].includes(e.kind) ? 0 : minutesBetween(e.start, e.end) / 60), 0);
    out.innerHTML = `
      ${
        documents.length
          ? `<div class="section-title" style="margin-top:4px">${esc(t('Documents'))} (${documents.length})</div>
          <div class="card"><div class="table-wrap"><table class="table"><tbody>${documents
            .map(
              (d) => `<tr class="clickable" data-doc="${d.id}"><td style="width:36px">${icon('fileText')}</td><td class="strong">${esc(d.title)}</td>
              <td class="muted">${esc(docTypeLabel(d.docType))}</td><td class="muted">${esc(d.categoryName || '')}</td>
              <td class="muted nowrap">${esc(d.docDate ? fmtDate(d.docDate) : '')}</td></tr>`
            )
            .join('')}</tbody></table></div></div>`
          : ''
      }
      ${
        events.length
          ? `<div class="flex wrap" style="margin-top:22px">
            <div class="section-title" style="margin:0">${esc(tn(events.length, '{n} appointment', '{n} appointments'))}${truncated ? ' (300+)' : ''}</div>
            <span class="chip primary">${icon('clock')}${esc(t('{h} of teaching', { h: hoursLabel(totalHours) }))}</span>
            <span class="spacer"></span>
            <button class="btn sm" data-csv>${icon('download', 'sm')}${esc(t('Export CSV'))}</button>
            <button class="btn sm" data-print>${icon('printer', 'sm')}${esc(t('Print'))}</button></div>
            ${[...groups.entries()]
              .map(
                ([k, list]) => `<div class="result-month"><div class="head">${esc(fmtMonthYear(`${k}-01T00:00`))}<span class="badge">${list.length}</span>
                <span class="muted" style="font-weight:500">${esc(hoursLabel(hoursOf(list)))}</span></div>
                <div class="card"><div class="table-wrap"><table class="table"><tbody>${list
                  .map((e) => {
                    const cat = categoryById(e.categoryId);
                    return `<tr class="clickable" data-event="${e.id}" style="${e.status === 'cancelled' ? 'opacity:.55' : ''}">
                    <td style="width:6px;padding:0"><div style="width:4px;height:34px;border-radius:4px;background:${eventColor(e)}"></div></td>
                    <td class="nowrap">${esc(fmtShort(e.start))}<div class="small muted">${esc(timeRange(e))}</div></td>
                    <td><div class="strong" style="${e.status === 'cancelled' ? 'text-decoration:line-through' : ''}">${esc(e.title)}</div>
                      <div class="small muted">${esc(kindLabel(e.kind))}${e.location ? ` · ${esc(e.location)}` : ''}</div></td>
                    <td class="muted">${cat ? `<span class="flex gap-sm"><span class="cat-dot" style="background:${cat.color}"></span>${esc(cat.name)}</span>` : ''}</td>
                    <td>${e.status === 'cancelled' ? `<span class="chip danger">${esc(t('Cancelled'))}</span>` : attestationChip(e)}</td>
                    <td class="num muted">${e.documentCount ? `${icon('fileText', 'sm')} ${e.documentCount}` : ''}</td></tr>`;
                  })
                  .join('')}</tbody></table></div></div></div>`
              )
              .join('')}`
          : ''
      }`;
  }

  function exportCsv() {
    const rows = [[t('Date'), t('Start'), t('End'), t('Title'), t('Type'), t('Institution'), t('Location'), t('Hours'), t('Status'), t('Attestation')]];
    for (const e of result.events) {
      const h = e.allDay ? 0 : minutesBetween(e.start, e.end) / 60;
      rows.push([
        e.start.slice(0, 10),
        e.allDay ? '' : e.start.slice(11, 16),
        e.allDay ? '' : e.end.slice(11, 16),
        e.title,
        kindLabel(e.kind),
        categoryById(e.categoryId)?.name || '',
        e.location,
        String(Math.round(h * 100) / 100).replace('.', state.settings.language === 'fr' ? ',' : '.'),
        e.status === 'cancelled' ? t('Cancelled') : '',
        e.attestation.required ? t(e.attestation.status === 'received' ? 'Received' : e.attestation.status === 'waived' ? 'Not needed' : 'Missing / to ask') : '',
      ]);
    }
    const sep = state.settings.language === 'fr' ? ';' : ',';
    const csv = '﻿' + rows.map((r) => r.map((c) => `"${String(c ?? '').replace(/"/g, '""')}"`).join(sep)).join('\r\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    a.download = `planner-${f.from || 'all'}-${f.to || todayStr()}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  const reload = debounce(load, 300);
  root.querySelector('[data-form]').addEventListener('submit', (e) => {
    e.preventDefault();
    load();
  });
  root.querySelector('[name=q]').addEventListener('input', (e) => {
    f.q = e.target.value.trim();
    reload();
  });
  root.querySelector('.filters').addEventListener('change', (e) => {
    if (e.target.name in f) {
      f[e.target.name] = e.target.value;
      load();
    }
  });
  on(root, 'click', '[data-preset]', (e, b) => {
    const p = presets()[Number(b.dataset.preset)];
    f.from = p.from;
    f.to = p.to;
    root.querySelector('[name=from]').value = p.from;
    root.querySelector('[name=to]').value = p.to;
    load();
  });
  on(root, 'click', '[data-reset]', () => {
    Object.keys(f).forEach((k) => (f[k] = ''));
    root.querySelectorAll('.filters input, .filters select, [name=q]').forEach((i) => (i.value = ''));
    load();
  });
  on(root, 'click', '[data-event]', (e, r) => openEventDetails(Number(r.dataset.event)));
  on(root, 'click', '[data-doc]', async (e, r) => {
    const { openDocument } = await import('./documents.js');
    openDocument(Number(r.dataset.doc));
  });
  on(root, 'click', '[data-csv]', exportCsv);
  on(root, 'click', '[data-print]', () => window.print());

  const onParams = (e) => {
    if (e.detail.q !== undefined && e.detail.q !== f.q) {
      f.q = e.detail.q;
      root.querySelector('[name=q]').value = f.q;
      load();
    }
  };
  window.addEventListener('route-params', onParams);
  const unsub = subscribe((what) => what === 'data' && anyFilter() && load());
  await load();
  return () => {
    unsub();
    window.removeEventListener('route-params', onParams);
  };
}
