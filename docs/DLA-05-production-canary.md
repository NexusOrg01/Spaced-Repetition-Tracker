# DLA-05 — One-owner production Entity Delta canary

**Scope:** one explicitly selected production Auth owner, with all other owners remaining on snapshot/chunk synchronization.  
**Parent:** DLA-04, PR #136.  
**Implementation branch:** `feat/dla05-production-canary` (stacked on `fix/dla04-entity-projection-guard`).  
**Production Supabase project:** `txugbdavblpettcnhcxl`.  
**Canonical production origin:** `https://spaced-repetition-tracker-delta.vercel.app`.

## Status and boundary

This change prepares a production-only, fail-closed client activation path and automated contract coverage. It does not apply a migration, create an allowlist row, change Vercel Production environment variables, deploy, merge, or enable Delta for a live account.

The production gate is default-off. It requires all of the following at build time:

- Vercel's system marker is `VERCEL=1`.
- Exact Nexus Vercel project ID `prj_UgPzqFpvqBaKkKXi2Vm2COxqUsDi`.
- `VERCEL_ENV=production` and `VERCEL_GIT_COMMIT_REF=main`.
- `NEXUS_ENTITY_DELTA_PRODUCTION_ENABLED=true`.
- `NEXUS_ENTITY_DELTA_PRODUCTION_OWNER_ID` is one valid UUID.

The generated client config embeds that single owner UUID and the canonical production origin. At runtime the app also verifies HTTPS, the exact canonical origin, the exact production Supabase URL, and that the authenticated owner and selected canary UUID match. Generic previews, PR previews, Netlify/Cloudflare, local builds, other Supabase projects, and other production owners cannot pass this gate.

After the gate is open for that one owner, the client reads that owner's sync mode. If the existing workspace is in snapshot mode, it first reads the snapshot's current `updated_at`, then calls the authenticated `nexus_enable_entity_delta` RPC with that exact timestamp. The server-side allowlist remains authoritative. A `pilot_not_enabled` result stays on snapshot mode; a stale snapshot conflict fails closed; a successful enable is followed by a fresh sync-state read confirming Delta mode before the coordinator starts. The selected owner is not inferred from browser state alone.

## Production activation package — separate from OPS-G3

The following pilot migrations already exist under `supabase/pilot-migrations/`. They are deliberately outside the default `supabase/migrations/` directory and OPS-G3's exact 11-file schema-install allowlist:

1. `20261117083717_add_entity_delta_pilot_eligibility.sql`
2. `20261117143610_add_entity_delta_snapshot_downgrade.sql`
3. `20261117163241_harden_entity_delta_enable_search_path.sql`
4. `20261117182817_harden_entity_delta_snapshot_noop_preconditions_20261117.sql`
5. `20261118093245_harden_entity_delta_rpc_search_paths.sql`
6. `20261118094046_revoke_delta_pilot_eligibility_on_downgrade.sql`

These are a separate production activation package, not OPS-G3 migrations. They create the default-deny owner allowlist and private downgrade receipts, install the exact owner-scoped enable/downgrade logic, harden SECURITY DEFINER search paths and idempotent preconditions, revoke broad/API-role access, grant only the reviewed authenticated RPC execution, and revoke pilot eligibility when a downgrade succeeds. The package must be rechecked against the final branch and the target production function signatures immediately before an approved production apply.

Do not apply the package through the OPS-G3 workflow or append it to the 11-file allowlist. Do not manually run fragments of it. Apply it only as the separately reviewed DLA-05 activation package after explicit owner approval.

## Read-only baseline captured for this implementation

The last direct read-only production query against `txugbdavblpettcnhcxl` found:

- 14 migration entries (the three baseline plus the 11 OPS-G3 migrations).
- 0 Nexus workspace rows and 0 workspace sync-state rows following the clean-start.
- 0 Delta operation rows and 0 operation receipts.
- The five workspace/sync tables have RLS enabled.
- `nexus_private.entity_delta_pilot_allowlist` is not installed.
- `nexus_private.entity_delta_downgrade_receipts` is not installed.
- The six existing Delta RPCs are not executable by `authenticated` or `anon`.

This is a read-only baseline, not a canary result. A new production account/workspace must exist before a canary can be selected; do not invent an Auth UUID or use a platform/operator identity as the canary.

## Approved execution order

1. Reconfirm the exact production project ref and migration head.
2. Recheck the six migration files/signatures and run their full local authenticated Supabase/Chromium tests on the exact PR commit.
3. Identify the selected production Auth UUID and verify it owns exactly one intended Nexus workspace with a current, readable snapshot. Keep a separate Owner-B identity for negative isolation assertions.
4. After explicit approval, apply only the six-file pilot activation package to `txugbdavblpettcnhcxl`. Verify the allowlist is empty/default-deny, all six RPCs have the intended authenticated-only grants, anon/PUBLIC/service_role remain revoked, private schema privileges remain revoked, and the downgrade receipt table/function exist.
5. After explicit approval, add exactly one enabled allowlist row for the selected Auth UUID with a bounded operator reason. No other owner is eligible.
6. After explicit approval, configure the Vercel **Production** environment with the production opt-in and that exact owner UUID, then perform the owner-authorized production deployment. Do not put these values in Preview or branch environments.
7. Use the selected owner's authenticated production browser session to run the automated DLA-05 protocol acceptance suite: publish/read/acknowledge/idempotent replay; stale-revision rejection and bounded retry; offline queue simulation/reconnect; snapshot/manifest/cursor consistency; compaction/stale-cursor snapshot fallback; Owner-B isolation; owner-scoped downgrade; and proof that normal sync does not re-enable the downgraded owner.
8. Run one concise read-only post-check of workspace modes, owner allowlist, operation/receipt state, RPC grants, and relevant error logs.

If a critical assertion fails, stop expansion and downgrade only the selected owner using the verified DLA-03 procedure. The downgrade must also revoke that owner's eligibility. Do not clear operation history, delete manifests, or improvise manual rollback SQL.

## DR-01 treatment

DR-01 remains **WAIVED**, not completed. No production backup, isolated restore, or disaster-recovery proof is claimed by DLA-05. This waiver is carried as an explicitly accepted residual risk under the v2 roadmap; it is not represented as a technical pass.

## Acceptance

- One selected production owner completes the automated Delta acceptance run without record loss or account crossover.
- All other owners remain in snapshot mode and cannot enable Delta.
- The selected owner can be returned to snapshot mode through the authenticated owner-scoped downgrade.
- Successful downgrade revokes that owner's allowlist eligibility; ordinary sync cannot re-enable it.
- One read-only post-check finds no Critical data-integrity, authorization, or synchronization error.

## Current disposition

**Implementation: in progress on the DLA-05 PR. Production activation: not performed.** A production owner UUID, authenticated canary session, and separate explicit approval for the production activation actions are still required.
