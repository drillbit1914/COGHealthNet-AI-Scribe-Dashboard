# Wellness Ave Scheduling — Phase 1

Pediatric OT/PT scheduling for Anguilla. The spec is [`docs/PRD.md`](docs/PRD.md) (v2), the single source of truth.

**Status: chunk 1 of 2 done: backend.** This chunk covers the schema, scheduling engine, booking, status machine, notifications, jobs and the full HTTP API. PRD §14 acceptance tests 1–14 pass against real Postgres. **Chunk 2 still needs building:** the parent booking web app and the admin/provider console UI, both on top of this API.

## Stack
Node 22 + TypeScript, Fastify 5, PostgreSQL 16 (raw SQL via `pg`), Zod, Vitest. The PRD requires a `btree_gist` exclusion constraint, and ORMs can't express it, so the project uses plain SQL migrations.

## Run
```bash
cp .env.example .env            # fill in DATABASE_URL + SESSION_SECRET
npm install
npm run migrate                 # schema + clinic defaults (Fri 08–17, Sat 08–18, AST)
npm run create-staff -- admin@clinic.ai 'a-long-password' ADMIN   # prints TOTP enrolment URI
npm start                       # API on :3000
npm run worker                  # expiries, escalations, reminders, agendas, retention (every minute)
npm test                        # needs TEST_DATABASE_URL (default postgres://wav:wav@localhost:5432/wav_test)
```
Without WhatsApp/Twilio credentials, messages go to an in-memory `FakeMessenger`, so dev and tests never send anything.

## Layout
| Path | Purpose |
|---|---|
| `db/migrations/001_init.sql` | PRD §11 schema + `no_provider_overlap` exclusion constraint |
| `src/availability.ts` | Pooled slots: grid, hours, per-provider overrides, buffer, notice, horizon, time off |
| `src/booking.ts` | Request submission, tentative least-loaded assignment, savepoint retry on constraint violation |
| `src/appointments.ts` | §6 status machine, confirm/reassign/decline/alternate, cancel/reschedule, payments |
| `src/notify/` | Fan-out, can_book-only buttons, WhatsApp→SMS fallback, Meta + Twilio adapters |
| `src/waitlist.ts` | T8 offers (max 3), atomic first-claim-wins |
| `src/closures.ts`, `src/series.ts` | Clinic closure tool, time off, recurring series |
| `src/jobs.ts` | Expiry, 50% escalation, T6 reminders (once), S3 agendas, message-body retention |
| `src/auth.ts` | OTP (5/hr, 5-try lockout), sessions (30 d parent / 12 h staff), staff scrypt + TOTP |
| `src/privacy.ts` | Export, erase, breach export, merge duplicates |
| `src/api/` | `parent.ts`, `admin.ts`, `webhooks.ts` (signature-verified) |
| `src/i18n/en.ts` | All strings and templates T0–T10, S1–S3 |

## Decisions where the PRD was silent
- **Parent can withdraw a REQUESTED booking.** This adds `REQUESTED → CANCELLED_BY_PARENT`. The clinic can also cancel pending requests (needed for closures).
- **Expired requests send T4** ("expired before it could be confirmed"), so a parent is never left without an answer.
- **Proposing an alternate moves the hold.** The appointment moves to the new slot, and the original time is kept in `original_starts_at` and released to the waitlist.
- **Parent reschedule creates a new REQUESTED appointment** that goes back through approval. An admin reschedule (drag) is CONFIRMED immediately.
- **A recurring series sends T3 for the first visit only.** The 24-hour reminders cover the rest, so parents don't get a flood of messages.
- **Consents** are required for evaluations and for new child records, unless the current version is already on file.
- **Missing and restricted look the same.** Restricted links and other families' children both return 404, so a restriction is never revealed (§8).
- **Local file storage** sits behind a `Storage` interface with 15-minute HMAC-signed URLs. Swap in S3/GCS for production.
