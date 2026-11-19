-- Restored from the SQL statements recorded in production migration history.
-- Keep this file aligned with version 20261012033747; do not apply it manually
-- to production or alter remote migration history as part of this repair.

REVOKE EXECUTE ON FUNCTION public.rls_auto_enable() FROM PUBLIC, anon, authenticated;
REVOKE TRUNCATE, TRIGGER, REFERENCES ON TABLE public.nexus_user_data FROM authenticated;
