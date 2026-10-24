# Nexus cloud-first storage migration plan

**Status:** Design and readiness plan only. No application storage code is changed by this document.

## Executive decision

Move signed-in workspaces toward **Supabase as the durable source of truth** and **IndexedDB as the local working copy and offline outbox**. Keep a local-only guest workspace for people who do not sign in. Do not make a hurried switch from localStorage directly to remote-only operation: that would make studying depend on connectivity and could destroy unsynced data.

The first cloud-first release should retain the existing single-workspace snapshot contract in `public.nexus_user_data`. It already has owner-only row-level security and conditional writes. Do not normalize the entire workspace into dozens of tables or introduce a second replication protocol in the same change. Make local persistence reliable first, then consider server-side revisions or per-record replication as a separate project.

## Current-state audit

Audited against repository main commit `dfcc7fc780f5a2cca03ae6149cee1fd520afedc3` on 2026-10-24. Migration/security cleanup is tracked separately in PR #113; it remains unmerged.

### What is already implemented

- Supabase Auth supports signed-in accounts. The cloud backup table stores one JSON workspace snapshot per account, keyed by `user_id`.
- Owner-only RLS policies let authenticated users select, insert, and update their own row. Cloud writes compare the observed `updated_at` value before updating and verify the result by reading the row back.
- The client already has an account-bound outbox, a last-confirmed common merge base, conflict-recovery archives, bounded retry/reconnect logic, and a three-way merge implementation. It protects same-account concurrent edits and keeps FSRS scheduling fields coherent when the same topic is reviewed on two devices.
- Account switching is guarded. Pending items are tied to a user ID; the client does not intentionally upload one account's offline snapshot under another account.
- Portable JSON backups include tracker state, FSRS data embedded in topics, and Study Hub data. Legacy schema-3 backups have a migration path.
- Automated runtime tests cover many simulated race, recovery, account-isolation, and offline cases.

### Remaining constraint

The active app workspace, FSRS settings/cards, outbox, merge base, and conflict archive still rely on browser localStorage. Compaction reduces space usage but does not remove browser quota, eviction, or site-data-clearing risk. Most of the app's save paths currently use synchronous localStorage operations; replacing them with IndexedDB must therefore include a deliberate bootstrap/storage-boundary refactor, not only a new helper file.

Cloud sync also remains a client-driven whole-workspace snapshot protocol. Its retries run when the page is open or returns to the foreground; it is not a guaranteed background worker while the app is closed. Guest work remains device-local until the user exports it or chooses to attach it to an account.

## Target behavior

1. **Signed in, online:** authenticate, fetch the user's remote workspace and revision, hydrate the local working copy, then save changes through the existing conditional cloud-write/reconciliation protocol. A successful save means the local durable transaction has completed and the remote write has been verified.
2. **Signed in, offline:** read and write the user's IndexedDB workspace. Keep one coalesced pending workspace snapshot per account with its original cloud base revision. Retry when connectivity and the app return; never silently overwrite a newer cloud revision.
3. **Guest mode:** use a separate, device-local workspace in IndexedDB. Do not upload it until the person explicitly chooses an account and confirms how guest data should be handled.
4. **Account switch/sign-out:** retain workspaces and queues under their original owner key. A failed cloud fetch must not expose another account's saved workspace as if it belonged to the active account.
5. **Browser storage migration:** preserve the current localStorage records until the IndexedDB copy is validated and can be read back. Never delete old data as part of the first migration attempt.
6. **Export and recovery:** keep a portable JSON backup independent of the sync queue. Queue IDs, account ownership and internal merge metadata are not portable workspace data.

## Proposed local data model

Use one IndexedDB database (for example, `nexus-workspace-v1`) with an explicit schema version and transaction-based writes:

| Store | Key and contents | Purpose |
|---|---|---|
| `workspaces` | owner key → normalized tracker + Study Hub snapshot, schema, checksum, local revision, saved time | Durable local working copy for each account and the guest workspace |
| `syncMeta` | owner key → last confirmed cloud revision and common base snapshot reference | Three-way reconciliation after reconnect |
| `outbox` | owner key → operation ID, local sequence, base cloud revision, snapshot, status and timestamps | Durable retry queue, coalesced because the server currently stores one snapshot per account |
| `conflicts` | owner key + conflict ID → base/local/remote alternatives and resolution metadata | Local recovery when concurrent edits conflict |
| `migrationMeta` | device-level migration marker, source checksum, completed steps and timestamps | Idempotent migration from existing browser data |

Implementation details:
- Use structured-cloneable JSON values and schema/version validators. Continue validating stable IDs before merging.
- Commit the workspace, outbox snapshot, base revision, and conflict alternatives in one IndexedDB transaction when they form one logical change.
- Queue writes in a serialized transaction layer. Surface a visible save/sync error if persistence fails; do not acknowledge an outbox item just because an in-memory or localStorage write succeeded.
- Keep the remote snapshot's `updated_at` compare-and-swap guard for the first release. Do not introduce new database columns or an RPC until IndexedDB migration and restore tests pass.
- Do not put the Supabase service-role/secret key in the browser. Only use the existing publishable client key and authenticated RLS access.

## Implementation phases

### Phase 0 — finish the foundation

- Review PR #113 and its read-only migration history check; keep it separate from the storage refactor.
- Keep production untouched until a separate, explicit release approval. Use the existing staging project for database and auth tests.
- Preserve the current JSON export path as an independent recovery route.

### Phase 1 — map the real storage boundary

