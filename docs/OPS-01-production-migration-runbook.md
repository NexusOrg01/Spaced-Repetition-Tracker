# OPS-01 — Protected production migration runbook

**Target project:** `txugbdavblpettcnhcxl` (production; ap-south-1)  
**Runner:** `.github/workflows/ops-01-production-migrations.yml`  
**Default action:** dry run. The workflow is manual-only and rejects refs other than `main`.

## Required GitHub environment setup

Before enabling the runner, a repository administrator must create the GitHub Actions environment named `nexus-production-migrations` and configure:

- Required reviewers. At least one reviewer must be different from the workflow initiator, where GitHub supports that setting.
- Environment-scoped secrets `SUPABASE_ACCESS_TOKEN` and `SUPABASE_DB_PASSWORD`.
- No PR workflow may access these production secrets.

The workflow declares this environment but cannot create or prove its reviewer protection. Treat production apply as **not fully protected** until the environment review rules and secrets have been configured and checked in GitHub settings.

## Mandatory backup and isolated-restore gate

**Production apply is blocked until a fresh, complete and restorable database recovery set has been restored successfully into a separate recovery environment.** The earlier record of a backup-safeguard waiver is superseded for final rollout execution.

### Supabase export scope — important

Do **not** treat a plain `supabase db dump` as a complete Supabase project backup:

- The Supabase CLI dump excludes Supabase-managed schemas such as `auth`, `storage` and extension-managed schemas by default.
- A default dump is schema-only: it does not include table data or custom roles unless the corresponding options are requested.
- Database dumps do not include the actual files stored through the Supabase Storage API; those objects need their own backup if the project uses Storage.

