import { Router } from 'express';
import multer from 'multer';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { db, transaction, getSettings, UPLOAD_DIR } from '../db.js';
import { httpError } from '../recurrence.js';
import { isDateOnly, nowIn } from '../time.js';
import { recomputeCategory } from '../attestation.js';

export const DOC_TYPES = ['attestation', 'certificate', 'contract', 'payslip', 'other'];
const ALLOWED = {
  'application/pdf': '.pdf',
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
};

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) =>
      cb(null, (file.fieldname === 'thumb' ? 'thumb-' : '') + crypto.randomBytes(16).toString('hex') + (ALLOWED[file.mimetype] || '')),
  }),
  limits: { fileSize: 25 * 1024 * 1024, files: 2 },
  fileFilter: (req, file, cb) => {
    if (file.fieldname === 'thumb' && file.mimetype !== 'image/jpeg') return cb(httpError(400, 'Invalid thumbnail.'));
    if (ALLOWED[file.mimetype]) cb(null, true);
    else cb(httpError(400, 'Only PDF, JPG, PNG or WebP files can be saved.'));
  },
});

function uploadFiles(req, res, next) {
  upload.fields([
    { name: 'file', maxCount: 1 },
    { name: 'thumb', maxCount: 1 },
  ])(req, res, (err) => {
    if (err?.code === 'LIMIT_FILE_SIZE') return next(httpError(400, 'This file is larger than 25 MB.'));
    next(err);
  });
}

function removeFile(name) {
  if (!name) return;
  fs.rm(path.join(UPLOAD_DIR, path.basename(name)), { force: true }, () => {});
}

function discardUploads(req) {
  for (const list of Object.values(req.files || {})) for (const f of list) removeFile(f.filename);
}

function linkedEvents(docId) {
  return db
    .prepare(
      `SELECT e.id, e.title, e.start, e.end, e.attestation_status, e.category_id FROM document_events de
       JOIN events e ON e.id = de.event_id WHERE de.document_id = ? ORDER BY e.start`
    )
    .all(docId)
    .map((e) => ({ id: e.id, title: e.title, start: e.start, end: e.end, attestationStatus: e.attestation_status }));
}

export function serializeDoc(d) {
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
    hasThumb: !!d.thumb_name || d.mime.startsWith('image/'),
    events: linkedEvents(d.id),
    notes: d.notes,
    tags: d.tags ? d.tags.split(',').filter(Boolean) : [],
    pages: d.pages,
    createdAt: d.created_at,
    updatedAt: d.updated_at,
  };
}

const SELECT = `
  SELECT d.*, c.name AS category_name, c.color AS category_color
  FROM documents d
  LEFT JOIN categories c ON c.id = d.category_id`;

function parseIds(v) {
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
    if (!db.prepare('SELECT id FROM events WHERE id = ?').get(id)) throw httpError(400, 'One of the linked appointments no longer exists.');
  }
  return ids;
}

function cleanMeta(body, partial) {
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
  if (f.period_from && f.period_to && f.period_to < f.period_from)
    throw httpError(400, 'The end of the period must be after its start.');
  if (!partial || body.hours !== undefined) {
    const h = body.hours === '' || body.hours === null || body.hours === undefined ? null : Number(body.hours);
    if (h !== null && (!Number.isFinite(h) || h < 0 || h > 100000)) throw httpError(400, 'Hours must be a positive number.');
    f.hours = h;
  }
  if (!partial || body.categoryId !== undefined) {
    const id = body.categoryId ? parseInt(body.categoryId, 10) : null;
    if (id && !db.prepare('SELECT id FROM categories WHERE id = ?').get(id)) throw httpError(400, 'That institution no longer exists.');
    f.category_id = id || null;
  }
  if (!partial || body.notes !== undefined) f.notes = String(body.notes ?? '').slice(0, 5000);
  if (!partial || body.tags !== undefined) {
    const tags = Array.isArray(body.tags) ? body.tags : String(body.tags ?? '').split(',');
    f.tags = [...new Set(tags.map((t) => String(t).trim().replace(/,/g, '')).filter(Boolean))].slice(0, 20).join(',');
  }
  if (body.pages !== undefined) f.pages = Math.max(1, parseInt(body.pages, 10) || 1);
  return f;
}

function setLinks(docId, eventIds, markReceived) {
  if (eventIds === undefined) return;
  db.prepare('DELETE FROM document_events WHERE document_id = ?').run(docId);
  const ins = db.prepare('INSERT OR IGNORE INTO document_events (document_id, event_id) VALUES (?, ?)');
  for (const id of eventIds) ins.run(docId, id);
  if (markReceived) for (const id of eventIds) markEventReceived(id);
}

export function markEventReceived(eventId) {
  const ev = db.prepare('SELECT * FROM events WHERE id = ?').get(eventId);
  if (!ev || ev.attestation_status === 'received') return;
  const now = nowIn(getSettings().timezone);
  db.prepare(
    `UPDATE events SET attestation_required = 1,
       attestation_source = COALESCE(attestation_source, 'manual'),
       attestation_status = 'received', attestation_received_at = ?, attestation_snoozed_until = NULL,
       updated_at = datetime('now') WHERE id = ?`
  ).run(now, eventId);
  db.prepare(`UPDATE notifications SET read_at = datetime('now') WHERE event_id = ? AND type = 'attestation' AND read_at IS NULL`).run(eventId);
  recomputeCategory(ev.category_id);
}

export const documentsRouter = Router();

