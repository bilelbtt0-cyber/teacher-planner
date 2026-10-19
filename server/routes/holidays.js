import { Router } from 'express';
import { db, transaction } from '../db.js';
import { httpError } from '../errors.js';
import { isDateOnly, addDays } from '../time.js';
import { recomputeCategory, TEACHING_KINDS } from '../attestation.js';

const serialize = (h) => ({
  id: h.id,
  name: h.name,
  start: h.start_date,
  end: h.end_date,
  cancelClasses: !!h.cancel_classes,
  cancelledCount: h.cancelled_count ?? undefined,
});

const KIND_LIST = TEACHING_KINDS.map((k) => `'${k}'`).join(',');

async function cancelInside(h) {
  const rows = await db.all(
    `SELECT id, category_id FROM events WHERE status = 'scheduled' AND kind IN (${KIND_LIST}) AND start >= ? AND start < ?`,
    `${h.start_date}T00:00`,
    addDays(`${h.end_date}T00:00`, 1)
  );
  if (rows.length) {
    await db.run(
      `UPDATE events SET status = 'cancelled', cancel_reason = ?, updated_at = datetime('now')
       WHERE status = 'scheduled' AND kind IN (${KIND_LIST}) AND start >= ? AND start < ?`,
      `holiday:${h.id}`,
      `${h.start_date}T00:00`,
      addDays(`${h.end_date}T00:00`, 1)
    );
  }
  return rows;
}

async function restore(holidayId) {
  const rows = await db.all('SELECT id, category_id FROM events WHERE cancel_reason = ?', `holiday:${holidayId}`);
  await db.run(`UPDATE events SET status = 'scheduled', cancel_reason = NULL, updated_at = datetime('now') WHERE cancel_reason = ?`, `holiday:${holidayId}`);
  return rows;
}

function clean(body) {
  const name = String(body.name ?? '').trim().slice(0, 120);
  if (!name) throw httpError(400, 'Please enter a name.');
  if (!isDateOnly(body.start) || !isDateOnly(body.end)) throw httpError(400, 'Please enter a valid date.');
  if (body.end < body.start) throw httpError(400, 'The end date must be on or after the start date.');
  return { name, start: body.start, end: body.end, cancel: body.cancelClasses === false ? 0 : 1 };
}

const recompute = async (rows) => {
  for (const cat of new Set(rows.map((r) => r.category_id))) await recomputeCategory(cat);
};

export const holidaysRouter = Router();

holidaysRouter.get('/', async (req, res) => {
  const rows = await db.all(
    `SELECT h.*, (SELECT COUNT(*) FROM events e WHERE e.cancel_reason = 'holiday:' || h.id) AS cancelled_count
     FROM holidays h ORDER BY h.start_date`
  );
  res.json(rows.map(serialize));
});

holidaysRouter.post('/', async (req, res) => {
  const c = clean(req.body);
  const result = await transaction(async () => {
    const id = (await db.run('INSERT INTO holidays (name, start_date, end_date, cancel_classes) VALUES (?, ?, ?, ?)', c.name, c.start, c.end, c.cancel))
      .lastInsertRowid;
    const h = await db.get('SELECT * FROM holidays WHERE id = ?', id);
    const cancelled = c.cancel ? await cancelInside(h) : [];
    await recompute(cancelled);
    return { id, cancelled: cancelled.length };
  });
  res.status(201).json({ holiday: serialize(await db.get('SELECT * FROM holidays WHERE id = ?', result.id)), cancelled: result.cancelled });
});

holidaysRouter.put('/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!(await db.get('SELECT id FROM holidays WHERE id = ?', id))) throw httpError(404, 'Not found.');
  const c = clean(req.body);
  const cancelledCount = await transaction(async () => {
    const restored = await restore(id);
    await db.run('UPDATE holidays SET name = ?, start_date = ?, end_date = ?, cancel_classes = ? WHERE id = ?', c.name, c.start, c.end, c.cancel, id);
    const h = await db.get('SELECT * FROM holidays WHERE id = ?', id);
    const cancelled = c.cancel ? await cancelInside(h) : [];
    await recompute([...restored, ...cancelled]);
    return cancelled.length;
  });
  res.json({ holiday: serialize(await db.get('SELECT * FROM holidays WHERE id = ?', id)), cancelled: cancelledCount });
});

holidaysRouter.delete('/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const restored = await transaction(async () => {
    const rows = await restore(id);
    await db.run('DELETE FROM holidays WHERE id = ?', id);
    await recompute(rows);
    return rows.length;
  });
  res.json({ ok: true, restored });
});
