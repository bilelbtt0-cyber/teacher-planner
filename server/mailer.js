import nodemailer from 'nodemailer';
import { db, getSettings } from './db.js';
import { getPrimaryUser } from './auth.js';

export const APP_URL = (process.env.APP_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, '');

// Online, hosts like Render block email ports, so emails go out through a web API instead:
//  - EMAIL_RELAY_URL + EMAIL_RELAY_SECRET: a Google Apps Script that sends from a Gmail account
//    (free, no phone verification; see docs/gmail-relay.gs), or
//  - BREVO_API_KEY + EMAIL_FROM: Brevo's API with a verified sender, e.g. "Agenda <agenda@gmail.com>".
const RELAY_URL = process.env.EMAIL_RELAY_URL || '';
const RELAY_SECRET = process.env.EMAIL_RELAY_SECRET || '';
const BREVO_KEY = process.env.BREVO_API_KEY || '';
const EMAIL_FROM = process.env.EMAIL_FROM || '';
const useRelay = () => !!(RELAY_URL && RELAY_SECRET);
const useBrevo = () => !!(BREVO_KEY && EMAIL_FROM);

/** True when the hosting provides the email service, so she has nothing to configure. */
export const emailManaged = () => useRelay() || useBrevo();

async function sendWithRelay({ to, subject, html, text, appName }) {
  // Apps Script answers a POST with a redirect to the result; fetch follows it.
  const res = await fetch(RELAY_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ secret: RELAY_SECRET, to, subject, html, text: text || subject, fromName: appName }),
    redirect: 'follow',
    signal: AbortSignal.timeout(30000),
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* Google returned an HTML page: usually the script is not deployed for "Anyone" */
  }
  if (!data) throw Object.assign(new Error('The email relay did not answer correctly. Check its deployment (access: Anyone).'), { code: 'EAPI' });
  if (!data.ok) throw Object.assign(new Error(data.error || 'The email relay refused the email.'), { code: data.error === 'Unauthorized' ? 'EAUTH' : 'EAPI' });
}

export function emailConfigured(settings) {
  if (emailManaged()) return true;
  const s = settings.smtp || {};
  return !!(s.host && s.port && (s.from || s.user));
}

export async function recipient(settings) {
  return settings.notifyEmail || (await getPrimaryUser())?.email || '';
}

function parseAddress(value) {
  const m = String(value).match(/^\s*(.*?)\s*<([^>]+)>\s*$/);
  return m ? { name: m[1].replace(/^"|"$/g, '') || undefined, email: m[2] } : { email: String(value).trim() };
}

async function sendWithBrevo({ to, subject, html, text, appName }) {
  const sender = parseAddress(EMAIL_FROM);
  if (!sender.name) sender.name = appName;
  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'api-key': BREVO_KEY, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ sender, to: [{ email: to }], subject, htmlContent: html, textContent: text || subject }),
    signal: AbortSignal.timeout(15000),
  });
  if (res.status !== 201 && res.status !== 202) {
    let detail = '';
    try {
      detail = (await res.json()).message || '';
    } catch {
      /* no body */
    }
    throw Object.assign(new Error(detail || `HTTP ${res.status}`), { code: res.status === 401 ? 'EAUTH' : 'EAPI' });
  }
}

function transport(settings) {
  const s = settings.smtp;
  return nodemailer.createTransport({
    host: s.host,
    port: Number(s.port) || 587,
    secure: !!s.secure,
    auth: s.user ? { user: s.user, pass: s.pass } : undefined,
    connectionTimeout: 15000,
    greetingTimeout: 15000,
  });
}

function log(to, subject, status, error = null) {
  return db.run('INSERT INTO email_log (recipient, subject, status, error) VALUES (?, ?, ?, ?)', to || '-', subject, status, error);
}

