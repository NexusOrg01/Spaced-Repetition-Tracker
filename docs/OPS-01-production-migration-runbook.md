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

## DR-01 waiver and owner-approved risk acceptance

**DR-01 is WAIVED IN FULL. It was not performed.** The owner explicitly accepts that production has no verified backup or restore point and that existing Auth identities/workspace data may be irrecoverable after a damaging change. No backup, export, off-site encrypted copy, isolated restore, fidelity test, or `NEXUS-DR-YYYYMMDD-XXXX` evidence ID exists.

The durable approval record is:

`https://github.com/NexusOrg01/Spaced-Repetition-Tracker/pull/131#issuecomment-6957021229`

This exact URL is the owner's approval comment on PR #131. The workflow validates this exact reference. It is a risk-acceptance record, **not** a backup/restore evidence ID and not a claim of disaster-recovery readiness.

### Apply-time controls retained

The waiver replaces only the old DR evidence-ID requirement. It does not bypass these controls:

1. The workflow must run from `main` in the `nexus-production-migrations` environment.
2. The repository must verify the protected environment, allowed deployment ref, required reviewers and environment-scoped `SUPABASE_ACCESS_TOKEN` and `SUPABASE_DB_PASSWORD` before apply. A workflow declaration alone is not proof of those settings.
3. The operator must enter the exact confirmation phrase `APPLY-OPS-01-TO-PRODUCTION` and the exact risk-acceptance URL above.
4. The migration ledger must equal the three known baseline versions plus exactly the 11 reviewed pending OPS-01 migrations. The pinned Supabase CLI dry-run must match those files exactly.
5. The workflow targets only production project `txugbdavblpettcnhcxl`. No pilot/activation migration, RPC browser grant, or workspace mode change is included.
6. The environment reviewer must inspect the owner approval record and the run summary before approving the protected job.

### Data disposition authorized by the owner

On 17 November 2026 the owner additionally authorized disposal of existing workspace data and test/account data in staging and production, stating that these records do not need preservation. This permission allows scoped cleanup where the rollout requires it; it does **not** mean OPS-G3 should silently delete data.

- OPS-G3 remains the exact additive 11-file schema migration set. It must not contain ad hoc workspace truncation or direct writes to Supabase-managed Auth tables.
- Do not delete Auth identities with raw SQL. Any account deletion must use a supported Supabase Auth Admin path.
- Any staging/production workspace cleanup must be a separately recorded, tightly scoped action with pre/post row counts, and must not drop schema, active-manifest guards, private functions, or migration history.
- The production OPS-G3 acceptance check continues to verify workspace ownership integrity and snapshot-mode state. If cleanup is required, its effect must be explicitly visible in the audit output rather than silently treated as an ordinary migration side-effect.

### Residual risk

A failed migration or data-destructive forward fix could permanently lose the existing production data. There is no isolated recovery project and no verified point-in-time restore under this waiver. If post-migration checks fail, stop; do not claim rollback is available. Continue only with a reviewed forward-fix and the owner's recorded risk acceptance.

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
