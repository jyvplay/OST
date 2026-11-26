-- Apply after tt218-desktop-generation.sql, before TT219 server deployment.
-- Rotates existing preset tokens on every run to invalidate pre-install views.
-- This updates preset rows and locks the table: back up and schedule maintenance.
-- PostgreSQL 13+ is required for gen_random_uuid().
BEGIN;
SET LOCAL lock_timeout = '4s';
SET LOCAL statement_timeout = '60s';
CREATE OR REPLACE FUNCTION public.ost_preset_generation_guard_fn()
RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  -- Cover moving either into or out of the preset namespace as well as an
  -- insert supplying a copied generation. Other desktop rows remain unchanged.
  IF left(NEW.id, 7) = 'preset:' OR (TG_OP = 'UPDATE' AND left(OLD.id, 7) = 'preset:') THEN
    NEW.generation := gen_random_uuid();
  END IF;
  RETURN NEW;
END
$fn$;
DROP TRIGGER IF EXISTS ost_desktop_generation_guard ON public.desktop_state;
CREATE TRIGGER ost_desktop_generation_guard BEFORE INSERT OR UPDATE ON public.desktop_state
FOR EACH ROW EXECUTE FUNCTION public.ost_preset_generation_guard_fn();
-- A pre-install legacy update may have left the old generation unchanged.
-- Invalidating every extant preset closes that deployment-time gap. Re-running
-- preserves content but intentionally invalidates outstanding delete tokens.
UPDATE public.desktop_state SET generation = gen_random_uuid() WHERE left(id, 7) = 'preset:';
COMMIT;
