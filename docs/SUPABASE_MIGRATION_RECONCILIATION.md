# Supabase migration reconciliation

**Checked:** 2026-11-14  
**Repository branch:** `android/capacitor-multistore-foundation`  
**Staging project:** `nexus-sync-staging`

This record compares the timestamped files in `supabase/migrations/` on the PR branch with the migration history returned by the isolated staging project. The local side here is the committed migration-file inventory; no separate local PostgreSQL stack was attached to this audit.

## Result

The shared migration chain is aligned after correcting one staging history version. The remaining file/history differences are intentional environment-specific exceptions and are documented below.

| Version | Local migration file | Staging history | Reconciliation |
| --- | --- | --- | --- |
| `20261014` | `20261014_one_active_syllabus_request_per_user.sql` | Absent | Retained as historical source migration. Staging has no `public.nexus_syllabus_requests` table, so it must not be applied there. |
| `20261018` | `20261018_retire_community_wishlist.sql` | Absent | Retained as historical source migration. Both syllabus tables are absent in staging, so the guarded retirement migration would have no effect there. |
| `20261024065138` | Not in the standard migration folder | Present | Staging-only permission-alignment migration. Its exact SQL was recovered from the staging ledger and archived at `supabase/staging-migrations/20261024065138_align_staging_nexus_user_data_permissions.sql`. This archive is deliberately outside `supabase/migrations/` and is not part of the shared auto-apply chain. |
| `20261109052019` | Present | Present | Aligned |
| `20261109053246` | Present | Present | Aligned |
| `20261113095723` | Present | Present | Aligned |
| `20261113101625` | Present | Present | Aligned |
| `20261113215301` | Present | Present | Aligned |
| `20261113222129` | Present | Present | Aligned |
| `20261114093000` | Present | Present after repair | The staging ledger previously recorded the already-applied SQL under the erroneous version `20261114035035`. The ledger version was corrected to `20261114093000`; the migration SQL was not rerun. |
| `20261114103353` | Present | Present | Aligned |

## Verification

The staging schema was inspected before and after the history repair:

- `public.nexus_syllabus_requests` and `public.nexus_syllabus_votes` do not exist; the legacy one-active-request index is absent.
- `nexus_workspace_operations_entity_identity_check` exists and is validated.
- `nexus_guard_active_chunk_manifest_delete` exists on `public.nexus_user_data_chunks`.
- After the repair, staging lists `20261114093000` and no longer lists `20261114035035`.
- The staging-only `20261024065138` row and all eight shared later versions remain present.

The version correction touched only `supabase_migrations.schema_migrations.version` for the one verified row. Its recorded SQL, name, creator metadata, and applied schema objects were preserved. No schema migration was executed during reconciliation.

## Operating rule

Do not apply the two legacy syllabus migrations to staging unless that environment intentionally reintroduces the archived syllabus tables and the resulting schema change is reviewed. Keep the recovered staging-only permission migration in `supabase/staging-migrations/`, not `supabase/migrations/`, so a normal production migration push cannot pick it up accidentally.

No production project, production schema, production data, or live Nexus deployment was accessed or changed.
