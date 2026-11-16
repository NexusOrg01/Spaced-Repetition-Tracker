# Phase 3.5 — Web/PWA scaling evidence, diagnostics and retention policy

## Capacity: measured evidence versus configured ceiling

The cloud chunk writer uses 256 KiB UTF-8 chunks, a maximum of 900 chunks (a **configured ceiling** of 235,929,600 bytes / 225 MiB), four rows per insert batch, 16 rows per read/verification page, a 1 MiB chunked-snapshot threshold, and a seven-day age threshold for superseded chunk cleanup. Cleanup scans at most 201 candidates and deletes at most 200 per pass. The writer rejects workspaces requiring more than 900 chunks before it publishes a manifest.

The PR's CI benchmark exercises UTF-8 partitioning at 1, 27, 64, 128 and 225 MiB, checks exact byte totals and chunk bounds, verifies multi-byte UTF-8 boundaries, and proves 225 MiB + 1 byte requires 901 chunks. CI records timings and process RSS in a JSON artifact. This is a Node.js runner benchmark of the partitioner, **not** proof that a browser, Android WebView, network or Supabase project can upload, hydrate, delete, recover or compact a 225 MiB workspace.

Separate Phase 3.4 local-Supabase evidence exercised a 26.9 MB workspace with 77,144 topics and 72,001 review-history rows through a two-client lifecycle, recovery and account-isolation checks. That remains the strongest end-to-end large-workspace measurement currently established by automated evidence. The configured 225 MiB ceiling must not be advertised as the supported workspace size.

**Provisional evidence envelope:** end-to-end automated verification is evidenced at approximately 26.9 MB in the controlled CI/local-Supabase fixture. The client rejects snapshots above the configured 225 MiB transport ceiling. Intermediate sizes (64/128 MiB) are measured only for chunk partitioning until full browser/network/backend lifecycle tests are available. Physical supported-device testing is still required.

## User-controlled operational diagnostics

Sync diagnostics remain opt-in through the existing user-controlled diagnostics toggle. The schema 4 export adds:

- Compatibility snapshot queue presence, local sequence and archived-snapshot count.
- Bounded observed entity-outbox depth, with explicit `hasMore`, exactness and snapshot-required flags.
- Device publish revision, acknowledgement sequence and **last locally observed** server-head revision (not a live remote read).
- Recent revision conflicts and merged-record conflict counts.
- Last observed remote chunk count and payload bytes.
- Local recovery-journal phase and recovery lock.
- Observed compaction/cleanup pending state, cleanup count/backlog signal/failure.
- IndexedDB availability, pending local writes and sync-error presence.

The collector reads at most 1,000 queued entity changes through the bounded IndexedDB API and records counts only. Conflict alternatives, topic content, account identifiers, operation identifiers, recovery digests, emails and credentials are not added to the operational summary. The report is generated locally and downloaded only after the user explicitly enables diagnostics and selects Download. It does not send telemetry. Values unavailable while Delta is disabled are reported as unavailable rather than guessed.

## Retention and recovery policy

| Data class | Current implementation | Retention / recovery policy |
|---|---|---|
| Active snapshot chunks | Immutable revision chunks referenced by the active manifest; database trigger protects active-manifest deletion | Never age-delete active chunks. Only a verified replacement manifest can supersede them. |
| Superseded and interrupted chunk uploads | Cleanup selects owner-scoped rows at least 7 days old, excludes active revision, probes 201 candidates and deletes at most 200 per pass | Retain for at least 7 days to allow interrupted publication/retry. Repeat cleanup on later successful sync; emit a backlog signal when the 201-row probe is full. Do not increase cap without a separate capacity/locking review. |
| Entity operation rows | Compaction removes only rows at or below the verified snapshot compaction floor; RPC limit is at most 5,000, with client calls capped at 2,000 rows and four rounds per pass | Never delete operations newer than the compaction floor. Remaining backlog is retried after a later verified checkpoint/idle sync. |
| Idempotency receipts | Compacted only at/below the verified floor and only after all operation rows for the receipt have been removed | Preserve receipts for un-compacted operations. A stale retry below the floor must request snapshot recovery, not be accepted as a new operation. |
| Delete tombstones | Represented in the ordered operation log and carried into the verified full snapshot | Retain until a snapshot at/above the delete revision is verified. Then the operation may be compacted because the snapshot carries the resulting deletion. No independent TTL for un-compacted tombstones. |
| Device cursors | Owner-scoped IndexedDB cursor tracks publish, acknowledgement and last observed server head; no age-based expiration | Do not age-delete. If cursor is behind the compaction floor or baseline mismatches, require verified snapshot reconciliation and cursor rebind. |
| Recovery journals | Durable prepared/staged/published phases; write locks survive restart | No age-based deletion. Keep an incomplete journal and staged candidate until verified local commit or explicit owner-scoped account deletion. Never clear it as generic cache cleanup. |
| Recovery completion receipts | Owner-scoped receipt supports idempotent replay after ambiguous outcomes | Keep until account deletion unless a separately reviewed retention protocol proves replay safety. |
| Offline snapshot queue | Per-owner queue; a pending item is acknowledged only after verified sync; replaced entries are archived; archived queue is bounded to 1,000 entries | Preserve unsynced data; do not prune pending snapshots by age. Archive is bounded by count, not time. |
| Conflict archive | Per-owner archive keeps the latest 10 conflict records | Count-bounded, not age-bounded. Do not export conflict alternatives in operational diagnostics. |

### Failure and fallback guarantees

- Active-manifest protection and snapshot-candidate validation are database-enforced after OPS-01 is applied.
- An interrupted upload must not replace the published manifest. Orphan chunks remain outside the active snapshot and become eligible only under the stale cleanup rule.
- Compaction uses a verified snapshot floor and bounded batches. Permission errors, aborts or invalid receipts remain pending rather than invalidating the verified snapshot.
- A device outside the retained Delta tail must recover from a verified full snapshot plus the remaining ordered tail. If reconstruction, hashes, revision checks or local commit verification fail, stop and preserve local work; do not silently apply a partial state.
- The existing snapshot path remains default-on for normal app sync; Delta remains default-off in production. If the chunk schema is missing, the app keeps the bounded legacy compatibility route for small snapshots and fails closed for oversized workspaces.
- Account deletion explicitly clears owner-scoped cursor, outbox, journal, completion receipt, queue and conflict archive. This is a deletion flow, not periodic retention cleanup.

## Phase 3.5 completion gates

- **P35-01 — partially verified:** the configured chunk ceiling is measured at the partitioner layer and the 26.9 MB lifecycle has separate end-to-end CI evidence. This is not a 225 MiB end-to-end/device capacity certification.
- **P35-02 — implemented for local export:** required metric categories are present where local state exists. Live server-head polling remains unavailable while Delta is disabled; the export labels this.
- **P35-03 — documented against current mechanisms:** no time-based pruning was added for cursors, recovery journals, completion receipts or un-compacted operations.
- **P35-04 — provisional, not 100% signed off:** production migration/read-back, backup/restore evidence and physical supported-device acceptance remain incomplete. Backup safeguards were explicitly waived for this task and Android device testing remains deferred by user instruction.
