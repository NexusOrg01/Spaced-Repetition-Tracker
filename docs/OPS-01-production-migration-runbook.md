# OPS-01 — Protected production migration runbook

**Target project:** `txugbdavblpettcnhcxl` (production; ap-south-1)  
**Runner:** `.github/workflows/ops-01-production-migrations.yml`  
**Default action:** dry run. The workflow is manual-only and rejects refs other than `main`.

## Required GitHub environment setup

Before enabling the runner, a repository administrator must create the GitHub Actions environment named `nexus-production-migrations` and configure:

- Required reviewers (where available, require a reviewer other than the workflow initiator).
- Environment-scoped secrets `SUPABASE_ACCESS_TOKEN` and `SUPABASE_DB_PASSWORD`.
- No PR workflow should have access to those production secrets.

The workflow declares this environment but cannot create or prove its reviewer protection. Treat production apply as **not fully protected** until the environment review rules and secrets have been configured and checked in GitHub settings.

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
2. Keep `operation = dry-run` for the first run. Review the target, migration history, dry-run list and workflow artifact. A dry run is not a migration apply.
3. For a separate apply run, choose `apply` and enter exactly `APPLY-OPS-01-TO-PRODUCTION`. The configured GitHub environment approval is also required.
4. Confirm all 11 migrations are recorded after apply. The workflow then runs the post-migration SQL in read-only mode.
5. Review the evidence artifact and Supabase advisors before any pilot. Verification checks chunk RLS, active-manifest protection, snapshot-candidate validation, sync-state alignment, six Delta RPC grants, private schema grants and all existing workspaces staying in snapshot mode.

## Safety and rollback

- No job is triggered by a pull request, branch push or deployment. Creating this PR does not contact production Supabase.
- The only hosted write command is `supabase db push --yes --remote=<fixed production ref>`, inside the manual protected-environment job after the typed confirmation.
- CLI v3 defaults database commands to local unless `--remote` is passed. Every remote command therefore names the exact production reference. CLI is pinned to stable `3.0.0`; do not replace it with an unpinned latest install.
- Keep additive schema objects on an application rollback. Do **not** drop chunk tables, private guard functions, active manifests, operation/receipt history or sync-state rows as an emergency rollback.
- If post-apply verification fails, stop rollout and forward-fix. Do not enable Delta, grant its browser RPCs, change workspace modes or bypass snapshot fallback.
- The existing snapshot/chunk writer remains the compatibility route. Delta remains default-off.
- The user explicitly waived the backup safeguard for this task. **No new backup or restore-point verification was performed by this PR.** This is a recorded risk, not a claim that a backup exists.
- A successful migration run is not permission to enable Delta globally. Pilot activation and production feature-flag changes remain separate reviewed steps.

## Scope boundary

This PR does not run the workflow, apply migrations, change project secrets/settings, create preview secrets, enable Delta, write production tables, or modify the live Nexus deployment.
