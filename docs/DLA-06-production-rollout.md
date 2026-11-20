# DLA-06 — Controlled production Entity Delta rollout

**Status:** COMPLETED  
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

The obsolete DLA-05 singular variable may remain configured as inert legacy state. The current build/runtime gate reads the plural owner-ID variable only. Removal is not required for DLA-06 acceptance and is outside this rollout unless separately approved.

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

**DLA-06 technical acceptance: COMPLETED — 20 November 2026.** The expanded two-owner Production state and the Account B authenticated downgrade/re-enable lifecycle have been executed and independently verified. The legacy singular Vercel Production owner-ID variable remains as deferred configuration cleanup; it is not used by the active plural build gate and will not be changed without separate explicit owner approval. P35-04 remains a separate final report/retirement task and must explicitly preserve the DR-01 waiver.


## Status reconciliation addendum — 20 November 2026

**Current disposition: PARTIAL / IN PROGRESS.** The read-only Production post-check still shows exactly two Auth users, two workspace rows and two sync-state rows; both owners are in Delta mode and each has one enabled allowlist entry. Revision-order, mode/marker, row/receipt and owner-isolation assertions remain as recorded in the P35-04 acceptance audit.

The OPS-G4 temporary snapshot-only account test is separate from DLA-06. That account was removed after its snapshot publish/read/offline/reconnect test and is not evidence of Account B's Delta activation handoff.

**Remaining DLA-06 acceptance evidence:** Account B must be shown entering Delta through the normal authenticated `nexus_enable_entity_delta` client handoff using its exact current snapshot timestamp. The database's current Delta mode does not prove that client handoff occurred. Do not change the mode directly with SQL.

The obsolete singular `NEXUS_ENTITY_DELTA_PRODUCTION_OWNER_ID` variable is still present in the Vercel Production environment. The plural variable is the active build gate. Remove the singular variable only after the DLA-06 post-check is accepted and the owner has explicitly approved that Production environment change. No environment change is performed by this addendum.

Until these items are evidenced and the permitted environment cleanup is approved and completed, DLA-06 remains **PARTIAL** and P35-04 remains **PARTIAL**. DR-01 remains **WAIVED**, not completed.


## Execution addendum — Account B authenticated downgrade and Delta re-enable (20 November 2026)

**Result: DLA-06 — COMPLETED.** This addendum supersedes the earlier baseline and status-reconciliation statements that described Account B's authenticated handoff as pending.

### Account B protected downgrade

The owner confirmed the Android Production session was Account B. The browser preflight on the canonical Production origin reported:

- `helperAvailable: true`
- `productionGate: true`
- `productionOrigin` matched the canonical Production origin
- `accountBApproved: true`
- authenticated session `signedIn: true`, `ready: true`
- `online: true`

The owner invoked the existing protected `NexusCloudSync.downgradeEntityDelta()` helper from that authenticated session. Its returned result was:

- `ok: true`, `downgraded: true`, `alreadyDowngraded: false`
- resulting mode: `snapshot`
- head revision: 1; snapshot revision: 1
- compaction: `ok: true`, `complete: true`, `pending: false`
- compacted through revision: 1; rounds: 1
- deleted operations: 0; deleted receipts: 0

The helper completed the synchronization/snapshot/compaction/downgrade sequence. No direct sync-state mode or marker edit and no manual operation/receipt deletion was performed.

### Authorized eligibility restoration and authenticated re-enable

After successful downgrade, the Account B row in `nexus_private.entity_delta_pilot_allowlist` was confirmed disabled. Under the owner's explicit approval for the DLA-06 Account B downgrade/re-enable test, only that existing Account B allowlist row was re-enabled with a bounded DLA-06 audit reason. No sync-state mode or Delta marker was directly modified.

The owner refreshed the authenticated Account B Production session, allowed the normal application synchronization flow to run, and reported that Nexus returned to **Synced**. The client implementation was inspected: for a production-gated owner in snapshot mode, it reads the current `nexus_user_data.updated_at`, calls authenticated `nexus_enable_entity_delta` with that exact timestamp, and verifies the returned Delta mode with a fresh sync-state read.

### Independent read-only Production post-check

A SELECT-only query against Production project `txugbdavblpettcnhcxl` after the authenticated sync returned:

| Assertion | Account B | Account A |
|---|---:|---:|
| Sync mode | `delta` | `delta` |
| Head revision | 1 | 2 |
| Snapshot revision | 1 | 2 |
| Compacted through revision | 1 | 2 |
| Delta allowlist enabled | true | true |
| Operation rows | 0 | 0 |
| Receipt rows | 0 | 0 |

Account B's snapshot `updated_at` advanced to `2026-11-20 13:53:03.225425+00`, after the eligibility restoration and authenticated refresh. Account A remained in Delta mode with its revisions and eligibility unchanged. Both owners' operation and receipt counts were zero.

### Disposition and boundary

- **DLA-06: COMPLETED.** Protected downgrade, compaction, eligibility revocation, authorized eligibility restoration, normal authenticated client re-enable, and independent two-owner post-check all passed.
- **Account isolation: PASS.** Account A remained unchanged; no third owner was added or affected.
- **Legacy singular Vercel variable:** retained as separately approved configuration cleanup. The active build gate uses the plural variable. No Vercel environment mutation is included in this completion.
- **P35-04:** remains a separate final audit/retirement task; do not infer it is closed by DLA-06.
- **DR-01:** remains **WAIVED**, not completed.

No merge or new deployment was performed as part of this documentation update.


## Final owner disposition — 20 November 2026

**DLA-06: COMPLETED.** The owner has accepted retaining the obsolete singular `NEXUS_ENTITY_DELTA_PRODUCTION_OWNER_ID` Vercel Production variable. It is not used by the active plural owner-list gate, and its removal is not required to complete DLA-06 or P35-04. No Vercel environment mutation is part of this disposition.

The completed rollout scope is the two current approved Production owners/workspaces. Future signups remain default-deny until explicitly allowlisted; this runbook does not claim automatic enrollment for future users.

**P35-04: COMPLETED** for the approved two-owner Web/PWA clean-start scope, with the limitations and retirement decision recorded in `docs/P35-04-final-acceptance-audit-2026-11-20.md`. **DR-01 remains WAIVED**, not completed; disaster recovery is not tested or proven.

No Production setting, database, account, deployment or promotion was changed by this documentation addendum.
