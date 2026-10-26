import { Router } from 'express';
import multer from 'multer';
import fs from 'node:fs';
import path from 'node:path';
import { putInTrash } from '../trash.js';
import { db, transaction, getSettings, UPLOAD_DIR } from '../db.js';
import { httpError } from '../errors.js';
import { isDateOnly, nowIn } from '../time.js';
import { recomputeCategory } from '../attestation.js';

export const DOC_TYPES = ['attestation', 'certificate', 'contract', 'support', 'other'];
export const ALLOWED = {
  'application/pdf': '.pdf',
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  // Course material is often prepared in Word, PowerPoint or Excel.
  'application/msword': '.doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/vnd.ms-powerpoint': '.ppt',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx',
  'application/vnd.ms-excel': '.xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
  'application/vnd.oasis.opendocument.text': '.odt',
  'application/vnd.oasis.opendocument.presentation': '.odp',
  'text/plain': '.txt',
};
const MIME_BY_EXT = Object.fromEntries(Object.entries(ALLOWED).map(([mime, ext]) => [ext, mime]));
MIME_BY_EXT['.jpeg'] = 'image/jpeg';
export const MAX_FILE_MB = 15;

// Files are kept in memory just long enough to be written into the database.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_MB * 1024 * 1024, files: 2 },
  fileFilter: (req, file, cb) => {
    if (file.fieldname === 'thumb' && file.mimetype !== 'image/jpeg') return cb(httpError(400, 'Invalid thumbnail.'));
    // Some browsers send Office files without a type: recognise them by their extension.
    if (!ALLOWED[file.mimetype]) file.mimetype = MIME_BY_EXT[path.extname(file.originalname || '').toLowerCase()] || file.mimetype;
    if (ALLOWED[file.mimetype]) cb(null, true);
    else cb(httpError(400, 'This type of file cannot be saved. Use PDF, photos, Word, PowerPoint or Excel.'));
  },
});

function uploadFiles(req, res, next) {
  upload.fields([
    { name: 'file', maxCount: 1 },
    { name: 'thumb', maxCount: 1 },
  ])(req, res, (err) => {
    if (err?.code === 'LIMIT_FILE_SIZE') return next(httpError(400, `This file is larger than ${MAX_FILE_MB} MB.`));
    next(err);
  });
}

function removeLegacyFile(name) {
  if (!name || name.startsWith('db:')) return;
  fs.rm(path.join(UPLOAD_DIR, path.basename(name)), { force: true }, () => {});
}

async function linkedEvents(docId) {
  const rows = await db.all(
    `SELECT e.id, e.title, e.start, e.end, e.attestation_status FROM document_events de
     JOIN events e ON e.id = de.event_id WHERE de.document_id = ? ORDER BY e.start`,
    docId
  );
  return rows.map((e) => ({ id: e.id, title: e.title, start: e.start, end: e.end, attestationStatus: e.attestation_status }));
}

export async function serializeDoc(d) {
  return {
    id: d.id,
    title: d.title,
    mime: d.mime,
    size: d.size,
    originalName: d.original_name,
    docType: d.doc_type,
    docDate: d.doc_date,
    periodFrom: d.period_from,
    periodTo: d.period_to,
    hours: d.hours,
    categoryId: d.category_id,
    categoryName: d.category_name ?? null,
    categoryColor: d.category_color ?? null,
    courseId: d.course_id ?? null,
    courseTitle: d.course_title ?? null,
    hasText: !!d.has_text,
    hasThumb: !!d.has_thumb || d.mime.startsWith('image/'),
    events: await linkedEvents(d.id),
    notes: d.notes,
    tags: d.tags ? d.tags.split(',').filter(Boolean) : [],
    pages: d.pages,
    createdAt: d.created_at,
    updatedAt: d.updated_at,
  };
}

