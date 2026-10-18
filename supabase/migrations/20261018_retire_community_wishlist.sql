-- Retire the in-app Community Wishlist after the new application version is live.
-- IMPORTANT: run ONLY after the Google-Forms-based app is deployed to Production and
-- /api/syllabus-requests is no longer part of the deployed application.
-- This preserves existing request/vote rows as an archive; it does not delete them.
-- It revokes access from normal client roles and removes the old community RLS policies.

BEGIN;

DO $retire$
BEGIN
  IF to_regclass('public.nexus_syllabus_requests') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL PRIVILEGES ON TABLE public.nexus_syllabus_requests FROM PUBLIC, anon, authenticated';
    EXECUTE 'DROP POLICY IF EXISTS "Anyone can read syllabus requests" ON public.nexus_syllabus_requests';
    EXECUTE 'DROP POLICY IF EXISTS "Signed-in users can create syllabus requests" ON public.nexus_syllabus_requests';
    EXECUTE 'DROP POLICY IF EXISTS "Owners can delete their own syllabus requests" ON public.nexus_syllabus_requests';

    IF has_table_privilege('anon', 'public.nexus_syllabus_requests', 'SELECT')
       OR has_table_privilege('authenticated', 'public.nexus_syllabus_requests', 'SELECT')
       OR has_table_privilege('anon', 'public.nexus_syllabus_requests', 'INSERT')
       OR has_table_privilege('authenticated', 'public.nexus_syllabus_requests', 'INSERT')
       OR has_table_privilege('anon', 'public.nexus_syllabus_requests', 'DELETE')
       OR has_table_privilege('authenticated', 'public.nexus_syllabus_requests', 'DELETE') THEN
      RAISE EXCEPTION 'Unexpected client privileges remain on nexus_syllabus_requests; transaction aborted.';
    END IF;
  END IF;

  IF to_regclass('public.nexus_syllabus_votes') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL PRIVILEGES ON TABLE public.nexus_syllabus_votes FROM PUBLIC, anon, authenticated';
    EXECUTE 'DROP POLICY IF EXISTS "Anyone can read syllabus votes" ON public.nexus_syllabus_votes';
    EXECUTE 'DROP POLICY IF EXISTS "Signed-in users can upvote as themselves" ON public.nexus_syllabus_votes';
    EXECUTE 'DROP POLICY IF EXISTS "Users can remove their own upvotes" ON public.nexus_syllabus_votes';

    IF has_table_privilege('anon', 'public.nexus_syllabus_votes', 'SELECT')
       OR has_table_privilege('authenticated', 'public.nexus_syllabus_votes', 'SELECT')
       OR has_table_privilege('anon', 'public.nexus_syllabus_votes', 'INSERT')
       OR has_table_privilege('authenticated', 'public.nexus_syllabus_votes', 'INSERT')
       OR has_table_privilege('anon', 'public.nexus_syllabus_votes', 'DELETE')
       OR has_table_privilege('authenticated', 'public.nexus_syllabus_votes', 'DELETE') THEN
      RAISE EXCEPTION 'Unexpected client privileges remain on nexus_syllabus_votes; transaction aborted.';
    END IF;
  END IF;

  -- Also disable any earlier privacy-RPC functions if they were ever installed.
  IF to_regprocedure('public.get_nexus_syllabus_vote_counts()') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON FUNCTION public.get_nexus_syllabus_vote_counts() FROM PUBLIC, anon, authenticated';
  END IF;
  IF to_regprocedure('public.get_my_nexus_syllabus_votes()') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON FUNCTION public.get_my_nexus_syllabus_votes() FROM PUBLIC, anon, authenticated';
  END IF;
  IF to_regprocedure('public.set_nexus_syllabus_vote(uuid,boolean)') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON FUNCTION public.set_nexus_syllabus_vote(uuid,boolean) FROM PUBLIC, anon, authenticated';
  END IF;
  IF to_regprocedure('public.get_nexus_syllabus_requests()') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON FUNCTION public.get_nexus_syllabus_requests() FROM PUBLIC, anon, authenticated';
  END IF;
  IF to_regprocedure('public.has_my_active_nexus_syllabus_request()') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON FUNCTION public.has_my_active_nexus_syllabus_request() FROM PUBLIC, anon, authenticated';
  END IF;
  IF to_regprocedure('public.create_nexus_syllabus_request(text,text,text)') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON FUNCTION public.create_nexus_syllabus_request(text,text,text) FROM PUBLIC, anon, authenticated';
  END IF;
  IF to_regprocedure('public.delete_my_nexus_syllabus_request(uuid)') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON FUNCTION public.delete_my_nexus_syllabus_request(uuid) FROM PUBLIC, anon, authenticated';
  END IF;
END;
$retire$;

COMMIT;
