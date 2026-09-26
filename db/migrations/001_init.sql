-- Wellness Ave Scheduling — Phase 1 schema (PRD §11). All timestamps are UTC (timestamptz).
CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE clinic_settings (
  id          smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  settings    jsonb NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE provider (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL,
  discipline    text NOT NULL CHECK (discipline IN ('OT','PT')),
  color         text NOT NULL DEFAULT '#4F7CAC',
  phone_e164    text,
  display_order int  NOT NULL DEFAULT 0,
  active        boolean NOT NULL DEFAULT true
);

-- provider_id NULL = clinic-wide default. weekday: 0=Sun … 6=Sat. Times are clinic-local.
CREATE TABLE availability_rule (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id uuid REFERENCES provider(id) ON DELETE CASCADE,
  weekday     smallint NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  start_time  time NOT NULL,
  end_time    time NOT NULL CHECK (end_time > start_time)
);

-- provider_id NULL = clinic-wide block.
CREATE TABLE time_off (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id uuid REFERENCES provider(id) ON DELETE CASCADE,
  starts_at   timestamptz NOT NULL,
  ends_at     timestamptz NOT NULL CHECK (ends_at > starts_at),
  reason      text,
  is_closure  boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE guardian (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name               text,
  phone_e164         text NOT NULL UNIQUE,
  whatsapp_opt_in_at timestamptz,
  sms_opt_out_at     timestamptz,
  verified_at        timestamptz,
  merged_into_id     uuid REFERENCES guardian(id),
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE patient (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name              text NOT NULL,
  dob                    date,
  created_by_guardian_id uuid REFERENCES guardian(id),
  needs_admin_match      boolean NOT NULL DEFAULT false,
  merged_into_id         uuid REFERENCES patient(id),
  created_at             timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE guardian_patient (
  guardian_id            uuid NOT NULL REFERENCES guardian(id) ON DELETE CASCADE,
  patient_id             uuid NOT NULL REFERENCES patient(id) ON DELETE CASCADE,
  relationship           text,
  can_book               boolean NOT NULL DEFAULT false,
  receives_notifications boolean NOT NULL DEFAULT true,
  restricted             boolean NOT NULL DEFAULT false,
  notes                  text,
  added_by_guardian_id   uuid REFERENCES guardian(id),
  PRIMARY KEY (guardian_id, patient_id)
);

CREATE TABLE recurring_series (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id  uuid NOT NULL REFERENCES patient(id),
  provider_id uuid NOT NULL REFERENCES provider(id),
  visit_type  text NOT NULL,
  rule        text NOT NULL CHECK (rule IN ('WEEKLY','BIWEEKLY')),
  count       int  NOT NULL CHECK (count > 0),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE appointment (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ref                      text NOT NULL UNIQUE,
  patient_id               uuid NOT NULL REFERENCES patient(id),
  provider_id              uuid NOT NULL REFERENCES provider(id),
  provider_assigned_by     text NOT NULL CHECK (provider_assigned_by IN ('SYSTEM','ADMIN')),
  visit_type               text NOT NULL CHECK (visit_type IN ('FOLLOW_UP','EVALUATION')),
  starts_at                timestamptz NOT NULL,
  ends_at                  timestamptz NOT NULL CHECK (ends_at > starts_at),
  status                   text NOT NULL CHECK (status IN (
                             'REQUESTED','ALTERNATE_PROPOSED','CONFIRMED','DECLINED','EXPIRED','CANCELLED',
                             'COMPLETED','NO_SHOW','CANCELLED_BY_PARENT','CANCELLED_BY_CLINIC','RESCHEDULED')),
  requested_by_guardian_id uuid REFERENCES guardian(id),
  expires_at               timestamptz,
  original_starts_at       timestamptz,          -- set when an alternate time is proposed
  series_id                uuid REFERENCES recurring_series(id),
  rescheduled_from_id      uuid REFERENCES appointment(id),
  decline_reason           text,
  cancel_reason            text,
  payment_status           text NOT NULL DEFAULT 'UNPAID'
                             CHECK (payment_status IN ('UNPAID','PAID_CASH','PAID_BANK_TRANSFER','WAIVED')),
  payment_method           text,
  payment_reference        text,
  payment_recorded_by      uuid,
  payment_recorded_at      timestamptz,
  late_cancel              boolean NOT NULL DEFAULT false,
  escalation_sent_at       timestamptz,
  reminder_sent_at         timestamptz,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX appointment_patient_idx ON appointment (patient_id, starts_at);
CREATE INDEX appointment_status_idx  ON appointment (status, starts_at);

-- PRD §11: double-booking is impossible at the database level.
ALTER TABLE appointment ADD CONSTRAINT no_provider_overlap
  EXCLUDE USING gist (provider_id WITH =, tstzrange(starts_at, ends_at, '[)') WITH &&)
  WHERE (status IN ('REQUESTED','ALTERNATE_PROPOSED','CONFIRMED'));

CREATE TABLE evaluation_intake (
  appointment_id   uuid PRIMARY KEY REFERENCES appointment(id) ON DELETE CASCADE,
  reason_text      text NOT NULL CHECK (char_length(reason_text) <= 500),
  reason_tags      text[] NOT NULL DEFAULT '{}',
  payer_type       text NOT NULL CHECK (payer_type IN ('INSURANCE','SELF_PAY')),
  insurer          text,
  member_no        text,
  has_referral     boolean NOT NULL DEFAULT false,
  referral_file_key text
);

CREATE TABLE payment_proof (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  appointment_id uuid NOT NULL REFERENCES appointment(id),
  guardian_id    uuid REFERENCES guardian(id),
  text           text,
  file_key       text,
  received_at    timestamptz NOT NULL DEFAULT now(),
  reviewed_by    uuid,
  reviewed_at    timestamptz
);

CREATE TABLE consent (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  guardian_id uuid NOT NULL REFERENCES guardian(id),
  patient_id  uuid REFERENCES patient(id),
  type        text NOT NULL CHECK (type IN ('DATA_PROCESSING','MESSAGING')),
  version     text NOT NULL,
  granted_at  timestamptz NOT NULL DEFAULT now(),
  withdrawn_at timestamptz
);

CREATE TABLE waitlist_entry (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id  uuid NOT NULL REFERENCES patient(id),
  guardian_id uuid NOT NULL REFERENCES guardian(id),
  visit_type  text NOT NULL,
  date_from   date NOT NULL,
  date_to     date NOT NULL,
  "window"    text NOT NULL DEFAULT 'ANY' CHECK ("window" IN ('ANY','MORNING','AFTERNOON')),
  status      text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','OFFERED','FULFILLED','REMOVED')),
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- One offer per freed slot; first claim wins (claimed_at set atomically).
CREATE TABLE waitlist_offer (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id  uuid NOT NULL REFERENCES provider(id),
  visit_type   text NOT NULL,
  starts_at    timestamptz NOT NULL,
  ends_at      timestamptz NOT NULL,
  entry_ids    uuid[] NOT NULL,
  claimed_by_entry_id uuid REFERENCES waitlist_entry(id),
  claimed_at   timestamptz,
  appointment_id uuid REFERENCES appointment(id),
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE rebook_entry (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id     uuid NOT NULL REFERENCES patient(id),
  appointment_id uuid NOT NULL REFERENCES appointment(id),
  reason         text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  resolved_at    timestamptz
);

CREATE TABLE message (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  guardian_id         uuid REFERENCES guardian(id),
  staff_user_id       uuid,
  provider_id         uuid REFERENCES provider(id),
  appointment_id      uuid REFERENCES appointment(id),
  template_key        text,
  channel             text NOT NULL CHECK (channel IN ('WHATSAPP','SMS')),
  to_phone            text,
  provider_message_id text,
  status              text NOT NULL,   -- QUEUED | SENT | DELIVERED | READ | FAILED | RECEIVED | SKIPPED
  error               text,
  direction           text NOT NULL CHECK (direction IN ('OUT','IN')),
  body                text,
  buttons             jsonb,
  fallback_of_id      uuid REFERENCES message(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX message_provider_msg_idx ON message (provider_message_id);
CREATE INDEX message_appt_idx ON message (appointment_id);

CREATE TABLE otp_code (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone      text NOT NULL,
  code_hash  text NOT NULL,
  expires_at timestamptz NOT NULL,
  attempts   int NOT NULL DEFAULT 0,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX otp_phone_idx ON otp_code (phone, created_at);

CREATE TABLE staff_user (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL UNIQUE,
  role          text NOT NULL CHECK (role IN ('ADMIN','PROVIDER')),
  provider_id   uuid REFERENCES provider(id),
  password_hash text NOT NULL,
  totp_secret   text
);

CREATE TABLE session (
  token_hash    text PRIMARY KEY,
  guardian_id   uuid REFERENCES guardian(id) ON DELETE CASCADE,
  staff_user_id uuid REFERENCES staff_user(id) ON DELETE CASCADE,
  expires_at    timestamptz NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK ((guardian_id IS NULL) <> (staff_user_id IS NULL))
);

CREATE TABLE audit_log (
  id         bigserial PRIMARY KEY,
  actor_type text NOT NULL,   -- GUARDIAN | STAFF | SYSTEM
  actor_id   uuid,
  action     text NOT NULL,
  entity     text NOT NULL,
  entity_id  text,
  before     jsonb,
  after      jsonb,
  at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_entity_idx ON audit_log (entity, entity_id);

CREATE TABLE schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());
