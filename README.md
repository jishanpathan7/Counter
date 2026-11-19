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
| **Today** (front desk) | The front desk's landing screen: one line saying what needs doing, then parents to call (urgent first), classes the teacher hasn't sent, parents still to reply with a countdown, and classes later today. "Nothing needs you right now" when it's all done. |
| **Home** (owner) | One sentence on how today is going (with a link to the to-do list), an impact card ("parents hear within 10 min, 1h 40m before class ends"), class cards with a timeline, an activity feed and students who need attention. Updates live. |
| **Take attendance** | Big P / A / L buttons, progress bar and "mark all present". Teachers see only their own batches and never see parents' numbers. |
| **Students** | Search, filter and sort by 30-day attendance. WhatsApp consent per parent ("Agreed", "Not asked", "Said STOP"), a "No WhatsApp consent" filter, one button to record signed admission forms, and a copyable `wa.me/…?text=START` opt-in link. At-risk flags: under 75%, 3+ absences in 14 days, or repeated bunks. Profile with a 90-day calendar, streaks, every WhatsApp alert and reply, and one-tap call / WhatsApp. |
| **CSV import** | Paste from Excel or upload a CSV. A preview flags bad phone numbers and unknown batches before anything is saved. |
| **Calls** | Tap to call, add a note, log the outcome; the register updates itself. |
| **WhatsApp** | Every message in and out. Until a WhatsApp account is connected, a phone-style simulator lets you reply as the parent. |
| **Reports** | 7 / 30 / 90 days, this month or a custom range, by batch. Daily chart, batch and student tables, reply rate, average reply time, bunks caught. CSV export. |
| **Settings** | Class timers, batches (time, length, days), holidays (no classes, no alerts), team and roles, the alert message editor with live preview (Hinglish, English, हिंदी), WhatsApp Cloud API connection, owner's daily summary, PIN change. |

Readable by design: text meets WCAG AA contrast (4.5:1) in light and dark mode, checked on every
screen; six text sizes with a 16px base; plain words instead of system terms ("practice mode", not
"simulator"); Meta's technical WhatsApp fields are folded away from owners; on phones the tab bar
holds four places plus "More".

Also included: phone + PIN login (6–8 digit PINs that aren't a sequence, a repeat or part of the
mobile number; older or easy PINs must be replaced at the next login), four roles (agency admin,
owner, front desk, teacher), a first-run setup wizard, dark mode, and installability as a phone app
(PWA).

### Roles

| | Agency admin | Owner | Front desk | Teacher |
| --- | :-: | :-: | :-: | :-: |
| Agency console, add / pause institutes | ✓ | | | |
| Settings, team, WhatsApp, import | ✓ | ✓ | | |
| Dashboard, students, calls, WhatsApp, reports | ✓ | ✓ | ✓ | |
| Take attendance | ✓ | ✓ | ✓ | own batches |

### Parent consent

WhatsApp only allows business messages to people who agreed to get them, and India's DPDP Act asks
for the same. So by default (Settings → General → *Parent consent*):

- An absence alert goes on WhatsApp only if the parent has agreed. Otherwise the absence becomes a
  call task ("Call instead: no WhatsApp consent"), so the parent still hears about it.
- Parents agree by **sending START** to the institute's WhatsApp number (the opt-in link or a QR code
  on the admission form), or the office **records the signed admission form** (one student, or
  everyone without a record). A plain "haan" / "yes" also counts from a parent with no record yet.
- **STOP** (also "band karo", "बंद") turns alerts off for good: they're never messaged again, even if
  the consent rule is switched off, and staff can't override it. Only the parent can undo it with
  START. Both are acknowledged on WhatsApp in Hinglish.
- Every change is kept in a consent log (who, how, when and the wording agreed to), shown on the
  student's profile. Numbers that aren't in the student list can't opt themselves in.

### Plans and billing

| Plan | Price (before GST) | Students | Logins | Reports |
| --- | --- | --- | --- | --- |
| Trial | free, 30 days | 100 | 5 | full |
| Starter | ₹999 / month | 100 | 3 | last month |
| Standard | ₹1,999 / month | 300 | 10 | full + CSV |
| Pro | ₹3,999 / month | 1,000 | 25 | full + CSV |
| Custom | agreed fee | no limit | no limit | full + CSV |

A year costs ten months. Limits only stop adding students or logins. Taking attendance, alerts,
replies and calls are never limited.

- **Late payment:**
  - for the first 7 days after the paid-until date, a banner with a "Pay now" link;
  - from day 8 to 14, setup changes are paused but attendance and alerts carry on;
  - after 14 days the institute is paused. The agency can always get in.
