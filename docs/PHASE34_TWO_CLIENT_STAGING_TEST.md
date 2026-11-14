# Phase 3.4 authenticated two-client staging test

This is an operator-run integration test for the isolated Supabase project **nexus-sync-staging** only. It uses real Supabase Auth password sessions and the staging REST/RPC endpoints. It does not use service-role credentials, touch production, or turn on the application's normal entity-delta feature gate.

## Safety boundary

- Confirm the target project is **nexus-sync-staging** (**xuwfzibxhxzxxupprxsq**), never **nexus-spaced-repetition**.
- Keep PR #126 on **android/capacitor-multistore-foundation**.
- The web harness is **staging-test/two-client.html**. It blocks the production Nexus hostname and all non-preview origins, uses only the hard-coded staging Supabase project, requires two reserved **@example.invalid** disposable accounts, and keeps credentials in form memory only.
- Do not set **NEXUS_ENTITY_DELTA_SYNC_STAGING** in Vercel or Netlify. The normal app gate stays false.
- The SQL GRANT below is temporary and global to the **authenticated** database role on staging. Run it immediately before the test, keep the window short, and run the REVOKE immediately after the test (including after a failed run). No migration adds these grants.

## 1. Create disposable accounts

Run **supabase/tests/nexus_entity_delta_two_client_setup.sql** once in the staging SQL editor. It creates two confirmed email/password users, their matching `auth.identities` email-provider rows, empty version-4 compatibility snapshots, and outputs the two emails/passwords. Use only those credentials in the preview harness. The reserved prefix is **nexus-3-4-two-client-**.

Do not use personal accounts, real email addresses, or an existing staging account.

## 2. Temporarily expose the RPCs to authenticated test sessions

Run this SQL against staging immediately before the browser test:

~~~sql
GRANT EXECUTE ON FUNCTION public.nexus_get_entity_sync_state() TO authenticated;
GRANT EXECUTE ON FUNCTION public.nexus_enable_entity_delta(timestamptz) TO authenticated;
GRANT EXECUTE ON FUNCTION public.nexus_publish_entity_operation(text,bigint,jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.nexus_read_entity_operations(bigint,integer,integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.nexus_publish_entity_snapshot(bigint,timestamptz,jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.nexus_compact_entity_operations(integer) TO authenticated;
~~~

The test itself uses only state-read, enable, publish and bounded-read RPCs. Snapshot publication and compaction are granted only to mirror the full six-function rollout permission set already reviewed in the rollback-only authenticated SQL probe; do not call them from this harness.

## 3. Run the authenticated test on a PR preview

Open the PR preview and navigate to **/staging-test/two-client.html**. Enter both disposable credentials and run the test.

The harness establishes three independent Auth sessions:
- Client A1 and Client A2 sign into the same disposable account from separate sessions (two-device concurrency).
- Client B signs into a different disposable account (owner isolation).

Assertions include:
- both users start in snapshot mode and are independently enabled;
- A and B publish without crossing account state;
- two same-account publishers racing at one expected revision produce exactly one commit and one revision_conflict;
- the losing operation retries at the next revision, and an identical retry replays its original receipt;
- reusing an operation ID with a different request hash is rejected;
- bounded readers see only each owner's contiguous operation groups;
- owner-filtered table reads cannot reveal the other user's rows;
- authenticated clients cannot write directly to the immutable operation table;
- final heads are A=3 and B=1.

A pass here proves authenticated PostgREST/RPC behavior and server-side two-client concurrency for disposable accounts. It does not by itself prove the production app's IndexedDB journal, UI reconciliation, device persistence, Android WebView, or physical two-device performance. Those remain separate gates.

## 4. Revoke RPC access immediately

Run this against staging as soon as the harness completes, whether it passed or failed:

~~~sql
REVOKE EXECUTE ON FUNCTION public.nexus_get_entity_sync_state() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.nexus_enable_entity_delta(timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.nexus_publish_entity_operation(text,bigint,jsonb) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.nexus_read_entity_operations(bigint,integer,integer) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.nexus_publish_entity_snapshot(bigint,timestamptz,jsonb) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.nexus_compact_entity_operations(integer) FROM PUBLIC, anon, authenticated;
~~~

Then verify all six signatures have **has_function_privilege(..., 'authenticated', 'EXECUTE') = false**, and that pre-existing accounts remain in **snapshot** mode.

## 5. Delete disposable accounts and verify cleanup

Run **supabase/tests/nexus_entity_delta_two_client_cleanup.sql**. The reserved-prefix filter is intentionally narrow; deleting each Auth user cascades to their workspace snapshots, chunks, sync state, operation rows and receipts.

Finally verify:
- no **nexus-3-4-two-client-%@example.invalid** user remains;
- no delta-mode account remains;
- no operation or receipt row remains for either deleted test owner;
- all six RPCs are non-executable by **PUBLIC**, **anon**, and **authenticated**;
- pre-existing workspace and chunk counts return to their pre-test values.

Do not mark this gate complete unless both the authenticated browser run and post-cleanup verification are recorded in docs/entity-delta-sync-status.md.
