-- Run ONLY against the disposable local Phase 3.4 Supabase project after the test.
-- Restore the private global control to its safe default before deleting the
-- disposable accounts. This file must never be run against a hosted project.
UPDATE nexus_private.entity_delta_rollout_control
   SET enabled = false,
       reason = 'DLA-07 local browser fixture cleanup; default disabled',
       updated_at = clock_timestamp()
 WHERE rollout_key = 'global';

-- This prefix is reserved exclusively for disposable Phase 3.4 two-client fixtures.
-- auth.users deletion cascades through workspace snapshots, chunks, sync-state,
-- operation rows and receipts. Never broaden this predicate.
DELETE FROM auth.users
WHERE email LIKE 'nexus-3-4-two-client-%@example.invalid'
RETURNING id, email;