- **Payments.** The agency records each payment (the institute's own payment link, or a UPI link
  built from the agency's UPI ID), which moves the paid-until date on by one period and issues a
  GST invoice: one numbering sequence per financial year, CGST + SGST in the same state, IGST
  across states, and no GST if the agency isn't registered. Invoices open as a printable page
  (save as PDF) and are kept even if the institute is deleted.
- **Usage.** Owners see students, logins and WhatsApp alerts this month against the plan
  (about 4 alerts per student per month are included). Institutes from before plans existed are
  on "Custom" with no due date, so nothing changes for them until the agency sets a plan.

### Login security

- PINs are 6–8 digits and can't be `123456`, one digit repeated, a simple pattern or part of the
  mobile number. Anyone still on an old 4-digit or guessable PIN can log in once but must choose a new
  PIN before they can see anything.
- Wrong PINs are counted in the database, so limits survive restarts and serverless cold starts:
  5 tries per phone from one device, 20 per phone from anywhere, 30 from one network, each per
  15 minutes. One person guessing can't lock the real user out of their own device.
- Every login is a server-side session. Logging out ends it for good (a copied cookie stops working),
  and changing or resetting a PIN signs that person out on every other device.
- Behind a proxy or load balancer set `TRUST_PROXY` so limits use the visitor's real address.

### Privacy and data

Students' and parents' details belong to the institute, and the app is built so the institute can
answer to parents and to India's DPDP Act:

- **Export.** The front desk or owner can download everything held about one family when a parent
  asks: every child on that number, attendance, alerts, call notes, WhatsApp messages and consent
  history. The owner can download the whole institute as one JSON file (Settings → Privacy & data),
  to keep or to move to another system. Credentials and PINs are never included.
- **Erasure.**
  - "Remove" only hides a student. **Erase** deletes their attendance, alerts and call notes for
    good. If no other child uses the parent's number, it also deletes that parent's messages and
    consent records. A parent who sent STOP stays on the do-not-message list (number only).
  - Removed students are listed under Settings → Privacy & data, to erase one by one or all at
    once (for example at the end of the year).
  - Erased rows are overwritten in the database file, not just unlinked.
- **Closing an account.** The agency admin can delete a paused institute. That deletes its database
  and the logins of team members who use no other institute.
- **Privacy log.** Every download and erasure is logged with who and when. Erased students appear by
  number, never by name.
- **Encrypted credentials.** Each institute's WhatsApp access token and app secret are stored
  encrypted (AES-256-GCM). The key comes from `DATA_ENCRYPTION_KEY`, or is derived from
  `SESSION_SECRET`, and is never stored in the database or the backups. Older plain-text values
  are encrypted automatically. If the key changes, the app doesn't send with a broken token: it
  asks the owner to enter it again.

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
attendance history. The login screen has one-tap buttons for each role (PIN `482915`):

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

## Running it for real institutes

`deploy/` has everything to run it on your own server in India: a Docker image, Caddy for automatic
HTTPS, and Litestream copying every database change to S3-compatible storage within seconds. A new
server restores itself from that backup on first start. Also included:
- a health check that also catches a stalled scheduler;
- error reports to Sentry with phone numbers masked;
- a monthly restore drill (`node server/backup.js drill`);
- point-in-time copies covering 30 days.

Follow **[deploy/README.md](deploy/README.md)**:

```sh
cd deploy && cp .env.example .env     # domain, secrets, backup bucket
docker compose up -d --build
```

## Deploying on Vercel (demo)

The repo deploys to Vercel as-is: `vercel.json` builds the app into `dist/` and runs the API from
`api/index.js` as one serverless function. Set `SESSION_SECRET` (at least 32 random characters) and,
for the demo, `SEED_DEMO=true`. Without demo data, set `SETUP_TOKEN` to enable first-run setup.

On Vercel the app runs in **demo mode**: data lives in the function's temporary folder and is reset
whenever Vercel starts a fresh instance, the alert timers run as requests come in, and screens
refresh every few seconds instead of over a live connection. For real institutes, use the Docker
setup above.

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
  index.js      starts the server and the scheduler (reads .env), stops cleanly on SIGTERM
  runtime.js    builds the platform and app from environment settings
  backup.js     Litestream config, restore on start, restore drill, point-in-time copies
  errors.js     error reports to Sentry (numbers masked, no request data)
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
deploy/         docker-compose (app + Caddy), Caddyfile, entrypoint, production runbook
Dockerfile      production image (non-root, with Litestream)
test/           flow, HTTP/role, operations and backup tests (node --test)
```
