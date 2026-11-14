BEGIN;

-- Keep record keys and JSON payload IDs consistent even if a future authenticated
-- caller bypasses the shared browser-side validator. Metadata roots have canonical IDs.
DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.nexus_workspace_operations'::regclass
      AND conname = 'nexus_workspace_operations_entity_identity_check'
  ) THEN
    ALTER TABLE public.nexus_workspace_operations
      ADD CONSTRAINT nexus_workspace_operations_entity_identity_check
      CHECK (
        (collection = 'trackerMeta' AND entity_id = 'tracker' AND operation = 'put')
        OR (collection = 'featureMeta' AND entity_id = 'features' AND operation = 'put')
        OR (
          collection NOT IN ('trackerMeta', 'featureMeta')
          AND (
            operation = 'delete'
            OR COALESCE(
              jsonb_typeof(value -> 'id') = 'string'
              AND value ->> 'id' = entity_id,
              false
            )
          )
        )
      ) NOT VALID;
  END IF;
END;
$migration$;

ALTER TABLE public.nexus_workspace_operations
  VALIDATE CONSTRAINT nexus_workspace_operations_entity_identity_check;

COMMENT ON CONSTRAINT nexus_workspace_operations_entity_identity_check
  ON public.nexus_workspace_operations
  IS 'Requires every non-metadata put payload ID to match entity_id and keeps metadata roots on their canonical IDs.';

COMMIT;
