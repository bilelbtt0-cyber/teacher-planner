# Planner — schedule, reminders & attestations for a teacher

A private web app that shows a teacher's whole schedule, reminds her of appointments in the app and by email, and makes sure she **never forgets an attestation**. It also keeps a searchable library of all her scanned documents.

The interface is available in French and English (chosen at first launch; can be changed in Settings).

---

## Run it (local)

**Requirement:** [Node.js](https://nodejs.org) version 22.13 or newer (Node 24 recommended).

- **Windows:** double-click **`Start Planner.bat`**. It installs dependencies the first time, starts the app and opens the browser.
- **Any OS:**
  ```bash
  npm install
  npm start            # → http://localhost:3000
  ```

The first visit asks you to create the account (name, email, password, language). Only one account exists; everything else needs the password.

**Using it from a phone on the same Wi-Fi:** open `http://<computer-ip>:3000`. Scanning works with the phone's camera app. The live camera preview inside the page needs HTTPS, so it will be available once the app is hosted.

---

## Main features

| Area | What it does |
|---|---|
| **Today** | Greeting, today's timeline with a "now" marker, upcoming 7 days, hours done/planned this week and month, missing attestations with one-click actions, progress toward the next hours-based attestation. |
| **Calendar** | Month / week / day / list views. Click or drag to create, drag to move, resize to change duration. Colour per institution, filters, show/hide cancelled sessions. Keyboard: ←/→, `T` today, `M` `W` `D` `L` views, `N` new appointment, `/` search. |
| **Appointments** | Type (class, exam, meeting, personal, other), institution, room, notes, all-day, quick duration chips, repetition (daily / weekly on chosen days / monthly, until a date or N sessions, defaults to the end of the school year), several reminders each optionally by email. |
| **Attestations** | Any appointment can require an attestation (with a note: who to ask, what to bring). Institutions can have a rule such as *"one attestation every 30 teaching hours"*: the app counts the hours and flags the right session automatically. Once a flagged session ends, she gets an in-app notification **and an email, repeated until she marks it received or not needed**. The red banner stays visible on every page meanwhile. |
| **Mark as received** | Scan it now, upload a file, link an existing document, or just mark it. One attestation can cover several sessions (select several and mark them together). Snooze ("remind me tomorrow") and Undo are available everywhere. |
| **Documents / scanner** | Camera capture (one photo per page) or PDF / photo upload / drag-and-drop. Multi-page, rotate, crop, *Clean* or *B&W* filter. Saved as a named PDF with a thumbnail, type, date, institution, period, hours, tags and linked sessions. Searchable and filterable by year, type and institution. |
| **Search & history** | Nothing is ever lost: search all appointments and documents by word, period (this month, last school year…), institution, type, attestation status. Shows total teaching hours, and exports CSV (opens in Excel) or prints. |
| **Settings** | Profile & password, institutions (colour, hours rule, archive), default reminders, nag frequency, quiet hours, morning summary email, browser notifications, email account, language, theme (light/dark/auto), week start, working hours, time zone, backup, `.ics` export. |

---

## Email setup (to receive reminders by email)

Settings → **Email** → choose *Gmail*, *Outlook* or *Yahoo*, then enter the account that will **send** the reminders. Then click **Send a test email**.

- **Gmail:** turn on 2-step verification, then create an **App password** (Google Account → Security → App passwords) and paste it as the password. The normal password does not work.
- "Recent email activity" (in the same section) shows each email sent, failed or skipped, with the error message if any.

Emails sent by the app:
- the reminders she chose (e.g. 1 day before);
- **missing attestations**, at the end of the session and then every *N* hours (default: daily), outside quiet hours. A single email lists everything still missing;
- an optional **morning summary** (today's schedule + missing attestations).

> Reminders are sent by the running app. While the app runs on a laptop, emails only go out when the laptop is on and the app is open. Missed reminders are caught up when it starts again. Hosting removes this limitation.

---

## Data & backup

- Everything lives in the **`data/`** folder: `planner.db` (SQLite database) and `uploads/` (scans).
- Settings → Data → **Download backup** produces a `.zip` with both.
- **Restore:** stop the app, put `planner.db` and the `uploads` folder from the zip into `data/`, start again.

---

## Hosting later

The app is a single Node.js process with no external database, so any small VPS or Node host works.

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `HOST` | `0.0.0.0` | Listen address |
| `APP_URL` | `http://localhost:PORT` | Public URL used in email links (e.g. `https://planner.example.com`) |
| `DATA_DIR` | `./data` | Where the database and scans are stored (put it on a persistent disk) |

Checklist:
1. Copy the project (with `data/` to keep existing data), then run `npm install --omit=dev`.
2. Run it with a process manager so it restarts automatically, e.g. `pm2 start "npm start" --name planner`.
3. Put it behind HTTPS (Caddy / Nginx / the host's proxy). HTTPS is required for the live camera scanner on phones, and cookies are automatically marked `Secure`.
4. Set `APP_URL` to the public address.
5. Back up `DATA_DIR` regularly.

---

## Project structure

```
server/
  index.js          Express app, static files, error handling
  db.js             SQLite schema (migrations) and settings
  auth.js           Account setup, login, sessions (scrypt + HttpOnly cookie)
  time.js           Wall-clock time helpers (user time zone)
  recurrence.js     Repetition rules → occurrences
  attestation.js    "Every N hours" rule engine and progress
  scheduler.js      Reminders, attestation nagging, morning summary (every minute)
  mailer.js         SMTP sending + email templates
  routes/           events, categories (institutions), documents, misc (dashboard, search, settings, export)
public/
  index.html, css/app.css
  js/app.js         Shell, router, notifications panel, banner
  js/eventForm.js   Appointment editor, details panel, attestation actions
  js/scanner.js     Camera / upload, page editor, PDF generation
  js/views/         today, calendar, attestations, documents, search, settings
  js/i18n.js, fr.js Translations and date formatting
```

## Scenarios handled (highlights)

- Editing a repeating series: *only this*, *this and following*, or *all*; moving by drag asks the same. Changing the repetition rebuilds the following sessions but **keeps past sessions and any with a received attestation or documents**.
- Cancelling a session keeps it in the history (struck through, excluded from hours); deleting is separate and warns about linked documents.
- Hours rule recalculates when sessions are added, moved, cancelled or change institution. An attestation she has already handled is never changed automatically.
- Several overdue attestations → one email, not one per session. Repeated scheduler runs never duplicate emails or notifications.
- Laptop off at reminder time → only the most relevant missed reminder is delivered when the app starts again.
- Unsaved changes are protected, and every destructive action asks for confirmation (many can be undone from the toast).
- Session expiry, offline server, wrong file types, files over 25 MB, camera refused or unavailable: each shows a clear message.
- Login is rate-limited; changing the password signs out other devices.
