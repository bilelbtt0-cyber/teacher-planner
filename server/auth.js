import crypto from 'node:crypto';
import { Router } from 'express';
import { db } from './db.js';
import { httpError } from './recurrence.js';

const COOKIE = 'tp_session';
const SESSION_DAYS = 30;
// Online, the very first account can only be created with this code, so a stranger who finds
// the link before the teacher cannot claim the planner.
const SETUP_CODE = (process.env.SETUP_CODE || '').trim();

export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(':');
  const candidate = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, 'hex');
  return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
}

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > -1) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

async function createSession(res, req, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + SESSION_DAYS * 86400000);
  await db.run('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)', token, userId, expires.toISOString());
  const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
  res.setHeader(
    'Set-Cookie',
    `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Expires=${expires.toUTCString()}${secure ? '; Secure' : ''}`
  );
}

async function userFromRequest(req) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (!token) return null;
  const row = await db.get(
    'SELECT u.id, u.name, u.email, s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?',
    token
  );
  if (!row) return null;
  if (row.expires_at < new Date().toISOString()) {
    await db.run('DELETE FROM sessions WHERE token = ?', token);
    return null;
  }
  return { id: row.id, name: row.name, email: row.email, token };
}

export async function requireAuth(req, res, next) {
  const user = await userFromRequest(req);
  if (!user) return res.status(401).json({ error: 'Please sign in again.' });
  req.user = user;
  next();
}

// Basic brute-force protection: 8 failed attempts per IP lock login for 10 minutes.
const attempts = new Map();
function checkRate(ip) {
  const a = attempts.get(ip);
  if (a && a.count >= 8 && Date.now() - a.first < 10 * 60000) {
    throw httpError(429, 'Too many attempts. Please wait a few minutes and try again.');
  }
  if (a && Date.now() - a.first >= 10 * 60000) attempts.delete(ip);
}
function recordFailure(ip) {
  const a = attempts.get(ip) || { count: 0, first: Date.now() };
  a.count += 1;
  attempts.set(ip, a);
}

function validEmail(email) {
  return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

const hasUser = async () => (await db.get('SELECT COUNT(*) AS n FROM users')).n > 0;

export const authRouter = Router();

authRouter.get('/me', async (req, res) => {
  if (!(await hasUser())) return res.json({ setupRequired: true, setupCodeRequired: !!SETUP_CODE });
  const user = await userFromRequest(req);
  if (!user) return res.json({ authenticated: false });
  res.json({ authenticated: true, user: { id: user.id, name: user.name, email: user.email } });
});

authRouter.post('/setup', async (req, res) => {
  if (await hasUser()) throw httpError(409, 'An account already exists. Please sign in.');
  const { name, email, password, setupCode } = req.body || {};
  if (SETUP_CODE) {
    checkRate(req.ip);
    if (String(setupCode || '').trim() !== SETUP_CODE) {
      recordFailure(req.ip);
      throw httpError(403, 'The invitation code is not correct.');
    }
  }
  if (!name || !String(name).trim()) throw httpError(400, 'Please enter your name.');
  if (!validEmail(email)) throw httpError(400, 'Please enter a valid email address.');
  if (!password || String(password).length < 8) throw httpError(400, 'The password needs at least 8 characters.');
  const info = await db.run(
    'INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)',
    String(name).trim(),
    String(email).trim().toLowerCase(),
    hashPassword(String(password))
  );
  await createSession(res, req, info.lastInsertRowid);
  res.json({ ok: true });
});

authRouter.post('/login', async (req, res) => {
  const ip = req.ip;
  checkRate(ip);
  const { email, password } = req.body || {};
  const user = await db.get('SELECT * FROM users WHERE email = ?', String(email || '').trim().toLowerCase());
  if (!user || !verifyPassword(String(password || ''), user.password_hash)) {
    recordFailure(ip);
    throw httpError(401, 'Email or password is incorrect.');
  }
  attempts.delete(ip);
  await createSession(res, req, user.id);
  res.json({ ok: true });
});

authRouter.post('/logout', async (req, res) => {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (token) await db.run('DELETE FROM sessions WHERE token = ?', token);
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
  res.json({ ok: true });
});

authRouter.put('/profile', requireAuth, async (req, res) => {
  const { name, email, currentPassword, newPassword } = req.body || {};
  const user = await db.get('SELECT * FROM users WHERE id = ?', req.user.id);
  if (name !== undefined && !String(name).trim()) throw httpError(400, 'Please enter your name.');
  if (email !== undefined && !validEmail(email)) throw httpError(400, 'Please enter a valid email address.');
  if (newPassword) {
    if (!verifyPassword(String(currentPassword || ''), user.password_hash)) throw httpError(400, 'Your current password is incorrect.');
    if (String(newPassword).length < 8) throw httpError(400, 'The new password needs at least 8 characters.');
    await db.run('UPDATE users SET password_hash = ? WHERE id = ?', hashPassword(String(newPassword)), user.id);
    // Sign out every other device after a password change.
    await db.run('DELETE FROM sessions WHERE user_id = ? AND token != ?', user.id, req.user.token);
  }
  await db.run(
    'UPDATE users SET name = ?, email = ? WHERE id = ?',
    name !== undefined ? String(name).trim() : user.name,
    email !== undefined ? String(email).trim().toLowerCase() : user.email,
    user.id
  );
  res.json({ user: await db.get('SELECT id, name, email FROM users WHERE id = ?', user.id) });
});

export function getPrimaryUser() {
  return db.get('SELECT id, name, email FROM users ORDER BY id LIMIT 1');
}
