# PRD — Pediatric OT/PT Scheduling System (Phase 1) — v2
Working name: Wellness Ave Scheduling. This file is the single source of truth for both the Claude Code and Replit builds. Any value in {{BRACES}} is a config setting stored in the database, not hard-coded.

v2 changes: Anguilla locale; parents pick a time only and the admin assigns the provider; the co-parent receives updates but cannot book by default; payment is cash or NCBA transfer; SMS moves to Twilio; clinic-closure tool and anti-phishing measures added.

---

## 1. Product summary
Parents open a link, sign in with their phone number, pick a visit type, pick an open time, and submit a request. They never choose a provider. The request holds the slot and lands in the administrator's approval queue, where the admin assigns or confirms the provider. Every status change is sent by WhatsApp (SMS fallback) to every guardian on the child's record who is set to receive notifications — built for separated households from day one.

## 2. Locale defaults (config)
- Country: Anguilla. Timezone: America/Anguilla (AST, UTC−4, no daylight saving). Store all timestamps in UTC, render in AST.
- Currency: EC$ (XCD). Phone format: E.164, default country code +1, local area code 264; accept numbers from other countries (parents abroad, e.g. St. Maarten, USA, UK).
- Language: English; all strings in an i18n file.
- Clinic hours (clinic-wide default, per-provider override allowed):
  - Friday 08:00–17:00
  - Saturday 08:00–18:00
- Providers: 4 (name, discipline OT or PT, color, WhatsApp number, active flag). Provider names are never shown to parents before confirmation.

## 3. Roles and permissions
- Primary guardian (the parent who booked, or any guardian the admin sets can_book = true): book, view, cancel/reschedule the child's appointments; join waitlist; manage own contact and consent.
- Notify-only guardian (default for a co-parent): receives all appointment messages and can view upcoming appointments; cannot book, cancel, or reschedule. Admin can upgrade them to can_book.
- Provider: view own calendar; mark attended/no-show; add time off. Approval rights configurable ({{PROVIDER_CAN_APPROVE}} default false — admin approves).
- Administrator: everything — assignment, approvals, all calendars, patients, guardians, payments, settings, closures, message log, audit log, reports.
- Every write action is recorded in the audit log (who, what, when, before/after).

## 4. Scheduling rules
- Visit types: Follow-Up 60 minutes; Evaluation 90 minutes.
- Start-time grid: every 30 minutes ({{SLOT_STEP_MIN}} = 30).
- A slot is offered only if the full visit fits inside open hours. Last starts: Follow-Up Fri 16:00 / Sat 17:00; Evaluation Fri 15:30 / Sat 16:30.
- Pooled availability: a time is shown to parents if at least one active provider is free for the full duration. Parents see times only.
- Tentative assignment: on submit, the system places the request with the free provider who has the fewest bookings that day (ties broken by provider order). This holds a real slot so the database can prevent double-booking. The admin sees this as "suggested provider" and can reassign to any other provider free at that time before confirming.
- Optional rule {{EVAL_DISCIPLINE_MATCH}}: admin may tag each provider OT/PT; reassignment picker shows discipline next to each name.
- Buffer between visits: {{BUFFER_MIN}} default 0.
- Booking horizon: {{HORIZON_DAYS}} default 28 days. Minimum notice: {{MIN_NOTICE_HOURS}} default 12.
- Blocking statuses: REQUESTED, ALTERNATE_PROPOSED, CONFIRMED.
- Double-booking is impossible at the database level (section 11), not just in application code.
- Time off / closures: provider-level and clinic-level blocks remove availability.

## 5. Parent booking flow
Visit type is chosen before times are shown, because a 90-minute evaluation fits fewer slots than a 60-minute follow-up.

Step 1 — Sign in: mobile number → 6-digit code by WhatsApp (SMS fallback) → verified. Returning guardians see their children. Notify-only guardians see upcoming visits but no booking buttons.
Step 2 — Visit type: Follow-Up (1 hour) or Evaluation (1.5 hours).
Step 3 — Date and time: calendar showing only Fridays and Saturdays with availability; tap a time.
Step 4 — Details:

