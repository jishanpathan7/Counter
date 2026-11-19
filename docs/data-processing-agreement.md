# Data processing agreement (template)

Between **[Institute legal name]** ("the Institute", the data fiduciary) and **[Agency legal
name]** ("the Provider", the data processor), for the Attendance Alert service.

> Template only. Have a lawyer adapt it to your contract and confirm it against the Digital
> Personal Data Protection Act, 2023 and the DPDP Rules, 2025 before anyone signs it.

## 1. What this covers

The Provider runs Attendance Alert for the Institute: recording attendance, telling parents about
absences on WhatsApp, recording their replies and staff calls, and reports. The Institute decides
why and how student and parent data is used. The Provider processes it only to deliver the service
and only on the Institute's instructions, which include the settings the Institute chooses in the
app.

## 2. The data

| Who | What |
| --- | --- |
| Students | Name, batch, attendance (present, absent, late, on leave), notes from calls |
| Parents and guardians | Name, WhatsApp number, WhatsApp messages to and from the Institute, consent records |
| Institute staff | Name, mobile number, role, sign-in times, actions in the app |

No payment cards, ID documents, addresses of students, or exam results.

## 3. The Provider's duties

The Provider will:

1. Use the data only to provide the service, never for its own purposes and never sold.
2. Keep it confidential, and limit access to staff who need it for support. Those staff are bound
   by confidentiality.
3. Keep it secure, including at least:
   - PIN sign-in, with limits on wrong PINs and sessions that can be ended;
   - encrypted connections (HTTPS);
   - stored WhatsApp credentials encrypted;
   - continuous backups with a monthly restore test;
   - an access log and a sign-in log, kept at least 180 days.
4. Store the data in India: server [region] and backups [region].
5. Send WhatsApp messages only to parents who agreed, and never to a parent who sent STOP.
6. Help the Institute answer parents' requests. The app lets the Institute download one family's
   data, correct it, and erase a student.
7. Delete data on the schedule the Institute sets (Settings → Privacy & data), and all of it at
   the end of the contract (section 7).
8. Tell the Institute about any personal data breach **without delay**, and in any case within
   **[24] hours** of becoming aware. Help it inform the Data Protection Board and parents, and
   report to CERT-In within 6 hours where required (see `docs/breach-response.md`).

## 4. Sub-processors

The Provider uses these sub-processors. It will tell the Institute in advance before adding or
replacing one, and the Institute may object.

| Sub-processor | For | Data |
| --- | --- | --- |
| Meta Platforms (WhatsApp Business Platform) | Sending and receiving WhatsApp messages | Parent numbers, message text |
| [Hosting provider, region] | Running the server | All service data |
| [Backup storage provider, region] | Encrypted-in-transit backups | All service data |
| [Error reporting, e.g. Sentry] (if used) | Error reports | Technical details only. Phone numbers are masked; no message text, request contents or cookies |

## 5. The Institute's duties

The Institute will:

- collect parents' consent for WhatsApp alerts (on the admission form or by the parent sending
  START), and record it in the app;
- keep student and parent details accurate;
- keep its staff's PINs private and remove staff who leave.

## 6. Audits

The Provider will answer the Institute's reasonable questions about how the data is protected,
and provide the access log and sign-in log on request.

## 7. End of the contract

Within **[30] days** of the end of the contract, the Provider will:

1. Give the Institute a full export (Settings → Privacy & data → Download all data) if it asks.
2. Delete the Institute's database and the team accounts used only for this Institute.
3. Delete backup copies within the backup retention period (**[30] days**).
4. Keep invoices and payment records as tax law requires. They contain no student or parent data.

The Provider will confirm the deletion in writing.

## Signatures

| | Institute | Provider |
| --- | --- | --- |
| Name | | |
| Title | | |
| Date | | |
| Signature | | |
