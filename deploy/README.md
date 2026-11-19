# Running Attendance Alert in production

This folder runs the app on your own server in India:

- **app**: the Node server, plus [Litestream](https://litestream.io), which copies every database
  change to S3-compatible storage within about a second.
- **caddy**: the web server in front. It gets and renews the HTTPS certificate by itself.

Vercel stays useful for the demo link. Its storage is temporary, so it can't hold real data.

## What you need

| | Notes |
| --- | --- |
| A Linux VM in India | Mumbai, Hyderabad, Delhi or Bengaluru, for example AWS `ap-south-1`/`ap-south-2`, Google Cloud `asia-south1`/`asia-south2`, DigitalOcean `BLR1` or Azure Central India. One small VM (1–2 vCPU, 2 GB RAM) is a sensible start, because the app is one Node process with SQLite. Open only ports 22, 80 and 443. |
| A domain | For example `app.yourbrand.in`, with a DNS **A record** pointing at the VM's IP. |
| A storage bucket for backups | An S3 bucket in `ap-south-1` keeps data in India. Cloudflare R2 or DigitalOcean Spaces also work (set `BACKUP_S3_ENDPOINT`). Create a key that can only use this bucket (policy below). |
| Optional: [Sentry](https://sentry.io) | Error alerts. The free tier is enough to start with. |
| Optional: an uptime monitor | For example Better Stack, UptimeRobot or healthchecks.io. |

## First deployment

```sh
# on the VM, with Docker installed (https://docs.docker.com/engine/install/)
git clone <your repo> attendance-alert && cd attendance-alert/deploy
cp .env.example .env
nano .env        # DOMAIN, SESSION_SECRET (openssl rand -hex 32), SETUP_TOKEN, BACKUP_S3_*
APP_RELEASE=$(git rev-parse --short HEAD) docker compose up -d --build
docker compose logs -f app
```

Then open `https://<DOMAIN>`. The setup screen asks for the `SETUP_TOKEN` from `.env`, so nobody
else can claim the server first.

The startup log tells you whether backups are on:

```
Backups on: every change is copied to storage within seconds.
```

If it says `WARNING: backups are OFF`, fix `.env` before you put in real data.

In Meta's WhatsApp settings, set each institute's webhook to
`https://<DOMAIN>/webhooks/whatsapp/<institute-slug>`, with the verify token and app secret from
the institute's WhatsApp settings.

## Updating

```sh
cd attendance-alert && git pull && cd deploy
APP_RELEASE=$(git rev-parse --short HEAD) docker compose up -d --build
```

The app stops cleanly: it finishes the current scheduler round, closes the databases, and Litestream
copies the last changes before it exits. Expect a few seconds of downtime. Check
`https://<DOMAIN>/api/health`: its `release` should show the new version.

## Staging: try updates before customers see them

Run a second, small VM with the same setup and its own settings file:

```sh
cd attendance-alert/deploy
cp .env.example staging.env   # DOMAIN=staging.yourbrand.in, a different SESSION_SECRET,
                              # BACKUP_S3_PATH=staging, SEED_DEMO=true for demo data
ENV_FILE=staging.env docker compose --env-file staging.env up -d --build
```

Deploy a change to staging first, click through it, then update production. Never point staging at
production's `BACKUP_S3_PATH`: the two would overwrite each other's backups.

## Database upgrades

Schema changes are numbered migrations (`server/db.js` for each institute, `server/platform.js` for
the platform). On start, each database is upgraded in order. Before the first change to an existing
file, a copy is saved next to it as `<file>.before-v<N>`. If an upgrade ever goes wrong, stop the
app, put that copy back and start the previous version. The error message names the migration that
failed. Delete old `.before-v*` copies once you're happy.

## CI

`.github/workflows/ci.yml` runs on every push:
- the full test suite, including the disaster-recovery test with Litestream;
- the web build;
- a production Docker build, which it starts and health-checks.

Merge only when it's green.

## Monitoring

| Watch | How | Alerts you when |
| --- | --- | --- |
| The app | Point an uptime monitor at `https://<DOMAIN>/api/health` every 1–5 minutes | The site is down, the database isn't answering, or the scheduler has stalled. A stalled scheduler means alerts stop going out, which looks fine from outside, so the health check returns 503 then. |
| Backups | Set `BACKUP_HEARTBEAT_URL` to a healthchecks.io-style URL that expects a ping every 5 minutes | Backups stop working |
| Errors | Set `SENTRY_DSN` | Something fails: a 500 error, a scheduler failure or a webhook failure. Phone numbers are masked, and request bodies, cookies and headers are never sent. |
| Logs | `docker compose logs -f app` | Logs are rotated at 20 MB × 10 files |
| Request log (180 days) | Agency console API `/api/agency/request-log`, or `sqlite3 /data/logs.db` | Every API and webhook request: time, path (no query strings), status, user, address. Kept 180 days for CERT-In, and backed up with the rest |

Docker also checks `/api/health` itself, and Caddy only starts sending traffic once the app is healthy.

## Backups and restoring

> **Keep a copy of `deploy/.env` somewhere safe**, such as a password manager. The backups hold the
> data, but the WhatsApp credentials inside them are encrypted with `DATA_ENCRYPTION_KEY` (or a key
> derived from `SESSION_SECRET`). Restore with a different key and everything works except WhatsApp
> sending, until the owner enters the token again.

**On a new server, restoring happens by itself.** On start, the app restores any database that's
missing on disk from the bucket, then carries on backing up. To move servers, or after losing one:
run the same `.env` on a new VM and `docker compose up -d`. Point DNS at the new IP.

> Never run two servers against the same bucket and path at once. They would overwrite each
> other's backups. Stop the old one first, or change `BACKUP_S3_PATH` for a test copy.

**Restore drill: do it monthly** (it takes seconds and doesn't touch live data):

```sh
docker compose exec app node server/backup.js drill
```

It restores every database from the bucket into a temporary folder, checks each one is intact, and
compares row counts with the live data:

```
platform.db                      intact  users 6, institutes 3, memberships 5
institutes/bright-future.db      intact  students 22, batches 3, sessions 95, alerts 75, ...
Restore drill passed: 4 databases restored and intact.
```

**Going back in time** (for example, someone deleted a batch by mistake): Litestream keeps 30 days
(`BACKUP_RETENTION`) of history. Restore a copy of that institute's database as it was at a given
moment. This writes a separate file and never touches the live data:

```sh
docker compose exec app node server/backup.js copy institutes/<slug>.db /tmp/before.db 2026-11-19T10:00:00+05:30
docker compose cp app:/tmp/before.db ./before.db    # to inspect it
```

Swapping it in for the live database is a deliberate step: stop the app, keep the current file as a
spare, put the copy in its place, and start again. Ask your developer if in doubt.

## Erased data and backups

When a student is erased or an institute deleted, the live database changes at once. Copies already
in the backup bucket are kept for the retention period (`BACKUP_RETENTION`, 30 days by default) and
then removed. So you can tell a parent their data is erased now and gone from the backups within
30 days.

A deleted institute's database is no longer watched, so its folder (`<BACKUP_S3_PATH>/institutes/<slug>.db/`)
stays in the bucket until you delete it there. Delete it once you're sure, for example with the
storage provider's console.

## Storage key policy (AWS)

Give the backup key access to this one bucket only:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    { "Effect": "Allow", "Action": ["s3:ListBucket", "s3:GetBucketLocation"], "Resource": "arn:aws:s3:::YOUR-BUCKET" },
    { "Effect": "Allow", "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"], "Resource": "arn:aws:s3:::YOUR-BUCKET/*" }
  ]
}
```

## Server hygiene

- Log in with SSH keys only, and turn on automatic security updates (`unattended-upgrades` on Ubuntu/Debian).
- Keep the firewall to ports 22, 80 and 443. The app's port 3001 is only reachable through Caddy.
- `deploy/.env` holds your secrets: `chmod 600 .env`, and never commit it.

## How this was tested

The whole stack was run end to end with a local S3 server:
- HTTPS through Caddy, with Secure cookies.
- Login limits use the visitor's real address: a faked `X-Forwarded-For` doesn't get around them,
  and a locked device doesn't lock out other devices.
- A student added over HTTPS, then the containers, data volume and certificates all deleted. A fresh
  `docker compose up` restored all 4 databases, including that student, and the drill passed.
- `docker compose stop` exits cleanly, with Litestream shutting down last.

The disaster-recovery test also runs in `npm test` wherever `litestream` is installed.
