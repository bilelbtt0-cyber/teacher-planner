import { Router } from 'express';
import { putInTrash } from '../trash.js';
import { db, transaction, getSettings } from '../db.js';
import { httpError } from '../errors.js';
import { isWallClock, addMinutes, diffMinutes, nowIn } from '../time.js';
import { recomputeCategory } from '../attestation.js';
import { courseBrief, KINDS } from './courses.js';

export { KINDS };

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
    title: row.title,
    kind: row.kind,
    categoryId: row.category_id,
    courseId: row.course_id ?? null,
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
  if (!partial || body.courseId !== undefined) {
    const id = body.courseId ? parseInt(body.courseId, 10) : null;
    if (id && !(await db.get('SELECT id FROM courses WHERE id = ?', id))) throw httpError(400, 'That course no longer exists.');
    f.course_id = id || null;
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

/** Sessions created by the old weekly timetable that are still to come and hold no history. */
async function generatedFutureSessions(now) {
  return db.all(
    `SELECT e.id, e.category_id FROM events e
     WHERE e.series_id IS NOT NULL AND e.start >= ?
       AND COALESCE(e.attestation_status, '') NOT IN ('received', 'waived')
       AND NOT EXISTS (SELECT 1 FROM document_events de WHERE de.event_id = e.id)`,
    now
  );
}

export async function loadEvent(id) {
  const row = await getRow(id);
  const documents = await db.all(
    `SELECT d.id, d.title, d.mime, d.doc_date, d.created_at, (d.thumb_name IS NOT NULL OR d.thumb_data IS NOT NULL) AS has_thumb
     FROM document_events de JOIN documents d ON d.id = de.document_id WHERE de.event_id = ? ORDER BY d.created_at DESC`,
    id
  );
  return serializeEvent(row, {
    course: await courseBrief(row.course_id),
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

// Sessions no longer repeat. These two let her remove, in one go, the upcoming sessions that the
// old weekly timetable created in advance (past sessions and anything with an attestation or a
// document are always kept).
eventsRouter.get('/generated', async (req, res) => {
  const now = nowIn((await getSettings()).timezone);
  res.json({ upcoming: (await generatedFutureSessions(now)).length });
});

eventsRouter.post('/generated/clear', async (req, res) => {
  const now = nowIn((await getSettings()).timezone);
  const removed = await transaction(async () => {
    const rows = await generatedFutureSessions(now);
    await deleteEvents(rows.map((r) => r.id));
    for (const c of new Set(rows.map((r) => r.category_id))) await recomputeCategory(c);
    return rows.length;
  });
  res.json({ ok: true, removed });
});

eventsRouter.get('/:id', async (req, res) => {
  res.json(await loadEvent(parseInt(req.params.id, 10)));
});

eventsRouter.post('/', async (req, res) => {
  const fields = await cleanFields(req.body);
  const att = attestationColumns(fields._attestation, null);
  delete fields._attestation;
  const id = await transaction(async () => {
    const newId = await insertRow({ ...fields, ...att });
    await recomputeCategory(fields.category_id);
    return newId;
  });
  res.status(201).json({ event: await loadEvent(id) });
});

eventsRouter.put('/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const row = await getRow(id);
  const fields = await cleanFields(req.body);
  const att = fields._attestation;
  delete fields._attestation;
  await transaction(async () => {
    await updateRow(id, { ...fields, ...attestationColumns(att, row) });
    for (const c of new Set([row.category_id, fields.category_id])) await recomputeCategory(c);
  });
  res.json({ event: await loadEvent(id) });
});

/** Drag & drop / resize from the calendar. */
eventsRouter.patch('/:id/move', async (req, res) => {
  const id = parseInt(req.params.id, 10);
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
  await transaction(async () => {
    await db.run(
      `UPDATE events SET start = ?, end = ?, all_day = ?, attestation_last_nag_at = NULL, updated_at = datetime('now') WHERE id = ?`,
      start,
      end,
      allDay ? 1 : 0,
      id
    );
    await recomputeCategory(row.category_id);
  });
  res.json({ event: await loadEvent(id) });
});

eventsRouter.delete('/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const mode = req.query.mode === 'cancel' ? 'cancel' : 'delete';
  const row = await getRow(id);
  let trashId = null;
  await transaction(async () => {
    if (mode === 'cancel') {
      await db.run(`UPDATE events SET status = 'cancelled', cancel_reason = NULL, updated_at = datetime('now') WHERE id = ?`, id);
    } else {
      trashId = await putInTrash('event', row.title, [
        { tbl: 'events', where: 'id = ?', args: [id] },
        { tbl: 'document_events', where: 'event_id = ?', args: [id] },
      ]);
      await deleteEvents([id]);
    }
    await recomputeCategory(row.category_id);
  });
  res.json({ ok: true, trashId });
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
