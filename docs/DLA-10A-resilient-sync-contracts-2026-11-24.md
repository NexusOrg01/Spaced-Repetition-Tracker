# DLA-10A — Non-Blocking Resilient Sync Architecture and Contract Freeze

**Date:** 24 November 2026  
**Workstream:** DLA-10 — Non-Blocking Resilient Sync  
**PR:** [#147](https://github.com/NexusOrg01/Spaced-Repetition-Tracker/pull/147)  
**Branch:** `fix/sync-account-handoff-reliability`  
**Scope:** Web/PWA sync architecture and durable-operation contracts. This document does not enable Delta, grant RPC access, apply migrations, merge the PR, or authorize production changes.

## 1. Objective and governing decisions

Nexus must remain usable from an owner-verified local workspace while cloud synchronization proceeds independently. A local edit must become durable before the UI reports it saved. Network loss, tab closure, browser closure, refresh, and account switching must not silently discard accepted work.

The following decisions are frozen for DLA-10:

1. **Local readiness and cloud verification are separate states.** A verified local workspace may be shown while cloud work is pending. Rendering local data never means `Synced`.
2. **The owner is the durable security boundary.** Every persisted workspace, outbox operation, cursor, receipt, and recovery journal is partitioned by the authenticated owner ID.
3. **Session epochs fence live work, not durable identity.** A request captures the current owner and session epoch and revalidates both around asynchronous boundaries. A session epoch is not a durable authorization token: it changes on reload. A queued operation survives reload under its owner and must be revalidated against the newly authenticated session before replay.
4. **Operation IDs are stable across retries.** A retry reuses the same operation ID and exact payload hash. A changed payload requires a new operation ID.
5. **Acknowledgement is a verified commit, not a successful HTTP/RPC response.** The server receipt and resulting revision/head must be validated, then the local cursor and outbox acknowledgement must commit atomically.
6. **No execution after close is assumed.** Closing a tab/browser stops page JavaScript. Correctness comes from durable local state and resumption on the next application start or online event. Service-worker/background-sync execution may optimize latency but is never a correctness prerequisite.
7. **Snapshot/chunk remains the compatibility and recovery path.** Delta is additive, versioned, gated, and fail-closed. Unsupported schema, missing/gapped revisions, compaction-floor misses, expired receipts, or failed verification require snapshot recovery.
8. **No full-screen sync lock is permitted after the local workspace is safely available.** Account identity rotation may synchronously isolate the old workspace; ordinary sync must not block navigation or editing once local readiness is established.

## 2. Existing architecture map — verified on PR #147

| Layer | Current implementation | Responsibility and boundary |
|---|---|---|
| Workspace edit/save | `app-core.js` — `save()`, `NexusOfflineSyncQueue.commitWorkspace()` | Serializes tracker and Study Hub state, commits the compatibility snapshot queue, and requests IndexedDB persistence/projection work. |
| Legacy snapshot queue | `offline-sync-queue.js` | Schema-versioned owner-keyed pending snapshot, stable operation ID for that queued snapshot, local sequence, base server stamp, conflict archive, and recovery-completion markers. |
| Durable local storage | `nexus-storage.js` | IndexedDB records/workspace snapshots, owner-scoped entity generations, sequence-indexed outbox, operation markers/fingerprints, delta cursor, recovery journal, and atomic local acknowledgement/apply/recovery transactions. |
| Snapshot/chunk transport | `cloud-chunk-storage.js` | JSONB/chunk snapshot read/write, immutable chunk revisions, SHA-256 verification, manifest publication, compare-and-swap, and bounded cleanup. Current chunk policy is 256 KiB UTF-8 chunks, bounded insert/read batches, and a 900-chunk ceiling. |
| Entity Delta protocol | `entity-delta-sync.js` | Owner verification, bounded remote pages, grouped publication, receipt/read-back validation, atomic pull application, conflict preparation, recovery publication, and snapshot fallback. |
| Reconciliation | `workspace-sync-merge.js` | Three-way base/local/remote merge, stable entity identity, conflict recording, and cooperative asynchronous comparison. |
| Session/coordinator/UI | `cloud-sync.js` | `sessionEpoch`, owner checks, abort scopes, synchronous workspace isolation on identity rotation, retry scheduling, online resumption, local-ready handling, watchdogs, and truthful sync status. |

### 2.1 Current local outbox record shape

The current IndexedDB entity outbox uses owner/generation-scoped records with fields including:

- `ownerId`, `generation`, `sequence`, `operationId`
- `kind` (`change`, operation marker, or sequence-indexed operation marker)
- `collection`, `entityId`, `operation`, `position`, `positionMode`
- `createdAt` and an operation-payload SHA-256 fingerprint on the idempotency marker

The current cursor carries the protocol version, owner, generation, workspace revision, published revision, acknowledged sequence, remote head revision, snapshot stamp, and `requiresPull`. The server receipt carries the operation ID, committed revision, head revision, and change count.

This is an existing Delta outbox, but it is not yet the complete DLA-10 durable-save contract below. In particular, ordinary app saves currently commit the workspace/legacy snapshot queue first and call `syncWorkspaceEntities()` separately after the durable flush. The entity outbox is therefore not yet part of the same IndexedDB transaction as every accepted ordinary edit.

## 3. Frozen durable operation contract — target for DLA-10B

The canonical operation is an **owner-scoped logical change group**. A group may contain multiple entity changes that must become visible together, such as a review plus its history row or a stream/subject cascade.

| Field | Contract |
|---|---|
| `recordVersion` | Version of the local outbox record envelope. Unknown versions are preserved and block replay; they are never silently discarded. |
| `protocolVersion` | Remote protocol contract version. Current Delta cursor protocol is version 1. |
| `ownerId` | Authenticated Supabase user ID. Required on every record and included in the storage key/owner partition. |
| `operationId` | Secure, stable idempotency ID for this logical group. Reused unchanged for every retry. |
| `generation` | Local entity-projection generation to which the operation belongs. A generation mismatch blocks publication until reconciliation. |
| `operationType` / `payloadVersion` | Explicit logical operation type and payload schema version. A payload is validated before enqueue and again before transport. |
| `sequence` | Monotonic per-owner local ordering value. Groups are dispatched in order; a later group cannot overtake an unresolved dependency. |
| `dependsOn` | Zero or more prior operation IDs that must be acknowledged before this group is dispatched. Sequence order remains the primary total order. |
| `baseRevision` | Verified server revision against which the operation was prepared/rebased. A stale base is a conflict, not permission to overwrite. |
| `targetRevision` | Null until the server returns a validated durable receipt; then set to the receipt's committed revision. |
| `changes` | Bounded ordered entity changes with collection allowlist, stable entity ID, put/delete operation, validated value, and ordering metadata. |
| `requestHash` | Canonical SHA-256 of the exact normalized operation payload. The server independently computes its hash. |
| `createdAt`, `updatedAt` | UTC timestamps for diagnostics and retention. They are not ordering or concurrency tokens. |
| `attemptCount`, `lastAttemptAt`, `nextAttemptAt` | Durable retry metadata. Retry scheduling is bounded and resumes after reload; wall-clock values do not replace revision checks. |
| `lastErrorCode` | Allowlisted non-sensitive failure category only. Never persist tokens, raw payloads, or unfiltered server errors. |
| `deliveryState` | One of `pending`, `in_flight`, `awaiting_receipt`, `conflict`, `recovery_required`, or `acknowledged`. An `in_flight` record found after restart returns to `pending` after owner/schema validation. |
| `acknowledgement` | Null until verified. Then contains the operation ID, request hash, server revision/head, change count, and acknowledgement time from the validated receipt. |

### 3.1 Session/epoch fence

The durable record is bound to `ownerId`, not to a session epoch that becomes obsolete on reload. An in-flight sender captures `{ ownerId, sessionEpoch }` and an abort signal. It must check that fence before dispatch, after every awaited network response, before local acknowledgement, and before updating UI state.

An optional `createdSessionEpoch` may be stored for diagnostics only. It must never authorize replay. On startup, the application authenticates the owner again, rotates to a new epoch, and revalidates the durable operation under that owner.

### 3.2 Lifecycle transitions

- Normal delivery: `pending → in_flight → awaiting_receipt → acknowledged`
- Transient network/timeout/ambiguous response: `in_flight|awaiting_receipt → pending` with bounded retry metadata; reuse the same operation ID and hash.
- Revision conflict: `in_flight → conflict → reconciling → pending` with an explicitly rebased operation, or `recovery_required` when three-way recovery is necessary.
- Recovery: `recovery_required → prepared → staged → published → committed`. The account write lock remains until the atomic local recovery commit.
- Restart: any persisted `in_flight`/ `awaiting_receipt` state is rechecked by operation ID and hash; it is not assumed failed or successful merely because the previous page disappeared.

## 4. Checkpoint and commit semantics

### 4.1 Local save commit point

The local commit point is one successful IndexedDB transaction containing the accepted workspace snapshot/revision, its owner-scoped outbox operation group, and the associated ordering/idempotency metadata. Only after that transaction commits may the UI report **Saved on this device**. If it fails, the save is reported as failed; the application must not claim that the durable outbox accepted the edit.

The legacy snapshot queue remains available for snapshot-mode compatibility. It must not be acknowledged or removed as a side effect of merely creating a Delta outbox record.

### 4.2 Publish/acknowledgement commit point

A publish response is not enough. The client must validate:

- exact owner and operation ID;
- request hash/payload identity;
- committed revision equals the expected next server revision;
- server head is not behind the committed revision;
- change count matches the group;
- the durable receipt/read-back is consistent with the operation.

Then one IndexedDB transaction advances the cursor and acknowledges/removes only the exact operation group. On timeout, ambiguous response, owner/epoch change, malformed receipt, or revision conflict, the local operation remains pending.

### 4.3 Pull commit point

A remote page is validated before application. Each complete operation group and its cursor advancement commit atomically. A failed transaction leaves the prior generation/cursor and all pending local work intact. No partial group is visible.

### 4.4 Snapshot recovery commit point

The existing recovery journal phases are `prepared`, `staged`, and `published`; the final local commit atomically switches the active generation, commits tracker and Study Hub compatibility snapshots, updates the cursor and snapshot base/queue state, records a completion receipt, and removes the live recovery intent. The published phase requires exact remote snapshot read-back proof. A restart resumes from the durable journal; it does not infer success from a network call.

## 5. Idempotency, ordering, and conflict policy

- The same `operationId + requestHash` returns the original server receipt/revision and creates no duplicate operation group.
- The same operation ID with a different hash is a hard idempotency conflict.
- Server revisions are authoritative and monotonically allocated per owner. Timestamps and client clocks are diagnostic only.
- One logical multi-entity action is one operation group and one server revision. Groups are never split across read pages.
- A stale `baseRevision` produces a structured revision conflict. The client pulls the missing remote state, revalidates its local generation/cursor/outbox, and performs a three-way merge.
- Non-overlapping edits may be merged. Same-identity overlapping edits are preserved as conflicts/recovery candidates; they are not silently overwritten.
- A cursor below the compaction floor, a missing/gapped revision, unsupported payload version, expired receipt, malformed group, or failed integrity check requires a verified full snapshot recovery.
- Tombstones remain until a verified snapshot advances the compaction floor beyond them. Wall-clock age alone never authorizes deletion.

## 6. Snapshot/Delta compatibility and migration contract

1. Existing JSONB and chunked snapshot readers/writers remain the compatibility and recovery path. Chunk publication verifies chunk order, count, bytes, reconstructed payload, and SHA-256 before manifest publication.
2. Delta remains explicitly gated. Existing accounts stay in snapshot mode unless a separately controlled staging eligibility decision is made. The current preview gate remains default-off and browser RPC grants remain revoked until the applicable staging acceptance work is complete.
3. The Delta marker `entity-delta-v1` must not be mistaken for an ordinary legacy workspace. Older snapshot-only clients fail closed rather than overwrite a Delta account.
4. The current legacy offline snapshot queue is schema version 1; the local Delta cursor is protocol version 1. DLA-10B adds versioned outbox records without silently reinterpreting or deleting legacy pending snapshots/outbox rows.
5. Migration is additive and owner-scoped. Read old records with explicit compatibility defaults, validate them, and preserve them until a new record/receipt is proven. Unknown future versions pause replay and retain the data for recovery.
6. No production migration, feature-gate activation, RPC grant, account reset, or production configuration change is part of DLA-10.

## 7. Non-blocking UI and lifecycle contract

- Once an owner-verified local workspace is ready, navigation and editing remain available while sync continues.
- The UI distinguishes `Local workspace ready`, `Sync pending`, `Syncing`, `Sync delayed`, and `Synced`. `Synced` requires verified convergence: cursor at the server head, no unacknowledged outbox group, and the existing read-back checks satisfied.
- A watchdog is a feedback deadline, not permission to expose unverified data or falsely report success.
- Offline/network loss retains pending operations and their IDs. The online event or next application start resumes them automatically.
- Tab/browser closure stops page execution. The system guarantees durable state and next-start resumption, not continued JavaScript execution after close.
- Account rotation synchronously isolates the previous workspace, aborts old-epoch work, and prevents old callbacks from acknowledging or updating the new owner's UI.

## 8. Current-head reconciliation and open evidence

**Baseline inspected:** PR #147, branch `fix/sync-account-handoff-reliability`, commit `7256d1cf5b145a83af2c7e2f7f56b73f515961a6`.  
**Preview:** https://spaced-repetition-tracker-cw19rlsnk-recall-ed03.vercel.app/  
**Netlify preview:** https://deploy-preview-147--nexussrt.netlify.app

- Validate workflow run **#2191** passed on this head. It runs the storage, offline queue, entity-delta client, cloud recovery/runtime, merge, isolation, safety, build, and security checks.
- Phase 3.4 local authenticated two-client integration run **#677 failed** at the 26.9 MB lifecycle step. The browser harness timed out waiting for initial sync verification after 180 seconds. The trace reached `commit-local-recovery` but did not emit its completion before the test deadline. Post-timeout diagnostics showed the local edit and active projection still readable; they did not establish verified cloud convergence. This is not a pass and must not be recorded as data-loss proof or as successful sync.
- Latest ⭐ ledger reconciliation: DLA-09A remains blocked on app-level recovery proof; DLA-09B remains partial (the prior cold-restore sample was 130.176 seconds, above the 60-second target); DLA-09C and DLA-09D remain supported by the current green focused validation; DLA-09E timing qualification remains open. The failed run #677 reinforces that DLA-09A/B/E are not closed.
- The current save path confirms the DLA-10B implementation gap: `app-core.js` commits the workspace and legacy snapshot queue, then awaits IndexedDB flush and calls `syncWorkspaceEntities()` separately. The entity projection/outbox transaction is not atomic with the accepted ordinary workspace edit. Current outbox rows also lack explicit payload-version, dependency, retry, and delivery-state fields; the cursor and operation markers currently carry part of that information.

These open DLA-09 results are carried forward as risks. They are not silently marked complete by this architecture freeze.

## 9. DLA-10A acceptance checklist

- [x] Snapshot/chunk, Entity Delta, IndexedDB projection/outbox, legacy offline queue, merge, and account/session mechanisms mapped to current modules.
- [x] Durable operation schema and versioning fields defined, including owner, stable operation ID, epoch fence semantics, ordering/dependencies, base/target revisions, retry metadata, delivery state, and verified acknowledgement.
- [x] Local, publish, pull, and recovery checkpoint/commit points defined.
- [x] Idempotency, duplicate receipt, stale-base, concurrent-device, compaction-floor, and recovery conflict behavior defined.
- [x] Lifecycle/status transitions and local-ready versus cloud-verified semantics defined.
- [x] Snapshot/Delta compatibility and additive migration policy defined.
- [x] Browser/tab closure is explicitly treated as termination of page execution; durable next-start resumption is the correctness guarantee.
- [x] Current implementation gaps and failed current-head integration evidence recorded without overstating completion.
- [ ] Automated contract guard and final PR validation pass on the resulting DLA-10A commit.

**Exit gate:** DLA-10B may start only after the automated contract guard and the relevant PR validation pass. DLA-10A does not authorize a merge, deployment/promotion, production write, staging RPC grant, or production database/configuration change.
