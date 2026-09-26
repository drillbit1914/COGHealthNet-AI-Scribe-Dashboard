-- sessions_valid_after is a revocation marker: nothing is revoked until logout-everywhere, a restriction or a merge sets it.
ALTER TABLE guardian   ALTER COLUMN sessions_valid_after SET DEFAULT '1970-01-01 00:00:00+00'::timestamptz;
ALTER TABLE staff_user ALTER COLUMN sessions_valid_after SET DEFAULT '1970-01-01 00:00:00+00'::timestamptz;
