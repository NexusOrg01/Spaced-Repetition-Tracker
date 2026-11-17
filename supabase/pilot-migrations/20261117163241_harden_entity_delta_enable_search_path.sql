BEGIN;

-- The hosted staging DLA-02 function was deployed with a non-empty search_path
-- despite the reviewed pilot migration requiring an empty SECURITY DEFINER path.
-- Pin it explicitly before any hosted QA or production activation.
ALTER FUNCTION public.nexus_enable_entity_delta(timestamptz)
  SET search_path = '';

COMMENT ON FUNCTION public.nexus_enable_entity_delta(timestamptz) IS
  'DLA-02 owner-scoped Delta enablement. Requires auth.uid() and an enabled private allowlist row; validates the exact owner snapshot and chunk manifest before changing mode. Uses an empty SECURITY DEFINER search_path.';

COMMIT;
