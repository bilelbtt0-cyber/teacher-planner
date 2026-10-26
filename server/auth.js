import crypto from 'node:crypto';
import { Router } from 'express';
import { db, getSettings } from './db.js';
import { httpError } from './errors.js';
import { emailConfigured } from './mailer.js';
import { sendSignInAlert, sendPasswordChanged, sendResetCode } from './securityMail.js';

const COOKIE = 'tp_session';
// She stays signed in on her device: a session lasts a year and is renewed when she uses the app.
const SESSION_DAYS = 365;
const RENEW_AFTER_DAYS = 1;
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

function setSessionCookie(req, res, token, expires) {
  const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
  res.setHeader(
    'Set-Cookie',
    `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Expires=${expires.toUTCString()}${secure ? '; Secure' : ''}`
  );
}

async function createSession(res, req, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + SESSION_DAYS * 86400000);
  await db.run('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)', token, userId, expires.toISOString());
  setSessionCookie(req, res, token, expires);
}

/** Pushes the expiry a year ahead again, at most once a day, so an active device is never signed out. */
async function renewSession(req, res, user) {
  const remainingDays = (new Date(user.expiresAt) - Date.now()) / 86400000;
  if (remainingDays > SESSION_DAYS - RENEW_AFTER_DAYS) return;
  const expires = new Date(Date.now() + SESSION_DAYS * 86400000);
  await db.run('UPDATE sessions SET expires_at = ? WHERE token = ?', expires.toISOString(), user.token);
  setSessionCookie(req, res, user.token, expires);
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
  return { id: row.id, name: row.name, email: row.email, token, expiresAt: row.expires_at };
}

export async function requireAuth(req, res, next) {
  const user = await userFromRequest(req);
  if (!user) return res.status(401).json({ error: 'Please sign in again.' });
  await renewSession(req, res, user);
  req.user = user;
  next();
}

// Brute-force protection, kept in the database so a restart of the host does not reset it.
// Each key ("ip:…", "account:…") allows a number of failures per 15 minutes.
const WINDOW_MS = 15 * 60000;
const LIMITS = { ip: 8, account: 20, forgot: 5 };
const limitOf = (key) => LIMITS[key.split(':')[0]];

async function checkRate(...keys) {
  for (const key of keys) {
    const a = await db.get('SELECT count, first_at FROM login_attempts WHERE key = ?', key);
    if (a && Date.now() - a.first_at < WINDOW_MS && a.count >= limitOf(key)) {
      throw httpError(429, 'Too many attempts. Please wait a few minutes and try again.');
    }
  }
}
async function recordFailure(...keys) {
  const now = Date.now();
  for (const key of keys) {
    await db.run(
      `INSERT INTO login_attempts (key, count, first_at) VALUES (?, 1, ?)
       ON CONFLICT(key) DO UPDATE SET
         count = CASE WHEN ? - first_at >= ? THEN 1 ELSE count + 1 END,
         first_at = CASE WHEN ? - first_at >= ? THEN ? ELSE first_at END`,
      key, now, now, WINDOW_MS, now, WINDOW_MS, now
    );
  }
}
async function clearFailures(...keys) {
  for (const key of keys) await db.run('DELETE FROM login_attempts WHERE key = ?', key);
}
const accountKey = (email) => `account:${String(email || '').trim().toLowerCase()}`;

// One-time codes ("forgotten password", "this wasn't me") are stored only as a hash.
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
async function createCode(purpose, userId, code, minutes) {
  await db.run('DELETE FROM auth_codes WHERE purpose = ? AND user_id = ?', purpose, userId);
  await db.run(
    'INSERT INTO auth_codes (code_hash, purpose, user_id, expires_at) VALUES (?, ?, ?, ?)',
    sha256(`${purpose}:${code}`),
    purpose,
    userId,
    new Date(Date.now() + minutes * 60000).toISOString()
  );
}

/** Emails her about a new sign-in, with a link to sign every device out. Never blocks the sign-in. */
async function alertSignIn(req, userId) {
  try {
    const token = crypto.randomBytes(32).toString('hex');
    // Several alerts may be valid at once (one per sign-in), so older links are kept until they expire.
    await db.run(
      'INSERT INTO auth_codes (code_hash, purpose, user_id, expires_at) VALUES (?, ?, ?, ?)',
      sha256(`revoke:${token}`),
      'revoke',
      userId,
      new Date(Date.now() + 14 * 86400000).toISOString()
    );
    await sendSignInAlert(req.headers['user-agent'], token);
  } catch (err) {
    console.error('[sign-in alert]', err.message);
  }
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
  await renewSession(req, res, user);
  res.json({ authenticated: true, user: { id: user.id, name: user.name, email: user.email } });
});

