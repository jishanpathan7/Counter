# Attendance Alert

Attendance automation for coaching institutes. When a student is absent, their parent finds out on
WhatsApp within minutes of class starting, instead of at 6 PM when class is over.

## How it works

1. **Teacher marks attendance** on their phone (P / A / L).
2. **Auto-verify**: 10 minutes after class starts, absentees are confirmed. Anyone left unmarked
   counts as absent.
3. **Parent gets a WhatsApp alert**: *"Aaj ki class mein Rohan ki attendance record nahi hui. Please
   confirm."* with two buttons: **Leave** and **Late 15 min**.
4. **Parent replies** by tapping a button, or by typing something like "aaj chutti hai".
5. **Register updates itself**: the student goes from A to L, with the reason.
6. **No reply in 3 minutes?** The parent goes on the **Call tasks** list. Staff call them and log
   the outcome: leave, late, present, bunk, or unreachable.

The dashboard shows every batch live and how quickly parents were informed.

Built-in safeguards:
- Parents are never messaged for a class where the teacher took no attendance. The dashboard
  flags it as "Attendance not taken". This prevents messaging a whole batch if the system is
  installed, or a batch is added, after class time.
- If the teacher is still marking at verify time, verification waits until everyone is marked or
  they have stopped for 90 seconds.
- Each student gets at most one alert per class. A parent can only answer their own child's alert.
- If a WhatsApp message fails to send, it goes straight to the call list.

## Run it

Needs Node.js 22.13 or newer.

```bash
npm install
npm run dev        # API on :3001, app on http://localhost:5173
```

It starts with demo batches (Batch B: Aarav, Diya, Rohan, Meera) and the **WhatsApp simulator**.
Alerts appear on the **WhatsApp** tab, where you can tap reply buttons as the parent.

**Quick demo:** in **Setup**, set both timers to `0.5` minutes. On the **Dashboard**, press
**Start class now** on a batch. Mark students on the **Teacher** tab, then watch alerts go out,
reply on the **WhatsApp** tab, and wait for the call task.

Production:

```bash
npm run build      # builds the app into dist/
npm start          # serves the API and the app on PORT (default 3001)
npm test           # runs the server tests
```

Configuration is in `.env` (copy `.env.example`). Set `ACCESS_CODE` before putting the app online:
it holds children's names and parents' phone numbers.

## Connecting real WhatsApp

Uses the [Meta WhatsApp Cloud API](https://developers.facebook.com/docs/whatsapp/cloud-api).

1. Create a Meta app with the WhatsApp product and get a **phone number ID** and a **permanent
   access token**. Put them in `WHATSAPP_PHONE_NUMBER_ID` and `WHATSAPP_TOKEN`.
2. Create a message template, for example named `attendance_alert`, category *Utility*:
   - Body: `Namaste {{1}}, aaj ki {{2}} class ({{3}}) mein {{4}} ki attendance record nahi hui. Please confirm.`
     (`{{1}}` parent name, `{{2}}` batch, `{{3}}` class time, `{{4}}` student name)
   - Buttons: two **Quick reply** buttons, `Leave` and `Late 15 min`, in that order.

   Once it is approved, set `WHATSAPP_TEMPLATE=attendance_alert` (and `WHATSAPP_TEMPLATE_LANG` to
   the template's language code). Without a template, WhatsApp only delivers alerts to parents who
   messaged you in the last 24 hours.
3. Webhook: point Meta at `https://<your-server>/webhooks/whatsapp`, enter the same value you put in
   `WHATSAPP_VERIFY_TOKEN`, and subscribe to **messages**. Set `WHATSAPP_APP_SECRET` so incoming
   webhooks are signature-checked.

Once `WHATSAPP_TOKEN` and `WHATSAPP_PHONE_NUMBER_ID` are set, the simulator turns off and the
WhatsApp tab becomes a log of real messages.

## Code layout

```
server/
  index.js      starts the server and the scheduler (reads .env)
  app.js        HTTP API, WhatsApp webhook, access code, live updates (server-sent events)
  service.js    the attendance flow: marking, verify, alerts, replies, escalation, call tasks
  messaging.js  WhatsApp Cloud API client, webhook parsing, simulator
  db.js         SQLite schema (Node's built-in node:sqlite)
  time.js       institute time-zone helpers
  seed.js       demo data
web/src/        React app: Dashboard, Teacher, Call tasks, WhatsApp, Setup
test/           end-to-end flow tests (node --test)
```

Data lives in one SQLite file (`data/attendance.db` by default). Back it up like any other file.
