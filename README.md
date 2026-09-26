# Wellness Ave Scheduling

Pediatric OT/PT scheduling for Wellness Ave, Anguilla.

- Parents book at `/book`.
- Staff approve and manage at `/admin`.
- Updates go by WhatsApp, with SMS as the fallback.

The spec is [`docs/PRD.md`](docs/PRD.md) and the project rules are in [`CLAUDE.md`](CLAUDE.md).

| Build prompt    | Scope                                                                                            | Status |
| --------------- | ------------------------------------------------------------------------------------------------ | ------ |
| 1 Foundation    | Schema, exclusion constraint, seed, availability engine, appointment service                     | ✅     |
| 2 Parent app    | OTP sign-in, 5-step booking, My visits, guardian links                                           | ✅     |
| 3 Messaging     | WhatsApp/Twilio providers, outbox worker, webhooks, cron                                         | ✅     |
| 4 Admin console | Queue, calendar, patients, payments, closures, series, waitlist, logs, settings, reports, deploy | ✅     |

**Stack:** Next.js 15 (App Router) · TypeScript · Tailwind · Prisma 7 + PostgreSQL (Supabase) · Vercel.

---

## 1. Local development

```bash
pnpm install                     # also generates the Prisma client
cp .env.example .env             # set DATABASE_URL, DIRECT_URL, SESSION_SECRET (32+ chars), ADMIN_EMAIL, ADMIN_INITIAL_PASSWORD
pnpm db:migrate                  # schema + btree_gist no_provider_overlap constraint
pnpm db:seed                     # PRD defaults, 4 placeholder providers, Fri/Sat hours, first admin (prints the TOTP URI once)
pnpm dev                         # http://localhost:3000/book and /admin
```

Without WhatsApp/Twilio credentials, messages are printed to the server console. In development, sign-in codes are printed there too.

**Tests:**

```bash
pnpm typecheck && pnpm test      # needs a disposable Postgres at TEST_DATABASE_URL
pnpm build && pnpm e2e           # Playwright at 390px against `next start`
```

## 2. Supabase (database + private storage)

1. **Create a Supabase project.** Pick the region closest to Anguilla (e.g. `us-east-1`). Note in the privacy notice that data is hosted outside Anguilla (PRD §13).
2. **Set the database URLs.** Under Project settings → Database → Connection string:
   - `DATABASE_URL` = the **transaction pooler** URL (port `6543`, add `?pgbouncer=true`).
   - `DIRECT_URL` = the **direct** URL (port `5432`). Migrations use this one.
3. **Run migrations once, from your machine or CI.** Run `pnpm db:migrate`, then `pnpm db:seed`. The migration enables `btree_gist`, which Supabase supports.
4. **Create a private bucket.** Under Storage, create a **private** bucket named `wellness-ave-private` (or set `STORAGE_BUCKET`). Leave it private: files are only ever served by 15-minute signed URLs.
5. **Set the storage keys.** Set `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` (Project settings → API). The service role key is server-only; never expose it to the browser.

## 3. Vercel

1. **Import the repo in Vercel.** It detects Next.js on its own. The build runs `prisma generate && next build`.
2. **Add every variable from `.env.example`** under Settings → Environment Variables.
   - `APP_BASE_URL` must be the public origin, e.g. `https://book.wellnessave.com`.
   - Leave `FILE_ROOT`, `MESSAGING_LOG_FILE` and `TEST_DATABASE_URL` unset in production.
3. **Cron.** `vercel.json` schedules `/api/cron/{outbox,expire,reminders,agenda,waitlist,retention}`. Vercel sends `Authorization: Bearer $CRON_SECRET` automatically once `CRON_SECRET` is set.
   - A 5-minute schedule needs the **Pro** plan.
   - Alternative: call the same URLs from Supabase `pg_cron` + `pg_net`:
     ```sql
     select cron.schedule('wav-expire', '*/5 * * * *',
       $$ select net.http_get('https://book.wellnessave.com/api/cron/expire',
            headers => jsonb_build_object('Authorization', 'Bearer <CRON_SECRET>')) $$);
     ```
