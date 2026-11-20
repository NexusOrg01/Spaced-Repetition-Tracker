# DLA-07 — Delta-first universal rollout

**Status:** Implementation committed to PR #146; automated validation in progress  
**Goal:** Entity Delta is the normal sync protocol for every existing and new Nexus account. Snapshot sync is retained for first-time baseline creation and verified recovery/downgrade only.  
**Target:** Web/PWA. **Timebox:** 60 minutes of implementation and focused automated validation.

## Audit findings — 20 November 2026

- Production is healthy. Read-only checks found 2 Auth users, 2 workspaces, and both workspaces already in Delta with enabled eligibility entries and no mode/marker mismatch.
- The Production build gate embeds a fixed list of two owner UUIDs. cloud-sync.js requires membership in that list.
- The server-side nexus_enable_entity_delta RPC requires an enabled row in nexus_private.entity_delta_pilot_allowlist; the column defaults to false. Missing rows are rejected. No Auth-user trigger enrolls new accounts.
- A new account must first publish a verified snapshot because the enable RPC requires an existing snapshot. The current client does not immediately retry Delta enablement after that first baseline is written.
- Delta sync failures currently pause sync and preserve local data. The tested NexusCloudSync.downgradeEntityDelta() helper exists, but normal sync does not invoke it automatically.
- A successful downgrade disables an existing allowlist row, but does not create a disabled row when the owner has no row. That must change before missing rows can mean automatic eligibility.

## Required steps

| Step | Work | Time |
|---|---|---:|
| 1. Global eligibility | Replace the embedded owner list with one Production-wide client gate. Add a private server-side rollout switch, default off. When enabled, an authenticated owner is eligible unless an explicit per-owner disabled override exists. Keep the exact Production project/origin checks and all existing owner/snapshot/manifest validation. | 15 min |
| 2. Automatic enrollment | Enable existing snapshot-mode workspaces through the normal authenticated RPC. For a new signup, write and verify its first baseline snapshot, then immediately run the same Delta enable handshake; no manual allowlisting or extra user edit. | 10 min |
| 3. Automatic fallback | On a recoverable Delta sync failure, invoke the existing owner-scoped DLA-03 downgrade and verify snapshot mode before using snapshot sync. Make downgrade write a durable disabled owner override even when no row existed, so the account stays in fallback until deliberately re-enabled. | 15 min |
| 4. Focused automated tests | Run build-gate tests and the existing local Supabase + authenticated Chromium tests for existing accounts, first-time signup-to-Delta, owner isolation, downgrade persistence, and Delta-failure fallback. | 15 min |
| 5. Production activation | After separate explicit owner approval, enable the server rollout switch and deploy the Production build. Run read-only checks that eligible workspaces are in Delta and a new account enters Delta after its baseline snapshot. | 5 min |

**Total target: 60 minutes.** No independent-review gate, repeat physical-device matrix, new stress-test programme, backup/restore work, or unrelated scaling work is part of DLA-07.

## Completion criteria

- Existing and future authenticated accounts use Delta by default.
- New accounts transition automatically from their one-time verified baseline snapshot to Delta.
- Snapshot mode is used only for baseline creation or after a verified DLA-03 downgrade.
- A downgraded owner remains in snapshot mode until explicitly re-enabled.
- Automated tests pass for enrollment, account isolation, and fallback.

**Production boundary:** This roadmap does not authorize Production database changes, environment changes, deployment, or account operations. Those actions require the owner's separate explicit approval.

## Engineering implementation record — 20 November 2026

The following implementation is on the existing DLA-07 PR branch. This is not a production activation record.

- **Global client gate:** `scripts/build.mjs` no longer reads or emits `NEXUS_ENTITY_DELTA_PRODUCTION_OWNER_IDS`. The generated flag still requires the exact Nexus Vercel project, Production environment, `main` branch, and explicit `NEXUS_ENTITY_DELTA_PRODUCTION_ENABLED=true`. The canonical Production app origin and Supabase project checks remain in `cloud-sync.js`.
- **Server-side enrollment:** `supabase/production-activation/20261120200000_dla07_universal_delta_enrollment.sql` adds a private global rollout-control row defaulting to disabled. The authenticated enable RPC auto-creates an enabled per-owner row only when the global switch is enabled, but respects an existing `enabled=false` opt-out.
- **Concurrency and downgrade:** enable and downgrade take the global-control lock and the same owner-scoped advisory lock before the allowlist/workspace locks. All three DLA-03 downgrade success/idempotency branches now upsert a disabled owner override, including when the row is absent.
- **First snapshot bootstrap:** after a compatibility snapshot is successfully verified, the ordinary upload path repeats the authenticated enrollment handshake. The runtime now continues into Delta when the RPC has just created the owner sync-state row, rather than incorrectly treating the pre-RPC missing row as permanent snapshot mode.
- **Automatic fallback:** recoverable failures may invoke the existing DLA-03 owner-scoped downgrade only after an RLS-protected read confirms that owner is in Delta. The client verifies snapshot mode again after downgrade; snapshot writes remain blocked when the mode is unknown, downgrade fails, or recovery is pending.
- **Local validation wiring:** the new server package is copied only into the disposable local Supabase project by `scripts/prepare-phase34-local-supabase.mjs`; it is not added to the repository's standard production migration set. The authenticated RPC SQL test exercises global-off denial, automatic enrollment, explicit opt-out, and missing-row downgrade persistence. The focused DLA-07 source-contract test is wired into the local integration workflow.

**Validation status:** the first workflow attempt reached the existing source-contract suite and exposed one stale assertion that still expected the old `const deltaResult` spelling. That assertion has been updated to match the guarded upload coordinator. The corrected workflow run is pending; no automated test suite is marked complete here until GitHub Actions reports success.

**Production status:** the global database switch remains default-off. No Production database, Vercel environment variable, deployment, user enrollment, or live rollout action has been changed. Step 5 remains approval-gated and is not part of this implementation pass.

## Source files

- scripts/build.mjs — current fixed owner-list build gate.
- cloud-sync.js — runtime owner gate, initial snapshot bootstrap, and Delta failure handling.
- supabase/production-activation/20261120103000_dla05_production_entity_delta_canary_activation.sql — current server-side pilot eligibility and downgrade functions.
- docs/P35-04-final-acceptance-audit-2026-11-20.md — completed two-owner rollout evidence and its scope boundary.
