import { db, transaction } from './db.js';
import { httpError } from './errors.js';

// Deleted appointments, documents and courses are kept for 30 days, so a wrong tap is never final.
// Rows are copied as they are (files included) and put back with their original ids, which are
// never reused because every table uses AUTOINCREMENT.
export const TRASH_DAYS = 30;
const BLOBS = ['file_data', 'thumb_data'];
// Links that may point to something deleted since: restored as empty rather than refused.
const OPTIONAL_LINKS = { category_id: 'categories', course_id: 'courses', series_id: 'series' };
// Links a row cannot live without: the row is skipped if the other side is gone.
const REQUIRED_LINKS = { document_events: { document_id: 'documents', event_id: 'events' } };

const columnCache = new Map();
async function columns(tbl) {
  if (!columnCache.has(tbl)) columnCache.set(tbl, (await db.all(`PRAGMA table_info(${tbl})`)).map((c) => c.name));
  return columnCache.get(tbl);
}

/** Copies rows of `tbl` matching `where` into a trash item, files included, without passing them through Node. */
async function copyRows(trashId, tbl, where, args) {
  const cols = await columns(tbl);
  const plain = cols.filter((c) => !BLOBS.includes(c));
  const blobs = BLOBS.map((b) => (cols.includes(b) ? b : 'NULL'));
  await db.run(
    `INSERT INTO trash_rows (trash_id, tbl, data, file_data, thumb_data)
     SELECT ?, ?, json_object(${plain.map((c) => `'${c}', ${c}`).join(', ')}), ${blobs.join(', ')} FROM ${tbl} WHERE ${where}`,
    trashId,
    tbl,
    ...args
  );
}

/**
 * Saves what is about to be deleted. `parts` are copied in order, so list parents first
 * (a course before its documents, a document before its links). Call inside the delete's transaction.
 */
export async function putInTrash(kind, title, parts, meta = {}) {
  const { lastInsertRowid: id } = await db.run(
    'INSERT INTO trash (kind, title, meta) VALUES (?, ?, ?)',
    kind,
    String(title || '').slice(0, 200),
    JSON.stringify(meta)
  );
  for (const p of parts) await copyRows(id, p.tbl, p.where, p.args || []);
  return id;
}

async function putBack(row) {
  const saved = Object.keys(JSON.parse(row.data));
  const cols = (await columns(row.tbl)).filter((c) => saved.includes(c) || BLOBS.includes(c));
  const value = (c) => {
    if (BLOBS.includes(c)) return c;
    const v = `json_extract(data, '$.${c}')`;
    return OPTIONAL_LINKS[c] ? `(SELECT id FROM ${OPTIONAL_LINKS[c]} WHERE id = ${v})` : v;
  };
  const guards = Object.entries(REQUIRED_LINKS[row.tbl] || {})
    .map(([c, t]) => ` AND EXISTS (SELECT 1 FROM ${t} WHERE id = json_extract(data, '$.${c}'))`)
    .join('');
  await db.run(`INSERT OR IGNORE INTO ${row.tbl} (${cols.join(', ')}) SELECT ${cols.map(value).join(', ')} FROM trash_rows WHERE id = ?${guards}`, row.id);
}

/** Puts a trash item back where it was. */
export async function restoreFromTrash(id) {
  const item = await db.get('SELECT * FROM trash WHERE id = ?', id);
  if (!item) throw httpError(404, 'This item is no longer in the trash.');
  const rows = await db.all('SELECT id, tbl, data FROM trash_rows WHERE trash_id = ? ORDER BY id', id);
  const categories = new Set();
  await transaction(async () => {
    for (const row of rows) {
      await putBack(row);
      if (row.tbl === 'events') categories.add(JSON.parse(row.data).category_id);
    }
    // A course's sessions stayed in the calendar: link them to it again.
    const meta = JSON.parse(item.meta || '{}');
    if (item.kind === 'course' && meta.courseId && meta.eventIds?.length) {
      const ids = meta.eventIds.map(Number).filter(Number.isInteger);
      for (let i = 0; i < ids.length; i += 400) {
        const chunk = ids.slice(i, i + 400);
        await db.run(`UPDATE events SET course_id = ? WHERE course_id IS NULL AND id IN (${chunk.map(() => '?').join(',')})`, meta.courseId, ...chunk);
      }
    }
    await deleteItem(id);
  });
  // Attestation counters of the institution change when a session comes back.
  const { recomputeCategory } = await import('./attestation.js');
  for (const c of categories) if (c) await recomputeCategory(c);
  return { kind: item.kind, title: item.title };
}

async function deleteItem(id) {
  await db.run('DELETE FROM trash_rows WHERE trash_id = ?', id);
  await db.run('DELETE FROM trash WHERE id = ?', id);
}

export async function deleteFromTrash(id) {
  await transaction(() => deleteItem(id));
}

export async function emptyTrash() {
  await transaction(async () => {
    await db.run('DELETE FROM trash_rows');
    await db.run('DELETE FROM trash');
  });
}

export function listTrash() {
  return db.all(
    `SELECT t.id, t.kind, t.title, t.deleted_at AS deletedAt,
       (SELECT COUNT(*) FROM trash_rows r WHERE r.trash_id = t.id AND r.tbl = 'documents') AS files,
       (SELECT COALESCE(SUM(LENGTH(r.file_data)), 0) FROM trash_rows r WHERE r.trash_id = t.id) AS bytes
     FROM trash t ORDER BY t.deleted_at DESC, t.id DESC`
  );
}

/** Removes for good what has been in the trash longer than TRASH_DAYS. */
export async function purgeTrash() {
  const old = await db.all(`SELECT id FROM trash WHERE deleted_at < datetime('now', '-${TRASH_DAYS} days')`);
  for (const { id } of old) await deleteFromTrash(id);
  return old.length;
}
