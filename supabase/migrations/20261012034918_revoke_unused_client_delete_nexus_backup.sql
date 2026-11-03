-- Restored from the SQL statements recorded in production migration history.
-- Keep this file aligned with version 20261012034918; do not apply it manually
-- to production or alter remote migration history as part of this repair.

REVOKE DELETE ON TABLE public.nexus_user_data FROM authenticated;
