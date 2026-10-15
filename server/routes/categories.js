import { Router } from 'express';
import { db, transaction, getSettings } from '../db.js';
import { httpError } from '../recurrence.js';
import { recomputeCategory, categoryProgress } from '../attestation.js';
import { nowIn } from '../time.js';

const serialize = (c) => ({
  id: c.id,
  name: c.name,
  color: c.color,
  attestationEveryHours: c.attestation_every_hours,
  archived: !!c.archived,
  eventCount: c.event_count ?? 0,
});

function clean(body) {
  const name = String(body.name ?? '').trim();
  if (!name) throw httpError(400, 'Please enter a name.');
  const color = /^#[0-9a-f]{6}$/i.test(body.color) ? body.color : '#5b5bd6';
  let every = body.attestationEveryHours;
  every = every === '' || every === null || every === undefined ? null : Number(every);
  if (every !== null && (!Number.isFinite(every) || every <= 0 || every > 10000))
    throw httpError(400, 'The number of hours must be a positive number.');
  return { name: name.slice(0, 120), color, every };
}

export const categoriesRouter = Router();

categoriesRouter.get('/', (req, res) => {
  const rows = db
    .prepare(
      `SELECT c.*, (SELECT COUNT(*) FROM events e WHERE e.category_id = c.id) AS event_count
       FROM categories c ORDER BY c.archived, c.name COLLATE NOCASE`
    )
    .all();
  res.json(rows.map(serialize));
});

categoriesRouter.get('/progress', (req, res) => {
  res.json(categoryProgress(nowIn(getSettings().timezone)));
});

categoriesRouter.post('/', (req, res) => {
  const { name, color, every } = clean(req.body);
  const dup = db.prepare('SELECT id FROM categories WHERE name = ? COLLATE NOCASE AND archived = 0').get(name);
  if (dup) throw httpError(409, `"${name}" already exists.`);
  const id = Number(
    db.prepare('INSERT INTO categories (name, color, attestation_every_hours) VALUES (?, ?, ?)').run(name, color, every)
      .lastInsertRowid
  );
  res.status(201).json(serialize(db.prepare('SELECT * FROM categories WHERE id = ?').get(id)));
});

categoriesRouter.put('/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const existing = db.prepare('SELECT * FROM categories WHERE id = ?').get(id);
  if (!existing) throw httpError(404, 'Not found.');
  const { name, color, every } = clean(req.body);
  const dup = db.prepare('SELECT id FROM categories WHERE name = ? COLLATE NOCASE AND archived = 0 AND id != ?').get(name, id);
  if (dup) throw httpError(409, `"${name}" already exists.`);
  const archived = req.body.archived !== undefined ? (req.body.archived ? 1 : 0) : existing.archived;
  transaction(() => {
    db.prepare('UPDATE categories SET name = ?, color = ?, attestation_every_hours = ?, archived = ? WHERE id = ?').run(
      name,
      color,
      every,
      archived,
      id
    );
    recomputeCategory(id);
  });
  res.json(serialize(db.prepare('SELECT * FROM categories WHERE id = ?').get(id)));
});

categoriesRouter.delete('/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  transaction(() => {
    // Remove automatic flags first: without the rule they would be orphans.
    db.prepare(
      `UPDATE events SET attestation_required = 0, attestation_source = NULL, attestation_status = NULL
       WHERE category_id = ? AND attestation_source = 'auto' AND attestation_status = 'pending'`
    ).run(id);
    db.prepare('DELETE FROM categories WHERE id = ?').run(id);
  });
  res.json({ ok: true });
});
