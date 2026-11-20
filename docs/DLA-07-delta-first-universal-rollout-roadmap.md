# DLA-07 — Delta-first universal rollout

**Status:** Proposed  
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

## Source files

- scripts/build.mjs — current fixed owner-list build gate.
- cloud-sync.js — runtime owner gate, initial snapshot bootstrap, and Delta failure handling.
- supabase/production-activation/20261120103000_dla05_production_entity_delta_canary_activation.sql — current server-side pilot eligibility and downgrade functions.
- docs/P35-04-final-acceptance-audit-2026-11-20.md — completed two-owner rollout evidence and its scope boundary.
