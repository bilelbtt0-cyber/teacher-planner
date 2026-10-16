import { api } from '../api.js';
import { t, tn, reminderLabel, timeAgo, hoursLabel, dateToWall, fmtDate } from '../i18n.js';
import { state, subscribe, loadSettings, loadCategories, changed, emit } from '../store.js';
import { esc, icon, on, toast, errorToast, setBusy, confirmDialog, initials, CATEGORY_COLORS, PALETTES, paletteGrid } from '../ui.js';
import { openCategoryForm, ruleDescription, categoryPayload } from '../eventForm.js';

const SECTIONS = [
  { id: 'personal', label: 'Personalisation', icon: 'sparkles' },
  { id: 'profile', label: 'Profile', icon: 'user' },
  { id: 'institutions', label: 'Institutions', icon: 'building' },
  { id: 'holidays', label: 'Holidays', icon: 'sun' },
  { id: 'notifications', label: 'Reminders', icon: 'bell' },
  { id: 'email', label: 'Email', icon: 'mail' },
  { id: 'appearance', label: 'Appearance', icon: 'palette' },
  { id: 'data', label: 'Data & backup', icon: 'database' },
];

const SMTP_PRESETS = {
  gmail: { host: 'smtp.gmail.com', port: 465, secure: true },
  outlook: { host: 'smtp-mail.outlook.com', port: 587, secure: false },
  yahoo: { host: 'smtp.mail.yahoo.com', port: 465, secure: true },
};

const REMINDER_CHOICES = [0, 10, 30, 60, 120, 1440, 2880, 10080];

