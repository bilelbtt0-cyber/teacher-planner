import { api } from '../api.js';
import { t, tn, reminderLabel, timeAgo, dateToWall, fmtDate } from '../i18n.js';
import { state, subscribe, loadSettings, loadCategories, changed } from '../store.js';
import { esc, icon, on, toast, errorToast, setBusy, confirmDialog, initials, openModal, PALETTES, paletteGrid } from '../ui.js';
import { openCategoryForm, ruleDescription, categoryPayload } from '../eventForm.js';
import { openTrash } from '../trash.js';

// Settings in four plain sections. Everything saves by itself; the few detailed or technical
// options are folded away ("Customise", "Advanced") so the page stays short.

const SECTIONS = [
  { id: 'me', label: 'Me', icon: 'user' },
  { id: 'places', label: 'My institutions', icon: 'building' },
  { id: 'reminders', label: 'My reminders', icon: 'bell' },
  { id: 'data', label: 'My data', icon: 'database' },
];
// Links written before the redesign still land in the right place.
const OLD_SECTIONS = { personal: 'me', profile: 'me', appearance: 'me', institutions: 'places', holidays: 'places', notifications: 'reminders', email: 'reminders' };

const SMTP_PRESETS = {
  gmail: { host: 'smtp.gmail.com', port: 465, secure: true },
  outlook: { host: 'smtp-mail.outlook.com', port: 587, secure: false },
  yahoo: { host: 'smtp.mail.yahoo.com', port: 465, secure: true },
};

const REMINDER_CHOICES = [0, 10, 30, 60, 120, 1440, 2880, 10080];

/** Three ready-made ways of being reminded; the details stay available under "Customise". */
const STYLES = [
  {
    id: 'calm',
    label: 'Gentle',
    description: 'A reminder in the app 1 hour before. Missing attestations: one email every 2 days. No morning email.',
    values: { defaultReminders: [{ minutes: 60, email: false }], nagIntervalHours: 48, digestEnabled: false },
  },
  {
    id: 'normal',
    label: 'Normal',
    recommended: true,
    description: 'A reminder 1 hour before, and the day before by email. Missing attestations: one email a day. A summary every morning.',
    values: { defaultReminders: [{ minutes: 60, email: false }, { minutes: 1440, email: true }], nagIntervalHours: 24, digestEnabled: true },
  },
  {
    id: 'close',
    label: 'Close follow-up',
    description: 'Reminders the day before (email), 1 hour and 30 minutes before. Missing attestations: an email every 4 hours. A summary every morning.',
    values: {
      defaultReminders: [{ minutes: 30, email: false }, { minutes: 60, email: false }, { minutes: 1440, email: true }],
      nagIntervalHours: 4,
      digestEnabled: true,
    },
  },
];

function currentStyle(s) {
  const same = (a, b) => JSON.stringify(a.map((r) => [r.minutes, !!r.email]).sort()) === JSON.stringify(b.map((r) => [r.minutes, !!r.email]).sort());
  const match = STYLES.find(
    (st) => same(st.values.defaultReminders, s.defaultReminders || []) && Number(s.nagIntervalHours) === st.values.nagIntervalHours && !!s.digestEnabled === st.values.digestEnabled
  );
  return match?.id || 'custom';
}

