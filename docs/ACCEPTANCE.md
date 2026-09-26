# PRD §14 acceptance tests — where each is proven

Run everything with `pnpm acceptance`, which runs the unit/integration suite against Postgres and then Playwright against a production build.

- **Unit/integration tests** use a real Postgres database with real concurrent transactions and fake WhatsApp/SMS senders. They run with `TZ=Asia/Tokyo`.
- **End-to-end tests** run `next start` against a fresh `wav_e2e` database. Parent tests use a 390px viewport; the admin browser runs in the `Asia/Tokyo` timezone.

| # | Acceptance test | Automated proof |
|---|---|---|
| 1 | A 90-minute evaluation is never offered at Fri 16:00 or Sat 17:00 | `tests/unit/scheduling.test.ts` › AC 1 |
| 2 | One provider free, two simultaneous submissions: exactly one succeeds; the other sees "That time was just taken" and fresh slots | `scheduling.test.ts` › AC 2 (concurrent transactions); `parent-api.test.ts` › SlotTakenError 409; the wizard refreshes the times in place |
| 3 | Two providers free: both succeed on different providers | `scheduling.test.ts` › AC 3 |
| 4 | A time disappears only when all providers are busy | `scheduling.test.ts` › AC 4 |
| 5 | Reassignment offers only providers free for the full duration | `scheduling.test.ts` › AC 5; `admin-api.test.ts` › queue… reassign dropdown; e2e `admin.spec.ts` |
| 6 | Two notified guardians → two T1/T2/T3; restricted → none; notify-only copy has no buttons | `messaging.test.ts` › fan-out (AC 6) |
| 7 | Notify-only guardian cannot book, cancel, reschedule or claim via UI, API or WhatsApp button | `parent-api.test.ts` › AC 7 + AC 11 on every parent route; `messaging.test.ts` › notify-only buttons; UI shows the primary-contact notice |
| 8 | WhatsApp failure triggers SMS within 60 seconds | `messaging.test.ts` › API error fallback; failed-status webhook fallback |
| 9 | Unanswered REQUESTED becomes EXPIRED on time and the slot reappears | `scheduling.test.ts` › AC 9 |
| 10 | Cancelling a confirmed slot sends T8; first Claim holds, later taps get "already taken" | `messaging.test.ts` › AC 10 (via signed WhatsApp button webhooks) |
| 11 | Parent A cannot load Parent B's child by editing an ID | `parent-api.test.ts` › AC 7 + AC 11 (404 on every route, including restricted) |
| 12 | Reminder T6 fires once, 24h before, not for cancelled visits | `messaging.test.ts` › AC 12 (through `/api/cron/reminders`) |
| 13 | Clinic closure cancels every affected visit and sends one T10 per notified guardian | `messaging.test.ts` › AC 13; `admin-api.test.ts` › closure preview/apply |
| 14 | All times display in AST whatever the device timezone | `scheduling.test.ts` › AC 14 (`TZ=Asia/Tokyo`); e2e `admin.spec.ts` (the Tokyo browser shows the same AST time the parent saw) |

Last full run: all unit/integration tests and all e2e tests passing (see the commit message).