authRouter.post('/setup', async (req, res) => {
  if (await hasUser()) throw httpError(409, 'An account already exists. Please sign in.');
  const { name, email, password, setupCode } = req.body || {};
  if (SETUP_CODE) {
    await checkRate(`ip:${req.ip}`);
    if (String(setupCode || '').trim() !== SETUP_CODE) {
      await recordFailure(`ip:${req.ip}`);
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
  const { email, password } = req.body || {};
  const keys = [`ip:${req.ip}`, accountKey(email)];
  await checkRate(...keys);
  const user = await db.get('SELECT * FROM users WHERE email = ?', String(email || '').trim().toLowerCase());
  if (!user || !verifyPassword(String(password || ''), user.password_hash)) {
    await recordFailure(...keys);
    throw httpError(401, 'Email or password is incorrect.');
  }
  await clearFailures(...keys);
  await createSession(res, req, user.id);
  res.json({ ok: true });
  alertSignIn(req, user.id);
});

// "This wasn't me", from the sign-in email: signs every device out. The link holds a one-time token.
authRouter.post('/revoke', async (req, res) => {
  await checkRate(`ip:${req.ip}`);
  const row = await db.get(
    "SELECT * FROM auth_codes WHERE purpose = 'revoke' AND code_hash = ? AND expires_at > ?",
    sha256(`revoke:${String(req.body?.token || '')}`),
    new Date().toISOString()
  );
  if (!row) {
    await recordFailure(`ip:${req.ip}`);
    throw httpError(400, 'This link has expired or was already used.');
  }
  await db.run('DELETE FROM sessions WHERE user_id = ?', row.user_id);
  await db.run("DELETE FROM auth_codes WHERE purpose = 'revoke' AND user_id = ?", row.user_id);
  res.json({ ok: true });
});

// Forgotten password, step 1: a 6-digit code is emailed if the address is the account's.
// The answer is the same either way, so it does not reveal which address is registered.
authRouter.post('/forgot', async (req, res) => {
  await checkRate(`forgot:${req.ip}`);
  await recordFailure(`forgot:${req.ip}`);
  if (!emailConfigured(await getSettings())) {
    throw httpError(503, 'Password reset by email is not available yet. Ask the person who set up the app.');
  }
  const user = await db.get('SELECT id FROM users WHERE email = ?', String(req.body?.email || '').trim().toLowerCase());
  if (user) {
    const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    await createCode('reset', user.id, code, 15);
    try {
      await sendResetCode(code);
    } catch (err) {
      console.error('[reset code]', err.message);
      throw httpError(502, 'The email could not be sent. Please try again in a moment.');
    }
  }
  res.json({ ok: true });
});

// Forgotten password, step 2: the code and a new password. Five wrong codes and it must be asked again.
authRouter.post('/reset', async (req, res) => {
  const { email, code, password } = req.body || {};
  const keys = [`ip:${req.ip}`, accountKey(email)];
  await checkRate(...keys);
  const wrong = async () => {
    await recordFailure(...keys);
    return httpError(400, 'This code is not correct or has expired. Ask for a new one.');
  };
  if (!password || String(password).length < 8) throw httpError(400, 'The new password needs at least 8 characters.');
  const user = await db.get('SELECT id FROM users WHERE email = ?', String(email || '').trim().toLowerCase());
  const row = user && (await db.get("SELECT * FROM auth_codes WHERE purpose = 'reset' AND user_id = ? AND expires_at > ?", user.id, new Date().toISOString()));
  if (!row || row.tries >= 5) throw await wrong();
  const expected = Buffer.from(row.code_hash, 'hex');
  const given = Buffer.from(sha256(`reset:${String(code || '').replace(/\D/g, '')}`), 'hex');
  if (!crypto.timingSafeEqual(expected, given)) {
    await db.run('UPDATE auth_codes SET tries = tries + 1 WHERE code_hash = ?', row.code_hash);
    throw await wrong();
  }
  await db.run('UPDATE users SET password_hash = ? WHERE id = ?', hashPassword(String(password)), user.id);
  await db.run('DELETE FROM sessions WHERE user_id = ?', user.id);
  await db.run("DELETE FROM auth_codes WHERE purpose = 'reset' AND user_id = ?", user.id);
  await clearFailures(...keys);
  await createSession(res, req, user.id);
  res.json({ ok: true });
  sendPasswordChanged().catch(() => {});
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
    sendPasswordChanged().catch(() => {});
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