Follow-Up path
- Patient name (select existing child, or type a name — typed names are flagged for admin to match).
- Submit → REQUESTED → T1 (request received + payment options).
- Admin confirms (and assigns provider) → T3 (confirmed, provider named).

Evaluation path
- Patient full name
- Date of birth
- Reason for evaluation (free text, 500 chars) + optional checklist: fine motor, gross motor, sensory processing, feeding, handwriting, developmental delay, post-injury/surgery, other
- Payment type: Insurance or Self-pay
  - If Insurance: insurer name, member/policy number, referral Yes/No; if Yes, upload referral letter (PDF/JPG/PNG, 10 MB max)
- Other parent/guardian (optional but prompted): name, relationship, mobile, toggle "send appointment updates to this person" (default on). Helper text: "They will receive updates. Only you can book or change appointments."
- Consents (required, stored with timestamp and version): consent to collect and use the child's personal and health information for care and scheduling; consent to receive appointment messages by WhatsApp/SMS
- Submit → REQUESTED → T2 ("Your therapist will reach out to you for confirmation").

Step 5 — Confirmation screen: summary (no provider name until confirmed), booking reference (e.g. WAV-4F7K), payment details for follow-ups, add-to-calendar (.ics) link, and the line "We will never send you new bank details by message."

## 6. Appointment status machine
- REQUESTED → CONFIRMED | DECLINED | ALTERNATE_PROPOSED | EXPIRED
- ALTERNATE_PROPOSED → CONFIRMED (parent accepts) | CANCELLED (parent declines or no reply in {{ALT_EXPIRY_HOURS}} = 24)
- CONFIRMED → COMPLETED | NO_SHOW | CANCELLED_BY_PARENT | CANCELLED_BY_CLINIC | RESCHEDULED (creates a new linked appointment)
- REQUESTED expires after {{REQUEST_EXPIRY_HOURS}} default 24; admin gets an escalation alert at 50% of that time.
- Provider assignment is tracked: provider_assigned_by = SYSTEM (tentative) or ADMIN.
- Payment status is separate: UNPAID | PAID_CASH | PAID_BANK_TRANSFER | WAIVED, plus payment reference and who recorded it.

## 7. Notifications
Channel rule per guardian: WhatsApp if opted in; otherwise SMS. If a WhatsApp send fails (API error or "failed" status webhook), resend by SMS automatically.

Fan-out rule: every guardian linked to the child with receives_notifications = true AND restricted = false gets their own message. Buttons that change an appointment (Reschedule, Accept, Claim) are included only in messages to guardians with can_book = true; notify-only guardians receive the same information without action buttons.

Anti-phishing rules for every message: sent only from the verified WhatsApp business profile; bank details only in T1 and always identical to what is posted at the clinic; no links to anything except the center's own booking domain; never ask for passwords, PINs, or card numbers.

WhatsApp templates are submitted to Meta as UTILITY category with transactional wording only.

