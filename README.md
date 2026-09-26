# Wellness Ave Scheduling

Pediatric OT/PT scheduling for Wellness Ave, Anguilla. Spec: [`docs/PRD.md`](docs/PRD.md). Project rules: [`CLAUDE.md`](CLAUDE.md).

## Build status

| Prompt          | Scope                                                                                         | Status |
| --------------- | --------------------------------------------------------------------------------------------- | ------ |
| 1 Foundation    | Scaffold, Prisma schema, exclusion constraint, seed, availability engine, appointment service | ✅     |
| 2 Parent app    | OTP sign-in, 5-step booking, My visits, guardian links                                        | ⏳     |
| 3 Messaging     | WhatsApp/Twilio providers, outbox worker, webhooks, cron                                      | ⏳     |
| 4 Admin console | Queue, calendar, patients, payments, closures, settings, deploy                               | ⏳     |

## Local setup

```bash
pnpm install
cp .env.example .env          # set DATABASE_URL, DIRECT_URL, SESSION_SECRET, ADMIN_EMAIL, ADMIN_INITIAL_PASSWORD
pnpm db:migrate               # schema + btree_gist exclusion constraint
pnpm db:seed                  # PRD defaults, 4 placeholder providers, Fri/Sat hours, first admin (prints TOTP URI)
pnpm dev
```

## Tests

```bash
pnpm typecheck && pnpm test   # needs a disposable Postgres at TEST_DATABASE_URL
```

The tests cover PRD acceptance tests 1, 2, 3 (real concurrent transactions), 4, 5, 9 and 14. There's also a check that the status transition table matches the PRD exactly.

## Messaging
- **Outbox.** Services only queue messages (`message` rows, status `PENDING`) inside the same transaction as the change. The outbox worker (`src/server/messaging/outbox.ts`) sends them in two situations:
  - straight after each API write, using Next's `after()`;
  - on every cron tick.
- **Channels and fallback.**
  - Each guardian gets WhatsApp if they opted in, otherwise SMS.
  - If a WhatsApp send fails, the SMS copy goes out immediately. That covers both an API error and a "failed" status webhook.
  - SMS retries with backoff (1 min, then 5 min) for 3 attempts in total.
- **Credentials.** Without WhatsApp/Twilio credentials, messages are logged to the console instead of sent.
- **Templates.** The registry is `src/server/messaging/templates.ts`: Meta name, language and variable order for each template. Once Meta approves the templates, drop the approved names in via `WA_TEMPLATE_NAMES`.
- **Webhooks.**
  - Meta: `GET/POST {APP_BASE_URL}/api/webhooks/whatsapp`. Verify token = `WA_VERIFY_TOKEN`, and payloads are checked against `WA_APP_SECRET`.
  - Twilio: `POST {APP_BASE_URL}/api/webhooks/sms`. Set it as both the inbound-message URL and the status callback. The signature is checked against `TWILIO_AUTH_TOKEN` over the public URL.
- **Cron jobs.** `GET /api/cron/{expire|reminders|agenda|waitlist|outbox|retention}` with `Authorization: Bearer $CRON_SECRET`, every 5 minutes.
