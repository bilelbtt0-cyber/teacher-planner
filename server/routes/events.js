import { Router } from 'express';
import { db, transaction, getSettings } from '../db.js';
import { normalizeRule, expand, httpError } from '../recurrence.js';
import { isWallClock, addMinutes, diffMinutes, nowIn, datePart } from '../time.js';
import { recomputeCategory, TEACHING_KINDS } from '../attestation.js';
import { cancellingHolidays, holidayFor } from './holidays.js';

export const KINDS = ['class', 'exam', 'meeting', 'personal', 'other'];

export function serializeEvent(row, extra = {}) {
  if (!row) return null;
  let reminders = [];
  try {
    reminders = JSON.parse(row.reminders);
  } catch {
    /* keep empty */
  }
  return {
    id: row.id,
    seriesId: row.series_id,
    title: row.title,
    kind: row.kind,
    categoryId: row.category_id,
    location: row.location,
    start: row.start,
    end: row.end,
    allDay: !!row.all_day,
    notes: row.notes,
    status: row.status,
    cancelReason: row.cancel_reason || null,
    reminders,
    attestation: {
      required: !!row.attestation_required,
      source: row.attestation_source,
      status: row.attestation_status,
      note: row.attestation_note,
      receivedAt: row.attestation_received_at,
      snoozedUntil: row.attestation_snoozed_until,
    },
    documentCount: row.document_count ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...extra,
  };
}

function cleanReminders(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const r of list) {
    const minutes = parseInt(r?.minutes, 10);
    if (!Number.isFinite(minutes) || minutes < 0 || minutes > 40320 || seen.has(minutes)) continue;
    seen.add(minutes);
    out.push({ minutes, email: !!r.email });
  }
  return out.sort((a, b) => a.minutes - b.minutes).slice(0, 6);
}

/** Validates the editable fields of an event payload. Returns a column map. */
async function cleanFields(body, { partial = false } = {}) {
  const f = {};
  if (!partial || body.title !== undefined) {
    const title = String(body.title ?? '').trim();
    if (!title) throw httpError(400, 'Please give the appointment a title.');
    f.title = title.slice(0, 200);
  }
  if (!partial || body.kind !== undefined) {
    f.kind = KINDS.includes(body.kind) ? body.kind : 'class';
  }
  if (!partial || body.categoryId !== undefined) {
    const id = body.categoryId ? parseInt(body.categoryId, 10) : null;
    if (id && !(await db.get('SELECT id FROM categories WHERE id = ?', id))) throw httpError(400, 'That institution no longer exists.');
    f.category_id = id || null;
  }
  if (!partial || body.location !== undefined) f.location = String(body.location ?? '').trim().slice(0, 200);
  if (!partial || body.notes !== undefined) f.notes = String(body.notes ?? '').slice(0, 5000);
  if (!partial || body.reminders !== undefined) f.reminders = JSON.stringify(cleanReminders(body.reminders));
  if (!partial || body.start !== undefined || body.end !== undefined || body.allDay !== undefined) {
    const allDay = !!body.allDay;
    let { start, end } = body;
    if (allDay) {
      start = String(start ?? '').slice(0, 10) + 'T00:00';
      end = String(end ?? '').slice(0, 10) + 'T00:00';
    }
    if (!isWallClock(start) || !isWallClock(end)) throw httpError(400, 'Please choose a valid date and time.');
    if (end <= start) {
      throw httpError(400, allDay ? 'The end date must be on or after the start date.' : 'The end time must be after the start time.');
    }
    if (diffMinutes(start, end) > 31 * 1440) throw httpError(400, 'An appointment cannot last more than 31 days.');
    f.start = start;
    f.end = end;
    f.all_day = allDay ? 1 : 0;
  }
  if (body.status !== undefined) {
    f.status = body.status === 'cancelled' ? 'cancelled' : 'scheduled';
    f.cancel_reason = null;
  }
  if (body.attestation !== undefined) {
    f._attestation = {
      required: !!body.attestation?.required,
      note: String(body.attestation?.note ?? '').slice(0, 1000),
    };
  }
  return f;
}

