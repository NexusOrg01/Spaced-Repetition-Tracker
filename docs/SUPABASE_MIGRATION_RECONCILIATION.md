# Supabase migration reconciliation

**Revalidated:** 2026-11-16  
**Repository branch:** `android/capacitor-multistore-foundation`  
**Hosted staging project:** `nexus-sync-staging` (`xuwfzibxhxzxxupprxsq`)  
**Production project:** `nexus-spaced-repetition` (`txugbdavblpettcnhcxl`) — not accessed for this audit

This record compares the timestamped migration files on the PR branch with the migration history and schema of the isolated hosted staging project. Integration tests use a separate disposable local Supabase instance; hosted staging is not used for disposable fixtures.

## Result

The shared migration chain through `20261114103353` is present in hosted staging after the earlier history-version repair. One newer branch migration, `20261115171500_validate_general_snapshot_candidates.sql`, is **present in source but not yet applied to hosted staging**. This is a known pending staging migration, not an unexplained history mismatch.

The pending migration installs server-side validation for general chunked snapshot candidates on both first insert and later updates. It verifies manifest shape, chunk-count/index continuity, chunk-count consistency and byte totals, and serializes candidate publication against stale-chunk cleanup. Until it is applied to hosted staging, that environment does not have this additional database-side publication guard. The client-side chunk read-back/hash validation and the existing active-manifest deletion guard remain present.

The new migration is applied by the disposable local Phase 3.4 project. The exact PR-head local integration workflow on 2026-11-16 passed the migration reset, general snapshot-candidate integrity/fallback tests, active-manifest race runner, chunk-storage test, authenticated two-client protocol, 26.9 MB lifecycle, and fixture/grant cleanup. Do not treat that local result as proof that hosted staging has received the migration.

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
| `20261115171500` | Present | **Absent at revalidation** | Pending hosted-staging application. The branch contains `20261115171500_validate_general_snapshot_candidates.sql`; disposable local Supabase applies it and its general snapshot integrity/fallback tests pass. Hosted staging still has the prior active-manifest guard but does not yet have `nexus_private.validate_chunked_nexus_snapshot_candidate()` or its `nexus_validate_chunked_snapshot_candidate` trigger. Apply and verify this migration in an explicitly scoped staging deployment before relying on hosted staging to test the new database-side candidate guard. |

## Hosted staging verification — read-only, 2026-11-16

The project was confirmed as `nexus-sync-staging`, region `ap-southeast-1`, status `ACTIVE_HEALTHY`, PostgreSQL 17.11. The migration ledger contains these nine entries:

- `20261024065138`
- `20261109052019`
- `20261109053246`
- `20261113095723`
- `20261113101625`
- `20261113215301`
- `20261113222129`
- `20261114093000`
- `20261114103353`

Schema checks confirmed:

- `nexus_workspace_operations_entity_identity_check` exists and is validated.
- `nexus_guard_active_chunk_manifest_delete` exists on `public.nexus_user_data_chunks`.
- The older `nexus_guard_chunked_snapshot_update` remains on `public.nexus_user_data`.
- The new `nexus_validate_chunked_snapshot_candidate` trigger/function is absent, consistent with the missing `20261115171500` history row.

Current non-content counts observed in staging: 4 workspace rows, 3,526 chunk rows, 4 sync-state rows in snapshot mode, 0 Delta-mode rows, 0 operation rows and 0 receipt rows. These are an observation at audit time, not a fixture baseline.

## RLS and permission verification — read-only, 2026-11-16

- RLS is enabled on `nexus_user_data`, `nexus_user_data_chunks`, `nexus_workspace_sync_state`, `nexus_workspace_operations`, and `nexus_workspace_operation_receipts`.
- `nexus_user_data` has owner-bound SELECT, INSERT and UPDATE policies; authenticated has no DELETE grant.
- `nexus_user_data_chunks` has owner-bound SELECT, INSERT and DELETE policies; authenticated has no UPDATE grant.
- Delta state, operation and receipt tables expose owner-scoped SELECT policies only. Authenticated has no direct INSERT, UPDATE or DELETE grants on those tables; anon has no table privileges.
- All six browser-facing Delta RPCs (`nexus_get_entity_sync_state`, `nexus_enable_entity_delta`, `nexus_publish_entity_operation`, `nexus_read_entity_operations`, `nexus_publish_entity_snapshot`, and `nexus_compact_entity_operations`) have EXECUTE revoked from PUBLIC, anon and authenticated. No staging account is in Delta mode.
- The security advisor returned one separate Auth configuration warning: leaked-password protection is disabled. This is a staging Auth setting, not an RLS or source-code finding; it was not changed in this source-freeze task.

## Operating rules

- Do not apply the two legacy syllabus migrations to staging unless that environment intentionally reintroduces the archived syllabus tables and the resulting schema change is reviewed.
- Keep the recovered staging-only permission migration in `supabase/staging-migrations/`, not `supabase/migrations/`, so a normal shared migration push cannot pick it up accidentally.
- Keep Delta RPC execution revoked and all existing workspaces in snapshot mode until the separately gated client rollout is reviewed. Snapshot/chunk compatibility remains authoritative.
- Do not use hosted staging or production for disposable test identities or race fixtures. Use the disposable local Phase 3.4 Supabase workflow.
- The pending `20261115171500` migration is a staging rollout prerequisite for the new general candidate guard; this reconciliation record does not apply it.

No production project, production schema, production data, or live Nexus deployment was accessed or changed.
