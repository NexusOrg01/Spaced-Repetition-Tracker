-- Run ONLY against the disposable local Phase 3.4 Supabase project after the test.
-- This prefix is reserved exclusively for disposable Phase 3.4 two-client fixtures.
-- auth.users deletion cascades through workspace snapshots, chunks, sync-state,
-- operation rows and receipts. Never broaden this predicate.
DELETE FROM auth.users
WHERE email LIKE 'nexus-3-4-two-client-%@example.invalid'
RETURNING id, email;