/** Turns the attestation part of a payload into column updates for one existing (or new) row. */
function attestationColumns(att, row) {
  if (!att) return {};
  const cols = { attestation_note: att.note };
  if (att.required) {
    if (!row || !row.attestation_required) {
      Object.assign(cols, { attestation_required: 1, attestation_source: 'manual', attestation_status: 'pending' });
    } else {
      // Turned back on after "not needed": it is pending again.
      if (row.attestation_status === 'waived') Object.assign(cols, { attestation_status: 'pending', attestation_last_nag_at: null });
      // An automatic flag stays automatic, so it keeps following the hours if sessions change.
    }
  } else if (row && row.attestation_required) {
    if (row.attestation_source === 'auto') {
      // Turning off an automatic flag means "not needed for this one": keep it as a waived checkpoint.
      if (row.attestation_status === 'pending') cols.attestation_status = 'waived';
    } else if (row.attestation_status === 'pending') {
      Object.assign(cols, {
        attestation_required: 0,
        attestation_source: null,
        attestation_status: null,
        attestation_snoozed_until: null,
        attestation_last_nag_at: null,
      });
    }
    // Received/waived history is never erased by an edit.
  }
  return cols;
}

async function updateRow(id, cols) {
  const keys = Object.keys(cols).filter((k) => !k.startsWith('_'));
  if (!keys.length) return;
  await db.run(
    `UPDATE events SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`,
    ...keys.map((k) => cols[k]),
    id
  );
}

async function insertRow(cols) {
  const keys = Object.keys(cols).filter((k) => !k.startsWith('_'));
  const info = await db.run(`INSERT INTO events (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`, ...keys.map((k) => cols[k]));
  return info.lastInsertRowid;
}

/** Deletes sessions and everything that points to them (documents themselves are kept). */
export async function deleteEvents(ids) {
  for (let i = 0; i < ids.length; i += 400) {
    const chunk = ids.slice(i, i + 400);
    const marks = chunk.map(() => '?').join(',');
    await db.run(`DELETE FROM document_events WHERE event_id IN (${marks})`, ...chunk);
    await db.run(`DELETE FROM notifications WHERE event_id IN (${marks})`, ...chunk);
    await db.run(`DELETE FROM events WHERE id IN (${marks})`, ...chunk);
  }
}

async function getRow(id) {
  const row = await db.get('SELECT * FROM events WHERE id = ?', id);
  if (!row) throw httpError(404, 'This appointment no longer exists. It may have been deleted.');
  return row;
}

/** An occurrence is "protected" when it holds history that must survive regenerating a series. */
async function isProtected(row) {
  if (row.attestation_status === 'received' || row.attestation_status === 'waived') return true;
  return (await db.get('SELECT COUNT(*) AS n FROM document_events WHERE event_id = ?', row.id)).n > 0;
}

async function seriesTargets(row, scope) {
  if (!row.series_id || scope === 'this') return [row];
  if (scope === 'all') return db.all('SELECT * FROM events WHERE series_id = ? ORDER BY start', row.series_id);
  return db.all('SELECT * FROM events WHERE series_id = ? AND start >= ? ORDER BY start', row.series_id, row.start);
}

/** Creates occurrences for `rule` starting at fields.start, skipping slots already taken by kept rows. */
async function createSeries(fields, rule, keptStarts = new Set()) {
  const duration = diffMinutes(fields.start, fields.end);
  const starts = expand(fields.start, rule);
  if (!starts.length) throw httpError(400, 'No session matches this repetition. Check the days and the end date.');
  const seriesId = (await db.run('INSERT INTO series (rule) VALUES (?)', JSON.stringify(rule))).lastInsertRowid;
  const holidays = TEACHING_KINDS.includes(fields.kind) ? await cancellingHolidays() : [];
  const ids = [];
  for (const start of starts) {
    if (keptStarts.has(start)) continue;
    const cols = { ...fields, series_id: seriesId, start, end: addMinutes(start, duration) };
    // Classes that fall in a holiday are created already cancelled, and come back if the holiday is removed.
    const holiday = holidayFor(holidays, start);
    if (holiday) Object.assign(cols, { status: 'cancelled', cancel_reason: `holiday:${holiday.id}` });
    ids.push(await insertRow(cols));
  }
  return { seriesId, ids };
}

async function seriesRule(seriesId) {
  if (!seriesId) return null;
  const s = await db.get('SELECT rule FROM series WHERE id = ?', seriesId);
  return s ? JSON.parse(s.rule) : null;
}

