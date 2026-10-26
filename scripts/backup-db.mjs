// Copies the whole online database (Turso) into a local SQLite file, files included.
// Read-only on the online side: use a read-only token.
// Usage: BACKUP_DATABASE_URL=libsql://… BACKUP_DATABASE_TOKEN=… node scripts/backup-db.mjs backup.db
import { createClient } from '@libsql/client';

const url = process.env.BACKUP_DATABASE_URL;
const authToken = process.env.BACKUP_DATABASE_TOKEN;
const out = process.argv[2];
if (!url || !authToken || !out) {
  console.error('Missing BACKUP_DATABASE_URL, BACKUP_DATABASE_TOKEN or the output file.');
  process.exit(1);
}

const live = createClient({ url, authToken });
const copy = createClient({ url: `file:${out.split('\\').join('/')}` });
// An exact replica: rows are copied as they are, in any order, so link checks are off for the copy.
await copy.execute('PRAGMA foreign_keys = OFF');

const schema = (
  await live.execute(
    "SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_litestream%' ORDER BY CASE type WHEN 'table' THEN 0 ELSE 1 END, name"
  )
).rows;
for (const r of schema) await copy.execute(r.sql);
const tables = schema.filter((r) => r.type === 'table').map((r) => r.name);

const counts = {};
for (const t of tables) {
  // Page through big tables so documents (stored as files in the database) never load all at once.
  counts[t] = 0;
  for (let offset = 0; ; offset += 50) {
    const rows = (await live.execute({ sql: `SELECT * FROM "${t}" LIMIT 50 OFFSET ?`, args: [offset] })).rows;
    if (!rows.length) break;
    const cols = Object.keys(rows[0]);
    const sql = `INSERT INTO "${t}" (${cols.map((c) => `"${c}"`).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`;
    await copy.batch(rows.map((row) => ({ sql, args: cols.map((c) => row[c]) })), 'write');
    counts[t] += rows.length;
    if (rows.length < 50) break;
  }
}

// The copy must have exactly what the online database has.
let ok = true;
for (const t of tables) {
  const live_n = Number((await live.execute(`SELECT COUNT(*) AS n FROM "${t}"`)).rows[0].n);
  const copy_n = Number((await copy.execute(`SELECT COUNT(*) AS n FROM "${t}"`)).rows[0].n);
  if (live_n !== copy_n) {
    ok = false;
    console.error(`Mismatch in ${t}: online ${live_n}, copy ${copy_n}`);
  }
}
const version = (await live.execute('SELECT version FROM schema_version')).rows[0]?.version;
console.log(`schema ${version} · ${Object.entries(counts).map(([t, n]) => `${t} ${n}`).join(' · ')}`);
if (!ok) process.exit(1);
console.log('Backup complete.');