export async function render(root, params) {
  root.innerHTML = `
    <div class="settings-layout">
      <nav class="settings-nav">${SECTIONS.map((s) => `<a href="#/settings?s=${s.id}" data-sec="${s.id}">${icon(s.icon, 'sm')}${esc(t(s.label))}</a>`).join('')}</nav>
      <div data-sections></div>
    </div>`;
  const box = root.querySelector('[data-sections]');

  async function saveSettings(patch, msg = t('Saved')) {
    try {
      await api.put('/api/settings', patch);
      await loadSettings();
      toast(msg, { type: 'success', duration: 1800 });
      return true;
    } catch (err) {
      errorToast(err);
      return false;
    }
  }

  function draw() {
    const s = state.settings;
    const u = state.user;
    const tzs = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [s.timezone];
    if (!tzs.includes(s.timezone)) tzs.unshift(s.timezone);
    const cats = state.categories;
    const notifPerm = 'Notification' in window ? Notification.permission : 'unsupported';

    const ob = s.onboarding || {};
    box.innerHTML = `
      <section class="card settings-section" id="sec-personal">
        <div class="card-header"><div style="flex:1"><h2>${esc(t('Personalisation'))}</h2><p>${esc(t('The welcome guide sets up your institutions, timetable and reminders from your answers.'))}</p></div>
          ${ob.completed ? `<span class="chip success">${icon('check')}${esc(t('Completed'))}</span>` : `<span class="chip warning">${esc(t('Not finished'))}</span>`}</div>
        <div class="card-body flex wrap">
          <a class="btn primary" href="#/welcome">${icon('sparkles', 'sm')}${esc(ob.completed ? t('Open the welcome guide again') : t('Continue the welcome guide'))}</a>
          <button class="btn" data-answers>${icon('fileText', 'sm')}${esc(t('See all my answers'))}</button>
        </div>
      </section>

      <section class="card settings-section" id="sec-profile">
        <div class="card-header"><div><h2>${esc(t('Profile'))}</h2><p>${esc(t('Your name, sign-in email and password.'))}</p></div></div>
        <div class="card-body">
          <form class="stack" data-profile novalidate>
            <div class="flex"><span class="avatar" style="width:48px;height:48px;font-size:17px">${esc(initials(u.name))}</span>
              <div><div class="strong">${esc(u.name)}</div><div class="small muted">${esc(u.email)}</div></div></div>
            <div class="grid-2">
              <div class="field"><label>${esc(t('Name'))}</label><input class="input" name="name" value="${esc(u.name)}" autocomplete="name"></div>
              <div class="field"><label>${esc(t('Sign-in email'))}</label><input class="input" name="email" type="email" value="${esc(u.email)}" autocomplete="email"></div>
            </div>
            <details><summary class="small strong" style="cursor:pointer;color:var(--primary-text)">${esc(t('Change password'))}</summary>
              <div class="grid-2" style="margin-top:12px">
                <div class="field"><label>${esc(t('Current password'))}</label><input class="input" name="currentPassword" type="password" autocomplete="current-password"></div>
                <div class="field"><label>${esc(t('New password'))}</label><input class="input" name="newPassword" type="password" minlength="8" autocomplete="new-password"><span class="hint">${esc(t('At least 8 characters.'))}</span></div>
              </div></details>
            <div><button class="btn primary" type="submit">${esc(t('Save profile'))}</button></div>
          </form>
        </div>
      </section>

      <section class="card settings-section" id="sec-institutions">
        <div class="card-header"><div style="flex:1"><h2>${esc(t('Institutions'))}</h2><p>${esc(t('Schools and centres you work for. Each has a colour in the calendar and can have an attestation rule.'))}</p></div>
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
        </div>
      </section>

      <section class="card settings-section" id="sec-holidays">
        <div class="card-header"><div><h2>${esc(t('Holidays'))}</h2><p>${esc(t('Classes during a holiday are cancelled automatically, and come back if you remove the holiday.'))}</p></div></div>
        <div class="card-body">
          ${holidays
            .map(
              (h) => `<div class="cat-row"><span style="color:var(--warning-text)">${icon('sun', 'sm')}</span>
              <div style="flex:1;min-width:0"><div class="name">${esc(h.name)}</div>
              <div class="small muted">${esc(fmtDate(h.start))} → ${esc(fmtDate(h.end))}${h.cancelClasses ? ` · ${esc(tn(h.cancelledCount || 0, '{n} class cancelled', '{n} classes cancelled'))}` : ''}</div></div>
              <button class="btn ghost sm icon-only" data-del-hol="${h.id}" title="${esc(t('Delete'))}" style="color:var(--danger-text)">${icon('trash', 'sm')}</button></div>`
            )
            .join('')}
          <form class="flex wrap" data-holiday-form style="margin-top:${holidays.length ? '14px' : '0'}" novalidate>
            <input class="input" name="name" placeholder="${esc(t('e.g. Winter holidays'))}" style="flex:1;min-width:160px">
            <input class="input" type="date" name="start" style="width:auto"><span class="muted">→</span><input class="input" type="date" name="end" style="width:auto">
            <label class="switch"><input type="checkbox" name="cancel" checked><span class="track"></span>${esc(t('Cancel classes'))}</label>
            <button class="btn soft" type="submit">${icon('plus', 'sm')}${esc(t('Add'))}</button>
          </form>
        </div>
      </section>

      <section class="card settings-section" id="sec-notifications">
        <div class="card-header"><div><h2>${esc(t('Reminders'))}</h2><p>${esc(t('How and when the app reminds you.'))}</p></div></div>
        <div class="card-body">
          <div class="setting-row stacked"><div class="info"><div class="t">${esc(t('Default reminders for new appointments'))}</div>
            <div class="d">${esc(t('You can still change them on each appointment.'))}</div></div>
            <div class="control"><div class="pills">${REMINDER_CHOICES.map((m) => {
              const r = s.defaultReminders.find((x) => x.minutes === m);
              return `<button class="pill ${r ? 'active' : ''}" data-def-rem="${m}">${esc(reminderLabel(m))}</button>`;
            }).join('')}</div></div></div>
          <div class="setting-row"><div class="info"><div class="t">${esc(t('Missing attestation: remind me every'))}</div>
            <div class="d">${esc(t('After a session that needs an attestation ends, reminders repeat until you mark it received.'))}</div></div>
            <div class="control"><select class="select" data-setting="nagIntervalHours">
              ${[2, 4, 8, 12, 24, 48].map((h) => `<option value="${h}" ${Number(s.nagIntervalHours) === h ? 'selected' : ''}>${esc(h < 24 ? t('{n} hours', { n: h }) : h === 24 ? t('day') : t('2 days'))}</option>`).join('')}
            </select></div></div>
          <div class="setting-row"><div class="info"><div class="t">${esc(t('Quiet hours'))}</div><div class="d">${esc(t('No attestation reminders during this time.'))}</div></div>
            <div class="control"><input class="input" type="time" data-setting="quietStart" value="${s.quietStart}"><span class="muted">→</span><input class="input" type="time" data-setting="quietEnd" value="${s.quietEnd}"></div></div>
          <div class="setting-row"><div class="info"><div class="t">${esc(t('Morning summary email'))}</div><div class="d">${esc(t('Your day and missing attestations, every morning.'))}</div></div>
            <div class="control"><input class="input" type="time" data-setting="digestTime" value="${s.digestTime}" ${s.digestEnabled ? '' : 'disabled'}>
              <label class="switch"><input type="checkbox" data-setting-bool="digestEnabled" ${s.digestEnabled ? 'checked' : ''}><span class="track"></span></label></div></div>
          <div class="setting-row"><div class="info"><div class="t">${esc(t('Desktop notifications'))}</div>
            <div class="d">${esc(notifPerm === 'granted' ? t('Enabled in this browser.') : notifPerm === 'denied' ? t('Blocked. Allow notifications for this site in your browser settings.') : notifPerm === 'unsupported' ? t('Not supported by this browser.') : t('Get a pop-up even when the app is in another tab.'))}</div></div>
            <div class="control">${notifPerm === 'default' ? `<button class="btn sm" data-ask-notif>${icon('bell', 'sm')}${esc(t('Enable'))}</button>` : notifPerm === 'granted' ? `<span class="chip success">${icon('check')}${esc(t('Active'))}</span>` : ''}</div></div>
        </div>
      </section>

      <section class="card settings-section" id="sec-email">
        <div class="card-header"><div style="flex:1"><h2>${esc(t('Email'))}</h2><p>${esc(t('To receive reminders by email, connect an email account that will send them.'))}</p></div>
          ${s.smtpConfigured ? `<span class="chip success">${icon('check')}${esc(t('Configured'))}</span>` : `<span class="chip warning">${esc(t('Not configured'))}</span>`}</div>
        <div class="card-body">
          <div class="setting-row"><div class="info"><div class="t">${esc(t('Send reminders by email'))}</div><div class="d">${esc(t('Turn off to receive reminders only in the app.'))}</div></div>
            <div class="control"><label class="switch"><input type="checkbox" data-setting-bool="emailEnabled" ${s.emailEnabled ? 'checked' : ''}><span class="track"></span></label></div></div>
          <div class="setting-row"><div class="info"><div class="t">${esc(t('Send reminders to'))}</div><div class="d">${esc(t('Leave empty to use your sign-in email.'))}</div></div>
            <div class="control"><input class="input" type="email" data-setting="notifyEmail" value="${esc(s.notifyEmail)}" placeholder="${esc(u.email)}" style="width:260px"></div></div>
          ${
            s.emailManaged
              ? `<div class="tip" style="margin-top:6px">${icon('checkCircle')}<span>${esc(t('Emails are sent by the planner’s own email service. There is nothing to set up.'))}</span></div>
                <div class="flex wrap" style="margin-top:12px"><button class="btn" type="button" data-test-email>${icon('mail', 'sm')}${esc(t('Send a test email'))}</button>
                <span class="small muted">${esc(t('to {e}', { e: s.recipient || u.email }))}</span></div>`
              : ''
          }
          <form class="stack" data-smtp novalidate style="border-top:1px solid var(--border);padding-top:16px" ${s.emailManaged ? 'hidden' : ''}>
            <div class="flex wrap"><span class="label">${esc(t('Sending account (SMTP)'))}</span><span class="spacer"></span>
              <span class="small muted">${esc(t('Quick setup:'))}</span>
              <button type="button" class="pill" data-preset="gmail">Gmail</button><button type="button" class="pill" data-preset="outlook">Outlook</button><button type="button" class="pill" data-preset="yahoo">Yahoo</button></div>
            <div class="tip" data-gmail-tip hidden>${icon('info')}<span>${esc(t('For Gmail: turn on 2-step verification, then create an “App password” (Google Account → Security → App passwords) and paste it below. Your normal password will not work.'))}</span></div>
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
              <button class="btn" type="button" data-test-email ${s.smtpConfigured ? '' : 'disabled'}>${icon('mail', 'sm')}${esc(t('Send a test email'))}</button>
              <span class="small muted">${esc(t('to {e}', { e: s.recipient || u.email }))}</span></div>
          </form>
          <details style="margin-top:16px" data-log-details><summary class="small strong" style="cursor:pointer;color:var(--primary-text)">${esc(t('Recent email activity'))}</summary><div data-email-log style="margin-top:8px"></div></details>
        </div>
      </section>

      <section class="card settings-section" id="sec-appearance">
        <div class="card-header"><div><h2>${esc(t('Appearance'))}</h2><p>${esc(t('Language, theme and calendar preferences.'))}</p></div></div>
        <div class="card-body">
          <div class="setting-row"><div class="info"><div class="t">${esc(t('Language'))}</div></div>
            <div class="control"><div class="segmented"><button data-lang="fr" class="${s.language === 'fr' ? 'active' : ''}">Français</button><button data-lang="en" class="${s.language === 'en' ? 'active' : ''}">English</button></div></div></div>
          <div class="setting-row"><div class="info"><div class="t">${esc(t('Name of your planner'))}</div><div class="d">${esc(t('Shown at the top of the app and in your emails.'))}</div></div>
            <div class="control"><input class="input" data-setting="appName" value="${esc(s.appName || 'Planner')}" maxlength="40" style="width:220px"></div></div>
          <div class="setting-row stacked"><div class="info"><div class="t">${esc(t('Colour theme'))}</div><div class="d">${esc(t('Changes the colours of the whole planner.'))}</div></div>
            <div class="control">${paletteGrid(s.palette || 'rose')}</div></div>
          <div class="setting-row"><div class="info"><div class="t">${esc(t('Theme'))}</div></div>
            <div class="control"><div class="segmented">${['system', 'light', 'dark']
              .map((th) => `<button data-theme-opt="${th}" class="${s.theme === th ? 'active' : ''}">${esc(t(th === 'system' ? 'Automatic' : th === 'light' ? 'Light' : 'Dark'))}</button>`)
              .join('')}</div></div></div>
          <div class="setting-row"><div class="info"><div class="t">${esc(t('Week starts on'))}</div></div>
            <div class="control"><div class="segmented"><button data-week="1" class="${s.weekStart === 1 ? 'active' : ''}">${esc(t('Monday'))}</button><button data-week="0" class="${s.weekStart === 0 ? 'active' : ''}">${esc(t('Sunday'))}</button></div></div></div>
          <div class="setting-row"><div class="info"><div class="t">${esc(t('Working hours'))}</div><div class="d">${esc(t('Highlighted in the calendar; the week view opens at the start time.'))}</div></div>
            <div class="control"><input class="input" type="time" data-setting="dayStart" value="${s.dayStart}"><span class="muted">→</span><input class="input" type="time" data-setting="dayEnd" value="${s.dayEnd}"></div></div>
          <div class="setting-row"><div class="info"><div class="t">${esc(t('Time zone'))}</div><div class="d">${esc(t('Reminders are sent according to this time zone.'))}</div></div>
            <div class="control"><select class="select" data-setting="timezone" style="max-width:260px">${tzs.map((z) => `<option ${z === s.timezone ? 'selected' : ''}>${esc(z)}</option>`).join('')}</select></div></div>
        </div>
      </section>

      <section class="card settings-section" id="sec-data">
        <div class="card-header"><div><h2>${esc(t('Data & backup'))}</h2><p>${esc(t('Everything is stored on this computer. Keep a backup somewhere safe.'))}</p></div></div>
        <div class="card-body">
          <div class="setting-row"><div class="info"><div class="t">${esc(t('Full backup'))}</div><div class="d">${esc(t('All appointments, settings and scanned documents in one .zip file.'))}</div></div>
            <div class="control"><a class="btn" href="/api/export/backup">${icon('download', 'sm')}${esc(t('Download backup'))}</a></div></div>
          <div class="setting-row"><div class="info"><div class="t">${esc(t('Export calendar'))}</div><div class="d">${esc(t('An .ics file you can import into Google Calendar, Outlook or your phone.'))}</div></div>
            <div class="control"><a class="btn" href="/api/export/calendar.ics">${icon('calendar', 'sm')}${esc(t('Export .ics'))}</a></div></div>
          <div class="setting-row"><div class="info"><div class="t">${esc(t('Sign out'))}</div><div class="d">${esc(t('You will need your password to come back.'))}</div></div>
            <div class="control"><button class="btn soft-danger" data-logout>${icon('logout', 'sm')}${esc(t('Sign out'))}</button></div></div>
        </div>
      </section>`;

    const gmailTip = box.querySelector('[data-gmail-tip]');
    if (/gmail/i.test(s.smtp.host)) gmailTip.hidden = false;
    highlightNav();
  }

  function highlightNav(id) {
    const current = id || params.s || 'profile';
    root.querySelectorAll('[data-sec]').forEach((a) => a.classList.toggle('active', a.dataset.sec === current));
  }

  // ----- events -----
  on(root, 'click', '[data-sec]', (e, a) => {
    e.preventDefault();
    const target = document.getElementById(`sec-${a.dataset.sec}`);
    target?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    history.replaceState(null, '', `#/settings?s=${a.dataset.sec}`);
    highlightNav(a.dataset.sec);
  });

  box.addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    const btn = form.querySelector('[type=submit]');
    if (form.matches('[data-profile]')) {
      const body = { name: form.name.value, email: form.email.value };
      if (form.newPassword.value) {
        body.currentPassword = form.currentPassword.value;
        body.newPassword = form.newPassword.value;
      }
      setBusy(btn, true);
      try {
        const res = await api.put('/api/auth/profile', body);
        state.user = res.user;
        toast(body.newPassword ? t('Profile and password updated') : t('Profile updated'), { type: 'success' });
        draw();
        document.querySelectorAll('.user-chip .name').forEach((n) => (n.textContent = res.user.name));
        document.querySelectorAll('.user-chip .email').forEach((n) => (n.textContent = res.user.email));
      } catch (err) {
        errorToast(err);
        setBusy(btn, false);
      }
    } else if (form.matches('[data-smtp]')) {
      setBusy(btn, true);
      const ok = await saveSettings({
        smtp: { host: form.host.value, port: form.port.value, secure: form.secure.checked, user: form.user.value, pass: form.pass.value, from: form.from.value },
      }, t('Email settings saved'));
      if (ok) draw();
      else setBusy(btn, false);
    }
  });

  box.addEventListener('change', async (e) => {
    const el = e.target;
    if (el.dataset.setting) {
      let value = el.value;
      if (el.dataset.setting === 'nagIntervalHours') value = Number(value);
      if (el.type === 'time' && !value) return;
      const ok = await saveSettings({ [el.dataset.setting]: value });
      if (!ok) draw();
    } else if (el.dataset.settingBool) {
      await saveSettings({ [el.dataset.settingBool]: el.checked });
      draw();
    }
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
  on(box, 'click', '[data-lang]', async (e, b) => {
    await saveSettings({ language: b.dataset.lang }, b.dataset.lang === 'fr' ? 'Langue enregistrée' : 'Language saved');
  });
  on(box, 'click', '[data-theme-opt]', async (e, b) => {
    if (await saveSettings({ theme: b.dataset.themeOpt })) draw();
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
  on(box, 'click', '[data-logout]', async () => {
    const { logout } = await import('../app.js');
    logout();
  });
  box.addEventListener('toggle', (e) => e.target.matches('[data-log-details]') && e.target.open && loadLog(), true);

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

  // ----- personalisation, holidays, colour -----
  on(box, 'click', '[data-answers]', async () => {
    const { openAnswersSummary } = await import('./welcome.js');
    openAnswersSummary();
  });
  on(box, 'click', '[data-palette-opt]', async (e, b) => {
    const p = PALETTES.find((x) => x.id === b.dataset.paletteOpt);
    await saveSettings({ palette: p.id, accentColor: p.accent }, t('Theme changed'));
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
  box.addEventListener('submit', async (e) => {
    if (!e.target.matches('[data-holiday-form]')) return;
    const f = e.target;
    const btn = f.querySelector('[type=submit]');
    setBusy(btn, true);
    try {
      const res = await api.post('/api/holidays', { name: f.name.value, start: f.start.value, end: f.end.value || f.start.value, cancelClasses: f.cancel.checked });
      toast(res.cancelled ? tn(res.cancelled, 'Holiday added · {n} class cancelled', 'Holiday added · {n} classes cancelled') : t('Holiday added'), { type: 'success' });
      await loadHolidays();
      changed();
    } catch (err) {
      setBusy(btn, false);
      errorToast(err);
    }
  });

  async function loadHolidays() {
    try {
      holidays = await api.get('/api/holidays');
    } catch {
      holidays = [];
    }
    draw();
  }

  const unsub = subscribe((what) => {
    if (what === 'categories' || what === 'settings') draw();
  });
  let holidays = [];
  draw();
  loadHolidays();
  if (params.s) setTimeout(() => document.getElementById(`sec-${params.s}`)?.scrollIntoView({ block: 'start' }), 50);
  return unsub;
}