export async function render(root, params) {
  root.innerHTML = `
    <div class="settings-layout">
      <nav class="settings-nav">${SECTIONS.map((s) => `<a href="#/settings?s=${s.id}" data-sec="${s.id}">${icon(s.icon, 'sm')}${esc(t(s.label))}</a>`).join('')}</nav>
      <div data-sections></div>
    </div>`;
  const box = root.querySelector('[data-sections]');
  let holidays = [];
  let generated = 0;
  const openDetails = new Set();

  async function saveSettings(patch, msg = t('Saved')) {
    try {
      await api.put('/api/settings', patch);
      await loadSettings();
      toast(`${msg} ✓`, { type: 'success', duration: 1600 });
      return true;
    } catch (err) {
      errorToast(err);
      return false;
    }
  }

  const row = (title, desc, control, stacked = false) =>
    `<div class="setting-row ${stacked ? 'stacked' : ''}"><div class="info"><div class="t">${esc(title)}</div>${desc ? `<div class="d">${esc(desc)}</div>` : ''}</div><div class="control">${control}</div></div>`;
  const fold = (id, label, content) =>
    `<details class="settings-more" data-fold="${id}" ${openDetails.has(id) ? 'open' : ''}><summary>${icon('settings', 'sm')}${esc(label)}${icon('chevronD', 'sm')}</summary><div class="settings-more-body">${content}</div></details>`;

  function draw() {
    const s = state.settings;
    const u = state.user;
    const tzs = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [s.timezone];
    if (!tzs.includes(s.timezone)) tzs.unshift(s.timezone);
    const cats = state.categories;
    const notifPerm = 'Notification' in window ? Notification.permission : 'unsupported';
    const style = currentStyle(s);
    const ob = s.onboarding || {};

    box.innerHTML = `
      <section class="card settings-section" id="sec-me">
        <div class="card-header"><div><h2>${esc(t('Me'))}</h2><p>${esc(t('Your name, your sign-in and how the planner looks.'))}</p></div></div>
        <div class="card-body">
          <div class="me-card">
            <span class="avatar" style="width:52px;height:52px;font-size:18px">${esc(initials(u.name))}</span>
            <div class="grid-2" style="flex:1">
              <div class="field"><label>${esc(t('Name'))}</label><input class="input" data-profile="name" value="${esc(u.name)}" autocomplete="name"></div>
              <div class="field"><label>${esc(t('Sign-in email'))}</label><input class="input" type="email" data-profile="email" value="${esc(u.email)}" autocomplete="email"></div>
            </div>
          </div>
          ${row(t('Password'), t('Used to sign in on a new device.'), `<button class="btn sm" data-change-password>${icon('lock', 'sm')}${esc(t('Change password'))}</button>`)}
          ${row(t('Language'), '', `<div class="segmented"><button data-lang="fr" class="${s.language === 'fr' ? 'active' : ''}">Français</button><button data-lang="en" class="${s.language === 'en' ? 'active' : ''}">English</button></div>`)}
          ${row(t('Colours'), '', paletteGrid(s.palette || 'rose'), true)}
          ${row(
            t('Theme'),
            '',
            `<div class="segmented">${['system', 'light', 'dark']
              .map((th) => `<button data-theme-opt="${th}" class="${s.theme === th ? 'active' : ''}">${esc(t(th === 'system' ? 'Automatic' : th === 'light' ? 'Light' : 'Dark'))}</button>`)
              .join('')}</div>`
          )}
          ${row(
            t('Welcome guide'),
            ob.completed ? t('You can go through it again at any time.') : t('Not finished yet.'),
            `<a class="btn sm" href="#/welcome">${icon('sparkles', 'sm')}${esc(ob.completed ? t('Open it again') : t('Continue'))}</a><button class="btn ghost sm" data-answers>${esc(t('My answers'))}</button>`
          )}
        </div>
      </section>

      <section class="card settings-section" id="sec-places">
        <div class="card-header"><div style="flex:1"><h2>${esc(t('My institutions'))}</h2><p>${esc(t('Where you teach, how each one gives attestations, and the holidays.'))}</p></div>
          <button class="btn soft sm" data-new-cat>${icon('plus', 'sm')}${esc(t('Add'))}</button></div>
        <div class="card-body">
          ${
            cats.length
              ? cats
                  .map(
                    (c) => `<div class="cat-row" style="${c.archived ? 'opacity:.55' : ''}">
                <span class="cat-dot" style="background:${c.color};width:14px;height:14px"></span>
                <div style="flex:1;min-width:0"><div class="name">${esc(c.name)} ${c.archived ? `<span class="chip muted">${esc(t('Archived'))}</span>` : ''}</div>
                  <div class="small muted">${c.attestationMode ? `${icon('attestation', 'sm')} ${esc(ruleDescription(c))} · ` : ''}${esc(tn(c.eventCount, '{n} appointment', '{n} appointments'))}</div></div>
                <button class="btn ghost sm" data-edit-cat="${c.id}">${icon('edit', 'sm')}<span>${esc(t('Edit'))}</span></button>
                <button class="btn ghost sm icon-only" data-archive-cat="${c.id}" title="${esc(c.archived ? t('Restore') : t('Archive'))}">${icon(c.archived ? 'undo' : 'inbox', 'sm')}</button>
                <button class="btn ghost sm icon-only" data-del-cat="${c.id}" title="${esc(t('Delete'))}" style="color:var(--danger-text)">${icon('trash', 'sm')}</button>
              </div>`
                  )
                  .join('')
              : `<div class="empty" style="padding:20px">${esc(t('No institution yet. Add the schools or centres where you teach.'))}<br><button class="btn primary" data-new-cat style="margin-top:12px">${icon('plus')}${esc(t('Add an institution'))}</button></div>`
          }
          <div class="settings-sub">${icon('sun', 'sm')} ${esc(t('Holidays'))}<span class="small muted">${esc(t('Classes during a holiday are cancelled automatically.'))}</span></div>
          ${holidays
            .map(
              (h) => `<div class="cat-row"><span style="color:var(--warning-text)">${icon('sun', 'sm')}</span>
              <div style="flex:1;min-width:0"><div class="name">${esc(h.name)}</div>
              <div class="small muted">${esc(fmtDate(h.start))} → ${esc(fmtDate(h.end))}${h.cancelClasses ? ` · ${esc(tn(h.cancelledCount || 0, '{n} class cancelled', '{n} classes cancelled'))}` : ''}</div></div>
              <button class="btn ghost sm icon-only" data-del-hol="${h.id}" title="${esc(t('Delete'))}" style="color:var(--danger-text)">${icon('trash', 'sm')}</button></div>`
            )
            .join('')}
          <form class="flex wrap" data-holiday-form style="margin-top:10px" novalidate>
            <input class="input" name="name" placeholder="${esc(t('e.g. Winter holidays'))}" style="flex:1;min-width:160px">
            <input class="input" type="date" name="start" style="width:auto"><span class="muted">→</span><input class="input" type="date" name="end" style="width:auto">
            <label class="switch"><input type="checkbox" name="cancel" checked><span class="track"></span>${esc(t('Cancel classes'))}</label>
            <button class="btn soft" type="submit">${icon('plus', 'sm')}${esc(t('Add'))}</button>
          </form>
        </div>
      </section>

      <section class="card settings-section" id="sec-reminders">
        <div class="card-header"><div style="flex:1"><h2>${esc(t('My reminders'))}</h2><p>${esc(t('Choose how closely the planner follows you. You can change it at any time.'))}</p></div>
          <button class="btn ghost sm" data-preview>${icon('eye', 'sm')}${esc(t('See an example'))}</button></div>
        <div class="card-body">
          <div class="style-cards">${STYLES.map(
            (st) => `<button class="style-card ${style === st.id ? 'active' : ''}" data-style="${st.id}" aria-pressed="${style === st.id}">
              <span class="style-top"><span class="radio"></span><b>${esc(t(st.label))}</b>${st.recommended ? `<span class="chip primary">${esc(t('recommended'))}</span>` : ''}</span>
              <span class="d">${esc(t(st.description))}</span></button>`
          ).join('')}</div>
          ${style === 'custom' ? `<p class="small muted" style="margin-top:8px">${icon('settings', 'sm')} ${esc(t('You use your own settings (see “Customise” below).'))}</p>` : ''}
          <p class="small muted" style="margin-top:8px">${esc(t('Reminders apply to the appointments you add from now on; each one can still be changed.'))}</p>
          <div style="margin-top:10px">
          ${row(
            t('Emails go to'),
            s.emailManaged || s.smtpConfigured ? '' : t('Email is not set up yet: reminders appear in the app only.'),
            `<input class="input" type="email" data-setting="notifyEmail" value="${esc(s.notifyEmail)}" placeholder="${esc(u.email)}" style="width:240px">
             ${s.smtpConfigured ? `<button class="btn sm" type="button" data-test-email title="${esc(t('Send a test email'))}">${icon('mail', 'sm')}${esc(t('Test'))}</button>` : ''}`
          )}
          ${row(t('Receive emails'), t('Turn off to get reminders only in the app.'), `<label class="switch"><input type="checkbox" data-setting-bool="emailEnabled" ${s.emailEnabled ? 'checked' : ''}><span class="track"></span></label>`)}
          </div>
          ${fold(
            'custom',
            t('Customise'),
            `${row(
              t('Reminders before each appointment'),
              t('The ones with an email are also sent by email.'),
              `<div class="pills">${REMINDER_CHOICES.map((m) => {
                const r = s.defaultReminders.find((x) => x.minutes === m);
                return `<button class="pill ${r ? 'active' : ''}" data-def-rem="${m}">${esc(reminderLabel(m))}${r?.email ? ` ${icon('mail', 'sm')}` : ''}</button>`;
              }).join('')}</div>`,
              true
            )}
            ${row(
              t('Missing attestation: remind me every'),
              t('Until you mark it as received.'),
              `<select class="select" data-setting="nagIntervalHours">${[2, 4, 8, 12, 24, 48]
                .map((h) => `<option value="${h}" ${Number(s.nagIntervalHours) === h ? 'selected' : ''}>${esc(h < 24 ? t('{n} hours', { n: h }) : h === 24 ? t('day') : t('2 days'))}</option>`)
                .join('')}</select>`
            )}
            ${row(
              t('Morning summary email'),
              t('Your day and missing attestations, every morning.'),
              `<input class="input" type="time" data-setting="digestTime" value="${s.digestTime}" ${s.digestEnabled ? '' : 'disabled'}>
               <label class="switch"><input type="checkbox" data-setting-bool="digestEnabled" ${s.digestEnabled ? 'checked' : ''}><span class="track"></span></label>`
            )}
            ${row(t('Quiet hours'), t('No attestation reminders during this time.'), `<input class="input" type="time" data-setting="quietStart" value="${s.quietStart}"><span class="muted">→</span><input class="input" type="time" data-setting="quietEnd" value="${s.quietEnd}">`)}
            ${row(
              t('Notifications on this computer'),
              notifPerm === 'granted'
                ? t('Enabled in this browser.')
                : notifPerm === 'denied'
                  ? t('Blocked. Allow notifications for this site in your browser settings.')
                  : notifPerm === 'unsupported'
                    ? t('Not supported by this browser.')
                    : t('Get a pop-up even when the app is in another tab.'),
              notifPerm === 'default' ? `<button class="btn sm" data-ask-notif>${icon('bell', 'sm')}${esc(t('Enable'))}</button>` : notifPerm === 'granted' ? `<span class="chip success">${icon('check')}${esc(t('Active'))}</span>` : ''
            )}
            <details style="margin-top:12px" data-log-details><summary class="small strong" style="cursor:pointer;color:var(--primary-text)">${esc(t('Recent email activity'))}</summary><div data-email-log style="margin-top:8px"></div></details>`
          )}
        </div>
      </section>

      <section class="card settings-section" id="sec-data">
        <div class="card-header"><div><h2>${esc(t('My data'))}</h2><p>${esc(
          s.storage === 'cloud'
            ? t('Everything is kept safely online, and you can find it from any device. You can also keep a copy.')
            : t('Everything is stored on this computer. Keep a backup somewhere safe.')
        )}</p></div></div>
        <div class="card-body">
          ${row(t('Full backup'), t('All appointments, courses, settings and documents in one .zip file.'), `<a class="btn" href="/api/export/backup">${icon('download', 'sm')}${esc(t('Download'))}</a>`)}
          ${row(t('Trash'), t('Deleted appointments, documents and courses can be restored for 30 days.'), `<button class="btn" data-open-trash>${icon('trash', 'sm')}${esc(t('Open the trash'))}</button>`)}
          ${row(t('My schedule as a PDF'), t('A week or a month, ready to print or send.'), `<button class="btn" data-export-pdf>${icon('fileText', 'sm')}${esc(t('Download'))}</button>`)}
          ${
            generated
              ? row(
                  t('Sessions from the old weekly timetable'),
                  tn(
                    generated,
                    '{n} upcoming session was created in advance by the old weekly timetable. Remove it if it does not match your real schedule. Past sessions, and any with an attestation or a document, are kept.',
                    '{n} upcoming sessions were created in advance by the old weekly timetable. Remove them if they do not match your real schedule. Past sessions, and any with an attestation or a document, are kept.'
                  ),
                  `<button class="btn soft-danger" data-clear-generated>${icon('trash', 'sm')}${esc(t('Remove them'))}</button>`
                )
              : ''
          }
          ${row(t('Sign out'), t('You will need your password to come back.'), `<button class="btn soft-danger" data-logout>${icon('logout', 'sm')}${esc(t('Sign out'))}</button>`)}
          ${fold(
            'advanced',
            t('Advanced'),
            `${row(t('Name of your planner'), t('Shown at the top of the app and in your emails.'), `<input class="input" data-setting="appName" value="${esc(s.appName || 'Planner')}" maxlength="40" style="width:200px">`)}
            ${row(t('Week starts on'), '', `<div class="segmented"><button data-week="1" class="${s.weekStart === 1 ? 'active' : ''}">${esc(t('Monday'))}</button><button data-week="0" class="${s.weekStart === 0 ? 'active' : ''}">${esc(t('Sunday'))}</button></div>`)}
            ${row(t('Working hours'), t('Highlighted in the calendar; the week view opens at the start time.'), `<input class="input" type="time" data-setting="dayStart" value="${s.dayStart}"><span class="muted">→</span><input class="input" type="time" data-setting="dayEnd" value="${s.dayEnd}">`)}
            ${row(t('Time zone'), t('Reminders are sent according to this time zone.'), `<select class="select" data-setting="timezone" style="max-width:240px">${tzs.map((z) => `<option ${z === s.timezone ? 'selected' : ''}>${esc(z)}</option>`).join('')}</select>`)}
            ${row(t('Export calendar'), t('An .ics file you can import into Google Calendar, Outlook or your phone.'), `<a class="btn sm" href="/api/export/calendar.ics">${icon('calendar', 'sm')}${esc(t('Export .ics'))}</a>`)}
            ${
              s.emailManaged
                ? ''
                : `<form class="stack" data-smtp novalidate style="border-top:1px solid var(--border);padding-top:16px;margin-top:4px">
              <div class="flex wrap"><span class="label">${esc(t('Sending account (SMTP)'))}</span><span class="spacer"></span>
                <span class="small muted">${esc(t('Quick setup:'))}</span>
                <button type="button" class="pill" data-preset="gmail">Gmail</button><button type="button" class="pill" data-preset="outlook">Outlook</button><button type="button" class="pill" data-preset="yahoo">Yahoo</button></div>
              <div class="tip" data-gmail-tip ${/gmail/i.test(s.smtp.host) ? '' : 'hidden'}>${icon('info')}<span>${esc(t('For Gmail: turn on 2-step verification, then create an “App password” (Google Account → Security → App passwords) and paste it below. Your normal password will not work.'))}</span></div>
              <div class="grid-3">
                <div class="field" style="grid-column:span 2"><label>${esc(t('Server'))}</label><input class="input" name="host" value="${esc(s.smtp.host)}" placeholder="smtp.gmail.com"></div>
                <div class="field"><label>${esc(t('Port'))}</label><input class="input" name="port" type="number" value="${esc(s.smtp.port)}"></div>
              </div>
              <div class="grid-2">
                <div class="field"><label>${esc(t('Username (email)'))}</label><input class="input" name="user" value="${esc(s.smtp.user)}" autocomplete="off"></div>
                <div class="field"><label>${esc(t('Password / app password'))}</label><input class="input" name="pass" type="password" value="${s.smtp.pass ? '__unchanged__' : ''}" autocomplete="new-password"></div>
              </div>
              <div class="grid-2">
                <div class="field"><label>${esc(t('Sender address (optional)'))}</label><input class="input" name="from" value="${esc(s.smtp.from)}" placeholder="${esc(t('Planner <you@gmail.com>'))}"></div>
                <div class="field" style="justify-content:flex-end"><label class="switch"><input type="checkbox" name="secure" ${s.smtp.secure ? 'checked' : ''}><span class="track"></span>${esc(t('Secure connection (SSL, port 465)'))}</label></div>
              </div>
              <div class="flex wrap"><button class="btn primary" type="submit">${esc(t('Save'))}</button>
                <button class="btn" type="button" data-test-email ${s.smtpConfigured ? '' : 'disabled'}>${icon('mail', 'sm')}${esc(t('Send a test email'))}</button></div>
            </form>`
            }`
          )}
        </div>
      </section>`;
    highlightNav();
  }

  function highlightNav(id) {
    const current = id || OLD_SECTIONS[params.s] || params.s || 'me';
    root.querySelectorAll('[data-sec]').forEach((a) => a.classList.toggle('active', a.dataset.sec === current));
  }

  // ----- navigation -----
  on(root, 'click', '[data-sec]', (e, a) => {
    e.preventDefault();
    document.getElementById(`sec-${a.dataset.sec}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    history.replaceState(null, '', `#/settings?s=${a.dataset.sec}`);
    highlightNav(a.dataset.sec);
  });
  // Folded parts stay open after a change redraws the page.
  box.addEventListener('toggle', (e) => {
    const d = e.target;
    if (d.matches?.('[data-fold]')) d.open ? openDetails.add(d.dataset.fold) : openDetails.delete(d.dataset.fold);
    if (d.matches?.('[data-log-details]') && d.open) loadLog();
  }, true);

  // ----- me -----
  box.addEventListener('change', async (e) => {
    const el = e.target;
    if (el.dataset.profile) {
      const value = el.value.trim();
      if (!value || value === state.user[el.dataset.profile]) return;
      try {
        const res = await api.put('/api/auth/profile', { name: state.user.name, email: state.user.email, [el.dataset.profile]: value });
        state.user = res.user;
        toast(`${t('Saved')} ✓`, { type: 'success', duration: 1600 });
        document.querySelectorAll('.user-chip .name').forEach((n) => (n.textContent = res.user.name));
        document.querySelectorAll('.user-chip .email').forEach((n) => (n.textContent = res.user.email));
        document.querySelectorAll('.user-chip .avatar').forEach((n) => (n.textContent = initials(res.user.name)));
      } catch (err) {
        errorToast(err);
        el.value = state.user[el.dataset.profile];
      }
    } else if (el.dataset.setting) {
      let value = el.value;
      if (el.dataset.setting === 'nagIntervalHours') value = Number(value);
      if (el.type === 'time' && !value) return;
      if (!(await saveSettings({ [el.dataset.setting]: value }))) draw();
    } else if (el.dataset.settingBool) {
      await saveSettings({ [el.dataset.settingBool]: el.checked });
      draw();
    }
  });
  on(box, 'click', '[data-change-password]', () => {
    const m = openModal({
      title: t('Change password'),
      size: 'sm',
      content: `<form class="stack" novalidate>
          <div class="field"><label>${esc(t('Current password'))}</label><input class="input" name="currentPassword" type="password" autocomplete="current-password" autofocus></div>
          <div class="field"><label>${esc(t('New password'))}</label><input class="input" name="newPassword" type="password" minlength="8" autocomplete="new-password"><span class="hint">${esc(t('At least 8 characters.'))}</span></div>
        </form>`,
      footer: `<span class="spacer"></span><button class="btn" data-close>${esc(t('Cancel'))}</button><button class="btn primary" data-ok>${esc(t('Save'))}</button>`,
    });
    const form = m.root.querySelector('form');
    const submit = async () => {
      const btn = m.root.querySelector('[data-ok]');
      if (!form.currentPassword.value) return form.currentPassword.focus();
      if (form.newPassword.value.length < 8) {
        form.newPassword.focus();
        return toast(t('The new password needs at least 8 characters.'), { type: 'error' });
      }
      setBusy(btn, true);
      try {
        await api.put('/api/auth/profile', { name: state.user.name, email: state.user.email, currentPassword: form.currentPassword.value, newPassword: form.newPassword.value });
        toast(t('Profile and password updated'), { type: 'success' });
        m.close(true);
      } catch (err) {
        setBusy(btn, false);
        errorToast(err);
      }
    };
    m.root.querySelector('[data-ok]').addEventListener('click', submit);
    form.addEventListener('submit', (e) => (e.preventDefault(), submit()));
  });
  on(box, 'click', '[data-lang]', async (e, b) => {
    await saveSettings({ language: b.dataset.lang }, b.dataset.lang === 'fr' ? 'Langue enregistrée' : 'Language saved');
  });
  on(box, 'click', '[data-theme-opt]', async (e, b) => {
    if (await saveSettings({ theme: b.dataset.themeOpt })) draw();
  });
  on(box, 'click', '[data-palette-opt]', async (e, b) => {
    const p = PALETTES.find((x) => x.id === b.dataset.paletteOpt);
    await saveSettings({ palette: p.id, accentColor: p.accent }, t('Theme changed'));
  });
  on(box, 'click', '[data-answers]', async () => {
    const { openAnswersSummary } = await import('./welcome.js');
    openAnswersSummary();
  });

  // ----- institutions & holidays -----
  on(box, 'click', '[data-new-cat]', () => openCategoryForm());
  on(box, 'click', '[data-edit-cat]', (e, b) => openCategoryForm(state.categories.find((c) => c.id === Number(b.dataset.editCat))));
  on(box, 'click', '[data-archive-cat]', async (e, b) => {
    const c = state.categories.find((x) => x.id === Number(b.dataset.archiveCat));
    try {
      await api.put(`/api/categories/${c.id}`, categoryPayload(c, { archived: !c.archived }));
      await loadCategories();
      changed();
      toast(c.archived ? t('Institution restored') : t('Institution archived. Its history is kept.'));
    } catch (err) {
      errorToast(err);
    }
  });
  on(box, 'click', '[data-del-cat]', async (e, b) => {
    const c = state.categories.find((x) => x.id === Number(b.dataset.delCat));
    const ok = await confirmDialog({
      title: t('Delete “{name}”?', { name: c.name }),
      message: c.eventCount
        ? esc(tn(c.eventCount, '{n} appointment uses it. It will be kept, without an institution. Tip: archive it instead to keep the history tidy.', '{n} appointments use it. They will be kept, without an institution. Tip: archive it instead to keep the history tidy.'))
        : esc(t('This cannot be undone.')),
      confirm: t('Delete'),
      danger: true,
    });
    if (!ok) return;
    try {
      await api.del(`/api/categories/${c.id}`);
      await loadCategories();
      changed();
    } catch (err) {
      errorToast(err);
    }
  });
  on(box, 'click', '[data-del-hol]', async (e, b) => {
    const h = holidays.find((x) => x.id === Number(b.dataset.delHol));
    const ok = await confirmDialog({
      title: t('Delete “{name}”?', { name: h.name }),
      message: esc(h.cancelledCount ? tn(h.cancelledCount, 'The {n} cancelled class will be scheduled again.', 'The {n} cancelled classes will be scheduled again.') : t('This cannot be undone.')),
      confirm: t('Delete'),
      danger: true,
    });
    if (!ok) return;
    try {
      await api.del(`/api/holidays/${h.id}`);
      await loadHolidays();
      changed();
    } catch (err) {
      errorToast(err);
    }
  });

  // ----- reminders -----
  on(box, 'click', '[data-style]', async (e, b) => {
    const st = STYLES.find((x) => x.id === b.dataset.style);
    if (await saveSettings(st.values, t('Reminders: {name}', { name: t(st.label) }))) draw();
  });
  on(box, 'click', '[data-def-rem]', async (e, b) => {
    const m = Number(b.dataset.defRem);
    const list = [...state.settings.defaultReminders];
    const i = list.findIndex((r) => r.minutes === m);
    if (i > -1) list.splice(i, 1);
    else list.push({ minutes: m, email: m >= 1440 });
    list.sort((a, b2) => a.minutes - b2.minutes);
    if (await saveSettings({ defaultReminders: list })) draw();
  });
  on(box, 'click', '[data-preview]', () => {
    // What a reminder looks like in the app…
    toast(t('Coming up: {title}', { title: state.settings.language === 'fr' ? 'Maths — 3e année A' : 'Maths — Year 3A' }), {
      action: t('View'),
      onAction: () => {},
    });
    // …and by email.
    openModal({
      title: t('Example of a reminder email'),
      content: `<p class="small muted" style="margin-bottom:10px">${esc(t('In the app, reminders appear as the small message at the bottom of the screen, and in the bell at the top.'))}</p>
        <iframe class="email-preview" src="/api/settings/email-preview" title="${esc(t('Example of a reminder email'))}"></iframe>`,
      footer: `<span class="spacer"></span><button class="btn primary" data-close>${esc(t('Close'))}</button>`,
    });
  });
  on(box, 'click', '[data-open-trash]', () => openTrash());
  on(box, 'click', '[data-test-email]', async (e, b) => {
    setBusy(b, true);
    try {
      const res = await api.post('/api/settings/test-email');
      toast(t('Test email sent to {e}. Check your inbox (and spam folder).', { e: res.to }), { type: 'success', duration: 7000 });
    } catch (err) {
      errorToast(err);
    }
    setBusy(b, false);
    loadLog();
  });
  on(box, 'click', '[data-ask-notif]', async () => {
    try {
      await Notification.requestPermission();
    } catch {
      /* ignore */
    }
    draw();
  });

  // ----- data & advanced -----
  on(box, 'click', '[data-export-pdf]', async () => {
    const { exportSchedulePdf } = await import('../exportPdf.js');
    exportSchedulePdf();
  });
  on(box, 'click', '[data-week]', async (e, b) => {
    if (await saveSettings({ weekStart: Number(b.dataset.week) })) draw();
  });
  on(box, 'click', '[data-preset]', (e, b) => {
    const p = SMTP_PRESETS[b.dataset.preset];
    const form = box.querySelector('[data-smtp]');
    form.host.value = p.host;
    form.port.value = p.port;
    form.secure.checked = p.secure;
    box.querySelector('[data-gmail-tip]').hidden = b.dataset.preset !== 'gmail';
    form.user.focus();
  });
  on(box, 'click', '[data-clear-generated]', async (e, b) => {
    const ok = await confirmDialog({
      title: t('Remove the sessions from the old timetable?'),
      message: esc(tn(generated, '{n} upcoming session will be deleted. This cannot be undone.', '{n} upcoming sessions will be deleted. This cannot be undone.')),
      confirm: t('Remove them'),
      danger: true,
    });
    if (!ok) return;
    setBusy(b, true);
    try {
      const res = await api.post('/api/events/generated/clear');
      toast(tn(res.removed, '{n} session removed', '{n} sessions removed'), { type: 'success' });
      changed();
      await loadGenerated();
    } catch (err) {
      setBusy(b, false);
      errorToast(err);
    }
  });
  on(box, 'click', '[data-logout]', async () => {
    const { logout } = await import('../app.js');
    logout();
  });

  box.addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    const btn = form.querySelector('[type=submit]');
    if (form.matches('[data-smtp]')) {
      setBusy(btn, true);
      const ok = await saveSettings(
        { smtp: { host: form.host.value, port: form.port.value, secure: form.secure.checked, user: form.user.value, pass: form.pass.value, from: form.from.value } },
        t('Email settings saved')
      );
      if (ok) draw();
      else setBusy(btn, false);
    } else if (form.matches('[data-holiday-form]')) {
      setBusy(btn, true);
      try {
        const res = await api.post('/api/holidays', { name: form.name.value, start: form.start.value, end: form.end.value || form.start.value, cancelClasses: form.cancel.checked });
        toast(res.cancelled ? tn(res.cancelled, 'Holiday added · {n} class cancelled', 'Holiday added · {n} classes cancelled') : t('Holiday added'), { type: 'success' });
        await loadHolidays();
        changed();
      } catch (err) {
        setBusy(btn, false);
        errorToast(err);
      }
    }
  });

  async function loadLog() {
    const target = box.querySelector('[data-email-log]');
    if (!target) return;
    try {
      const rows = await api.get('/api/settings/email-log');
      target.innerHTML = rows.length
        ? rows
            .map(
              (r) => `<div class="log-row"><span class="chip ${r.status === 'sent' ? 'success' : r.status === 'failed' ? 'danger' : 'muted'}">${esc(t(r.status === 'sent' ? 'Sent' : r.status === 'failed' ? 'Failed' : 'Skipped'))}</span>
              <span class="ellipsis" style="flex:1">${esc(r.subject)}${r.error ? `<div class="small muted">${esc(r.error)}</div>` : ''}</span>
              <span class="small muted nowrap">${esc(timeAgo(dateToWall(new Date(r.created_at.replace(' ', 'T') + 'Z'))))}</span></div>`
            )
            .join('')
        : `<p class="small muted">${esc(t('No email sent yet.'))}</p>`;
    } catch (err) {
      target.textContent = err.message;
    }
  }

  async function loadHolidays() {
    try {
      holidays = await api.get('/api/holidays');
    } catch {
      holidays = [];
    }
    draw();
  }

  async function loadGenerated() {
    try {
      generated = (await api.get('/api/events/generated')).upcoming;
    } catch {
      generated = 0;
    }
    draw();
  }

  // The menu follows the section being read.
  let clicked = 0;
  root.addEventListener('click', (e) => e.target.closest('[data-sec]') && (clicked = Date.now()));
  const onScroll = () => {
    if (Date.now() - clicked < 900) return;
    const sections = [...box.querySelectorAll('.settings-section')];
    const current = sections.filter((s) => s.getBoundingClientRect().top < window.innerHeight * 0.35).pop() || sections[0];
    if (current) highlightNav(current.id.replace('sec-', ''));
  };
  window.addEventListener('scroll', onScroll, { passive: true });

  const unsubSettings = subscribe((what) => {
    if (what === 'categories' || what === 'settings') draw();
  });
  const unsub = () => {
    unsubSettings();
    window.removeEventListener('scroll', onScroll);
  };
  draw();
  loadHolidays();
  loadGenerated();
  const target = OLD_SECTIONS[params.s] || params.s;
  if (target) setTimeout(() => document.getElementById(`sec-${target}`)?.scrollIntoView({ block: 'start' }), 80);
  return unsub;
}
