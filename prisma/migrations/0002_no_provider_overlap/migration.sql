-- PRD §11: double-booking is impossible at the database level.
-- Prisma cannot express exclusion constraints, so this migration is hand-written.
CREATE EXTENSION IF NOT EXISTS btree_gist;

ALTER TABLE appointment ADD CONSTRAINT no_provider_overlap
  EXCLUDE USING gist (provider_id WITH =, tstzrange(starts_at, ends_at, '[)') WITH &&)
  WHERE (status IN ('REQUESTED','ALTERNATE_PROPOSED','CONFIRMED'));

-- Integrity checks Prisma cannot express.
ALTER TABLE appointment       ADD CONSTRAINT appointment_time_order CHECK (ends_at > starts_at);
ALTER TABLE time_off          ADD CONSTRAINT time_off_time_order    CHECK (ends_at > starts_at);
ALTER TABLE availability_rule ADD CONSTRAINT availability_rule_order CHECK (end_time > start_time);
ALTER TABLE availability_rule ADD CONSTRAINT availability_rule_weekday CHECK (weekday BETWEEN 0 AND 6);
ALTER TABLE clinic_settings   ADD CONSTRAINT clinic_settings_single_row CHECK (id = 1);
ALTER TABLE waitlist_entry    ADD CONSTRAINT waitlist_range CHECK (date_to >= date_from);
