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