// Never select the file contents when listing: only when a file is actually opened.
export const DOC_SELECT = `
  SELECT d.id, d.title, d.file_name, d.original_name, d.mime, d.size, d.doc_type, d.doc_date, d.period_from, d.period_to,
    d.hours, d.category_id, d.course_id, d.notes, d.tags, d.pages, d.created_at, d.updated_at,
    (d.thumb_name IS NOT NULL OR d.thumb_data IS NOT NULL) AS has_thumb, (d.ocr_text != '') AS has_text,
    c.name AS category_name, c.color AS category_color, co.title AS course_title
  FROM documents d
  LEFT JOIN categories c ON c.id = d.category_id
  LEFT JOIN courses co ON co.id = d.course_id`;

async function parseIds(v) {
  if (v === undefined) return undefined;
  let list = v;
  if (typeof v === 'string') {
    try {
      list = v.trim().startsWith('[') ? JSON.parse(v) : v.split(',');
    } catch {
      list = [];
    }
  }
  if (!Array.isArray(list)) list = [list];
  const ids = [...new Set(list.map((x) => parseInt(x, 10)).filter((x) => x > 0))];
  for (const id of ids) {
    if (!(await db.get('SELECT id FROM events WHERE id = ?', id))) throw httpError(400, 'One of the linked appointments no longer exists.');
  }
  return ids;
}

async function cleanMeta(body, partial) {
  const f = {};
  if (!partial || body.title !== undefined) {
    const title = String(body.title ?? '').trim();
    if (!title) throw httpError(400, 'Please give the document a name.');
    f.title = title.slice(0, 200);
  }
  if (!partial || body.docType !== undefined) f.doc_type = DOC_TYPES.includes(body.docType) ? body.docType : 'attestation';
  const date = (k, col) => {
    if (!partial || body[k] !== undefined) {
      const v = body[k] ? String(body[k]) : null;
      if (v && !isDateOnly(v)) throw httpError(400, 'Please enter a valid date.');
      f[col] = v;
    }
  };
  date('docDate', 'doc_date');
  date('periodFrom', 'period_from');
  date('periodTo', 'period_to');
  if (f.period_from && f.period_to && f.period_to < f.period_from) throw httpError(400, 'The end of the period must be after its start.');
  if (!partial || body.hours !== undefined) {
    const h = body.hours === '' || body.hours === null || body.hours === undefined ? null : Number(body.hours);
    if (h !== null && (!Number.isFinite(h) || h < 0 || h > 100000)) throw httpError(400, 'Hours must be a positive number.');
    f.hours = h;
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
  if (!partial || body.notes !== undefined) f.notes = String(body.notes ?? '').slice(0, 5000);
  if (body.ocrText !== undefined) f.ocr_text = String(body.ocrText ?? '').slice(0, 200000);
  if (!partial || body.tags !== undefined) {
    const tags = Array.isArray(body.tags) ? body.tags : String(body.tags ?? '').split(',');
    f.tags = [...new Set(tags.map((t) => String(t).trim().replace(/,/g, '')).filter(Boolean))].slice(0, 20).join(',');
  }
  if (body.pages !== undefined) f.pages = Math.max(1, parseInt(body.pages, 10) || 1);
  return f;
}

async function setLinks(docId, eventIds, markReceived) {
  if (eventIds === undefined) return;
  await db.run('DELETE FROM document_events WHERE document_id = ?', docId);
  for (const id of eventIds) await db.run('INSERT OR IGNORE INTO document_events (document_id, event_id) VALUES (?, ?)', docId, id);
  if (markReceived) for (const id of eventIds) await markEventReceived(id);
}

export async function markEventReceived(eventId) {
  const ev = await db.get('SELECT * FROM events WHERE id = ?', eventId);
  if (!ev || ev.attestation_status === 'received') return;
  const now = nowIn((await getSettings()).timezone);
  await db.run(
    `UPDATE events SET attestation_required = 1,
       attestation_source = COALESCE(attestation_source, 'manual'),
       attestation_status = 'received', attestation_received_at = ?, attestation_snoozed_until = NULL,
       updated_at = datetime('now') WHERE id = ?`,
    now,
    eventId
  );
  await db.run(`UPDATE notifications SET read_at = datetime('now') WHERE event_id = ? AND type = 'attestation' AND read_at IS NULL`, eventId);
  await recomputeCategory(ev.category_id);
}

const fileName = (file) => `db:${ALLOWED[file.mimetype] || ''}`;

export const documentsRouter = Router();

documentsRouter.get('/', async (req, res) => {
  const where = [];
  const args = [];
  const { q, type, categoryId, courseId, from, to, eventId, sort } = req.query;
  if (q) {
    const like = `%${String(q).trim()}%`;
    where.push(`(d.title LIKE ? OR d.notes LIKE ? OR d.tags LIKE ? OR d.original_name LIKE ? OR c.name LIKE ? OR co.title LIKE ? OR d.ocr_text LIKE ?
      OR EXISTS (SELECT 1 FROM document_events de JOIN events e ON e.id = de.event_id WHERE de.document_id = d.id AND e.title LIKE ?))`);
    args.push(like, like, like, like, like, like, like, like);
  }
  if (type && DOC_TYPES.includes(type)) {
    where.push('d.doc_type = ?');
    args.push(type);
  }
  if (categoryId) {
    where.push('d.category_id = ?');
    args.push(parseInt(categoryId, 10));
  }
  if (courseId) {
    where.push('d.course_id = ?');
    args.push(parseInt(courseId, 10));
  }
  if (eventId) {
    where.push('EXISTS (SELECT 1 FROM document_events de WHERE de.document_id = d.id AND de.event_id = ?)');
    args.push(parseInt(eventId, 10));
  }
  if (from && isDateOnly(from)) {
    where.push('COALESCE(d.doc_date, substr(d.created_at, 1, 10)) >= ?');
    args.push(from);
  }
  if (to && isDateOnly(to)) {
    where.push('COALESCE(d.doc_date, substr(d.created_at, 1, 10)) <= ?');
    args.push(to);
  }
  const order =
    sort === 'name'
      ? 'd.title COLLATE NOCASE'
      : sort === 'added'
        ? 'd.created_at DESC, d.id DESC'
        : 'COALESCE(d.doc_date, substr(d.created_at, 1, 10)) DESC, d.id DESC';
  const rows = await db.all(`${DOC_SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY ${order}`, ...args);
  res.json(await Promise.all(rows.map(serializeDoc)));
});

async function loadDoc(id) {
  const row = await db.get(`${DOC_SELECT} WHERE d.id = ?`, id);
  if (!row) throw httpError(404, 'This document no longer exists.');
  return row;
}

documentsRouter.get('/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const doc = await serializeDoc(await loadDoc(id));
  doc.ocrText = (await db.get('SELECT ocr_text FROM documents WHERE id = ?', id)).ocr_text;
  res.json(doc);
});

