# Supabase migration reconciliation

**Revalidated:** 2026-11-16  
**Repository branch:** `android/capacitor-multistore-foundation`  
**Hosted staging project:** `nexus-sync-staging` (`xuwfzibxhxzxxupprxsq`)  
**Production project:** `nexus-spaced-repetition` (`txugbdavblpettcnhcxl`) — read-only inspected 2026-11-16; no production schema, data, migration, Auth setting, or deployment was changed

This record compares the timestamped migration files on PR #126 with the hosted staging migration history and live schema. Integration tests use a separate disposable local Supabase instance. Hosted staging is not used for disposable fixtures.

## Result

The shared Phase 3.4 migration chain through `20261115171500_validate_general_snapshot_candidates.sql` is now present in hosted staging. The migration `20261115171500` was applied to **nexus-sync-staging only** on 2026-11-16. The Supabase migration ledger was guardedly reconciled to the exact source version and filename stem after the migration tool reported a transient server timestamp; the SQL was not reapplied during that ledger correction.

The new migration installs server-side validation for general chunked snapshot candidates on first insert and later updates. It validates manifest shape, chunk-count/index continuity, chunk-count consistency and byte totals, and serializes candidate publication against stale-chunk cleanup. Live read-only checks confirm the validator trigger exists exactly once on `public.nexus_user_data`. The existing active-manifest deletion guard exists exactly once on `public.nexus_user_data_chunks`.

The candidate validator and active-chunk deletion guard are in the private `nexus_private` schema. Both functions are SECURITY DEFINER with an empty `search_path`. The `anon` and `authenticated` roles have no schema USAGE and no EXECUTE privilege on either guard function.

The successful disposable local Phase 3.4 workflow independently applies the committed migrations to a fresh local database and runs candidate-integrity/fallback, active-manifest race, chunk-storage, authenticated two-client, 26.9 MB offline/stale-compaction lifecycle, and fixture/grant cleanup tests. This local integration remains separate from the one-time hosted staging migration application.

| Version | Local migration file | Hosted staging history | Reconciliation |
| --- | --- | --- | --- |
| `20261014` | `20261014_one_active_syllabus_request_per_user.sql` | Absent | Retained as historical source migration. Staging has no `public.nexus_syllabus_requests` table, so it must not be applied there. |
| `20261018` | `20261018_retire_community_wishlist.sql` | Absent | Retained as historical source migration. Both syllabus tables are absent in staging, so the guarded retirement migration would have no effect there. |
| `20261024065138` | Not in the standard migration folder | Present | Staging-only permission-alignment migration. Its exact SQL is archived at `supabase/staging-migrations/20261024065138_align_staging_nexus_user_data_permissions.sql`, outside the shared auto-apply chain. |
| `20261109052019` | Present | Present | Aligned |
| `20261109053246` | Present | Present | Aligned |
| `20261113095723` | Present | Present | Aligned |
| `20261113101625` | Present | Present | Aligned |
| `20261113215301` | Present | Present | Aligned |
| `20261113222129` | Present | Present | Aligned |
| `20261114093000` | Present | Present after repair | The staging ledger previously recorded the already-applied SQL under erroneous version `20261114035035`. The ledger version was corrected to `20261114093000`; the migration SQL was not rerun. |
| `20261114103353` | Present | Present | Aligned |
| `20261115171500` | Present | Present after guarded application on 2026-11-16 | Applied to isolated staging only. The history row was reconciled to the exact source version after the transient server timestamp; the migration SQL was not rerun. |

## Hosted staging verification — read-only, 2026-11-16

The project was confirmed as `nexus-sync-staging`, region `ap-southeast-1`, status `ACTIVE_HEALTHY`, PostgreSQL 17.11. The migration ledger contains ten entries: one staging-specific migration and nine shared Phase 3.4/chunk migrations (listed above).

Current non-content counts observed in staging:

- 4 rows in `public.nexus_user_data`.
- 6,275 rows in `public.nexus_user_data_chunks`.
- 4 workspace sync-state rows, all in `snapshot` mode.
- 0 `delta`-mode sync-state rows.
- 0 operation rows and 0 operation-receipt rows.

These are observations at revalidation time, not fixture baselines. No disposable test identities or race fixtures were created in hosted staging.

## RLS and permission verification — read-only, 2026-11-16

RLS is enabled on all five workspace tables:

- `nexus_user_data`
- `nexus_user_data_chunks`
- `nexus_workspace_sync_state`
- `nexus_workspace_operations`
- `nexus_workspace_operation_receipts`

The owner policies and role grants were rechecked:

- `nexus_user_data`: authenticated has owner-scoped SELECT, INSERT and UPDATE; no DELETE. `anon` has no table privileges.
- `nexus_user_data_chunks`: authenticated has owner-scoped SELECT, INSERT and DELETE; no UPDATE. `anon` has no table privileges.
- Sync-state, operation and receipt tables: authenticated has owner-scoped SELECT only; no direct INSERT, UPDATE or DELETE. `anon` has no table privileges.
- All six browser-facing Delta RPCs (`nexus_get_entity_sync_state`, `nexus_enable_entity_delta`, `nexus_publish_entity_operation`, `nexus_read_entity_operations`, `nexus_publish_entity_snapshot`, and `nexus_compact_entity_operations`) have EXECUTE revoked from PUBLIC, `anon` and `authenticated`.
- No staging workspace is in Delta mode. Snapshot/chunk sync remains the hosted protocol.
- The private candidate validator and active-chunk deletion guard are SECURITY DEFINER with an empty `search_path`; browser roles cannot use the private schema or execute either function.

