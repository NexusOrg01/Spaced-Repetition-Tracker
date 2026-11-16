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

**Production apply is blocked until a fresh, full database backup has been restored successfully into a separate recovery project.** The earlier record of a backup-safeguard waiver is superseded for final rollout execution.

Before an apply run:

1. Create a fresh database-level export covering the application schema and required data, including all current workspace rows and the Auth identities referenced by them. Record the production project ref and exact backup timestamp.
2. Store the backup encrypted at rest in an off-repository, access-controlled location. Do not upload the raw database dump, credentials, connection strings or user workspace content to GitHub Actions artifacts or PR comments.
3. Restore that export into a separate isolated recovery project. Never test a restore over production or hosted staging.
4. Verify the restored schema, migration baseline, workspace row count, all workspace payloads, Auth user references, foreign-key relationships and key table row counts. Record the backup SHA-256, recovery-project ref, restore timestamp, verification queries and result in a restricted audit record.
5. Assign a reference in the exact format `NEXUS-DR-YYYYMMDD-XXXX` (for example, `NEXUS-DR-20261117-AB12`). The reference is a pointer to the protected evidence, not proof by itself.
6. The protected GitHub environment reviewer must inspect the referenced evidence and independently confirm the isolated restore succeeded before approving an apply run.

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
