-- Disposable local Phase 3.4 baseline only; copied into the generated local project.
-- This is outside supabase/migrations and must never be pushed to a hosted database.
BEGIN;
CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;
CREATE TABLE IF NOT EXISTS public.nexus_user_data (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  payload jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.nexus_user_data ENABLE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE public.nexus_user_data FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.nexus_user_data TO authenticated;
DROP POLICY IF EXISTS "Users can manage own Nexus workspace data" ON public.nexus_user_data;
CREATE POLICY "Users can manage own Nexus workspace data"
  ON public.nexus_user_data FOR ALL TO authenticated
  USING ((SELECT auth.uid()) = user_id)
  WITH CHECK ((SELECT auth.uid()) = user_id);
COMMIT;
