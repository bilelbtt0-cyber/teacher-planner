import { Router } from 'express';
import { db, transaction, getSettings } from '../db.js';
import { httpError } from '../recurrence.js';
import { recomputeCategory, categoryProgress, ATTESTATION_MODES } from '../attestation.js';
import { nowIn } from '../time.js';

export const serializeCategory = (c) => ({
  id: c.id,
  name: c.name,
  color: c.color,
  attestationMode: c.attestation_mode && ATTESTATION_MODES.includes(c.attestation_mode) ? c.attestation_mode : null,
  attestationEveryHours: c.attestation_every_hours,
  attestationOffsetHours: c.attestation_offset_hours || 0,
  attestationSigner: c.attestation_signer || '',
  attestationSince: c.attestation_since,
  notes: c.notes || '',
  archived: !!c.archived,
  eventCount: c.event_count ?? 0,
});

const num = (v) => (v === '' || v === null || v === undefined ? null : Number(v));

function clean(body) {
  const name = String(body.name ?? '').trim();
  if (!name) throw httpError(400, 'Please enter a name.');
  const color = /^#[0-9a-f]{6}$/i.test(body.color) ? body.color : '#5b5bd6';
  let every = num(body.attestationEveryHours);
  let mode = ATTESTATION_MODES.includes(body.attestationMode) ? body.attestationMode : null;
  // Older clients only send the number of hours: treat it as the "hours" rule.
  if (body.attestationMode === undefined && every) mode = 'hours';
  if (mode === 'hours') {
    if (every === null || !Number.isFinite(every) || every <= 0 || every > 10000)
      throw httpError(400, 'The number of hours must be a positive number.');
  } else every = null;
  let offset = num(body.attestationOffsetHours) ?? 0;
  if (!Number.isFinite(offset) || offset < 0 || offset > 10000) throw httpError(400, 'Hours must be a positive number.');
  if (mode !== 'hours') offset = 0;
  return {
    name: name.slice(0, 120),
    color,
    mode,
    every,
    offset,
    signer: String(body.attestationSigner ?? '').trim().slice(0, 200),
    notes: String(body.notes ?? '').slice(0, 2000),
  };
}

export const categoriesRouter = Router();

categoriesRouter.get('/', async (req, res) => {
  const rows = await db.all(
    `SELECT c.*, (SELECT COUNT(*) FROM events e WHERE e.category_id = c.id) AS event_count
     FROM categories c ORDER BY c.archived, c.name COLLATE NOCASE`
  );
  res.json(rows.map(serializeCategory));
});

categoriesRouter.get('/progress', async (req, res) => {
  res.json(await categoryProgress(nowIn((await getSettings()).timezone)));
});

categoriesRouter.post('/', async (req, res) => {
  const c = clean(req.body);
  const dup = await db.get('SELECT id FROM categories WHERE name = ? COLLATE NOCASE AND archived = 0', c.name);
  if (dup) throw httpError(409, `"${c.name}" already exists.`);
  const since = c.mode ? nowIn((await getSettings()).timezone) : null;
  const { lastInsertRowid: id } = await db.run(
    `INSERT INTO categories (name, color, attestation_mode, attestation_every_hours, attestation_offset_hours,
      attestation_signer, notes, attestation_since) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    c.name, c.color, c.mode, c.every, c.offset, c.signer, c.notes, since
  );
  res.status(201).json(serializeCategory(await db.get('SELECT * FROM categories WHERE id = ?', id)));
});

categoriesRouter.put('/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const existing = await db.get('SELECT * FROM categories WHERE id = ?', id);
  if (!existing) throw httpError(404, 'Not found.');
  const c = clean({ notes: existing.notes, attestationSigner: existing.attestation_signer, ...req.body });
  const dup = await db.get('SELECT id FROM categories WHERE name = ? COLLATE NOCASE AND archived = 0 AND id != ?', c.name, id);
  if (dup) throw httpError(409, `"${c.name}" already exists.`);
  const archived = req.body.archived !== undefined ? (req.body.archived ? 1 : 0) : existing.archived;
  // A changed rule starts counting from now; renaming or recolouring keeps the original start.
  const ruleChanged =
    c.mode !== existing.attestation_mode ||
    (c.every || null) !== (existing.attestation_every_hours || null) ||
    c.offset !== (existing.attestation_offset_hours || 0);
  const since = !c.mode ? null : ruleChanged ? nowIn((await getSettings()).timezone) : existing.attestation_since;
  await transaction(async () => {
    await db.run(
      `UPDATE categories SET name = ?, color = ?, attestation_mode = ?, attestation_every_hours = ?, attestation_offset_hours = ?,
        attestation_signer = ?, notes = ?, attestation_since = ?, archived = ? WHERE id = ?`,
      c.name, c.color, c.mode, c.every, c.offset, c.signer, c.notes, since, archived, id
    );
    await recomputeCategory(id);
  });
  res.json(serializeCategory(await db.get('SELECT * FROM categories WHERE id = ?', id)));
});

categoriesRouter.delete('/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  await transaction(async () => {
    // Remove automatic flags first: without the rule they would be orphans.
    await db.run(
      `UPDATE events SET attestation_required = 0, attestation_source = NULL, attestation_status = NULL
       WHERE category_id = ? AND attestation_source = 'auto' AND attestation_status = 'pending'`,
      id
    );
    // Sessions and documents are kept, simply without an institution.
    await db.run('UPDATE events SET category_id = NULL WHERE category_id = ?', id);
    await db.run('UPDATE documents SET category_id = NULL WHERE category_id = ?', id);
    await db.run('DELETE FROM categories WHERE id = ?', id);
  });
  res.json({ ok: true });
});