export async function loadEvent(id) {
  const row = await getRow(id);
  const documents = await db.all(
    `SELECT d.id, d.title, d.mime, d.doc_date, d.created_at, (d.thumb_name IS NOT NULL OR d.thumb_data IS NOT NULL) AS has_thumb
     FROM document_events de JOIN documents d ON d.id = de.document_id WHERE de.event_id = ? ORDER BY d.created_at DESC`,
    id
  );
  const seriesCount = row.series_id ? (await db.get('SELECT COUNT(*) AS n FROM events WHERE series_id = ?', row.series_id)).n : 0;
  return serializeEvent(row, {
    rule: await seriesRule(row.series_id),
    seriesCount,
    documents: documents.map((d) => ({ ...d, has_thumb: !!d.has_thumb })),
  });
}

const markNotificationsRead = (eventId) =>
  db.run(`UPDATE notifications SET read_at = datetime('now') WHERE event_id = ? AND type = 'attestation' AND read_at IS NULL`, eventId);

export const eventsRouter = Router();

eventsRouter.get('/', async (req, res) => {
  const { start, end } = req.query;
  if (!start || !end) throw httpError(400, 'A date range is required.');
  const from = String(start).slice(0, 16);
  const to = String(end).slice(0, 16);
  const rows = await db.all(
    `SELECT e.*, (SELECT COUNT(*) FROM document_events de WHERE de.event_id = e.id) AS document_count
     FROM events e WHERE e.start < ? AND e.end > ? ORDER BY e.start`,
    to,
    from
  );
  res.json(rows.map((r) => serializeEvent(r)));
});

eventsRouter.get('/:id', async (req, res) => {
  res.json(await loadEvent(parseInt(req.params.id, 10)));
});

eventsRouter.post('/', async (req, res) => {
  const fields = await cleanFields(req.body);
  const rule = req.body.recurrence ? normalizeRule(req.body.recurrence) : null;
  const att = attestationColumns(fields._attestation, null);
  delete fields._attestation;
  const base = { ...fields, ...att };
  const result = await transaction(async () => {
    const ids = rule ? (await createSeries(base, rule)).ids : [await insertRow(base)];
    await recomputeCategory(base.category_id);
    return ids;
  });
  res.status(201).json({ ids: result, event: await loadEvent(result[0]), count: result.length });
});

