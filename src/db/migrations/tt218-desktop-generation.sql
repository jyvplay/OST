-- Run before deploying TT218 application code. PostgreSQL 13+ supplies
-- gen_random_uuid(). Adding a volatile default can rewrite the table; schedule
-- downtime and back up first. Existing desktop and preset contents are kept.
BEGIN;
SET LOCAL lock_timeout = '4s';
SET LOCAL statement_timeout = '60s';
ALTER TABLE public.desktop_state ADD COLUMN IF NOT EXISTS generation uuid NOT NULL DEFAULT gen_random_uuid();
COMMIT;
