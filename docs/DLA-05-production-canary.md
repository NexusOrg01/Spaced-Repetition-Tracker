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

A production-specific, separately reviewed activation migration is now prepared at:

`supabase/production-activation/20261120103000_dla05_production_entity_delta_canary_activation.sql`

It is a single explicit transaction ported from the ordered six DLA-02/DLA-03/DLA-04 pilot SQL source files. The file records the exact source blob SHAs and does not rely on the original DLA-03 file's QA-only deployment instruction. The package:

- Creates the private owner allowlist with `enabled=false` by default and no pre-authorized rows.
- Installs the server-side `auth.uid()` allowlist check and the authenticated-only Delta RPC grants.
- Installs the owner-scoped downgrade and private idempotency receipts.
- Applies the reviewed exact-snapshot no-op checks, empty SECURITY DEFINER search paths and allowlist revocation on successful downgrade.
- Keeps API-role access to `nexus_private` and direct bookkeeping table writes revoked.

This package is deliberately outside `supabase/migrations/` and OPS-G3's exact 11-file allowlist. The original source files under `supabase/pilot-migrations/` remain the isolated QA/test source; the production port does not move them into OPS-G3 or alter them.

**Production apply has not been run.** Applying this package changes production schema and authenticated RPC grants, so it requires a separate explicit owner approval for this exact file and target `txugbdavblpettcnhcxl`. It must not be applied as part of OPS-G3, from CI, or from a preview deployment. After it is applied, the allowlist must still be empty until the one selected production owner is separately approved.

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
2. Recheck the production-specific activation SQL and its six source migrations/signatures; run the full local authenticated Supabase/Chromium tests, including application of the production package to the disposable local database, on the exact PR commit.
3. After a selected canary account and a separate Owner-B control account have been created through the normal signup flow, identify both production Auth UUIDs. Verify the selected canary owner has exactly one intended Nexus workspace with a current, readable snapshot; keep Owner-B unlisted for negative isolation assertions. The clean-start production inventory currently contains no Auth users or workspaces.
4. After explicit approval, apply only `supabase/production-activation/20261120103000_dla05_production_entity_delta_canary_activation.sql` to `txugbdavblpettcnhcxl`. Verify the allowlist is empty/default-deny, all six RPCs have the intended authenticated-only grants, anon/PUBLIC/service_role remain revoked, private schema privileges remain revoked, and the downgrade receipt table/function exist.
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

**Implementation preparation: complete on the DLA-05 PR, subject to the current exact-head CI run. Live canary: not started. Production activation: not performed.** A production owner UUID, authenticated canary session, and separate explicit approval for the production activation actions are still required.


## Status reconciliation addendum — 20 November 2026

**DLA-05 status: COMPLETED.** The earlier `Current disposition` statement that the live canary had not started is superseded by the completed DLA-05 execution recorded in the P35-04 acceptance audit and merged PR [#142](https://github.com/NexusOrg01/Spaced-Repetition-Tracker/pull/142), merge commit `d16a5fabcc521fa5713903e4d346e38e83a3e95e`.

The one-owner Production canary and its automated acceptance/downgrade verification are accepted as complete. This completion is separate from DLA-06's subsequent two-owner expansion. It does not close P35-04, and it does not change the DR-01 disposition: **WAIVED, not completed**.
