-- Nexus Community Wishlist: least-privilege table grants
-- This script removes direct client access to both community tables. Public request
-- fields, ownership state, vote totals, and personal vote state use restricted RPCs instead.
-- Review before running in Supabase SQL Editor.

BEGIN;

DO $nexus$
BEGIN
  IF to_regclass('public.nexus_syllabus_requests') IS NULL
     OR to_regclass('public.nexus_syllabus_votes') IS NULL THEN
    RAISE EXCEPTION 'Nexus community tables are missing; no privilege changes applied.';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = to_regclass('public.nexus_syllabus_requests'))
     OR NOT (SELECT relrowsecurity FROM pg_class WHERE oid = to_regclass('public.nexus_syllabus_votes')) THEN
    RAISE EXCEPTION 'RLS must be enabled on both Nexus community tables before changing grants.';
  END IF;
  IF to_regprocedure('public.get_nexus_syllabus_vote_counts()') IS NULL
     OR to_regprocedure('public.get_my_nexus_syllabus_votes()') IS NULL
     OR to_regprocedure('public.set_nexus_syllabus_vote(uuid,boolean)') IS NULL
     OR to_regprocedure('public.get_nexus_syllabus_requests()') IS NULL
     OR to_regprocedure('public.has_my_active_nexus_syllabus_request()') IS NULL
     OR to_regprocedure('public.create_nexus_syllabus_request(text,text,text)') IS NULL
     OR to_regprocedure('public.delete_my_nexus_syllabus_request(uuid)') IS NULL THEN
    RAISE EXCEPTION 'Required restricted community RPCs are missing; install the additive privacy migrations before hardening table grants.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='nexus_syllabus_requests' AND cmd IN ('SELECT','ALL'))
     OR NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='nexus_syllabus_requests' AND cmd IN ('INSERT','ALL'))
     OR NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='nexus_syllabus_requests' AND cmd IN ('DELETE','ALL'))
     OR NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='nexus_syllabus_votes' AND cmd IN ('INSERT','ALL'))
     OR NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='nexus_syllabus_votes' AND cmd IN ('DELETE','ALL')) THEN
    RAISE EXCEPTION 'Required request or vote write policies are missing; no privilege changes applied.';
  END IF;
END;
$nexus$;

REVOKE ALL PRIVILEGES ON TABLE public.nexus_syllabus_requests FROM PUBLIC, anon, authenticated;
REVOKE ALL PRIVILEGES ON TABLE public.nexus_syllabus_votes FROM PUBLIC, anon, authenticated;

-- Request and vote operations are routed through restricted RPCs; client roles
-- receive no direct table privileges. Server-side admin operations use service_role.


DO $verify$
BEGIN
  IF has_table_privilege('anon','public.nexus_syllabus_requests','SELECT')
     OR has_table_privilege('anon','public.nexus_syllabus_requests','INSERT')
     OR has_table_privilege('anon','public.nexus_syllabus_requests','UPDATE')
     OR has_table_privilege('anon','public.nexus_syllabus_requests','DELETE')
     OR has_table_privilege('anon','public.nexus_syllabus_requests','TRUNCATE')
     OR has_table_privilege('anon','public.nexus_syllabus_requests','MAINTAIN')
     OR has_table_privilege('anon','public.nexus_syllabus_requests','REFERENCES')
     OR has_table_privilege('anon','public.nexus_syllabus_requests','TRIGGER')
     OR has_table_privilege('anon','public.nexus_syllabus_votes','SELECT')
     OR has_table_privilege('anon','public.nexus_syllabus_votes','INSERT')
     OR has_table_privilege('anon','public.nexus_syllabus_votes','UPDATE')
     OR has_table_privilege('anon','public.nexus_syllabus_votes','DELETE')
     OR has_table_privilege('anon','public.nexus_syllabus_votes','TRUNCATE')
     OR has_table_privilege('anon','public.nexus_syllabus_votes','MAINTAIN')
     OR has_table_privilege('anon','public.nexus_syllabus_votes','REFERENCES')
     OR has_table_privilege('anon','public.nexus_syllabus_votes','TRIGGER') THEN
    RAISE EXCEPTION 'Unexpected anon privileges remain; transaction aborted.';
  END IF;
  IF has_table_privilege('authenticated','public.nexus_syllabus_requests','SELECT')
     OR has_table_privilege('authenticated','public.nexus_syllabus_requests','INSERT')
     OR has_table_privilege('authenticated','public.nexus_syllabus_requests','DELETE')
     OR has_table_privilege('authenticated','public.nexus_syllabus_requests','UPDATE')
     OR has_table_privilege('authenticated','public.nexus_syllabus_requests','TRUNCATE')
     OR has_table_privilege('authenticated','public.nexus_syllabus_requests','MAINTAIN')
     OR has_table_privilege('authenticated','public.nexus_syllabus_requests','REFERENCES')
     OR has_table_privilege('authenticated','public.nexus_syllabus_requests','TRIGGER')
     OR has_table_privilege('authenticated','public.nexus_syllabus_votes','SELECT')
     OR has_table_privilege('authenticated','public.nexus_syllabus_votes','INSERT')
     OR has_table_privilege('authenticated','public.nexus_syllabus_votes','UPDATE')
     OR has_table_privilege('authenticated','public.nexus_syllabus_votes','DELETE')
     OR has_table_privilege('authenticated','public.nexus_syllabus_votes','TRUNCATE')
     OR has_table_privilege('authenticated','public.nexus_syllabus_votes','MAINTAIN')
     OR has_table_privilege('authenticated','public.nexus_syllabus_votes','REFERENCES')
     OR has_table_privilege('authenticated','public.nexus_syllabus_votes','TRIGGER') THEN
    RAISE EXCEPTION 'Unexpected authenticated privileges remain; transaction aborted.';
  END IF;
END;
$verify$;

COMMIT;

SELECT grantee, table_name, privilege_type
FROM information_schema.role_table_grants
WHERE table_schema='public'
  AND table_name IN ('nexus_syllabus_requests','nexus_syllabus_votes')
  AND grantee IN ('anon','authenticated','PUBLIC')
ORDER BY table_name, grantee, privilege_type;
