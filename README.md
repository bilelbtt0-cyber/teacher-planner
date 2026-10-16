# Planner — schedule, reminders & attestations for a teacher

A private web app that shows a teacher's whole schedule, reminds her of appointments in the app and by email, and makes sure she **never forgets an attestation**. It also keeps a searchable library of all her scanned documents.

The interface is available in French and English (chosen at first launch; can be changed in Settings).

---

## Run it (local)

**Requirement:** [Node.js](https://nodejs.org) version 20 or newer.

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

> On a computer, reminders go out only while the app is running (missed ones are caught up when it starts). Online, the app runs all the time and emails go through Brevo: see below.

---

## Data & backup

- **Locally**, everything lives in `data/planner.db`, scanned documents included.
- **Online**, everything lives in the Turso database (Turso also keeps its own short-term restore points).
- Settings → Data → **Download backup** gives a `.zip` with `data.json` (all appointments, institutions, attestations, settings, readable) and a `documents/` folder holding every scan as a real PDF or image.

---

## Put it online for free

Everything below uses free plans and needs no credit card. Render and Turso let you sign in with GitHub.

| Piece | Service (free plan) | Role |
|---|---|---|
| App | [Render](https://render.com) web service | Runs the site, redeploys automatically on every push to `main` |
| Data | [Turso](https://turso.tech) database | Keeps all data and scans (Render's free disk is wiped on restart) |
| Emails | [Brevo](https://www.brevo.com) | Sends reminder emails through its web API (Render's free plan blocks email ports) |
| Wake-up | [cron-job.org](https://cron-job.org) or [UptimeRobot](https://uptimerobot.com) | Calls `/api/health` every 10 minutes so the app never sleeps and reminders go out on time |

### Steps

1. **Turso**: create a database (region close to Tunisia, e.g. Frankfurt). Copy its URL (`libsql://…`) and create a token.
2. **Brevo** (optional, for emails): Senders → add and verify the address emails will come from. SMTP & API → create an API key.
3. **Render**: New + → **Blueprint** → choose this repository. Fill in:

   | Variable | Value |
   |---|---|
   | `DATABASE_URL` | the Turso URL |
   | `DATABASE_AUTH_TOKEN` | the Turso token |
   | `SETUP_CODE` | a code you choose and give to the teacher (she types it once to create her account) |
   | `APP_URL` | the Render address, e.g. `https://teacher-planner.onrender.com` (set it after the first deploy if needed) |
   | `BREVO_API_KEY`, `EMAIL_FROM` | the Brevo key and the verified sender, e.g. `Agenda <agenda@gmail.com>` |

4. **Pinger**: create a job that opens `https://<your-app>.onrender.com/api/health` every 10 minutes.
5. Send the teacher the link and the invitation code. The welcome guide does the rest.

Limits to know: Render's free plan gives 750 hours a month, enough for one service running all month. After a deploy, the first visit can take about a minute while the service starts.

### Other variables

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP port (set automatically by Render) |
| `DATA_DIR` | `./data` | Local database folder when `DATABASE_URL` is not set |
| `TRUST_PROXY` | – | Set to `1` behind a hosting proxy |
| SMTP | in Settings | Used instead of Brevo when the app runs on a computer |

---

## Project structure

```
server/
  index.js          Express app, static files, error handling
  db.js             Database (local SQLite file or Turso online), migrations, settings
  auth.js           Account setup, login, sessions (scrypt + HttpOnly cookie)
  time.js           Wall-clock time helpers (user time zone)
  recurrence.js     Repetition rules → occurrences
  attestation.js    "Every N hours" rule engine and progress
  scheduler.js      Reminders, attestation nagging, morning summary (every minute)
  mailer.js         Email via SMTP (local) or Brevo API (online) + templates
  routes/           events, categories (institutions), holidays, documents, misc (dashboard, search, settings, export)
public/
  index.html, css/app.css
  js/app.js         Shell, router, notifications panel, banner
  js/eventForm.js   Appointment editor, details panel, attestation actions
  js/scanner.js     Camera / upload, page editor, PDF generation
  js/views/         welcome (guide), today, calendar, attestations, documents, search, settings
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
