-- ARCHIVE ONLY: this migration was applied to the isolated nexus-sync-staging
-- project on 2026-10-24. It is intentionally outside supabase/migrations so it
-- is not picked up by the shared production migration chain.
--
-- Recovered verbatim from supabase_migrations.schema_migrations on staging.
-- The statements align staging's permissions with the already-verified
-- production access contract; retain here for provenance and auditability.

-- Align staging permissions with the already-verified production access contract.
REVOKE EXECUTE ON FUNCTION public.rls_auto_enable() FROM PUBLIC, anon, authenticated;

REVOKE ALL PRIVILEGES ON TABLE public.nexus_user_data FROM anon;
REVOKE DELETE, TRUNCATE, TRIGGER, REFERENCES ON TABLE public.nexus_user_data FROM authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.nexus_user_data TO authenticated;
GRANT ALL PRIVILEGES ON TABLE public.nexus_user_data TO service_role;

-- Restrict every backup policy to signed-in users and use Supabase's
-- initPlan form for auth.uid() to avoid per-row re-evaluation.
ALTER POLICY "Users can read own Nexus backup"
  ON public.nexus_user_data TO authenticated
  USING ((select auth.uid()));

ALTER POLICY "Users can insert own Nexus backup"
  ON public.nexus_user_data TO authenticated
  WITH CHECK ((select auth.uid()) = user_id);

ALTER POLICY "Users can update own Nexus backup"
  ON public.nexus_user_data TO authenticated
  USING ((select auth.uid()) = user_id)
  WITH CHECK ((select auth.uid()) = user_id);
