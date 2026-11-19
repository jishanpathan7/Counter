# Attendance Alert

Attendance automation for coaching institutes, built to be sold to many of them.

When a student is absent, their parent finds out on WhatsApp **within minutes of class starting**,
instead of at 6 PM when class is over. Parents reply with one tap, the register updates itself, and
parents who don't reply land on the front desk's call list.

## The flow

1. **The teacher takes attendance** on their phone: everyone is present unless they tap **Absent**,
   **Late** or **Leave**, then they press **Send to office**.
2. **Absentees are verified automatically** 10 minutes after class starts (or as soon as a late list
   is sent).
3. **The parent gets a WhatsApp message** with three buttons: **Leave**, **Late 15 min** and
   **Mujhe call karein** ("call me", for a parent who thought the child was in class).
4. **The parent replies**, by tapping a button or typing something like "aaj chutti hai". A reply
   such as "ghar se nikal gaya tha" or "why absent?" is treated as an emergency, never as leave.
5. **The record updates itself**: absent becomes leave or late, with the reason.
6. **No reply in 10 minutes?** It becomes a call task. Staff call and log the outcome: leave, late,
   present, bunk or unreachable.

## What's in the app

| Area | What it does |
| --- | --- |
| **Agency console** | Every institute you run in one place: monthly revenue, students covered, alerts sent, 7-day attendance trend. Add an institute with its owner's login in one form; pause or resume an institute (no logins, no messages). |
| **Dashboard** | Today's six steps as a live funnel, an impact card ("parents hear within 10 min, 1h 40m before class ends"), live class cards with a step-by-step timeline, an activity feed and students who need attention. Updates live. |
| **Take attendance** | Big P / A / L buttons, progress bar and "mark all present". Teachers see only their own batches and never see parents' numbers. |
| **Students** | Search, filter and sort by 30-day attendance. At-risk flags: under 75%, 3+ absences in 14 days, or repeated bunks. Profile with a 90-day calendar, streaks, every WhatsApp alert and reply, and one-tap call / WhatsApp. |
| **CSV import** | Paste from Excel or upload a CSV. A preview flags bad phone numbers and unknown batches before anything is saved. |
| **Call tasks** | Tap to call, add a note, log the outcome; the register updates itself. |
| **WhatsApp** | Every message in and out. Until a WhatsApp account is connected, a phone-style simulator lets you reply as the parent. |
| **Reports** | 7 / 30 / 90 days, this month or a custom range, by batch. Daily chart, batch and student tables, reply rate, average reply time, bunks caught. CSV export. |
| **Settings** | Class timers, batches (time, length, days), holidays (no classes, no alerts), team and roles, the alert message editor with live preview (Hinglish, English, हिंदी), WhatsApp Cloud API connection, owner's daily summary, PIN change. |

Also included: phone + PIN login with lockout after repeated wrong PINs, four roles (agency admin,
owner, front desk, teacher), a first-run setup wizard, dark mode, and installability as a phone app
(PWA).

### Roles

| | Agency admin | Owner | Front desk | Teacher |
| --- | :-: | :-: | :-: | :-: |
| Agency console, add / pause institutes | ✓ | | | |
| Settings, team, WhatsApp, import | ✓ | ✓ | | |
| Dashboard, students, calls, WhatsApp, reports | ✓ | ✓ | ✓ | |
| Take attendance | ✓ | ✓ | ✓ | own batches |

### Safeguards

- Parents are only messaged for a class the teacher has **sent to the office**. A forgotten or
  half-finished list never alerts anyone; instead the dashboard and the owner's daily summary flag
  "not sent by teacher", and the front desk can send it on the teacher's behalf.
- Students the teacher didn't tap count as present, never absent.
- Late and Leave are separate statuses. Late students count as attended in attendance percentages.
- Each student gets at most one alert per class, and a parent can only answer for their own child.
- "Mujhe call karein", or a reply saying the child left home, creates an **urgent** call task at the
  top of the list that never closes by itself.
- Once staff log a call outcome, later messages or old buttons can't overwrite it.
- Owners can only change the name or PIN of people who belong to their institute alone; the agency
  admin can't be added to an institute's team.
- WhatsApp webhooks are rejected unless they are signed with the institute's app secret.
- Every message stores WhatsApp's message id. Delivery updates show as ✓ / ✓✓ / read, an alert that
  can't be delivered (e.g. the number isn't on WhatsApp) becomes a call task at once, and a webhook
  Meta delivers twice is handled once.
- Sends time out after 10 seconds and are retried on rate limits and temporary errors; alerts for a
  class go out in parallel, and institutes are processed side by side, so one slow call doesn't
  delay everyone.
- Failed WhatsApp sends go straight to the call list. Holidays send nothing.
- Each institute has its own database file, so their data never mixes. WhatsApp tokens never
  reach the browser.

## Run it

Needs Node.js 22.13 or newer.