4. **Point the domain at Vercel.** HTTPS is automatic, and the app sends HSTS.

## 4. Meta WhatsApp Cloud API

1. **Get the account ready.** Complete Business verification and create the WhatsApp Business Account. Add a **dedicated** number that isn't already registered in the WhatsApp app, and request the display name **"Wellness Ave"**.
2. **Set the access variables.** Create a System User with a permanent token. Then set:
   - `WA_PHONE_NUMBER_ID`
   - `WA_ACCESS_TOKEN`
   - `WA_APP_SECRET` (App settings → Basic)
   - `WA_GRAPH_VERSION` (e.g. `v21.0`)
3. **Register the webhook.** Go to App → WhatsApp → Configuration → Webhook:
   - Callback URL: `https://<APP_BASE_URL>/api/webhooks/whatsapp`
   - Verify token: the value of `WA_VERIFY_TOKEN`
   - Subscribe to the **messages** field. It carries inbound replies and delivery statuses.
4. **Submit the templates.** Submit T0–T10 and S1–S3 from `src/i18n/en.json`: T0 as AUTHENTICATION, the rest as UTILITY. Each template's variable order is listed in `src/server/messaging/templates.ts`. Add the quick-reply buttons for T3, T5, T6 and T8 as shown there.
5. **Drop in the approved names.** If Meta approves different template names, set `WA_TEMPLATE_NAMES` (JSON, e.g. `{"T1":"wellness_ave_fu_received"}`). You don't need to change any code.

## 5. Twilio SMS

1. **Buy a sending number.** Buy an SMS-capable number or sender, then set `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` and `TWILIO_FROM_NUMBER`.
2. **Set the webhook URLs.** Under Phone number → Messaging configuration, set **A message comes in** to `POST https://<APP_BASE_URL>/api/webhooks/sms`. Delivery reports come back to the same URL: the app sets it as each message's `StatusCallback`.
3. **Match the public URL.** Requests are validated with `X-Twilio-Signature` over `APP_BASE_URL` + path, so `APP_BASE_URL` must match the URL Twilio calls exactly.
4. **Test on local networks.** Send a test SMS to both Anguilla mobile networks before launch (PRD §16).

## 6. First run checklist

- **Staff logins.** The first administrator is Dr. Kniquiah Hughes (`ADMIN_EMAIL=kniquiah.hughes@gmail.com`). Sign in at `/admin/login` with that email, the initial password and the authenticator code printed by `pnpm db:seed`. Then create provider logins under **Settings → Staff logins**.
- **Replace placeholders.** Under **Settings**, replace the placeholder providers. Defaults already set: clinic phone and staff alerts +1 786 942 0603; NCBA account "Wellness Ave." no. 6001232. The bank details must match the printed notice at the clinic.
- **Check the hours.** Under **Settings → Opening hours**, confirm Friday 08:00–17:00 and Saturday 08:00–18:00, plus any per-provider overrides.
- **Legal review.** Anguilla counsel reviews the consent text in `src/i18n/en.json` (`ui.details.consent*`), the privacy notice and the retention settings.

## Architecture notes

- **Double-booking.** It's impossible at the database level: the `no_provider_overlap` exclusion constraint. `src/server/appointments.ts` is the only place appointments are written; it retries the next free provider when the constraint fires.
- **Parent access.** Every parent query checks the guardian↔child link and `restricted = false`, and writes also require `can_book`. Missing and restricted records both return 404.
- **Messages.** They're queued in the same transaction as the change and sent by the outbox worker (`src/server/messaging/outbox.ts`). A WhatsApp failure falls back to SMS immediately; SMS retries 3 times with backoff.
- **Times.** Everything is stored in UTC and always rendered in the clinic timezone (AST), whatever the device's timezone.