| Key | Trigger | Recipients | Content (draft) |
|---|---|---|---|
| T0 otp | Sign-in | Requesting phone | Your Wellness Ave code is {{code}}. It expires in 10 minutes. (AUTHENTICATION template) |
| T1 fu_received | Follow-Up submitted | Notified guardians | Hi {{guardian}}, we received {{child}}'s follow-up request for {{day}} {{date}} at {{time}}. Ref {{ref}}. Payment options: cash at the clinic, or bank transfer to NCBA, account name {{ACCOUNT_NAME}}, account {{NCBA_ACCOUNT_NO}}, reference {{ref}}. After paying, reply with your transfer reference or a screenshot. We will never send new bank details by message. We will confirm shortly. |
| T2 eval_received | Evaluation submitted | Notified guardians | Hi {{guardian}}, we received {{child}}'s evaluation request for {{day}} {{date}} at {{time}}. Ref {{ref}}. Your therapist will reach out to you for confirmation. |
| T3 confirmed | Status → CONFIRMED | Notified guardians | {{child}}'s {{visit_type}} is confirmed: {{day}} {{date}}, {{time}}, with {{provider}}. Ref {{ref}}. Buttons (can_book only): View / Reschedule |
| T4 declined | Status → DECLINED | Notified guardians | We could not confirm {{child}}'s request for {{date}} {{time}}. {{reason}}. Book another time: {{link}} |
| T5 alternate | Status → ALTERNATE_PROPOSED | Notified guardians | We can offer {{new_day}} {{new_date}} at {{new_time}} for {{child}} instead. Buttons (can_book only): Accept / Choose another time |
| T6 reminder_24h | 24h before CONFIRMED | Notified guardians | Reminder: {{child}} has {{visit_type}} tomorrow at {{time}} with {{provider}}. Buttons (can_book only): I'll be there / Reschedule |
| T7 cancelled | Any cancellation | Notified guardians | {{child}}'s appointment on {{date}} at {{time}} is cancelled. {{reason}} Book again: {{link}} |
| T8 waitlist_offer | Slot freed + waitlist match | Waitlisted can_book guardians (max 3 at once) | A {{visit_type}} time opened: {{day}} {{date}} {{time}}. First to tap gets it. Button: Claim |
| T9 guardian_invite | Other guardian added | New guardian (SMS) | {{inviter}} added you to receive appointment updates for {{child}} at Wellness Ave. Reply YES to receive them on WhatsApp, or STOP to opt out. |
| T10 clinic_closure | Admin closes clinic | All notified guardians of affected visits | Wellness Ave is closed on {{date}} ({{reason}}). {{child}}'s {{time}} appointment is cancelled. We will contact you to rebook, or book here: {{link}} |
| S1 staff_new_request | New request | Admin | New {{visit_type}} request: {{child}}, {{date}} {{time}}, suggested provider {{provider}}. Review: {{admin_link}} |
| S2 staff_escalation | Request pending past 50% of expiry | Admin | Request {{ref}} still pending. Expires {{expires_at}}. |
| S3 provider_agenda | 07:00 AST on clinic days | Each provider | Today's schedule: {{n}} visits. First at {{time}}. {{link}} |

Inbound WhatsApp handling: button replies update the appointment only if the sender is a can_book guardian; a reply containing an image or text after T1 is attached to the latest unpaid appointment as a payment proof for admin review (never auto-marked paid).

