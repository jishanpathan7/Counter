# If personal data may have leaked: breach response runbook

For the agency running Attendance Alert and the institutes using it. Print it, and fill in the
contacts at the bottom **before** you need them.

> This is an operational checklist, not legal advice. The time limits below are as we understand
> CERT-In's 2022 directions and the DPDP Rules 2025. Confirm them with your lawyer and keep this
> page up to date.

## What counts as an incident

Treat any of these as an incident until you know otherwise:

- Someone signed in who shouldn't have: an unknown name or address in the **Sign-in log** (agency
  console), a run of "Wrong PIN" entries, or a team member reporting a PIN they didn't change.
- Student or parent data seen by someone outside the institute: an export file shared by mistake,
  a lost phone that was signed in, or a screenshot posted publicly.
- The server, the backup bucket or a WhatsApp access token exposed: keys in a chat or a public
  repository, or a server compromised.
- WhatsApp messages sent that nobody at the institute sent.

## The clock

| Who | Deadline | What |
| --- | --- | --- |
| CERT-In | **6 hours** from noticing a reportable cyber incident (including data breaches and unauthorised access) | Report at incident@cert-in.org.in, using CERT-In's incident form |
| Data Protection Board | **Without delay**, then a detailed report within **72 hours** | Under the DPDP Rules, the institute as data fiduciary informs the Board; the agency supports it |
| Affected parents | **Without delay** | Plain-language notice: what happened, what data, what they should do, whom to contact |
| The institute (if the agency finds it) | **Immediately** | By phone, then in writing |

The 6-hour clock starts when you notice, not when you're sure. Report what you know and update later.

## First hour: contain

1. **Write things down.** Open a document, note the time you noticed and every step from now on.
2. **Lock out the intruder.**
   - Someone's PIN is compromised: in Settings → Team, reset their PIN. That signs them out on
     every device.
   - Wider doubt: change `SESSION_SECRET` in `deploy/.env` and restart. **Everyone** is signed out.
     Note that this also changes the key for stored WhatsApp tokens unless `DATA_ENCRYPTION_KEY`
     is set, so owners will need to enter the token again.
   - WhatsApp token exposed: create a new token in Meta Business, revoke the old one, and paste the
     new one in Settings → WhatsApp → Technical setup.
   - Backup storage key exposed: rotate it with your storage provider and update `deploy/.env`.
3. **Keep the evidence.** Don't delete logs or databases. Save copies of:
   - the agency's **Sign-in log**;
   - each institute's **Who looked at student details** list and **Privacy log**
     (Settings → Privacy & data);
   - `docker compose logs app > incident-app.log`.
4. **If the server itself is compromised:** stop it (`docker compose down`), keep the disk, and
   start a fresh server from the backup (see `deploy/README.md`) with **all new secrets**.

## Within 6 hours: report

- **CERT-In:** send the incident form to incident@cert-in.org.in. Include the time noticed, the
  systems affected, what you've done so far, and a contact person.
- **The institute(s):** tell the owner what happened and agree who informs parents.

## Within 72 hours: understand and inform

- **Work out the scope.** Which institutes, which students and parents, what data (names, phone
  numbers, attendance, messages), and when. The access log and sign-in log show who opened what.
- **The institute informs the Data Protection Board** with the detailed report, and the affected
  parents in plain language. Here is a template (adapt it; send it in English and Hindi):

  > Dear parent, on [date] we found that [what happened]. It may have exposed [your name / phone
  > number / your child's attendance]. It did not include [e.g. payments or ID documents]. We have
  > [what was done]. You don't need to do anything / please [action]. Questions: [name, number].
  > — [Institute]

## Afterwards

- Write a short note: what happened, why, what changed. Keep it with the evidence.
- Fix the cause, run a restore drill (`node server/backup.js drill`), and check the steps above
  still match the product.

## Contacts (fill in now)

| Role | Name | Phone |
| --- | --- | --- |
| Agency incident lead | | |
| Hosting / server access | | |
| Lawyer | | |
| Each institute owner | | |

CERT-In: incident@cert-in.org.in (check cert-in.org.in for the current reporting form and phone numbers).