The staging security advisor returned one separate Auth configuration warning: leaked-password protection is disabled. This staging Auth setting was not changed. The performance advisor returned no findings.

## Operating rules

- Do not apply the two legacy syllabus migrations to staging unless that environment intentionally reintroduces the archived syllabus tables and the resulting schema change is reviewed.
- Keep the recovered staging-only permission migration in `supabase/staging-migrations/`, not `supabase/migrations/`, so a normal shared migration push cannot pick it up accidentally.
- Keep Delta RPC execution revoked and all existing workspaces in snapshot mode until the separately gated client rollout is reviewed. Snapshot/chunk compatibility remains authoritative.
- Do not use hosted staging or production for disposable test identities or race fixtures. Use the disposable local Phase 3.4 Supabase workflow.
- The shared Phase 3.4 chain is applied only to isolated hosted staging. Production was inspected read-only on 2026-11-16: its baseline and schema are now inventoried, but no Phase 3.4 migration is applied there. Production backup/PITR restore readiness remains unverified.

Production Supabase was accessed read-only on 2026-11-16. No production migration, schema/data/RLS/permission/Auth-setting change, live deployment, or PR merge was performed.


## Production baseline — read-only inspection, 2026-11-16

Project: `nexus-spaced-repetition` (`txugbdavblpettcnhcxl`), region `ap-south-1`, PostgreSQL 17.11, project status `ACTIVE_HEALTHY`.

### Production migration history

Only these three migrations are recorded in production:

| Version | Name |
| --- | --- |
| `20261010174818` | `create_nexus_user_data` |
| `20261012033747` | `revoke_unneeded_client_privileges` |
| `20261012034918` | `revoke_unused_client_delete_nexus_backup` |

None of the nine shared Phase 3.4 migrations is recorded in production. The staging-only `20261024065138_align_staging_nexus_user_data_permissions.sql` remains excluded from the production sequence.

### Production workspace schema and data shape

Production currently has `public.nexus_user_data`, `public.nexus_syllabus_requests`, and `public.nexus_syllabus_votes`. It does **not** have `nexus_user_data_chunks`, `nexus_workspace_sync_state`, `nexus_workspace_operations`, `nexus_workspace_operation_receipts`, or the `nexus_private` schema.

Read-only aggregate checks observed:

- 8 existing workspace rows.
- All 8 payloads are JSON objects in the legacy snapshot representation.
- 0 chunked manifests and 0 Delta protocol markers.
- Largest observed payload: 1,635,656 bytes.
- The existing `nexus_user_data` relation occupies approximately 892,928 bytes.

No workspace payloads or user identifiers were exported for this inventory.

### Production access-control and advisor observations

- `public.nexus_user_data` has RLS enabled with owner-scoped SELECT, INSERT and UPDATE policies. The `authenticated` role has those three table privileges; it has no DELETE privilege. `anon` has no table privileges on the Nexus workspace table.
- The two existing syllabus tables have RLS enabled but no policies. Supabase reports these as informational `rls_enabled_no_policy` findings; they were not changed.
- The production Auth advisor reports leaked-password protection disabled. The performance advisor reports an unindexed foreign key on `nexus_syllabus_votes.user_id` and two unused syllabus-table indexes. These are pre-existing, outside the Phase 3.4 workspace rollout scope, and were not changed.
- The production Health Advisor returned no findings.
- The production database has `pgcrypto` installed.
- Backup/PITR retention and restore-point readiness were not exposed through the available database connector and remain unverified. Verify them in the Supabase dashboard before a future production migration.

### Migration-order security correction on PR #126

The first version of `20261113095723_nexus_entity_delta_sync.sql` granted the six privileged Delta RPC functions to `authenticated`, relying on later migrations to revoke them. A fresh production migration sequence would therefore have had an intermediate interval where browser clients could call those RPCs.

That window has been removed in the current PR branch:

- The initial Delta migration now explicitly revokes all six RPCs from `PUBLIC`, `anon`, and `authenticated`; it contains no browser-role `GRANT EXECUTE`.
- `scripts/test-entity-delta-migration.mjs` asserts the initial migration is safe on its own.
- Exact-head validation #1543 and local Supabase integration #68 passed on source SHA `7ff0d3d27af03d00928f3b67a5a0a3ef85006409`.
- The staging database's current final state was rechecked read-only: all six Delta RPCs are non-executable by PUBLIC, anon and authenticated; all five workspace tables have RLS enabled; four existing staging workspaces remain in snapshot mode; operation/receipt tables are empty; and `nexus_private` is unavailable to browser roles.

The source correction does not rewrite the already-applied staging migration history. The clean local CI database applies the corrected initial migration from scratch and verifies the permissions before running its temporary, rollback/cleanup-protected authenticated RPC tests.

### Production rollout boundary

The nine shared migrations remain a **post-merge OPS-01 rollout task**. No production migration has been applied or dry-run against production. The production baseline is now known, but backups/PITR still need verification, and an explicit production execution approval must be obtained at the OPS-01 gate. Do not apply migrations from this preflight.