## 8. Guardians and separated households
- Many-to-many: a child can have multiple guardians; a guardian can have multiple children.
- Guardian-child link fields: relationship, can_book, receives_notifications, restricted, notes.
- Defaults: the guardian who creates the child record → can_book = true, receives_notifications = true. Any guardian added by that parent → can_book = false, receives_notifications = true.
- Admin can change can_book for any guardian (e.g. shared custody where both parents bring the child).
- restricted is admin-only (e.g. a court order). A restricted guardian gets no messages, cannot see the child, and cannot book — regardless of other flags. The UI never reveals that a restriction exists.
- An added guardian receives T9 by SMS and gets SMS updates until they reply YES (WhatsApp policy requires the recipient's own opt-in).
- If a notify-only guardian signs in and tries to book, show: "Bookings for {{child}} are made by the primary contact. Contact the clinic at {{CLINIC_PHONE}} for changes."
- Admin can merge duplicate guardians/children.

## 9. Admin and provider console
- Approval queue: oldest first, countdown to expiry, suggested provider shown with a reassign dropdown (only providers free at that time, with OT/PT tag and that day's load). One-click Confirm, Decline (reason required), Propose alternate (pick any pooled open slot → T5).
- Calendar: day and week views, columns per provider, color-coded by provider, pending striped, confirmed solid. Drag to reschedule or move between providers.
- Patients: search, child profile, guardians and their flags, visit history, evaluation intake, referral file, no-show count.
- Payments: mark paid (cash or bank transfer + reference), unpaid list, daily totals by method, review queue for proofs received by WhatsApp.
- Time off: provider or clinic-wide, date range or partial day.
- Clinic closure: select date range + reason → preview affected appointments → one action cancels all (CANCELLED_BY_CLINIC), sends T10, and adds each family to a "rebook" list.
- Recurring series: book a child weekly/biweekly for N sessions; conflicts listed before saving; created as CONFIRMED.
- Waitlist: view, add manually, remove.
- Message log: every outbound/inbound message with channel, delivery status, failure reason.
- Settings: hours, durations, horizon, notice, expiry windows, payment details, clinic phone, template variables, cancellation cutoff.
- Reports: visits by provider, provider load balance, no-show rate, requests approved/declined/expired, payments recorded by method.

## 10. Phase 1 additions (from competitive review)
Pediatric therapy platforms (Fusion Web Clinic, PtEverywhere, Practice Pro) converge on a common core; these are included because they are cheap to build and protect revenue or admin time:
1. 24-hour reminders with one-tap confirm/reschedule.
2. Self-service cancel/reschedule up to {{CANCEL_CUTOFF_HOURS}} default 24h before; later cancellations flagged as late.
3. Waitlist with automatic offers when a slot frees (first to claim wins).
4. Recurring standing appointments.
5. Family accounts with primary and notify-only guardians.
6. No-show and late-cancel tracking per child, visible at approval time.
7. Provider morning agenda message.
8. Add-to-calendar (.ics) link on every confirmation.
9. Booking reference codes in every message and used as the bank transfer reference.
10. Full audit log.
11. Clinic closure tool (storms, hurricane season, public holidays).
12. Anti-phishing message standards (section 7).

## 11. Data model (Postgres)
- clinic_settings (single row, JSON for template vars and payment details)
- provider (id, name, discipline, color, phone, display_order, active)
- availability_rule (provider_id nullable = clinic-wide, weekday, start_time, end_time)
- time_off (provider_id nullable, starts_at, ends_at, reason, is_closure bool)
- guardian (id, name, phone_e164 unique, whatsapp_opt_in_at, sms_opt_out_at, verified_at)
- patient (id, full_name, dob, created_by_guardian_id, needs_admin_match bool)
- guardian_patient (guardian_id, patient_id, relationship, can_book, receives_notifications, restricted, notes)
- appointment (id, ref unique, patient_id, provider_id, provider_assigned_by, visit_type, starts_at, ends_at, status, requested_by_guardian_id, expires_at, series_id, rescheduled_from_id, decline_reason, payment_status, payment_method, payment_reference, late_cancel bool, created_at, updated_at)
- evaluation_intake (appointment_id, reason_text, reason_tags[], payer_type, insurer, member_no, has_referral, referral_file_key)
- payment_proof (appointment_id, guardian_id, text, file_key, received_at, reviewed_by, reviewed_at)
- consent (guardian_id, patient_id, type, version, granted_at, withdrawn_at)
- waitlist_entry (patient_id, guardian_id, visit_type, date_from, date_to, window, status)
- recurring_series (id, patient_id, provider_id, visit_type, rule, count)
- message (id, guardian_id, appointment_id, template_key, channel, provider_message_id, status, error, direction, body, created_at)
- otp_code (phone, code_hash, expires_at, attempts)
- staff_user (id, email, role, provider_id nullable, password_hash, totp_secret nullable)
- audit_log (actor_type, actor_id, action, entity, entity_id, before jsonb, after jsonb, at)

Required raw-SQL constraint (ORMs do not generate this):
```sql
CREATE EXTENSION IF NOT EXISTS btree_gist;
ALTER TABLE appointment ADD CONSTRAINT no_provider_overlap
  EXCLUDE USING gist (provider_id WITH =, tstzrange(starts_at, ends_at, '[)') WITH &&)
  WHERE (status IN ('REQUESTED','ALTERNATE_PROPOSED','CONFIRMED'));
```
Tentative assignment must retry the next free provider if the insert hits this constraint (two parents booking the same time with two providers free → both succeed, on different providers).

## 12. Integrations
- WhatsApp: Meta WhatsApp Cloud API direct (no reseller markup). Webhook verifies X-Hub-Signature-256; handles status updates and inbound replies/media.
- SMS: Twilio Programmable Messaging behind a MessagingProvider interface (confirm delivery to Anguilla carriers during setup; +1-264 is North American numbering).
- File storage: private bucket, signed URLs (15-minute expiry) for referral letters and payment proofs.
- Payments: display-only in Phase 1 (cash or NCBA bank transfer). Admin records payment manually.

## 13. Privacy and security
- The records are children's health information. Build to an international baseline so the system holds up under any applicable regime: explicit, versioned guardian consent; access and deletion on request (admin export/delete tools); breach-response export listing affected records; minimum data in messages.
- Have Anguilla counsel confirm the consent text, privacy notice, retention period, and whether any registration or notification duty applies. Hosting outside Anguilla should be disclosed in the privacy notice.
- Security: HTTPS only; staff 2FA (TOTP) for admin; OTP rate limit 5 per phone per hour; lockout after 5 wrong codes; session 30 days parent / 12 hours staff; authorization checks on every parent query (guardian sees only linked, non-restricted children; only can_book guardians can write); no health details in WhatsApp/SMS bodies beyond name, visit type, time, provider.
- Retention setting for message bodies (default 12 months), then purge body text but keep metadata.

## 14. Acceptance tests (must pass before launch)
1. A 90-minute evaluation is never offered at Fri 16:00 or Sat 17:00.
2. With one provider free at a time, two simultaneous submissions: exactly one succeeds; the other sees "That time was just taken" and fresh slots.
3. With two providers free, two simultaneous submissions for the same time both succeed on different providers.
4. A time disappears from the parent calendar only when all providers are busy then.
5. Admin reassignment offers only providers free for the full duration.
6. A child with two notified guardians generates two T1/T2/T3 messages; a restricted guardian generates none; the notify-only guardian's copy has no action buttons.
7. A notify-only guardian cannot book, cancel, reschedule, or claim a waitlist slot via UI, API, or WhatsApp button.
8. WhatsApp failure triggers SMS within 60 seconds.
9. REQUESTED with no action becomes EXPIRED at the configured time and the slot reappears.
10. Cancelling a confirmed slot sends T8 to matching waitlist entries; the first Claim creates a hold, later taps get "already taken".
11. Parent A cannot load Parent B's child by editing an ID in the URL.
12. Reminder T6 fires once, 24h before, and not for cancelled visits.
13. Clinic closure cancels every affected appointment and sends one T10 per notified guardian.
14. All times display in AST regardless of the device timezone.

## 15. Phase 2 backlog
Online card payments via a gateway that settles to NCBA or another Anguilla account; automatic bank-transfer reconciliation; insurer pre-authorization tracking; therapist notes and home-exercise programs; parent progress updates; group sessions; telehealth; export to the practice EMR; analytics dashboard.

## 16. Pre-launch checklist (non-code — start now, critical path)
1. Meta Business verification + WhatsApp Business Account + a dedicated phone number not already used in the WhatsApp app; request the verified business profile. Allow 1–3 weeks.
2. Submit templates T0–T10, S1–S3 once the center name is final.
3. Twilio account; test SMS delivery to both Anguilla mobile networks.
4. Anguilla counsel review of consent text, privacy notice, and retention.
5. Final payment details (NCBA account name and number), clinic phone, cancellation policy wording.
6. Provider list, disciplines, colors, and any provider-specific hours.
7. Printed notice at the clinic showing the official bank details and "we never change bank details by message."
