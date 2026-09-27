# WhatsApp templates to submit to Meta

Generated from `src/server/messaging/templates.ts` and `src/i18n/en.json`. In WhatsApp Manager → Message templates → Create template: use the **name**, **category** and **language** below, paste the **body**, give each variable its **sample**, and add the **quick-reply buttons** where listed (button text only; the app supplies the payload). Keep the variables in this order.

## T0 — `wellness_ave_otp`

- Category: **AUTHENTICATION** · Language: **English (en)**
- Authentication templates use Meta's fixed wording: choose the "Copy code" button. The app sends the code as {{1}} and on the button.

**Body**

> Your Wellness Ave code is {{1}}. It expires in 10 minutes.

| Variable | Meaning | Sample |
|---|---|---|
| {{1}} | code | 482913 |

## T1 — `wellness_ave_fu_received`

- Category: **UTILITY** · Language: **English (en)**

**Body**

> Hi {{1}}, we received {{2}}'s follow-up request at Wellness Ave for {{3}} {{4}} at {{5}}. Ref {{6}}. Payment options: cash at the clinic, or bank transfer to NCBA, account name {{7}}, account {{8}}, reference {{9}}. After paying, reply with your transfer reference or a screenshot. We will never send new bank details by message. We will confirm shortly.

| Variable | Meaning | Sample |
|---|---|---|
| {{1}} | guardian | Tasha |
| {{2}} | child | Maya |
| {{3}} | day | Friday |
| {{4}} | date | 2 October 2026 |
| {{5}} | time | 9:00 AM |
| {{6}} | ref | WAV-4F7K |
| {{7}} | ACCOUNT_NAME | Wellness Ave. |
| {{8}} | NCBA_ACCOUNT_NO | 6001232 |
| {{9}} | ref | WAV-4F7K |

## T2 — `wellness_ave_eval_received`

- Category: **UTILITY** · Language: **English (en)**

**Body**

> Hi {{1}}, Wellness Ave received {{2}}'s evaluation request for {{3}} {{4}} at {{5}}. Ref {{6}}. Your therapist will reach out to you for confirmation.

| Variable | Meaning | Sample |
|---|---|---|
| {{1}} | guardian | Tasha |
| {{2}} | child | Maya |
| {{3}} | day | Friday |
| {{4}} | date | 2 October 2026 |
| {{5}} | time | 9:00 AM |
| {{6}} | ref | WAV-4F7K |

## T3 — `wellness_ave_confirmed`

- Category: **UTILITY** · Language: **English (en)**

**Body**

> Wellness Ave: {{1}}'s {{2}} is confirmed: {{3}} {{4}}, {{5}}, with {{6}}. Ref {{7}}.

| Variable | Meaning | Sample |
|---|---|---|
| {{1}} | child | Maya |
| {{2}} | visit_type | follow-up |
| {{3}} | day | Friday |
| {{4}} | date | 2 October 2026 |
| {{5}} | time | 9:00 AM |
| {{6}} | provider | Dr. Kniquiah Hughes |
| {{7}} | ref | WAV-4F7K |

**Quick-reply buttons:** "View", "Reschedule"

## T4 — `wellness_ave_declined`

- Category: **UTILITY** · Language: **English (en)**

**Body**

> Wellness Ave could not confirm {{1}}'s request for {{2}} {{3}}. {{4}}. Book another time: {{5}}

| Variable | Meaning | Sample |
|---|---|---|
| {{1}} | child | Maya |
| {{2}} | date | 2 October 2026 |
| {{3}} | time | 9:00 AM |
| {{4}} | reason | The requested time is no longer available |
| {{5}} | link | https://book.wellnessave.com/book |

## T5 — `wellness_ave_alternate`

- Category: **UTILITY** · Language: **English (en)**

**Body**

> Wellness Ave can offer {{1}} {{2}} at {{3}} for {{4}} instead.

| Variable | Meaning | Sample |
|---|---|---|
| {{1}} | new_day | Saturday |
| {{2}} | new_date | 3 October 2026 |
| {{3}} | new_time | 10:30 AM |
| {{4}} | child | Maya |