eventsRouter.put('/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const scope = ['this', 'following', 'all'].includes(req.body.scope) ? req.body.scope : 'this';
  const row = await getRow(id);
  const fields = await cleanFields(req.body);
  const att = fields._attestation;
  delete fields._attestation;
  const hasRecurrenceKey = Object.prototype.hasOwnProperty.call(req.body, 'recurrence');
  const newRule = req.body.recurrence ? normalizeRule(req.body.recurrence) : null;
  const oldRule = await seriesRule(row.series_id);
  const touchedCategories = new Set([row.category_id, fields.category_id]);
  // Attestation settings only spread to other sessions when she actually changed them here,
  // otherwise a single (or automatic) flag would be copied onto the whole series.
  const rowRequired = !!row.attestation_required && row.attestation_status !== 'waived';
  const attChanged = !!att && (att.required !== rowRequired || att.note !== row.attestation_note);
  const attForOthers = attChanged ? att : undefined;

  const affected = await transaction(async () => {
    // Case 1: a single appointment that becomes repeating.
    if (!row.series_id) {
      await updateRow(id, { ...fields, ...attestationColumns(att, row) });
      if (newRule) {
        const updated = await getRow(id);
        const inherit = attChanged || row.attestation_source === 'manual' ? att : undefined;
        const { seriesId } = await createSeries(
          { ...fields, ...attestationColumns(inherit, null), status: 'scheduled' },
          newRule,
          new Set([updated.start])
        );
        await db.run('UPDATE events SET series_id = ? WHERE id = ?', seriesId, id);
      }
      return [id];
    }

    // Case 2: only this occurrence.
    if (scope === 'this') {
      await updateRow(id, { ...fields, ...attestationColumns(att, row) });
      return [id];
    }

    const ruleChanged = hasRecurrenceKey && JSON.stringify(newRule) !== JSON.stringify(oldRule);

    // Case 3: the repetition itself changed: rebuild this and following sessions.
    if (ruleChanged) {
      const following = await db.all('SELECT * FROM events WHERE series_id = ? AND start >= ?', row.series_id, row.start);
      const kept = new Set();
      const others = following.filter((e) => e.id !== id);
      const seriesWide = others.length > 0 && others.every((e) => e.attestation_required && e.attestation_source === 'manual');
      const inherit = attChanged ? att : seriesWide ? { required: true, note: att?.note ?? row.attestation_note } : undefined;
      const toDelete = [];
      for (const e of others) {
        touchedCategories.add(e.category_id);
        if (await isProtected(e)) {
          await db.run('UPDATE events SET series_id = NULL WHERE id = ?', e.id);
          kept.add(e.start);
        } else toDelete.push(e.id);
      }
      await deleteEvents(toDelete);
      await updateRow(id, { ...fields, ...attestationColumns(att, row) });
      if (oldRule) {
        // Close the old series the day before this session, for the record.
        const prevDay = new Date(datePart(row.start) + 'T00:00:00Z');
        prevDay.setUTCDate(prevDay.getUTCDate() - 1);
        const closed = { ...oldRule, until: prevDay.toISOString().slice(0, 10), count: null };
        await db.run('UPDATE series SET rule = ? WHERE id = ?', JSON.stringify(closed), row.series_id);
      }
      if (newRule) {
        const updated = await getRow(id);
        kept.add(updated.start);
        const { seriesId } = await createSeries({ ...fields, ...attestationColumns(inherit, null), status: 'scheduled' }, newRule, kept);
        await db.run('UPDATE events SET series_id = ? WHERE id = ?', seriesId, id);
      } else {
        await db.run('UPDATE events SET series_id = NULL WHERE id = ?', id);
      }
      return [id];
    }

    // Case 4: same repetition, apply the changes to this & following (or all) sessions.
    const targets = await seriesTargets(row, scope);
    const shift = diffMinutes(row.start, fields.start);
    const duration = diffMinutes(fields.start, fields.end);
    const timeChanged = shift !== 0 || duration !== diffMinutes(row.start, row.end) || fields.all_day !== row.all_day;
    for (const t of targets) {
      touchedCategories.add(t.category_id);
      const cols = { ...fields, ...attestationColumns(t.id === id ? att : attForOthers, t) };
      if (t.id !== id) {
        if (timeChanged) {
          cols.start = addMinutes(t.start, shift);
          cols.end = addMinutes(cols.start, duration);
        } else {
          delete cols.start;
          delete cols.end;
        }
        delete cols.status; // cancelling one session should not cancel the others
        delete cols.cancel_reason;
      }
      await updateRow(t.id, cols);
    }
    return targets.map((t) => t.id);
  });

  await transaction(async () => {
    for (const c of touchedCategories) await recomputeCategory(c);
  });
  res.json({ event: await loadEvent(id), affected: affected.length });
});

/** Drag & drop / resize from the calendar. */
eventsRouter.patch('/:id/move', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const scope = req.body.scope === 'following' ? 'following' : 'this';
  const row = await getRow(id);
  const allDay = req.body.allDay !== undefined ? !!req.body.allDay : !!row.all_day;
  let { start, end } = req.body;
  if (allDay) {
    start = String(start).slice(0, 10) + 'T00:00';
    end = end ? String(end).slice(0, 10) + 'T00:00' : addMinutes(start, 1440);
  } else if (!end) {
    // Moving an all-day item into the time grid: give it a one-hour slot.
    end = isWallClock(start) ? addMinutes(start, row.all_day ? 60 : diffMinutes(row.start, row.end)) : null;
  }
  if (!isWallClock(start) || !isWallClock(end) || end <= start) throw httpError(400, 'That move is not valid.');
  const shift = diffMinutes(row.start, start);
  const duration = diffMinutes(start, end);
  const targets = await seriesTargets(row, scope);
  await transaction(async () => {
    for (const t of targets) {
      const s = t.id === id ? start : addMinutes(t.start, shift);
      await db.run(
        `UPDATE events SET start = ?, end = ?, all_day = ?, attestation_last_nag_at = NULL, updated_at = datetime('now') WHERE id = ?`,
        s,
        addMinutes(s, duration),
        allDay ? 1 : 0,
        t.id
      );
    }
    await recomputeCategory(row.category_id);
  });
  res.json({ event: await loadEvent(id), affected: targets.length });
});

