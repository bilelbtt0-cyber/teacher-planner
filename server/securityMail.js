import { getSettings } from './db.js';
import { sendMail, layout, esc, APP_URL } from './mailer.js';
import { nowIn } from './time.js';

// Emails about the account itself: a new sign-in, a password change, a reset code.
// They are sent even when reminder emails are turned off, because they protect her account.

const STRINGS = {
  en: {
    signInSubject: 'New sign-in to your planner',
    signInHeading: 'New sign-in',
    signInIntro: (device, when) => `Your planner was opened on <b>${device}</b>, ${when}.`,
    signInOk: 'If it was you, there is nothing to do.',
    signInNotMe: 'If it wasn’t you, sign every device out now, then change your password.',
    notMeButton: 'It wasn’t me',
    changedSubject: 'Your password was changed',
    changedHeading: 'Password changed',
    changedIntro: (when) => `The password of your planner was changed ${when}. Other devices were signed out.`,
    changedNotMe: 'If you didn’t do this, use “Forgot your password?” on the sign-in page right away.',
    codeSubject: (code) => `${code} is your code to reset your password`,
    codeHeading: 'Reset your password',
    codeIntro: 'Enter this code on the sign-in page to choose a new password. It is valid for 15 minutes.',
    codeNotMe: 'If you didn’t ask for this, ignore this email: your password stays the same.',
    when: (d, t) => `on ${d} at ${t}`,
    unknown: 'an unknown device',
  },
  fr: {
    signInSubject: 'Nouvelle connexion à votre agenda',
    signInHeading: 'Nouvelle connexion',
    signInIntro: (device, when) => `Votre agenda a été ouvert sur <b>${device}</b>, ${when}.`,
    signInOk: 'Si c’était vous, il n’y a rien à faire.',
    signInNotMe: 'Si ce n’était pas vous, déconnectez tous les appareils maintenant, puis changez votre mot de passe.',
    notMeButton: 'Ce n’était pas moi',
    changedSubject: 'Votre mot de passe a été modifié',
    changedHeading: 'Mot de passe modifié',
    changedIntro: (when) => `Le mot de passe de votre agenda a été modifié ${when}. Les autres appareils ont été déconnectés.`,
    changedNotMe: 'Si ce n’était pas vous, utilisez tout de suite « Mot de passe oublié ? » sur la page de connexion.',
    codeSubject: (code) => `${code} est votre code pour changer de mot de passe`,
    codeHeading: 'Changer votre mot de passe',
    codeIntro: 'Saisissez ce code sur la page de connexion pour choisir un nouveau mot de passe. Il est valable 15 minutes.',
    codeNotMe: 'Si vous n’avez rien demandé, ignorez cet email : votre mot de passe ne change pas.',
    when: (d, t) => `le ${d} à ${t}`,
    unknown: 'un appareil inconnu',
  },
};

/** "Chrome · Android", "Safari · iPhone"… from the browser's user agent. */
export function describeDevice(ua = '') {
  const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' : /Mac OS X|Macintosh/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : '';
  const browser = /Edg\//.test(ua) ? 'Edge' : /OPR\/|Opera/.test(ua) ? 'Opera' : /SamsungBrowser/.test(ua) ? 'Samsung Internet' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : '';
  return [browser, os].filter(Boolean).join(' · ');
}

async function context() {
  const settings = await getSettings();
  const s = STRINGS[settings.language] || STRINGS.en;
  const now = nowIn(settings.timezone);
  const date = settings.language === 'fr' ? `${now.slice(8, 10)}/${now.slice(5, 7)}/${now.slice(0, 4)}` : `${now.slice(0, 10)}`;
  return { s, when: s.when(date, now.slice(11, 16)) };
}

const p = (text) => `<p style="margin:0 0 12px;font-size:15px;line-height:1.55;color:#4a4a5e">${text}</p>`;

export async function sendSignInAlert(userAgent, revokeToken) {
  const { s, when } = await context();
  const device = esc(describeDevice(userAgent) || s.unknown);
  const url = `${APP_URL}/secure.html#${revokeToken}`;
  return sendMail(
    {
      subject: s.signInSubject,
      html: await layout({ heading: s.signInHeading, intro: s.signInIntro(device, when), body: p(s.signInOk) + p(s.signInNotMe), cta: s.notMeButton, ctaUrl: url, accent: '#c2410c' }),
      text: [s.signInHeading, s.signInIntro(device, when).replace(/<\/?b>/g, ''), s.signInOk, s.signInNotMe, `${s.notMeButton}: ${url}`].join('\n\n'),
    },
    { force: true }
  );
}

export async function sendPasswordChanged() {
  const { s, when } = await context();
  return sendMail(
    {
      subject: s.changedSubject,
      html: await layout({ heading: s.changedHeading, intro: s.changedIntro(when), body: p(s.changedNotMe), accent: '#c2410c' }),
      text: [s.changedHeading, s.changedIntro(when), s.changedNotMe].join('\n\n'),
    },
    { force: true }
  );
}

export async function sendResetCode(code) {
  const { s } = await context();
  const big = `<div style="font-size:32px;font-weight:700;letter-spacing:8px;color:#1c1c28;margin:4px 0 16px">${esc(code)}</div>`;
  return sendMail(
    {
      subject: s.codeSubject(code),
      html: await layout({ heading: s.codeHeading, intro: s.codeIntro, body: big + p(s.codeNotMe) }),
      text: [s.codeHeading, s.codeIntro, code, s.codeNotMe].join('\n\n'),
    },
    { force: true, throwOnError: true }
  );
}
