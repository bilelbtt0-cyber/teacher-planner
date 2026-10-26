import { Router } from 'express';
import { putInTrash } from '../trash.js';
import { db, transaction, getSettings } from '../db.js';
import { httpError } from '../errors.js';
import { nowIn } from '../time.js';
import { serializeDoc, DOC_SELECT } from './documents.js';

// A course is what she teaches, saved once: planning a session from it fills in everything,
// and its summary and files are at hand while she gives the lesson.

export const KINDS = ['class', 'exam', 'meeting', 'personal', 'other'];

function serializeCourse(c, extra = {}) {
  return {
    id: c.id,
    title: c.title,
    kind: c.kind,
    categoryId: c.category_id,
    location: c.location,
    durationMinutes: c.duration_minutes,
    summary: c.summary,
    archived: !!c.archived,
    fileCount: c.file_count ?? 0,
    sessionCount: c.session_count ?? 0,
    lastSession: c.last_session ?? null,
    nextSession: c.next_session ?? null,
    createdAt: c.created_at,
    updatedAt: c.updated_at,
    ...extra,
  };
}

const COURSE_SELECT = `
  SELECT c.*,
    (SELECT COUNT(*) FROM documents d WHERE d.course_id = c.id) AS file_count,
    (SELECT COUNT(*) FROM events e WHERE e.course_id = c.id AND e.status = 'scheduled') AS session_count,
    (SELECT MAX(e.start) FROM events e WHERE e.course_id = c.id AND e.status = 'scheduled' AND e.start < ?) AS last_session,
    (SELECT MIN(e.start) FROM events e WHERE e.course_id = c.id AND e.status = 'scheduled' AND e.start >= ?) AS next_session
  FROM courses c`;

async function clean(body) {
  const title = String(body.title ?? '').trim();
  if (!title) throw httpError(400, 'Please give the course a name.');
  const categoryId = body.categoryId ? parseInt(body.categoryId, 10) : null;
  if (categoryId && !(await db.get('SELECT id FROM categories WHERE id = ?', categoryId))) throw httpError(400, 'That institution no longer exists.');
  const duration = parseInt(body.durationMinutes, 10);
  if (!Number.isFinite(duration) || duration < 5 || duration > 1440) throw httpError(400, 'The duration must be between 5 minutes and 24 hours.');
  return {
    title: title.slice(0, 200),
    kind: KINDS.includes(body.kind) ? body.kind : 'class',
    category_id: categoryId || null,
    location: String(body.location ?? '').trim().slice(0, 200),
    duration_minutes: duration,
    summary: String(body.summary ?? '').slice(0, 50000),
    archived: body.archived ? 1 : 0,
  };
}

async function loadCourse(id) {
  const now = nowIn((await getSettings()).timezone);
  const row = await db.get(`${COURSE_SELECT} WHERE c.id = ?`, now, now, id);
  if (!row) throw httpError(404, 'This course no longer exists. It may have been deleted.');
  const files = await db.all(`${DOC_SELECT} WHERE d.course_id = ? ORDER BY d.created_at, d.id`, id);
  return serializeCourse(row, { files: await Promise.all(files.map(serializeDoc)) });
}

/** What a session shows about its course: enough to open the support during the lesson. */
export async function courseBrief(id) {
  if (!id) return null;
  const c = await db.get('SELECT id, title, summary FROM courses WHERE id = ?', id);
  if (!c) return null;
  const files = await db.all('SELECT id, title, mime FROM documents WHERE course_id = ? ORDER BY created_at, id', id);
  return { id: c.id, title: c.title, summary: c.summary, files };
}

export const coursesRouter = Router();

coursesRouter.get('/', async (req, res) => {
  const now = nowIn((await getSettings()).timezone);
  const rows = await db.all(`${COURSE_SELECT} ORDER BY c.archived, c.title COLLATE NOCASE`, now, now);
  res.json(rows.map((r) => serializeCourse(r)));
});

coursesRouter.get('/:id', async (req, res) => {
  res.json(await loadCourse(parseInt(req.params.id, 10)));
});

coursesRouter.post('/', async (req, res) => {
  const f = await clean(req.body || {});
  const keys = Object.keys(f);
  const { lastInsertRowid: id } = await db.run(
    `INSERT INTO courses (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`,
    ...keys.map((k) => f[k])
  );
  res.status(201).json(await loadCourse(id));
});

coursesRouter.put('/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!(await db.get('SELECT id FROM courses WHERE id = ?', id))) throw httpError(404, 'This course no longer exists. It may have been deleted.');
  const f = await clean(req.body || {});
  const keys = Object.keys(f);
  await db.run(`UPDATE courses SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`, ...keys.map((k) => f[k]), id);
  res.json(await loadCourse(id));
});

/** Deletes the course and its support files. Its sessions stay in the calendar and the history. */
coursesRouter.delete('/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const course = await db.get('SELECT title FROM courses WHERE id = ?', id);
  if (!course) return res.json({ ok: true });
  const trashId = await transaction(async () => {
    const eventIds = (await db.all('SELECT id FROM events WHERE course_id = ?', id)).map((e) => e.id);
    const tid = await putInTrash(
      'course',
      course.title,
      [
        { tbl: 'courses', where: 'id = ?', args: [id] },
        { tbl: 'documents', where: 'course_id = ?', args: [id] },
        { tbl: 'document_events', where: 'document_id IN (SELECT id FROM documents WHERE course_id = ?)', args: [id] },
      ],
      { courseId: id, eventIds }
    );
    await db.run('DELETE FROM document_events WHERE document_id IN (SELECT id FROM documents WHERE course_id = ?)', id);
    await db.run('DELETE FROM documents WHERE course_id = ?', id);
    await db.run('UPDATE events SET course_id = NULL WHERE course_id = ?', id);
    await db.run('DELETE FROM courses WHERE id = ?', id);
    return tid;
  });
  res.json({ ok: true, trashId });
});