function sendBytes(res, data, mime, disposition, niceName) {
  res.setHeader('Content-Type', mime);
  if (niceName) res.setHeader('Content-Disposition', `${disposition}; filename*=UTF-8''${encodeURIComponent(niceName)}`);
  res.setHeader('Cache-Control', 'private, max-age=300');
  res.end(Buffer.from(data));
}

function sendLegacy(res, name, mime, disposition, niceName) {
  const file = path.join(UPLOAD_DIR, path.basename(name));
  if (!fs.existsSync(file)) throw httpError(404, 'The file is missing from the storage folder.');
  res.setHeader('Content-Type', mime);
  if (niceName) res.setHeader('Content-Disposition', `${disposition}; filename*=UTF-8''${encodeURIComponent(niceName)}`);
  res.setHeader('Cache-Control', 'private, max-age=300');
  res.sendFile(file);
}

documentsRouter.get('/:id/file', async (req, res) => {
  const row = await db.get('SELECT title, file_name, mime, file_data FROM documents WHERE id = ?', parseInt(req.params.id, 10));
  if (!row) throw httpError(404, 'This document no longer exists.');
  const ext = ALLOWED[row.mime] || path.extname(row.file_name);
  const safe = (row.title.replace(/[\\/:*?"<>|\r\n]+/g, ' ').trim() || 'document') + ext;
  const disposition = req.query.download ? 'attachment' : 'inline';
  if (row.file_data) return sendBytes(res, row.file_data, row.mime, disposition, safe);
  sendLegacy(res, row.file_name, row.mime, disposition, safe);
});

documentsRouter.get('/:id/thumb', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const row = await db.get('SELECT mime, file_name, thumb_name, thumb_data FROM documents WHERE id = ?', id);
  if (!row) throw httpError(404, 'This document no longer exists.');
  if (row.thumb_data) return sendBytes(res, row.thumb_data, 'image/jpeg', 'inline');
  if (row.thumb_name) return sendLegacy(res, row.thumb_name, 'image/jpeg', 'inline');
  if (row.mime.startsWith('image/')) {
    const full = await db.get('SELECT file_data FROM documents WHERE id = ?', id);
    if (full.file_data) return sendBytes(res, full.file_data, row.mime, 'inline');
    return sendLegacy(res, row.file_name, row.mime, 'inline');
  }
  throw httpError(404, 'No preview.');
});

documentsRouter.post('/', uploadFiles, async (req, res) => {
  const file = req.files?.file?.[0];
  const thumb = req.files?.thumb?.[0];
  if (!file) throw httpError(400, 'Please add a file or a scan.');
  const meta = await cleanMeta(req.body, false);
  const eventIds = (await parseIds(req.body.eventIds)) || [];
  const id = await transaction(async () => {
    const { lastInsertRowid: newId } = await db.run(
      `INSERT INTO documents (title, file_name, original_name, mime, size, doc_type, doc_date, period_from, period_to,
        hours, category_id, course_id, notes, tags, pages, file_data, thumb_data)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      meta.title,
      fileName(file),
      file.originalname || '',
      file.mimetype,
      file.size,
      meta.doc_type,
      meta.doc_date,
      meta.period_from,
      meta.period_to,
      meta.hours,
      meta.category_id,
      meta.course_id,
      meta.notes,
      meta.tags,
      meta.pages || 1,
      file.buffer,
      thumb ? thumb.buffer : null
    );
    await setLinks(newId, eventIds, req.body.markReceived === 'true');
    return newId;
  });
  res.status(201).json(await serializeDoc(await loadDoc(id)));
});

documentsRouter.put('/:id', uploadFiles, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const existing = await db.get('SELECT id, file_name, thumb_name FROM documents WHERE id = ?', id);
  if (!existing) throw httpError(404, 'This document no longer exists.');
  const file = req.files?.file?.[0];
  const thumb = req.files?.thumb?.[0];
  const meta = await cleanMeta(req.body, true);
  const eventIds = await parseIds(req.body.eventIds);
  if (file) {
    Object.assign(meta, {
      file_name: fileName(file),
      original_name: file.originalname || '',
      mime: file.mimetype,
      size: file.size,
      file_data: file.buffer,
      thumb_data: thumb ? thumb.buffer : null,
      thumb_name: null,
      // A new file means new text: it is read again.
      ocr_text: meta.ocr_text ?? '',
    });
  }
  const keys = Object.keys(meta);
  await transaction(async () => {
    if (keys.length) {
      await db.run(`UPDATE documents SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`, ...keys.map((k) => meta[k]), id);
    }
    await setLinks(id, eventIds, req.body.markReceived === 'true');
  });
  if (file) {
    removeLegacyFile(existing.file_name);
    removeLegacyFile(existing.thumb_name);
  }
  res.json(await serializeDoc(await loadDoc(id)));
});

documentsRouter.delete('/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const row = await db.get('SELECT title FROM documents WHERE id = ?', id);
  if (!row) return res.json({ ok: true });
  // Kept in the trash for 30 days (older files saved on disk stay there too, so it can come back).
  const trashId = await transaction(async () => {
    const tid = await putInTrash('document', row.title, [
      { tbl: 'documents', where: 'id = ?', args: [id] },
      { tbl: 'document_events', where: 'document_id = ?', args: [id] },
    ]);
    await db.run('DELETE FROM document_events WHERE document_id = ?', id);
    await db.run('DELETE FROM documents WHERE id = ?', id);
    return tid;
  });
  res.json({ ok: true, trashId });
});
