# Project: Wellness Ave Scheduling
Pediatric OT/PT scheduling with guardian booking, approval queue, and WhatsApp/SMS notifications. Full spec: docs/PRD.md — it wins any conflict with code comments or assumptions.

## Stack (do not substitute without asking)
- Next.js 15 App Router, TypeScript strict, React Server Components by default
- Tailwind CSS + shadcn/ui
- PostgreSQL (Supabase) via Prisma; raw SQL migrations for anything Prisma cannot express (exclusion constraint, btree_gist)
- Zod for every input boundary (forms, API routes, webhooks)
- date-fns + date-fns-tz; store UTC, render America/Anguilla (AST, no DST)
- Parent auth: custom phone OTP (hashed codes, 10-min expiry) + signed httpOnly session cookie (iron-session)
- Staff auth: email + password (argon2) + TOTP for admin role
- Messaging: MessagingProvider interface with WhatsAppCloudProvider (Meta Graph API) and TwilioSmsProvider; outbox table + worker
- Jobs: /api/cron/* endpoints protected by CRON_SECRET, triggered every 5 min (Vercel Cron on Pro plan, or Supabase pg_cron + pg_net)
- Storage: Supabase Storage private bucket, signed URLs
- Tests: Vitest (unit/integration against a test DB), Playwright (e2e)
- Hosting: Vercel + Supabase

## Rules
- Never compute availability in the browser; the server is the source of truth.
- Every appointment write goes through one service module (src/server/appointments.ts) that: validates, writes, appends audit_log, and enqueues notifications in the same transaction.
- Catch Postgres exclusion violations (SQLSTATE 23P01) and return a typed SlotTakenError.
- Every parent-facing query filters by guardian_patient link AND restricted = false; every parent write additionally requires can_book = true. Write a test for each new parent endpoint proving cross-family access and notify-only writes fail.
- Provider names are never returned to parent endpoints for appointments not yet CONFIRMED.
- No health details in message bodies beyond name, visit type, date/time, provider.
- All user-facing strings in src/i18n/en.json.
- Config values from clinic_settings, never hard-coded.
- Run `pnpm typecheck && pnpm test` before declaring any task done. Commit at the end of each build prompt.

## Brand
- Clinic name: Wellness Ave (always this exact spelling and capitalization). Product name: Wellness Ave Scheduling.
- Repo/package slug: wellness-ave-scheduling. Session cookie: wellnessave_session. Booking reference prefix: WAV-.
- Page titles: "Book a visit | Wellness Ave" (parent) and "Admin | Wellness Ave" (staff). Header wordmark: "Wellness Ave" set in the brand font, no logo image until one is supplied.
- .ics files: ORGANIZER and calendar name "Wellness Ave"; event title "{child} — {visit type} at Wellness Ave".
- Every WhatsApp/SMS template body names Wellness Ave; the WhatsApp display name must be exactly "Wellness Ave".

## Design tokens
- Palette: Jacaranda #5B3F8C (primary), Ink #1F2230 (text), Paper #FBFAFD (background), Acacia #3C7A57 (confirmed), Sunbird #E7A93B (pending), Laterite #B5412F (declined/errors). Provider colors: 4 distinct, AA contrast on white.
- Type: Atkinson Hyperlegible for everything (parents read on phones, often in a hurry); one weight scale 400/700.
- Parent app is mobile-first, single-column, one decision per screen, thumb-reach primary button. Admin console is desktop-first, dense.
- Sentence case everywhere; buttons name the action ("Request this time", "Confirm visit").

## Commands
pnpm dev | pnpm typecheck | pnpm test | pnpm e2e | pnpm db:migrate | pnpm db:seed

## Implementation notes (keep current)
- Prisma 7 with `@prisma/adapter-pg`; client generated to `src/generated/prisma` (gitignored; `pnpm install` regenerates). Ids default to `gen_random_uuid()` in the database so raw SQL inserts work.
- The scheduling core (availability, row locks, savepoint retries against `no_provider_overlap`) is raw SQL run through Prisma (`q`/`exec` in `src/server/db.ts`) inside `prisma.$transaction`. Use the typed client for simple CRUD.
- Messages are only ever enqueued (outbox rows, status PENDING) inside the write transaction; the outbox worker sends them.
- Test DB: `TEST_DATABASE_URL` (default `postgres://wav:wav@localhost:5432/wav_test`). Vitest applies migrations with `prisma migrate deploy` and truncates tables between tests. Prisma refuses `migrate reset` from AI agents — do not work around that guard.
- Tests run with `TZ=Asia/Tokyo` to prove AST rendering is machine-independent.
- Pin TypeScript 5.x (Next 15 is incompatible with TypeScript 7).
- Outbox: sends happen only in `src/server/messaging/outbox.ts`. WhatsApp failure → immediate SMS fallback row (`fallback_of_id`); SMS retries 3× with backoff. T0 bodies/vars are nulled after sending — never log OTPs.
- Waitlist: offers go out inside the transaction that frees a slot; `/api/cron/waitlist` sweeps for any other open times and closes expired entries.
- Tests stub messaging with `tests/unit/mock-providers.ts` (`setProviders`); route handlers use `setRouteCtx` for the fixed clock.
