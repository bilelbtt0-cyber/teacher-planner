import express from 'express';
import path from 'node:path';
import { ROOT, DB_LOCATION, initDb } from './db.js';
import { authRouter, requireAuth } from './auth.js';
import { eventsRouter } from './routes/events.js';
import { categoriesRouter } from './routes/categories.js';
import { documentsRouter } from './routes/documents.js';
import { miscRouter } from './routes/misc.js';
import { holidaysRouter } from './routes/holidays.js';
import { startScheduler, tick } from './scheduler.js';

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const app = express();

app.disable('x-powered-by');
// Behind a hosting proxy (Render), trust its forwarded IP and https headers.
app.set('trust proxy', process.env.TRUST_PROXY ? 1 : 'loopback');
app.use(express.json({ limit: '1mb' }));
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
});

const nm = (p) => path.join(ROOT, 'node_modules', p);
const vendor = { maxAge: '7d' };
app.use('/vendor/fullcalendar', express.static(nm('fullcalendar'), vendor));
app.use('/vendor/fullcalendar-locales', express.static(nm('@fullcalendar/core/locales'), vendor));
app.use('/vendor/jspdf', express.static(nm('jspdf/dist'), vendor));
app.use('/vendor/inter', express.static(nm('@fontsource-variable/inter'), vendor));
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
app.use('/api/holidays', holidaysRouter);
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
