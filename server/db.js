import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..');
export const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, 'data');
export const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

export const DB_PATH = path.join(DATA_DIR, 'planner.db');
export const db = new DatabaseSync(DB_PATH);

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  PRAGMA busy_timeout = 5000;
`);

// Schema migrations: each entry runs once, in order. Never edit a shipped entry, append new ones.
const MIGRATIONS = [
  `
  CREATE TABLE users (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL
  );

  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE categories (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    color TEXT NOT NULL DEFAULT '#5b5bd6',
    attestation_every_hours REAL,
    archived INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE series (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    rule TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    series_id INTEGER REFERENCES series(id) ON DELETE SET NULL,
    title TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'class',
    category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
    location TEXT NOT NULL DEFAULT '',
    start TEXT NOT NULL,
    end TEXT NOT NULL,
    all_day INTEGER NOT NULL DEFAULT 0,
    notes TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'scheduled',
    reminders TEXT NOT NULL DEFAULT '[]',
    attestation_required INTEGER NOT NULL DEFAULT 0,
    attestation_source TEXT,
    attestation_status TEXT,
    attestation_note TEXT NOT NULL DEFAULT '',
    attestation_received_at TEXT,
    attestation_snoozed_until TEXT,
    attestation_last_nag_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX idx_events_start ON events(start);
  CREATE INDEX idx_events_series ON events(series_id);
  CREATE INDEX idx_events_category ON events(category_id);
  CREATE INDEX idx_events_attestation ON events(attestation_required, attestation_status);

  CREATE TABLE documents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    file_name TEXT NOT NULL,
    original_name TEXT NOT NULL DEFAULT '',
    mime TEXT NOT NULL,
    size INTEGER NOT NULL DEFAULT 0,
    doc_type TEXT NOT NULL DEFAULT 'attestation',
    doc_date TEXT,
    period_from TEXT,
    period_to TEXT,
    hours REAL,
    category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
    thumb_name TEXT,
    notes TEXT NOT NULL DEFAULT '',
    tags TEXT NOT NULL DEFAULT '',
    pages INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE document_events (
    document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    PRIMARY KEY (document_id, event_id)
  );
  CREATE INDEX idx_document_events_event ON document_events(event_id);
  CREATE INDEX idx_documents_date ON documents(doc_date);

  CREATE TABLE notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL DEFAULT '',
    event_id INTEGER REFERENCES events(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    read_at TEXT
  );
  CREATE INDEX idx_notifications_created ON notifications(created_at);

  CREATE TABLE sent_log (
    key TEXT PRIMARY KEY,
    sent_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE email_log (
    id INTEGER PRIMARY KEY,
    recipient TEXT NOT NULL,
    subject TEXT NOT NULL,
    status TEXT NOT NULL,
    error TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  `,
];

db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)');
const row = db.prepare('SELECT version FROM schema_version').get();
let version = row ? row.version : 0;
if (!row) db.prepare('INSERT INTO schema_version (version) VALUES (0)').run();
while (version < MIGRATIONS.length) {
  transaction(() => {
    db.exec(MIGRATIONS[version]);
    version += 1;
    db.prepare('UPDATE schema_version SET version = ?').run(version);
  });
}

export function transaction(fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

// ---------- Settings ----------

export const DEFAULT_SETTINGS = {
  language: 'en',
  timezone: 'Africa/Tunis',
  theme: 'system',
  weekStart: 1,
  dayStart: '07:00',
  dayEnd: '20:00',
  notifyEmail: '',
  emailEnabled: true,
  defaultReminders: [{ minutes: 60, email: false }, { minutes: 1440, email: true }],
  nagIntervalHours: 24,
  quietStart: '21:00',
  quietEnd: '08:00',
  digestEnabled: true,
  digestTime: '07:00',
  smtp: { host: '', port: 587, secure: false, user: '', pass: '', from: '' },
};

export function getSettings() {
  const out = structuredClone(DEFAULT_SETTINGS);
  for (const { key, value } of db.prepare('SELECT key, value FROM settings').all()) {
    try {
      out[key] = JSON.parse(value);
    } catch {
      /* ignore corrupt value, keep default */
    }
  }
  return out;
}

export function saveSettings(patch) {
  const stmt = db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  );
  transaction(() => {
    for (const [key, value] of Object.entries(patch)) {
      if (!(key in DEFAULT_SETTINGS)) continue;
      stmt.run(key, JSON.stringify(value));
    }
  });
  return getSettings();
}
