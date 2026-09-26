-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "visit_type" AS ENUM ('FOLLOW_UP', 'EVALUATION');

-- CreateEnum
CREATE TYPE "appointment_status" AS ENUM ('REQUESTED', 'ALTERNATE_PROPOSED', 'CONFIRMED', 'DECLINED', 'EXPIRED', 'CANCELLED', 'COMPLETED', 'NO_SHOW', 'CANCELLED_BY_PARENT', 'CANCELLED_BY_CLINIC', 'RESCHEDULED');

-- CreateEnum
CREATE TYPE "payment_status" AS ENUM ('UNPAID', 'PAID_CASH', 'PAID_BANK_TRANSFER', 'WAIVED');

-- CreateEnum
CREATE TYPE "payment_method" AS ENUM ('CASH', 'BANK_TRANSFER');

-- CreateEnum
CREATE TYPE "role" AS ENUM ('ADMIN', 'PROVIDER');

-- CreateEnum
CREATE TYPE "discipline" AS ENUM ('OT', 'PT');

-- CreateEnum
CREATE TYPE "assigned_by" AS ENUM ('SYSTEM', 'ADMIN');

-- CreateEnum
CREATE TYPE "channel" AS ENUM ('WHATSAPP', 'SMS');

-- CreateEnum
CREATE TYPE "message_status" AS ENUM ('PENDING', 'SENDING', 'SENT', 'DELIVERED', 'READ', 'FAILED', 'RECEIVED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "direction" AS ENUM ('OUT', 'IN');

-- CreateEnum
CREATE TYPE "payer_type" AS ENUM ('INSURANCE', 'SELF_PAY');

-- CreateEnum
CREATE TYPE "consent_type" AS ENUM ('DATA_PROCESSING', 'MESSAGING');

-- CreateEnum
CREATE TYPE "waitlist_status" AS ENUM ('ACTIVE', 'FULFILLED', 'REMOVED');

-- CreateEnum
CREATE TYPE "waitlist_window" AS ENUM ('ANY', 'MORNING', 'AFTERNOON');

-- CreateEnum
CREATE TYPE "series_rule" AS ENUM ('WEEKLY', 'BIWEEKLY');

-- CreateTable
CREATE TABLE "clinic_settings" (
    "id" SMALLINT NOT NULL DEFAULT 1,
    "settings" JSONB NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "clinic_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "provider" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "discipline" "discipline" NOT NULL,
    "color" TEXT NOT NULL,
    "phone_e164" TEXT,
    "display_order" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "provider_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "availability_rule" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "provider_id" UUID,
    "weekday" SMALLINT NOT NULL,
    "start_time" TIME(0) NOT NULL,
    "end_time" TIME(0) NOT NULL,

    CONSTRAINT "availability_rule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "time_off" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "provider_id" UUID,
    "starts_at" TIMESTAMPTZ(6) NOT NULL,
    "ends_at" TIMESTAMPTZ(6) NOT NULL,
    "reason" TEXT,
    "is_closure" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "time_off_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "guardian" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT,
    "phone_e164" TEXT NOT NULL,
    "whatsapp_opt_in_at" TIMESTAMPTZ(6),
    "sms_opt_out_at" TIMESTAMPTZ(6),
    "verified_at" TIMESTAMPTZ(6),
    "sessions_valid_after" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "merged_into_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "guardian_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "patient" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "full_name" TEXT NOT NULL,
    "dob" DATE,
    "created_by_guardian_id" UUID,
    "needs_admin_match" BOOLEAN NOT NULL DEFAULT false,
    "merged_into_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "patient_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "guardian_patient" (
    "guardian_id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "relationship" TEXT,
    "can_book" BOOLEAN NOT NULL DEFAULT false,
    "receives_notifications" BOOLEAN NOT NULL DEFAULT true,
    "restricted" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT,
    "added_by_guardian_id" UUID,

    CONSTRAINT "guardian_patient_pkey" PRIMARY KEY ("guardian_id","patient_id")
);

-- CreateTable
CREATE TABLE "recurring_series" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "patient_id" UUID NOT NULL,
    "provider_id" UUID NOT NULL,
    "visit_type" "visit_type" NOT NULL,
    "rule" "series_rule" NOT NULL,
    "count" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "recurring_series_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "appointment" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "ref" TEXT NOT NULL,
    "patient_id" UUID NOT NULL,
    "provider_id" UUID NOT NULL,
    "provider_assigned_by" "assigned_by" NOT NULL,
    "visit_type" "visit_type" NOT NULL,
    "starts_at" TIMESTAMPTZ(6) NOT NULL,
    "ends_at" TIMESTAMPTZ(6) NOT NULL,
    "status" "appointment_status" NOT NULL,
    "requested_by_guardian_id" UUID,
    "expires_at" TIMESTAMPTZ(6),
    "original_starts_at" TIMESTAMPTZ(6),
    "series_id" UUID,
    "rescheduled_from_id" UUID,
    "decline_reason" TEXT,
    "cancel_reason" TEXT,
    "payment_status" "payment_status" NOT NULL DEFAULT 'UNPAID',
    "payment_method" "payment_method",
    "payment_reference" TEXT,
    "payment_recorded_by" UUID,
    "payment_recorded_at" TIMESTAMPTZ(6),
    "late_cancel" BOOLEAN NOT NULL DEFAULT false,
    "escalation_sent_at" TIMESTAMPTZ(6),
    "reminder_sent_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "appointment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "evaluation_intake" (
    "appointment_id" UUID NOT NULL,
    "reason_text" VARCHAR(500) NOT NULL,
    "reason_tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "payer_type" "payer_type" NOT NULL,
    "insurer" TEXT,
    "member_no" TEXT,
    "has_referral" BOOLEAN NOT NULL DEFAULT false,
    "referral_file_key" TEXT,

    CONSTRAINT "evaluation_intake_pkey" PRIMARY KEY ("appointment_id")
);

-- CreateTable
CREATE TABLE "payment_proof" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "appointment_id" UUID NOT NULL,
    "guardian_id" UUID,
    "text" TEXT,
    "file_key" TEXT,
    "received_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewed_by" UUID,
    "reviewed_at" TIMESTAMPTZ(6),

    CONSTRAINT "payment_proof_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "consent" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "guardian_id" UUID NOT NULL,
    "patient_id" UUID,
    "type" "consent_type" NOT NULL,
    "version" TEXT NOT NULL,
    "granted_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "withdrawn_at" TIMESTAMPTZ(6),

    CONSTRAINT "consent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "waitlist_entry" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "patient_id" UUID NOT NULL,
    "guardian_id" UUID NOT NULL,
    "visit_type" "visit_type" NOT NULL,
    "date_from" DATE NOT NULL,
    "date_to" DATE NOT NULL,
    "window" "waitlist_window" NOT NULL DEFAULT 'ANY',
    "status" "waitlist_status" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "waitlist_entry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "waitlist_offer" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "provider_id" UUID NOT NULL,
    "visit_type" "visit_type" NOT NULL,
    "starts_at" TIMESTAMPTZ(6) NOT NULL,
    "ends_at" TIMESTAMPTZ(6) NOT NULL,
    "entry_ids" UUID[],
    "claimed_by_entry_id" UUID,
    "claimed_at" TIMESTAMPTZ(6),
    "appointment_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "waitlist_offer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rebook_entry" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "patient_id" UUID NOT NULL,
    "appointment_id" UUID NOT NULL,
    "reason" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMPTZ(6),

    CONSTRAINT "rebook_entry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "message" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "guardian_id" UUID,
    "provider_id" UUID,
    "appointment_id" UUID,
    "template_key" TEXT,
    "channel" "channel",
    "sms_only" BOOLEAN NOT NULL DEFAULT false,
    "to_phone" TEXT,
    "provider_message_id" TEXT,
    "status" "message_status" NOT NULL,
    "error" TEXT,
    "direction" "direction" NOT NULL,
    "body" TEXT,
    "vars" JSONB,
    "buttons" JSONB,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMPTZ(6),
    "fallback_of_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "otp_code" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "phone" TEXT NOT NULL,
    "code_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "consumed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "otp_code_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "staff_user" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "email" TEXT NOT NULL,
    "role" "role" NOT NULL,
    "provider_id" UUID,
    "password_hash" TEXT NOT NULL,
    "totp_secret" TEXT,
    "sessions_valid_after" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "staff_user_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_log" (
    "id" BIGSERIAL NOT NULL,
    "actor_type" TEXT NOT NULL,
    "actor_id" UUID,
    "action" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "entity_id" TEXT,
    "before" JSONB,
    "after" JSONB,
    "at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "time_off_starts_at_ends_at_idx" ON "time_off"("starts_at", "ends_at");

-- CreateIndex
CREATE UNIQUE INDEX "guardian_phone_e164_key" ON "guardian"("phone_e164");

-- CreateIndex
CREATE UNIQUE INDEX "appointment_ref_key" ON "appointment"("ref");

-- CreateIndex
CREATE INDEX "appointment_patient_id_starts_at_idx" ON "appointment"("patient_id", "starts_at");

-- CreateIndex
CREATE INDEX "appointment_status_starts_at_idx" ON "appointment"("status", "starts_at");

-- CreateIndex
CREATE INDEX "message_status_next_attempt_at_idx" ON "message"("status", "next_attempt_at");

-- CreateIndex
CREATE INDEX "message_provider_message_id_idx" ON "message"("provider_message_id");

-- CreateIndex
CREATE INDEX "message_appointment_id_idx" ON "message"("appointment_id");

-- CreateIndex
CREATE INDEX "otp_code_phone_created_at_idx" ON "otp_code"("phone", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "staff_user_email_key" ON "staff_user"("email");

-- CreateIndex
CREATE INDEX "audit_log_entity_entity_id_idx" ON "audit_log"("entity", "entity_id");

-- AddForeignKey
ALTER TABLE "availability_rule" ADD CONSTRAINT "availability_rule_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "provider"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "time_off" ADD CONSTRAINT "time_off_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "provider"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "patient" ADD CONSTRAINT "patient_created_by_guardian_id_fkey" FOREIGN KEY ("created_by_guardian_id") REFERENCES "guardian"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "guardian_patient" ADD CONSTRAINT "guardian_patient_guardian_id_fkey" FOREIGN KEY ("guardian_id") REFERENCES "guardian"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "guardian_patient" ADD CONSTRAINT "guardian_patient_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "guardian_patient" ADD CONSTRAINT "guardian_patient_added_by_guardian_id_fkey" FOREIGN KEY ("added_by_guardian_id") REFERENCES "guardian"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recurring_series" ADD CONSTRAINT "recurring_series_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recurring_series" ADD CONSTRAINT "recurring_series_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "provider"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointment" ADD CONSTRAINT "appointment_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointment" ADD CONSTRAINT "appointment_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "provider"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointment" ADD CONSTRAINT "appointment_requested_by_guardian_id_fkey" FOREIGN KEY ("requested_by_guardian_id") REFERENCES "guardian"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointment" ADD CONSTRAINT "appointment_series_id_fkey" FOREIGN KEY ("series_id") REFERENCES "recurring_series"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointment" ADD CONSTRAINT "appointment_rescheduled_from_id_fkey" FOREIGN KEY ("rescheduled_from_id") REFERENCES "appointment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "evaluation_intake" ADD CONSTRAINT "evaluation_intake_appointment_id_fkey" FOREIGN KEY ("appointment_id") REFERENCES "appointment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_proof" ADD CONSTRAINT "payment_proof_appointment_id_fkey" FOREIGN KEY ("appointment_id") REFERENCES "appointment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_proof" ADD CONSTRAINT "payment_proof_guardian_id_fkey" FOREIGN KEY ("guardian_id") REFERENCES "guardian"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consent" ADD CONSTRAINT "consent_guardian_id_fkey" FOREIGN KEY ("guardian_id") REFERENCES "guardian"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consent" ADD CONSTRAINT "consent_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patient"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "waitlist_entry" ADD CONSTRAINT "waitlist_entry_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "waitlist_entry" ADD CONSTRAINT "waitlist_entry_guardian_id_fkey" FOREIGN KEY ("guardian_id") REFERENCES "guardian"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "waitlist_offer" ADD CONSTRAINT "waitlist_offer_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "provider"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "waitlist_offer" ADD CONSTRAINT "waitlist_offer_appointment_id_fkey" FOREIGN KEY ("appointment_id") REFERENCES "appointment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rebook_entry" ADD CONSTRAINT "rebook_entry_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rebook_entry" ADD CONSTRAINT "rebook_entry_appointment_id_fkey" FOREIGN KEY ("appointment_id") REFERENCES "appointment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message" ADD CONSTRAINT "message_guardian_id_fkey" FOREIGN KEY ("guardian_id") REFERENCES "guardian"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message" ADD CONSTRAINT "message_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "provider"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message" ADD CONSTRAINT "message_appointment_id_fkey" FOREIGN KEY ("appointment_id") REFERENCES "appointment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_user" ADD CONSTRAINT "staff_user_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "provider"("id") ON DELETE SET NULL ON UPDATE CASCADE;