**Quick-reply buttons:** "Accept", "Choose another time"

## T6 — `wellness_ave_reminder_24h`

- Category: **UTILITY** · Language: **English (en)**

**Body**

> Reminder from Wellness Ave: {{1}} has {{2}} tomorrow at {{3}} with {{4}}.

| Variable | Meaning | Sample |
|---|---|---|
| {{1}} | child | Maya |
| {{2}} | visit_type | follow-up |
| {{3}} | time | 9:00 AM |
| {{4}} | provider | Dr. Kniquiah Hughes |

**Quick-reply buttons:** "I'll be there", "Reschedule"

## T7 — `wellness_ave_cancelled`

- Category: **UTILITY** · Language: **English (en)**

**Body**

> Wellness Ave: {{1}}'s appointment on {{2}} at {{3}} is cancelled. {{4}} Book again: {{5}}

| Variable | Meaning | Sample |
|---|---|---|
| {{1}} | child | Maya |
| {{2}} | date | 2 October 2026 |
| {{3}} | time | 9:00 AM |
| {{4}} | reason | The requested time is no longer available |
| {{5}} | link | https://book.wellnessave.com/book |

## T8 — `wellness_ave_waitlist_offer`

- Category: **UTILITY** · Language: **English (en)**

**Body**

> Wellness Ave: a {{1}} time opened: {{2}} {{3}} {{4}}. First to tap gets it.

| Variable | Meaning | Sample |
|---|---|---|
| {{1}} | visit_type | follow-up |
| {{2}} | day | Friday |
| {{3}} | date | 2 October 2026 |
| {{4}} | time | 9:00 AM |

**Quick-reply buttons:** "Claim"

## T9 — `wellness_ave_guardian_invite`

- Category: **UTILITY** · Language: **English (en)**

**Body**

> {{1}} added you to receive appointment updates for {{2}} at Wellness Ave. Reply YES to receive them on WhatsApp, or STOP to opt out.

| Variable | Meaning | Sample |
|---|---|---|
| {{1}} | inviter | Tasha |
| {{2}} | child | Maya |

## T10 — `wellness_ave_clinic_closure`

- Category: **UTILITY** · Language: **English (en)**

**Body**

> Wellness Ave is closed on {{1}} ({{2}}). {{3}}'s {{4}} appointment is cancelled. We will contact you to rebook, or book here: {{5}}

| Variable | Meaning | Sample |
|---|---|---|
| {{1}} | date | 2 October 2026 |
| {{2}} | reason | The requested time is no longer available |
| {{3}} | child | Maya |
| {{4}} | time | 9:00 AM |
| {{5}} | link | https://book.wellnessave.com/book |

## S1 — `wellness_ave_staff_new_request`

- Category: **UTILITY** · Language: **English (en)**

**Body**

> Wellness Ave — new {{1}} request: {{2}}, {{3}} {{4}}, suggested provider {{5}}. Review: {{6}}

| Variable | Meaning | Sample |
|---|---|---|
| {{1}} | visit_type | follow-up |
| {{2}} | child | Maya |
| {{3}} | date | 2 October 2026 |
| {{4}} | time | 9:00 AM |
| {{5}} | provider | Dr. Kniquiah Hughes |
| {{6}} | admin_link | https://book.wellnessave.com/admin |

## S2 — `wellness_ave_staff_escalation`

- Category: **UTILITY** · Language: **English (en)**

**Body**

> Wellness Ave — request {{1}} still pending. Expires {{2}}.

| Variable | Meaning | Sample |
|---|---|---|
| {{1}} | ref | WAV-4F7K |
| {{2}} | expires_at | 3 October 2026 9:00 AM |

## S3 — `wellness_ave_provider_agenda`

- Category: **UTILITY** · Language: **English (en)**

**Body**

> Wellness Ave — today's schedule: {{1}} visits. First at {{2}}. {{3}}

| Variable | Meaning | Sample |
|---|---|---|
| {{1}} | n | 4 |
| {{2}} | time | 9:00 AM |
| {{3}} | link | https://book.wellnessave.com/book |

