-- Align backup-table privileges and row policies with the verified access contract.
-- This migration was first applied to the staging project and then verified.
-- It is safe to run against production because it converges to the production
-- access contract: authenticated users can read/insert/update only their own row,
-- anonymous users have no table/function access, and service_role retains admin
-- privileges. The RLS event trigger itself remains enabled.

REVOKE EXECUTE ON FUNCTION public.rls_auto_enable() FROM PUBLIC, anon, authenticated;

REVOKE ALL PRIVILEGES ON TABLE public.nexus_user_data FROM anon;
REVOKE DELETE, TRUNCATE, TRIGGER, REFERENCES ON TABLE public.nexus_user_data FROM authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.nexus_user_data TO authenticated;
GRANT ALL PRIVILEGES ON TABLE public.nexus_user_data TO service_role;

ALTER POLICY "Users can read own Nexus backup"
  ON public.nexus_user_data TO authenticated
  USING ((select auth.uid()) = user_id);

ALTER POLICY "Users can insert own Nexus backup"
  ON public.nexus_user_data TO authenticated
  WITH CHECK ((select auth.uid()) = user_id);

ALTER POLICY "Users can update own Nexus backup"
  ON public.nexus_user_data TO authenticated
  USING ((select auth.uid()) = user_id)
  WITH CHECK ((select auth.uid()) = user_id);