- Inventory every key and caller in the app, including tracker state, FSRS settings/cards, Study Hub, current account owner, offline outbox, merge base, conflict archive, focus/session state, installed curriculum intents, and deletion tombstones.
- Add a versioned `NexusStorage` contract for open/read/write/remove/transaction/flush/migrate operations.
- Do not remove old direct storage paths until the inventory and regression tests cover them.

### Phase 2 — implement IndexedDB and one-time migration

- Add the IndexedDB database and transaction helpers with tests for quota/transaction failure, interrupted migration, malformed legacy values, and schema upgrades.
- On first startup, open IndexedDB before the main application reads workspace data. Copy existing localStorage values only when the corresponding IndexedDB owner/workspace is absent. Validate after write and keep the original localStorage copy as a rollback source.
- Migration must be idempotent: a reload at any step can safely continue without duplicating records or overwriting a newer IndexedDB/cloud version.
- Do not treat an empty database as permission to overwrite a non-empty local or remote workspace.

### Phase 3 — switch app persistence behind a controlled flag

- Route the tracker, FSRS, Study Hub, and sync metadata through the storage contract. Refactor startup and mutation paths to account for asynchronous IndexedDB initialization/flush instead of relying on localStorage's synchronous return.
- Keep a compatibility mirror only while it is needed for rollback. Make IndexedDB the primary offline workspace store after parity tests pass.
- Serialize writes and expose a clear persistence state (saving, saved offline, syncing, synced, conflict/action required). Cloud sync must wait for the matching IndexedDB transaction to commit.
- Use a feature flag or versioned rollout setting so the new storage path can be disabled without deleting either copy.

### Phase 4 — make signed-in startup cloud-first

- Wait for auth resolution before selecting an account workspace.
- Fetch the active account's cloud row and revision before declaring the signed-in workspace ready.
- If a cloud workspace exists and there is no queued local work, hydrate from the cloud and persist that revision into IndexedDB.
- If pending local work exists, compare Base, Local and Cloud through the existing merge/recovery code. Verify the remote revision before any write.
- If the account has no cloud row, require an explicit choice before uploading non-empty guest/local data. If neither remote nor local data exists, create a new empty workspace with an insert—not an upsert that can overwrite a concurrently created row.
- Keep sign-out and account-switch isolation tests as release blockers.

### Phase 5 — recoverability and conflict behavior

- Move outbox, common base, and conflict archive to IndexedDB in the same transaction model as the workspace.
- Preserve queue owner IDs and stable operation IDs. A lost HTTP response must be reconciled by remote read-back before a retry is acknowledged.
- Retain the current bounded automatic merge behavior. Do not automatically overwrite on a stale base revision.
- Ensure the backup exporter reads the canonical IndexedDB workspace and includes FSRS + Study Hub state regardless of online status.
- Restore must validate the full payload first, confirm any pending-queue archive decision, then atomically commit the replacement workspace and new queued snapshot.

### Phase 6 — staging validation and rollout

- Run the build and existing regression, curriculum integrity, backup/restore, cloud-sync runtime, conflict-recovery, outbox, and data-safety tests.
- Add IndexedDB-specific automated tests for upgrade interruption, reload recovery, cross-account isolation, quota failure, and transaction rollback.
- Test with two independent browser profiles/devices against staging: offline edits, independent edits, same-field conflicts, simultaneous FSRS reviews, Commerce pack install/delete/refresh, Study Hub, backup/restore, sign-out, and switching accounts.
- Confirm remote contents by signing in on a clean second browser; a passing mocked runtime test is not a substitute for this.
- Start with an opt-in/limited rollout. Keep the old data untouched, compare normalized checksums during the observation period, and retain a tested rollback path before removing the compatibility mirror.

### Phase 7 — only later, evaluate server-side protocol improvements

After the IndexedDB release is stable, evaluate a monotonic server revision or a security-reviewed RPC for idempotent conditional updates. Consider per-record tables/event replication only if actual scale or collaboration requirements justify the complexity. Do not combine such a redesign with the local-store migration.

## Required tests and release gates

- Existing guest data, an existing signed-in account, a newly created account, and two separate accounts on one device.
- New browser with cloud data but no local data; fresh account with non-empty guest data; empty cloud row; fetch error; expired session.
- Offline creation/edit/delete and reconnect; repeated retries; app closed and reopened; lost write response; concurrent writes from two devices; remote revision changes mid-upload.
- Concurrent edits to different records; edit versus delete; simultaneous review of the same topic; topic scheduling consistency; Study Hub checklist set union.
- Install/delete/refresh of the Commerce curriculum pack and future installed packs, including preservation of install markers and deletion tombstones.
- Full JSON export/import with tracker, FSRS, and Study Hub. A failed restore must leave the previous workspace and queue intact.
- IndexedDB quota/transaction failure and interrupted version upgrade; do not show a green “Saved” state until persistence has completed.
- Security: owner-only RLS, no anonymous backup access, account-switch display isolation, and no service-role key shipped to the client.

**Release gate:** no production migration, production Auth setting change, or live-app deployment without explicit approval. The preview must use staging Supabase, not production data.

## What you need to prepare

No new hosting account, database, paid plan, CLI installation, or database-password reset is needed to begin the implementation work.

Before the implementation PR is tested, please keep these safeguards ready:

1. Export a fresh Nexus JSON backup from every browser/device profile that contains study data. Different devices can have different local work, even when signed into the same account. Keep each export separate and do not upload it to a public issue.
2. If Nexus shows pending sync/conflict recovery, download its conflict-recovery file as well. Do not clear browser/site data or uninstall the PWA during migration testing.
3. Keep the current production app unchanged while staging tests run. No passwords, access tokens, or secret API keys need to be sent in chat.

I will handle source code, tests, staging-only migration work, and the implementation PR. Any production-side change remains a separate approval gate.