documentsRouter.get('/', (req, res) => {
  const where = [];
  const args = [];
  const { q, type, categoryId, from, to, eventId, sort } = req.query;
  if (q) {
    const like = `%${String(q).trim()}%`;
    where.push(`(d.title LIKE ? OR d.notes LIKE ? OR d.tags LIKE ? OR d.original_name LIKE ? OR c.name LIKE ?
      OR EXISTS (SELECT 1 FROM document_events de JOIN events e ON e.id = de.event_id WHERE de.document_id = d.id AND e.title LIKE ?))`);
    args.push(like, like, like, like, like, like);
  }
  if (type && DOC_TYPES.includes(type)) {
    where.push('d.doc_type = ?');
    args.push(type);
  }
  if (categoryId) {
    where.push('d.category_id = ?');
    args.push(parseInt(categoryId, 10));
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
  const rows = db.prepare(`${SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY ${order}`).all(...args);
  res.json(rows.map(serializeDoc));
});

documentsRouter.get('/:id', (req, res) => {
  const row = db.prepare(`${SELECT} WHERE d.id = ?`).get(parseInt(req.params.id, 10));
  if (!row) throw httpError(404, 'This document no longer exists.');
  res.json(serializeDoc(row));
});

function sendStored(res, fileName, mime, disposition, niceName) {
  const file = path.join(UPLOAD_DIR, path.basename(fileName));
  if (!fs.existsSync(file)) throw httpError(404, 'The file is missing from the storage folder.');
  res.setHeader('Content-Type', mime);
  if (niceName) res.setHeader('Content-Disposition', `${disposition}; filename*=UTF-8''${encodeURIComponent(niceName)}`);
  res.setHeader('Cache-Control', 'private, max-age=300');
  res.sendFile(file);
}

documentsRouter.get('/:id/file', (req, res) => {
  const row = db.prepare('SELECT * FROM documents WHERE id = ?').get(parseInt(req.params.id, 10));
  if (!row) throw httpError(404, 'This document no longer exists.');
  const safe = row.title.replace(/[\\/:*?"<>|\r\n]+/g, ' ').trim() || 'document';
  sendStored(res, row.file_name, row.mime, req.query.download ? 'attachment' : 'inline', safe + path.extname(row.file_name));
});

documentsRouter.get('/:id/thumb', (req, res) => {
  const row = db.prepare('SELECT * FROM documents WHERE id = ?').get(parseInt(req.params.id, 10));
  if (!row) throw httpError(404, 'This document no longer exists.');
  if (row.thumb_name) return sendStored(res, row.thumb_name, 'image/jpeg', 'inline');
  if (row.mime.startsWith('image/')) return sendStored(res, row.file_name, row.mime, 'inline');
  throw httpError(404, 'No preview.');
});

documentsRouter.post('/', uploadFiles, (req, res) => {
  const file = req.files?.file?.[0];
  const thumb = req.files?.thumb?.[0];
  if (!file) {
    discardUploads(req);
    throw httpError(400, 'Please add a file or a scan.');
  }
  let meta, eventIds;
  try {
    meta = cleanMeta(req.body, false);
    eventIds = parseIds(req.body.eventIds) || [];
  } catch (err) {
    discardUploads(req);
    throw err;
  }
  const id = transaction(() => {
    const newId = Number(
      db
        .prepare(
          `INSERT INTO documents (title, file_name, original_name, mime, size, doc_type, doc_date, period_from, period_to,
            hours, category_id, thumb_name, notes, tags, pages)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          meta.title,
          file.filename,
          file.originalname || '',
          file.mimetype,
          file.size,
          meta.doc_type,
          meta.doc_date,
          meta.period_from,
          meta.period_to,
          meta.hours,
          meta.category_id,
          thumb ? thumb.filename : null,
          meta.notes,
          meta.tags,
          meta.pages || 1
        ).lastInsertRowid
    );
    setLinks(newId, eventIds, req.body.markReceived === 'true');
    return newId;
  });
  res.status(201).json(serializeDoc(db.prepare(`${SELECT} WHERE d.id = ?`).get(id)));
});

documentsRouter.put('/:id', uploadFiles, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const existing = db.prepare('SELECT * FROM documents WHERE id = ?').get(id);
  const file = req.files?.file?.[0];
  const thumb = req.files?.thumb?.[0];
  if (!existing) {
    discardUploads(req);
    throw httpError(404, 'This document no longer exists.');
  }
  let meta, eventIds;
  try {
    meta = cleanMeta(req.body, true);
    eventIds = parseIds(req.body.eventIds);
  } catch (err) {
    discardUploads(req);
    throw err;
  }
  if (file) {
    Object.assign(meta, {
      file_name: file.filename,
      original_name: file.originalname || '',
      mime: file.mimetype,
      size: file.size,
      thumb_name: thumb ? thumb.filename : null,
    });
  }
  const keys = Object.keys(meta);
  transaction(() => {
    if (keys.length) {
      db.prepare(`UPDATE documents SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`).run(
        ...keys.map((k) => meta[k]),
        id
      );
    }
    setLinks(id, eventIds, req.body.markReceived === 'true');
  });
  if (file) {
    removeFile(existing.file_name);
    removeFile(existing.thumb_name);
  } else if (thumb) {
    removeFile(thumb.filename);
  }
  res.json(serializeDoc(db.prepare(`${SELECT} WHERE d.id = ?`).get(id)));
});

documentsRouter.delete('/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const row = db.prepare('SELECT * FROM documents WHERE id = ?').get(id);
  if (!row) return res.json({ ok: true });
  db.prepare('DELETE FROM documents WHERE id = ?').run(id);
  removeFile(row.file_name);
  removeFile(row.thumb_name);
  res.json({ ok: true });
});
