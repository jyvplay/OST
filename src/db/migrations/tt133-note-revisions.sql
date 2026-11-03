-- Data-preserving upgrade from the published pre-TT133 notes schema.
-- Apply ONCE before starting TT133+ application code against an older DB:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f src/db/migrations/tt133-note-revisions.sql
-- Idempotent on the published upgraded schema. No DROP, reset, reseed or rewrite
-- of user fields. PostgreSQL 16's constant default supplies revision 1 to old rows.
-- This does NOT create an incarnation token across backup restores/ID reuse.
BEGIN;
SET LOCAL lock_timeout = '4s';
SET LOCAL statement_timeout = '15s';
ALTER TABLE public.notes ADD COLUMN IF NOT EXISTS revision integer NOT NULL DEFAULT 1;
COMMIT;
