-- Staff login lockout (5 failures → 15 minutes) and deactivation.
ALTER TABLE staff_user ADD COLUMN failed_logins integer NOT NULL DEFAULT 0;
ALTER TABLE staff_user ADD COLUMN locked_until timestamptz;
ALTER TABLE staff_user ADD COLUMN active boolean NOT NULL DEFAULT true;
