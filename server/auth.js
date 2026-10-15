import crypto from 'node:crypto';
import { Router } from 'express';
import { db } from './db.js';
import { httpError } from './recurrence.js';

const COOKIE = 'tp_session';
const SESSION_DAYS = 30;

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

function createSession(res, req, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + SESSION_DAYS * 86400000);
  db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)').run(token, userId, expires.toISOString());
  const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
  res.setHeader(
    'Set-Cookie',
    `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Expires=${expires.toUTCString()}${secure ? '; Secure' : ''}`
  );
}

function userFromRequest(req) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (!token) return null;
  const row = db
    .prepare(
      `SELECT u.id, u.name, u.email, s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?`
    )
    .get(token);
  if (!row) return null;
  if (row.expires_at < new Date().toISOString()) {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    return null;
  }
  return { id: row.id, name: row.name, email: row.email, token };
}

export function requireAuth(req, res, next) {
  const user = userFromRequest(req);
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

export const authRouter = Router();

authRouter.get('/me', (req, res) => {
  const hasUser = db.prepare('SELECT COUNT(*) AS n FROM users').get().n > 0;
  if (!hasUser) return res.json({ setupRequired: true });
  const user = userFromRequest(req);
  if (!user) return res.json({ authenticated: false });
  res.json({ authenticated: true, user: { id: user.id, name: user.name, email: user.email } });
});

authRouter.post('/setup', (req, res) => {
  const hasUser = db.prepare('SELECT COUNT(*) AS n FROM users').get().n > 0;
  if (hasUser) throw httpError(409, 'An account already exists. Please sign in.');
  const { name, email, password } = req.body || {};
  if (!name || !String(name).trim()) throw httpError(400, 'Please enter your name.');
  if (!validEmail(email)) throw httpError(400, 'Please enter a valid email address.');
  if (!password || String(password).length < 8) throw httpError(400, 'The password needs at least 8 characters.');
  const info = db
    .prepare('INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)')
    .run(String(name).trim(), String(email).trim().toLowerCase(), hashPassword(String(password)));
  createSession(res, req, Number(info.lastInsertRowid));
  res.json({ ok: true });
});

authRouter.post('/login', (req, res) => {
  const ip = req.ip;
  checkRate(ip);
  const { email, password } = req.body || {};
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(String(email || '').trim().toLowerCase());
  if (!user || !verifyPassword(String(password || ''), user.password_hash)) {
    recordFailure(ip);
    throw httpError(401, 'Email or password is incorrect.');
  }
  attempts.delete(ip);
  createSession(res, req, user.id);
  res.json({ ok: true });
});

authRouter.post('/logout', (req, res) => {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
  res.json({ ok: true });
});

authRouter.put('/profile', requireAuth, (req, res) => {
  const { name, email, currentPassword, newPassword } = req.body || {};
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (name !== undefined && !String(name).trim()) throw httpError(400, 'Please enter your name.');
  if (email !== undefined && !validEmail(email)) throw httpError(400, 'Please enter a valid email address.');
  if (newPassword) {
    if (!verifyPassword(String(currentPassword || ''), user.password_hash))
      throw httpError(400, 'Your current password is incorrect.');
    if (String(newPassword).length < 8) throw httpError(400, 'The new password needs at least 8 characters.');
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(String(newPassword)), user.id);
    // Sign out every other device after a password change.
    db.prepare('DELETE FROM sessions WHERE user_id = ? AND token != ?').run(user.id, req.user.token);
  }
  db.prepare('UPDATE users SET name = ?, email = ? WHERE id = ?').run(
    name !== undefined ? String(name).trim() : user.name,
    email !== undefined ? String(email).trim().toLowerCase() : user.email,
    user.id
  );
  const updated = db.prepare('SELECT id, name, email FROM users WHERE id = ?').get(user.id);
  res.json({ user: updated });
});

export function getPrimaryUser() {
  return db.prepare('SELECT id, name, email FROM users ORDER BY id LIMIT 1').get();
}