```bash
npm install
npm run dev          # API on :3001, app on http://localhost:5173
```

The first start creates a **demo workspace**: an agency running three institutes, with a month of
attendance history. The login screen has one-tap buttons for each role (PIN `1234`):

| Role | Mobile |
| --- | --- |
| Agency admin | 99999 00000 |
| Institute owner (Bright Future Classes) | 99999 00001 |
| Front desk | 99999 00002 |
| Teacher (Batch B, JEE) | 99999 00003 |

Today's **Class 10 · Batch B** is left open, so you can try the live flow at any time of day:

1. Log in as the owner. In Settings → General, set both timers to `0.2` minutes.
2. On the Dashboard, press **Start class now** on Batch B.
3. On your phone, log in as the teacher, tap a couple of students **Absent** and press **Send to office**.
4. Within seconds parents are alerted. Reply as one parent on the **WhatsApp** tab, leave the other
   one silent, and watch the call task appear.

Production:

```bash
npm run build
SESSION_SECRET=$(openssl rand -hex 32) npm start   # serves API + app on PORT
npm test                                           # 31 server and API tests
```

Outside `npm run dev`, the server refuses to start without a `SESSION_SECRET` of at least 32
characters, and it never loads demo data unless you set `SEED_DEMO=true`. A fresh install opens a
setup wizard where you create your account and first institute; it asks for a **setup code**, which
is printed in the server log at startup (or set your own with `SETUP_TOKEN`). Data lives in `DATA_DIR` (default `data/`): `platform.db` holds users and institutes, and
`institutes/<name>.db` holds each institute's data. Back up that folder.

## Deploying on Vercel (demo)

The repo deploys to Vercel as-is: `vercel.json` builds the app into `dist/` and runs the API from
`api/index.js` as one serverless function. Set `SESSION_SECRET` (at least 32 random characters) and,
for the demo, `SEED_DEMO=true`. Without demo data, set `SETUP_TOKEN` to enable first-run setup.

On Vercel the app runs in **demo mode**: data lives in the function's temporary folder and is reset
whenever Vercel starts a fresh instance, the alert timers run as requests come in, and screens
refresh every few seconds instead of over a live connection. For real institutes, use a host with
an always-on server and a disk (`npm start`), or move the data to a hosted database.

## Connecting real WhatsApp

Each institute connects its own WhatsApp Business number in **Settings → WhatsApp & message**.

1. In Meta's developer dashboard, add the WhatsApp product. Copy the **phone number ID** and a
   **permanent access token** into the form.
2. Create a message template, for example `attendance_alert`, category *Utility*:
   - Body: `Namaste {{1}}, aaj ki {{2}} class ({{3}}) mein {{4}} ki attendance record nahi hui. Please confirm.`
     (`{{1}}` parent, `{{2}}` batch, `{{3}}` time, `{{4}}` student)
   - Three **Quick reply** buttons, in this order: `Leave`, `Late 15 min`, `Mujhe call karein`.

   Once it's approved, enter its name and language. Without an approved template, WhatsApp only
   delivers alerts to parents who messaged you in the last 24 hours.

   Also create the **owner summary** template (category *Utility*, no buttons) with eight values:
   `{{1}}: summary for {{2}}. Present {{3}}, absent {{4}}, on leave or late {{5}}. WhatsApp alerts {{6}}, replied {{7}}. Calls pending {{8}}.`
   (institute, date, present, absent, leave or late, alerts sent, parents replied, calls pending).
   Without it the daily summary is not sent on real WhatsApp; the WhatsApp log shows why.
3. Webhook: paste the **callback URL** shown in the form (`/webhooks/whatsapp/<institute>`) into
   Meta along with your verify token, subscribe to **messages**, and enter the app secret (Meta App
   settings → Basic). It is required: unsigned webhooks are rejected, so replies only arrive once
   it is set.

## Code layout

```
server/
  index.js      starts the server and the scheduler (reads .env)
  platform.js   users, PIN login, institutes, memberships, agency overview
  app.js        HTTP API with role checks, WhatsApp webhooks, live updates (server-sent events)
  service.js    one institute: marking, verify, alerts, replies, escalation, calls,
                holidays, student insights, import, reports, timeline, daily summary
  messaging.js  WhatsApp Cloud API client, webhook parsing, simulator
  db.js         institute database schema (Node's built-in node:sqlite)
  seed.js       demo workspace with realistic history
  time.js       time-zone helpers
web/src/
  App.jsx       routing, institute shell, sidebar / mobile tab bar
  views/        Auth (login, setup wizard), Agency, Dashboard, Teacher, Students,
                Tasks, Messages, Reports, Settings
  ui.jsx        icons, pills, modal, drawer, theme;  charts.jsx  trend chart, heatmap, sparkline
web/public/     PWA manifest, icons, service worker
test/           service flow tests and HTTP/role tests (node --test)
```
