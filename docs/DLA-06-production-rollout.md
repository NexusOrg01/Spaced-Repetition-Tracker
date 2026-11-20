# DLA-06 — Controlled production Entity Delta rollout

**Status:** In progress  
**Target:** The two current production end-user owners/workspaces only  
**Production Supabase project:** `txugbdavblpettcnhcxl`  
**Canonical production origin:** `https://spaced-repetition-tracker-delta.vercel.app`  
**Parent evidence:** DLA-05 production canary completed; see the active project ledger.

## Owner decision

The owner explicitly approved expanding production Delta eligibility to Account B as well as the existing Account A canary. No future task requires keeping a permanent snapshot-only control owner.

This rollout does not make every future signup automatically eligible. The server-side owner allowlist remains authoritative and default-deny; only the two explicitly approved current owners are included.

## Read-only baseline — 20 November 2026

- Two Auth owners and two workspace/sync-state rows exist.
- Account A: `delta`; head, snapshot, and compaction floor are all revision 2; allowlist enabled.
- Account B: `snapshot`; head, snapshot, and compaction floor are all revision 0; not allowlisted.
- Zero operation rows, operation receipts, and downgrade receipts.
- Production migration history includes the 14 OPS-G3 baseline/migration entries plus the DLA-05 production activation package (15 total).
- The private allowlist and downgrade-receipt tables exist; the seven Delta RPCs are present and scoped as previously verified.
- Existing security advisor notices are recorded separately; do not conflate the pre-existing SECURITY DEFINER RPC notices or leaked-password warning with a new DLA-06 regression.

No account UUIDs, emails, credentials, or workspace payloads belong in this runbook.

## Implementation

The DLA-05 production build gate accepted exactly one UUID. DLA-06 changes this to an explicitly enumerated, bounded owner set:

- New production-only variable: `NEXUS_ENTITY_DELTA_PRODUCTION_OWNER_IDS`.
- Comma-separated UUIDs are normalized and validated.
- Empty, malformed, duplicate, or more than 25 entries fail closed.
- The build still requires the exact Nexus Vercel project, Production environment, `main` ref, explicit production opt-in, and canonical production origin.
- Runtime owner matching uses exact membership in the embedded UUID array.
- The server-side allowlist remains the final authority. The client list cannot grant server eligibility.
- Preview, branch, local, Netlify/Cloudflare, and other Supabase project builds remain unable to enable production Delta.

The DLA-05 single-owner variable may remain temporarily during the transition. The new build reads only the plural variable. Remove the legacy singular variable after the new production deployment and both-owner post-check pass.

## Controlled rollout sequence

1. Confirm the DLA-05 canary remains healthy and the current production inventory still contains exactly the two expected owners/workspaces.
2. Validate the multi-owner gate on the exact PR head. Run the build-config tests, entity-delta client tests, runtime/cloud-sync tests, full local authenticated Supabase + Chromium workflow, and normal validation workflow.
3. After the PR is merged under owner approval, add exactly Account B to `nexus_private.entity_delta_pilot_allowlist` with `enabled=true` and a bounded DLA-06 audit reason. Preserve Account A's existing enabled row. Do not add any other owner.
4. Add `NEXUS_ENTITY_DELTA_PRODUCTION_OWNER_IDS` to the Vercel Production environment with exactly the two approved owner UUIDs. Keep the explicit production opt-in true. Do not put the plural variable in Preview or Development.
5. Deploy the approved `main` build to the canonical production origin. Do not promote a preview or use an alternate deployment origin.
6. Account B must enter Delta through the normal authenticated `nexus_enable_entity_delta` RPC handoff using its exact current snapshot timestamp. Do not directly update the sync-state mode or write the Delta marker with SQL.
7. Run the automated DLA-06 smoke checks against the expanded scope and verify the read-only postconditions below. If Account B's normal authenticated handoff cannot be exercised automatically, record that as the one remaining owner-session verification rather than claiming it passed.
8. Remove the obsolete singular Vercel owner variable only after the new deployment and read-only post-check confirm both owners remain eligible.

## Read-only acceptance post-check

- Exactly two workspaces and two sync-state rows exist.
- Both approved owners are in `delta` mode and each has exactly one enabled allowlist row.
- No unapproved owner is allowlisted.
- No owner/mode mismatch exists.
- Head, snapshot, and compaction-floor invariants hold for both owners.
- Operation rows and receipts are owner-scoped; no cross-owner access is possible.
- Snapshot fallback and the owner-specific DLA-03 downgrade remain available.
- The normal client cannot silently re-enable an owner after a successful downgrade.
- No new Critical data-integrity, synchronization, or authorization error is present.

There is no required multi-day observation period or permanent snapshot-only control account. Do not repeat the DLA-04 physical-device matrix.

## Rollback and residual risk

If a concrete critical failure occurs, stop expansion and use the tested owner-specific DLA-03 downgrade for the affected owner. Do not directly edit protocol markers, delete operation history, or remove active manifests as an improvised rollback.

DR-01 remains **WAIVED**, not completed. No production backup, restore, or disaster-recovery proof is claimed. Snapshot remains the recovery/fallback protocol, but this does not substitute for a disaster-recovery backup.

## Final sign-off

DLA-06 closes only after the expanded two-owner production state and the acceptance post-check are evidenced. P35-04 remains a separate final report/retirement task and must explicitly preserve the DR-01 waiver.


## Status reconciliation addendum — 20 November 2026

**Current disposition: PARTIAL / IN PROGRESS.** The read-only Production post-check still shows exactly two Auth users, two workspace rows and two sync-state rows; both owners are in Delta mode and each has one enabled allowlist entry. Revision-order, mode/marker, row/receipt and owner-isolation assertions remain as recorded in the P35-04 acceptance audit.

The OPS-G4 temporary snapshot-only account test is separate from DLA-06. That account was removed after its snapshot publish/read/offline/reconnect test and is not evidence of Account B's Delta activation handoff.

**Remaining DLA-06 acceptance evidence:** Account B must be shown entering Delta through the normal authenticated `nexus_enable_entity_delta` client handoff using its exact current snapshot timestamp. The database's current Delta mode does not prove that client handoff occurred. Do not change the mode directly with SQL.

The obsolete singular `NEXUS_ENTITY_DELTA_PRODUCTION_OWNER_ID` variable is still present in the Vercel Production environment. The plural variable is the active build gate. Remove the singular variable only after the DLA-06 post-check is accepted and the owner has explicitly approved that Production environment change. No environment change is performed by this addendum.

Until these items are evidenced and the permitted environment cleanup is approved and completed, DLA-06 remains **PARTIAL** and P35-04 remains **PARTIAL**. DR-01 remains **WAIVED**, not completed.
