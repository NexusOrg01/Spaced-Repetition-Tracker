-- Nexus Community Wishlist: expose request data without exposing owner_id.
-- Additive stage: safe to apply before deploying the API update. Existing table grants
-- remain unchanged until 20261019_revoke_public_syllabus_request_reads.sql is applied.
-- All functions use a fixed search_path and return only fields needed by the application.

BEGIN;

DO $nexus$
BEGIN
  IF to_regclass('public.nexus_syllabus_requests') IS NULL THEN
    RAISE EXCEPTION 'Nexus request table is missing; no changes applied.';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = to_regclass('public.nexus_syllabus_requests')) THEN
    RAISE EXCEPTION 'RLS must be enabled on the Nexus request table before applying this migration.';
  END IF;
END;
$nexus$;

CREATE OR REPLACE FUNCTION public.get_nexus_syllabus_requests()
RETURNS TABLE (
  id uuid,
  name text,
  category text,
  topics text,
  created_at timestamptz,
  is_owner boolean
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT
    request.id,
    request.name,
    request.category,
    request.topics,
    request.created_at,
    (auth.uid() IS NOT NULL AND request.owner_id = auth.uid()) AS is_owner
  FROM public.nexus_syllabus_requests AS request
  ORDER BY request.created_at DESC
  LIMIT 200;
$function$;

CREATE OR REPLACE FUNCTION public.has_my_active_nexus_syllabus_request()
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT auth.uid() IS NOT NULL AND EXISTS (
    SELECT 1
    FROM public.nexus_syllabus_requests AS request
    WHERE request.owner_id = auth.uid()
  );
$function$;

CREATE OR REPLACE FUNCTION public.create_nexus_syllabus_request(
  p_name text,
  p_category text,
  p_topics text
)
RETURNS TABLE (
  id uuid,
  name text,
  category text,
  topics text,
  created_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_user_id uuid := auth.uid();
  v_request public.nexus_syllabus_requests%ROWTYPE;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.nexus_syllabus_requests AS request
    WHERE request.owner_id = v_user_id
  ) THEN
    RAISE EXCEPTION 'ACTIVE_REQUEST_EXISTS' USING ERRCODE = '23505';
  END IF;

  INSERT INTO public.nexus_syllabus_requests (name, category, topics, owner_id)
  VALUES (p_name, p_category, COALESCE(p_topics, ''), v_user_id)
  RETURNING * INTO v_request;

  RETURN QUERY SELECT v_request.id, v_request.name, v_request.category,
                      v_request.topics, v_request.created_at;
END;
$function$;

CREATE OR REPLACE FUNCTION public.delete_my_nexus_syllabus_request(p_request_id uuid)
RETURNS TABLE (deleted boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_deleted boolean;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
  END IF;

  DELETE FROM public.nexus_syllabus_requests AS request
  WHERE request.id = p_request_id
    AND request.owner_id = auth.uid()
  RETURNING true INTO v_deleted;

  RETURN QUERY SELECT COALESCE(v_deleted, false);
END;
$function$;

REVOKE ALL ON FUNCTION public.get_nexus_syllabus_requests() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_nexus_syllabus_requests() TO anon, authenticated;

REVOKE ALL ON FUNCTION public.has_my_active_nexus_syllabus_request() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.has_my_active_nexus_syllabus_request() TO authenticated;

REVOKE ALL ON FUNCTION public.create_nexus_syllabus_request(text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_nexus_syllabus_request(text, text, text) TO authenticated;

REVOKE ALL ON FUNCTION public.delete_my_nexus_syllabus_request(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.delete_my_nexus_syllabus_request(uuid) TO authenticated;

COMMIT;
