# Supabase migration reconciliation

**Revalidated:** 2026-11-16  
**Repository branch:** `android/capacitor-multistore-foundation`  
**Hosted staging project:** `nexus-sync-staging` (`xuwfzibxhxzxxupprxsq`)  
**Production project:** `nexus-spaced-repetition` (`txugbdavblpettcnhcxl`) — not accessed

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
- This migration was applied only to isolated hosted staging. Do not infer that the production migration baseline, schema, backup or PITR readiness has been verified.

No production project, production schema, production data, or live Nexus deployment was accessed or changed.
