-- Nexus Community Wishlist: remove direct client access to request rows.
-- IMPORTANT: apply only AFTER the updated API is deployed to Production.
-- Apply 20261018_hide_syllabus_request_owner_ids.sql first and verify Preview.
-- The API then uses restricted RPCs for public listing, ownership, creation, and owner deletion.
-- The server-side API uses SUPABASE_SERVICE_ROLE_KEY only for administrator sync/delete.

BEGIN;

DO $nexus$
BEGIN
  IF to_regclass('public.nexus_syllabus_requests') IS NULL THEN
    RAISE EXCEPTION 'Nexus request table is missing; no changes applied.';
  END IF;
  IF to_regprocedure('public.get_nexus_syllabus_requests()') IS NULL
     OR to_regprocedure('public.has_my_active_nexus_syllabus_request()') IS NULL
     OR to_regprocedure('public.create_nexus_syllabus_request(text,text,text)') IS NULL
     OR to_regprocedure('public.delete_my_nexus_syllabus_request(uuid)') IS NULL THEN
    RAISE EXCEPTION 'Owner-safe request RPCs are missing; apply 20261018_hide_syllabus_request_owner_ids.sql first.';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = to_regclass('public.nexus_syllabus_requests')) THEN
    RAISE EXCEPTION 'RLS must be enabled on the Nexus request table before revoking direct access.';
  END IF;
END;
$nexus$;

REVOKE ALL PRIVILEGES ON TABLE public.nexus_syllabus_requests FROM PUBLIC, anon, authenticated;

DO $verify$
BEGIN
  IF has_table_privilege('anon', 'public.nexus_syllabus_requests', 'SELECT')
     OR has_table_privilege('authenticated', 'public.nexus_syllabus_requests', 'SELECT')
     OR has_table_privilege('anon', 'public.nexus_syllabus_requests', 'INSERT')
     OR has_table_privilege('authenticated', 'public.nexus_syllabus_requests', 'INSERT')
     OR has_table_privilege('anon', 'public.nexus_syllabus_requests', 'DELETE')
     OR has_table_privilege('authenticated', 'public.nexus_syllabus_requests', 'DELETE') THEN
    RAISE EXCEPTION 'Unexpected direct request-table privileges remain; transaction aborted.';
  END IF;
END;
$verify$;

COMMIT;

-- Verification: this query should return no rows for anon/authenticated privileges.
SELECT grantee, table_name, privilege_type
FROM information_schema.role_table_grants
WHERE table_schema = 'public'
  AND table_name = 'nexus_syllabus_requests'
  AND grantee IN ('anon', 'authenticated', 'PUBLIC')
ORDER BY grantee, privilege_type;