eventsRouter.delete('/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const scope = ['this', 'following', 'all'].includes(req.query.scope) ? req.query.scope : 'this';
  const mode = req.query.mode === 'cancel' ? 'cancel' : 'delete';
  const row = await getRow(id);
  const targets = await seriesTargets(row, scope);
  await transaction(async () => {
    if (mode === 'cancel') {
      for (const t of targets) {
        await db.run(`UPDATE events SET status = 'cancelled', cancel_reason = NULL, updated_at = datetime('now') WHERE id = ?`, t.id);
      }
    } else {
      await deleteEvents(targets.map((t) => t.id));
      if (row.series_id) {
        const left = (await db.get('SELECT COUNT(*) AS n FROM events WHERE series_id = ?', row.series_id)).n;
        if (!left) await db.run('DELETE FROM series WHERE id = ?', row.series_id);
      }
    }
    for (const c of new Set(targets.map((t) => t.category_id))) await recomputeCategory(c);
  });
  res.json({ ok: true, affected: targets.length });
});

/** Every attestation state change goes through here. */
eventsRouter.post('/:id/attestation', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const row = await getRow(id);
  const { action } = req.body || {};
  const now = nowIn((await getSettings()).timezone);

  await transaction(async () => {
    switch (action) {
      case 'require':
        await updateRow(id, {
          attestation_required: 1,
          attestation_source: 'manual',
          attestation_status: row.attestation_status === 'received' ? 'received' : 'pending',
          attestation_note: req.body.note !== undefined ? String(req.body.note).slice(0, 1000) : row.attestation_note,
        });
        break;
      case 'received': {
        if (!row.attestation_required) await updateRow(id, { attestation_required: 1, attestation_source: 'manual' });
        await updateRow(id, { attestation_status: 'received', attestation_received_at: now, attestation_snoozed_until: null });
        const docId = req.body.documentId ? parseInt(req.body.documentId, 10) : null;
        if (docId) {
          if (!(await db.get('SELECT id FROM documents WHERE id = ?', docId))) throw httpError(400, 'That document no longer exists.');
          await db.run('INSERT OR IGNORE INTO document_events (document_id, event_id) VALUES (?, ?)', docId, id);
        }
        await markNotificationsRead(id);
        break;
      }
      case 'pending':
        if (!row.attestation_required) throw httpError(400, 'No attestation is required for this appointment.');
        await updateRow(id, { attestation_status: 'pending', attestation_received_at: null, attestation_last_nag_at: null });
        break;
      case 'waived':
        if (!row.attestation_required) throw httpError(400, 'No attestation is required for this appointment.');
        await updateRow(id, { attestation_status: 'waived', attestation_snoozed_until: null });
        await markNotificationsRead(id);
        break;
      case 'snooze': {
        const hours = Math.max(1, Math.min(24 * 7, parseInt(req.body.hours, 10) || 24));
        await updateRow(id, { attestation_snoozed_until: addMinutes(now, hours * 60) });
        break;
      }
      case 'remove':
        if (row.attestation_source === 'auto' && row.attestation_status === 'pending') {
          await updateRow(id, { attestation_status: 'waived' });
        } else {
          await updateRow(id, {
            attestation_required: 0,
            attestation_source: null,
            attestation_status: null,
            attestation_received_at: null,
            attestation_snoozed_until: null,
            attestation_last_nag_at: null,
          });
        }
        break;
      default:
        throw httpError(400, 'Unknown action.');
    }
    await recomputeCategory(row.category_id);
  });
  res.json({ event: await loadEvent(id) });
});

/** Same actions for several sessions at once (one attestation often covers many sessions). */
eventsRouter.post('/bulk-attestation', async (req, res) => {
  const { ids, action } = req.body || {};
  if (!Array.isArray(ids) || !ids.length) throw httpError(400, 'Select at least one session.');
  if (!['received', 'waived', 'snooze'].includes(action)) throw httpError(400, 'Unknown action.');
  const now = nowIn((await getSettings()).timezone);
  const hours = Math.max(1, Math.min(24 * 7, parseInt(req.body.hours, 10) || 24));
  const categories = new Set();
  await transaction(async () => {
    for (const raw of ids) {
      const row = await db.get('SELECT * FROM events WHERE id = ?', parseInt(raw, 10));
      if (!row || !row.attestation_required) continue;
      categories.add(row.category_id);
      if (action === 'snooze') await updateRow(row.id, { attestation_snoozed_until: addMinutes(now, hours * 60) });
      else {
        await updateRow(row.id, {
          attestation_status: action,
          attestation_received_at: action === 'received' ? now : row.attestation_received_at,
          attestation_snoozed_until: null,
        });
        await markNotificationsRead(row.id);
      }
    }
    for (const c of categories) await recomputeCategory(c);
  });
  res.json({ ok: true });
});