See the official [Supabase CLI `db dump` reference](https://supabase.com/docs/reference/cli/supabase-db-dump) and [Supabase Database Backups guide](https://supabase.com/docs/guides/platform/backups).

For Nexus, the recovery set must cover, at minimum:

1. The application schema, functions, triggers, indexes, RLS policies, grants and required extensions.
2. All application table data, including every `public.nexus_user_data` row and its workspace payload.
3. Required custom database roles and privilege/default-privilege state.
4. The Auth user identities referenced by Nexus workspace rows, preserving the exact user UUIDs and the identity/account relationships needed to keep the workspace foreign keys valid.
5. Any project configuration or Storage objects that the application actually depends on.

The Auth identity item is a hard gate: a public-schema-only export that omits the corresponding `auth.users` identities is not a successful Nexus restore, even if the eight workspace rows themselves were copied. Do not assume that copying user emails or user metadata is equivalent to restoring the original Auth identities. Use a supported, reviewed method for preserving/reconstructing those identities in the isolated recovery environment and prove that every restored `nexus_user_data.user_id` resolves to the expected Auth user. Do not attempt undocumented direct writes to Supabase-managed Auth tables.

### Required recovery procedure

Before an apply run:

1. Create a fresh export/recovery set. Explicitly account for the CLI exclusions above; capture application schema, table data and custom roles separately where required, and separately preserve Auth identities and Storage objects using supported methods.
2. Record the production project ref, exact backup timestamp, export commands/methods, tool versions, file inventory and SHA-256 checksums.
3. Store the recovery set encrypted at rest in an off-repository, access-controlled location. Do not upload raw database dumps, Auth records, credentials, connection strings or user workspace content to GitHub Actions artifacts or PR comments.
4. Restore the recovery set into a separate isolated recovery project/environment. Never test a restore over production or hosted staging.
5. Verify the restored migration baseline, schema objects, all eight currently recorded Nexus workspace rows, every workspace payload, exact Auth user UUID references, foreign-key relationships, policies/permissions and required table row counts. If Storage is used, verify the objects independently.
6. Record the recovery project/environment ref, restore timestamp, verification queries/results and any deviations in a restricted audit record. Confirm the recovered application can read the preserved workspaces using the restored account identities.
7. Assign a reference in the exact format `NEXUS-DR-YYYYMMDD-XXXX` (for example, `NEXUS-DR-20261117-AB12`). The reference is a pointer to the protected evidence, not proof by itself.
8. The protected GitHub environment reviewer must inspect the referenced evidence and independently confirm the isolated restore succeeded before approving an apply run.

**Stop condition:** If the team cannot preserve and restore the original Auth user identities and their workspace ownership relationships through a supported method, the backup gate remains blocked. Do not apply the production migrations until an adequate recovery method is demonstrated.

The workflow enforces a non-empty, format-checked evidence reference for `apply`. The human environment approval is the actual evidence-review gate; the typed reference cannot prove that a backup exists or is restorable.

## Reviewed migration set and order

The guard script accepts only these 11 versioned files in `supabase/migrations`:

1. `20261014_one_active_syllabus_request_per_user.sql`
2. `20261018_retire_community_wishlist.sql`
3. `20261109052019_chunked_nexus_workspace_snapshots.sql`
4. `20261109053246_tighten_nexus_workspace_chunk_limit.sql`
5. `20261113095723_nexus_entity_delta_sync.sql`
6. `20261113101625_harden_nexus_entity_delta_reads_and_compaction.sql`
7. `20261113215301_defer_entity_delta_enablement_until_client_ready.sql`
8. `20261113222129_revoke_unwired_entity_delta_rpc_execution.sql`
9. `20261114093000_harden_nexus_entity_delta_record_identity.sql`
10. `20261114103353_protect_active_nexus_chunk_manifests.sql`
11. `20261115171500_validate_general_snapshot_candidates.sql`

The guard fails closed if any other migration file is added to that folder, if the remote ledger contains an unreviewed version, or if the CLI dry-run does not exactly match the pending allowlist. It deliberately excludes `supabase/staging-migrations/*` and `supabase/local-phase34/*`. It does not use `--include-all`, `migration repair`, roles, seed files or config pushes.

The production ledger was last inspected read-only before this runner was written. At that inspection it contained baseline versions `20261010174818`, `20261012033747` and `20261012034918`, with all 11 OPS-01 versions pending. Re-read the live ledger immediately before any apply; the runner does not assume that inspection remains current.

## Operator procedure

1. Open **Actions → OPS-01 protected production migration runner → Run workflow** on `main`.
2. Keep `operation = dry-run` for the first run. Review the target, migration history, dry-run list and workflow artifact. A dry run does not apply migrations.
3. After the backup/restore gate is complete, create a separate apply run. Choose `apply`, enter exactly `APPLY-OPS-01-TO-PRODUCTION`, and enter the verified backup/restore evidence reference.
4. The protected GitHub environment reviewer must inspect the evidence reference and approve the job. Do not approve an apply run until the isolated restore has been verified.
5. Confirm all 11 migrations are recorded after apply. The workflow then runs the post-migration SQL in read-only mode.
6. Review the evidence artifact and Supabase advisors before any pilot. Verification checks chunk RLS, active-manifest protection, snapshot-candidate validation, sync-state alignment, six Delta RPC grants, private schema grants and all existing workspaces staying in snapshot mode.

## Safety and rollback

- No job is triggered by a pull request, branch push or deployment. Creating this PR does not contact production Supabase.
- The only hosted write command is `supabase db push --yes --remote=<fixed production ref>`, inside the manual protected-environment job after the typed confirmation and environment approval.
- CLI v3 defaults database commands to local unless `--remote` is passed. Every remote command therefore names the exact production reference. CLI is pinned to stable `3.0.0`; do not replace it with an unpinned latest install.
- Keep additive schema objects on an application rollback. Do **not** drop chunk tables, private guard functions, active manifests, operation/receipt history or sync-state rows as an emergency rollback.
- If post-apply verification fails, stop rollout and forward-fix. Do not enable Delta, grant its browser RPCs, change workspace modes or bypass snapshot fallback.
- The existing snapshot/chunk writer remains the compatibility route. Delta remains default-off.
- A successful migration run is not permission to enable Delta globally. Pilot activation and production feature-flag changes remain separate reviewed steps.

## Scope boundary

This PR does not run the workflow, apply migrations, change project secrets/settings, create preview secrets, enable Delta, write production tables, or modify the live Nexus deployment.