/** Sends an email. Never throws unless `throwOnError` is set; failures are logged in the email activity. */
export async function sendMail({ subject, html, text }, { throwOnError = false, force = false } = {}) {
  const settings = await getSettings();
  const to = await recipient(settings);
  if (!force && !settings.emailEnabled) return { skipped: 'disabled' };
  if (!emailConfigured(settings)) {
    await log(to, subject, 'skipped', 'Email server is not configured');
    if (throwOnError) throw Object.assign(new Error('The email server is not configured yet.'), { status: 400 });
    return { skipped: 'not-configured' };
  }
  if (!to) {
    await log('-', subject, 'skipped', 'No recipient address');
    if (throwOnError) throw Object.assign(new Error('No email address to send to.'), { status: 400 });
    return { skipped: 'no-recipient' };
  }
  try {
    const appName = settings.appName || 'Planner';
    if (useRelay()) await sendWithRelay({ to, subject, html, text, appName });
    else if (useBrevo()) await sendWithBrevo({ to, subject, html, text, appName });
    else await transport(settings).sendMail({ from: settings.smtp.from || settings.smtp.user, to, subject, html, text });
    await log(to, subject, 'sent');
    return { sent: true };
  } catch (err) {
    const message = friendlyError(err);
    await log(to, subject, 'failed', message.slice(0, 500));
    if (throwOnError) throw Object.assign(new Error(message), { status: 400 });
    return { error: message };
  }
}

function friendlyError(err) {
  const code = err?.code || err?.errors?.[0]?.code;
  if (code === 'EAUTH' && useRelay()) return 'The email relay refused the secret. Check EMAIL_RELAY_SECRET.';
  if (code === 'EAUTH' && emailManaged()) return 'The email service rejected the API key.';
  if (code === 'EAPI') return err.message;
  if (code === 'EAUTH') return 'The email server refused the username or password. For Gmail, use an app password.';
  if (['ECONNREFUSED', 'ECONNECTION', 'ESOCKET', 'ETIMEDOUT', 'EDNS', 'ENOTFOUND', 'EHOSTUNREACH'].includes(code))
    return 'Could not connect to the email server. Check the server name, the port and the secure option.';
  if (code === 'EENVELOPE') return 'The email address was rejected by the server.';
  return `Sending failed: ${err?.message || err?.errors?.[0]?.message || code || 'unknown error'}`;
}

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
export { esc };

/** Wraps content in a simple, mobile-friendly email layout. */
export async function layout({ heading, intro = '', body = '', cta, ctaUrl, accent }) {
  const settings = await getSettings();
  accent = accent || settings.accentColor || '#5b5bd6';
  const appName = esc(settings.appName || 'Planner');
  return `<!doctype html><html><body style="margin:0;background:#f4f4f8;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1c1c28">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f8;padding:24px 12px">
  <tr><td align="center">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:16px;overflow:hidden;border:1px solid #e6e6ef">
      <tr><td style="height:6px;background:${accent}"></td></tr>
      <tr><td style="padding:28px 28px 8px">
        <div style="font-size:13px;color:#6b6b80;letter-spacing:.02em">${appName}</div>
        <h1 style="margin:6px 0 0;font-size:22px;line-height:1.3;color:#1c1c28">${heading}</h1>
        ${intro ? `<p style="margin:10px 0 0;font-size:15px;line-height:1.55;color:#4a4a5e">${intro}</p>` : ''}
      </td></tr>
      <tr><td style="padding:12px 28px 8px">${body}</td></tr>
      ${
        cta
          ? `<tr><td style="padding:12px 28px 28px"><a href="${ctaUrl}" style="display:inline-block;background:${accent};color:#fff;text-decoration:none;padding:12px 20px;border-radius:10px;font-weight:600;font-size:15px">${cta}</a></td></tr>`
          : '<tr><td style="height:20px"></td></tr>'
      }
    </table>
    <div style="font-size:12px;color:#8a8a9c;margin-top:14px">${appName} · ${settings.language === 'fr' ? 'Vous pouvez modifier vos préférences email dans les Paramètres.' : 'You can change email preferences in Settings.'}</div>
  </td></tr></table></body></html>`;
}

export function itemRow({ title, meta, color = '#5b5bd6', badge }) {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 10px;border:1px solid #ececf3;border-radius:12px">
    <tr><td style="width:6px;background:${color};border-radius:12px 0 0 12px"></td>
    <td style="padding:12px 14px">
      <div style="font-size:15px;font-weight:600;color:#1c1c28">${esc(title)}${
        badge ? ` <span style="font-size:12px;font-weight:600;color:#b4232a;background:#fdecec;border-radius:999px;padding:2px 8px;margin-left:6px">${esc(badge)}</span>` : ''
      }</div>
      <div style="font-size:13px;color:#6b6b80;margin-top:3px">${meta}</div>
    </td></tr></table>`;
}
