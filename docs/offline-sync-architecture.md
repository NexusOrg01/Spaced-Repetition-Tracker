# Nexus account-bound offline sync

## Scope of this increment

Nexus currently stores one complete workspace snapshot per authenticated user in `public.nexus_user_data`. The client uses owner-only row-level security (RLS) and conditional updates against `updated_at`. The repository does not define a per-operation server table or server-side idempotency RPC. This PR therefore adds a durable, account-bound local outbox for complete workspace snapshots while retaining the existing cloud contract. It is a safe bridge, not a claim that event-level replication is complete.

## Local outbox and retry rules

- Each pending snapshot records a stable operation ID, immutable owner user ID, workspace entity/type, schema version, monotonically increasing local sequence, base server revision, timestamps, and tracker + Study Hub payload.
- Workspace and outbox writes use the existing rollback-capable multi-key localStorage transaction helper. If the outbox write fails, the related workspace write rolls back.
- Pending snapshots are coalesced per owner because the current server stores a single whole-workspace snapshot. The latest snapshot replaces older unsent snapshots while retaining the original base server revision.
- Account A and Account B have independent queue entries. An upload requires the authenticated user ID and persisted workspace owner to match. Signing out does not remove the queue; switching accounts leaves the inactive account's pending snapshot parked.
- A snapshot is acknowledged only after a read-back verifies that the remote payload exactly matches the queued payload. If a response is lost after a successful write, a retry can recognize the already-committed payload and acknowledge it without issuing a second logical snapshot update.
- If the remote revision differs from the queued base and the payload does not already match, automatic writes pause and the existing explicit data-choice flow is used. A newer local snapshot created during an in-flight upload remains queued and is rebased only after the older snapshot is verified.
- If an explicit restore replaces a workspace with a pending snapshot, Nexus asks for confirmation and archives the previous snapshot in local recovery metadata before queuing the restored result.
- Invalid queue bytes are quarantined during the next workspace commit rather than silently overwritten. If the recovery slot is already occupied, the transaction fails closed and preserves the existing bytes.

## Backup compatibility

Portable JSON backups continue to include tracker state, validated FSRS cards embedded in topics, and Study Hub feature state. Backup metadata states that the account-bound queue itself is not portable; importing a queue into another browser/account would violate ownership isolation. Restoring a backup queues the resulting workspace under the currently persisted owner. A replace restore asks before archiving an existing pending snapshot. Legacy schema-3 backups continue through the existing migration path.

## Validation and limitations

- Automated queue tests cover owner binding, per-account isolation, coalescing/base revision preservation, acknowledgements, in-flight newer snapshots, explicit recovery archives, corrupted queue quarantine, failed atomic writes, and guest data not being assigned to an account.
- The existing conditional snapshot write and exact read-back verification remain the only server-side retry protection. This PR does not add server-side idempotency keys, per-record operation replication, append-only event replication, tombstones, or record-level conflict UI.
- Server authorization still depends on the existing `nexus_user_data` schema and RLS policies. No live Supabase schema or policy was changed. A separate test Supabase project was not exposed by the available connection, so live RLS enforcement and real-account cross-device tests remain unverified.
- The outbox stores a second copy of each owner's current pending workspace snapshot in localStorage. Large workspaces may approach browser storage quotas. A failed transaction rolls back and surfaces a save error; export a full JSON backup before continuing. A future IndexedDB migration should move workspace and queue together only after a tested recovery path is available.
- Do not test the preview against the production Supabase project. Do not merge until CI and the manual preview checklist pass.
