import { api, qs } from './api.js';
import { t, fmtDay, fmtDayYear, fmtDate, todayStr, addDaysStr, minutesBetween, hoursLabel } from './i18n.js';
import { state, categoryById, appName } from './store.js';
import { chooseDialog, toast, errorToast } from './ui.js';
import { kindLabel } from './eventForm.js';

// "Download my schedule": one question (which period?) and the PDF downloads right away.

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/** The built-in PDF fonts only know Western European letters: replace the few others we use. */
function pdfText(s) {
  return String(s ?? '')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/…/g, '...')
    .replace(/→/g, '->')
    .replace(/[^\u0000-ÿ]/g, '?');
}

function periods() {
  const today = todayStr();
  const weekStart = state.settings.weekStart === 0 ? 0 : 1;
  const shift = (new Date(`${today}T12:00`).getDay() - weekStart + 7) % 7;
  const thisWeek = addDaysStr(today, -shift);
  const nextWeek = addDaysStr(thisWeek, 7);
  const monthStart = `${today.slice(0, 8)}01`;
  const d = new Date(`${monthStart}T12:00`);
  const nextMonthStart = new Date(d.getFullYear(), d.getMonth() + 1, 1, 12);
  const nm = `${nextMonthStart.getFullYear()}-${String(nextMonthStart.getMonth() + 1).padStart(2, '0')}-01`;
  const afterNext = new Date(d.getFullYear(), d.getMonth() + 2, 1, 12);
  const an = `${afterNext.getFullYear()}-${String(afterNext.getMonth() + 1).padStart(2, '0')}-01`;
  const range = (from, to) => ({ from, to, label: `${fmtDate(from)} - ${fmtDate(addDaysStr(to, -1))}` });
  return {
    week: { title: t('This week'), ...range(thisWeek, nextWeek) },
    nextWeek: { title: t('Next week'), ...range(nextWeek, addDaysStr(nextWeek, 7)) },
    month: { title: t('This month'), ...range(monthStart, nm) },
    nextMonth: { title: t('Next month'), ...range(nm, an) },
  };
}

/** Asks for the period, then downloads the PDF. */
export async function exportSchedulePdf() {
  const P = periods();
  const choice = await chooseDialog({
    title: t('Download my schedule (PDF)'),
    message: t('Choose the period. The PDF downloads right away, ready to print or send.'),
    choices: Object.entries(P).map(([value, p]) => ({ value, label: p.title, description: p.label, icon: 'calendar' })),
  });
  if (!choice) return;
  const p = P[choice];
  try {
    const events = (await api.get(`/api/events${qs({ start: `${p.from}T00:00`, end: `${p.to}T00:00` })}`))
      .filter((e) => e.status !== 'cancelled')
      .sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
    if (!events.length) return toast(t('Nothing planned in this period.'));
    const { loadJsPdf } = await import('./scanner.js');
    const JsPDF = await loadJsPdf();
    const doc = buildPdf(new JsPDF({ unit: 'mm', format: 'a4' }), events, p);
    const name = `${t('Schedule')} ${p.from} ${t('to')} ${addDaysStr(p.to, -1)}.pdf`;
    doc.save(name);
    toast(t('Your schedule has been downloaded.'), { type: 'success' });
  } catch (err) {
    errorToast(err);
  }
}

function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  const n = m ? parseInt(m[1], 16) : 0x8a8aa0;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function buildPdf(doc, events, period) {
  const W = 210;
  const M = 16;
  const bottom = 280;
  let y = 0;
  const accent = hexToRgb(state.settings.accentColor || '#e0457b');

  function header(first) {
    doc.setFillColor(...accent);
    doc.rect(0, 0, W, 4, 'F');
    y = 14;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    doc.setTextColor(120);
    doc.text(pdfText(`${appName()} - ${state.user?.name || ''}`), M, y);
    if (!first) return (y += 8);
    y += 9;
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(19);
    doc.setTextColor(28);
    doc.text(pdfText(t('My schedule')), M, y);
    y += 7;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(11);
    doc.setTextColor(90);
    doc.text(pdfText(`${period.title} : ${period.label}`), M, y);
    y += 9;
  }

  function ensure(space) {
    if (y + space <= bottom) return;
    doc.addPage();
    header(false);
  }

  header(true);
  let currentDay = null;
  let totalMinutes = 0;
  for (const e of events) {
    const dayKey = e.start.slice(0, 10);
    const cat = categoryById(e.categoryId);
    const timeText = e.allDay ? t('All day') : `${e.start.slice(11, 16)} - ${e.end.slice(11, 16)}`;
    const meta = [cat?.name, e.location, e.kind !== 'class' ? kindLabel(e.kind) : ''].filter(Boolean).join('  ·  ');
    doc.setFontSize(11);
    const titleLines = doc.splitTextToSize(pdfText(e.title), W - M - 52);
    const needsAtt = e.attestation?.required && e.attestation.status === 'pending';
    const rowH = 6 + titleLines.length * 5 + (meta ? 5 : 0) + (needsAtt ? 5 : 0);

    if (dayKey !== currentDay) {
      ensure(10 + rowH);
      currentDay = dayKey;
      y += 3;
      doc.setFillColor(244, 244, 248);
      doc.roundedRect(M, y - 5, W - 2 * M, 8, 1.5, 1.5, 'F');
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(11);
      doc.setTextColor(28);
      doc.text(pdfText(cap(fmtDay(`${dayKey}T00:00`))), M + 3, y);
      y += 8;
    } else ensure(rowH);

    const top = y;
    doc.setFillColor(...hexToRgb(cat?.color));
    doc.rect(M + 1, top - 3.5, 1.2, rowH - 3, 'F');
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(10.5);
    doc.setTextColor(60);
    doc.text(pdfText(timeText), M + 5, top);
    doc.setFontSize(11);
    doc.setTextColor(28);
    doc.text(titleLines, M + 40, top);
    y = top + titleLines.length * 5;
    doc.setFont('helvetica', 'normal');
    if (meta) {
      doc.setFontSize(9.5);
      doc.setTextColor(110);
      doc.text(pdfText(meta), M + 40, y);
      y += 5;
    }
    if (needsAtt) {
      doc.setFontSize(9.5);
      doc.setTextColor(180, 35, 42);
      doc.text(pdfText(t('Attestation to ask')), M + 40, y);
      y += 5;
    }
    y += 3;
    if (!e.allDay && ['class', 'exam'].includes(e.kind)) totalMinutes += minutesBetween(e.start, e.end);
  }

  ensure(14);
  y += 4;
  doc.setDrawColor(225);
  doc.line(M, y, W - M, y);
  y += 7;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.setTextColor(28);
  doc.text(pdfText(`${t('Teaching hours')} : ${hoursLabel(totalMinutes / 60)}`), M, y);

  const pages = doc.getNumberOfPages();
  for (let i = 1; i <= pages; i++) {
    doc.setPage(i);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8.5);
    doc.setTextColor(150);
    doc.text(pdfText(t('Printed on {d}', { d: fmtDayYear(`${todayStr()}T00:00`) })), M, 290);
    doc.text(`${i} / ${pages}`, W - M, 290, { align: 'right' });
  }
  return doc;
}
