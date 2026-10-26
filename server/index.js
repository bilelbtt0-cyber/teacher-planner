import express from 'express';
import path from 'node:path';
import { ROOT, DB_LOCATION, initDb } from './db.js';
import { authRouter, requireAuth } from './auth.js';
import { eventsRouter } from './routes/events.js';
import { categoriesRouter } from './routes/categories.js';
import { documentsRouter } from './routes/documents.js';
import { coursesRouter } from './routes/courses.js';
import { miscRouter } from './routes/misc.js';
import { holidaysRouter } from './routes/holidays.js';
import { trashRouter } from './routes/trash.js';
import { startScheduler, tick } from './scheduler.js';

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const app = express();

app.disable('x-powered-by');
// Behind a hosting proxy (Render), trust its forwarded IP and https headers.
app.set('trust proxy', process.env.TRUST_PROXY ? 1 : 'loopback');
app.use(express.json({ limit: '1mb' }));

// Content-Security-Policy for the pages: only this site's own scripts can run, so even text that
// slipped through escaping could not execute. Inline styles stay allowed (the interface uses them);
// blob:/data: are needed for scans, previews and PDF export; wasm for the text reader.
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self' blob: data:",
  "worker-src 'self' blob:",
  "frame-src 'self' blob:",
  "media-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'self'",
].join('; ');

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  // Never shown inside another website (clickjacking); its own previews may still frame it.
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(), geolocation=(), payment=()');
  if (req.secure) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  // The policy applies to pages; files (PDFs, images) are served as they are.
  if (!req.path.startsWith('/api/') && !req.path.startsWith('/vendor/')) res.setHeader('Content-Security-Policy', CSP);
  next();
});

// Requests that change data must come from this site, in a format a forged cross-site form cannot
// produce (JSON or file upload). A missing body is treated as empty instead of crashing.
app.use('/api', (req, res, next) => {
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
    const origin = req.headers.origin;
    if (origin) {
      let sameSite = false;
      try {
        sameSite = new URL(origin).host === (req.headers['x-forwarded-host'] || req.headers.host);
      } catch {
        /* malformed origin */
      }
      if (!sameSite) return res.status(403).json({ error: 'This request was refused.' });
    }
    const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (type === 'text/plain' || type === 'application/x-www-form-urlencoded') {
      return res.status(415).json({ error: 'This request was refused.' });
    }
  }
  if (req.body === undefined) req.body = {};
  next();
});

const nm = (p) => path.join(ROOT, 'node_modules', p);
const vendor = { maxAge: '7d' };
app.use('/vendor/fullcalendar', express.static(nm('fullcalendar'), vendor));
app.use('/vendor/fullcalendar-locales', express.static(nm('@fullcalendar/core/locales'), vendor));
app.use('/vendor/jspdf', express.static(nm('jspdf/dist'), vendor));
app.use('/vendor/inter', express.static(nm('@fontsource-variable/inter'), vendor));
// Text recognition (Tesseract) and PDF reading (PDF.js) run in the browser, with files served from here.
app.use('/vendor/tesseract', express.static(nm('tesseract.js/dist'), vendor));
app.use('/vendor/tesseract-core', express.static(nm('tesseract.js-core'), vendor));
app.use('/vendor/pdfjs', express.static(nm('pdfjs-dist/build'), vendor));
const TESS_LANGS = ['fra', 'ara', 'eng'];
app.get('/vendor/tessdata/:file', (req, res, next) => {
  const lang = req.params.file.replace(/\.traineddata\.gz$/, '');
  if (!TESS_LANGS.includes(lang)) return next();
  res.sendFile(nm(`@tesseract.js-data/${lang}/4.0.0_best_int/${lang}.traineddata.gz`), { maxAge: '30d' }, (err) => err && next());
});
app.use(express.static(path.join(ROOT, 'public'), { index: 'index.html', maxAge: 0 }));

// Public health check. An external pinger calls it every few minutes: it keeps a free host awake
// and runs the reminders even if the host paused the app in between.
let lastPingTick = 0;
app.get('/api/health', (req, res) => {
  if (Date.now() - lastPingTick > 50 * 1000) {
    lastPingTick = Date.now();
    tick();
  }
  res.json({ ok: true });
});

app.use('/api/auth', authRouter);
app.use('/api', requireAuth);
app.use('/api/events', eventsRouter);
app.use('/api/categories', categoriesRouter);
app.use('/api/documents', documentsRouter);
app.use('/api/courses', coursesRouter);
app.use('/api/holidays', holidaysRouter);
app.use('/api/trash', trashRouter);
app.use('/api', miscRouter);
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const status = err.status || err.statusCode || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: status >= 500 ? 'Something went wrong on our side. Please try again.' : err.message });
});

await initDb();
app.listen(PORT, HOST, () => {
  console.log(`\n  Planner is running → http://localhost:${PORT}`);
  console.log(`  Database: ${DB_LOCATION}\n`);
  startScheduler();
});
