# Nexus account-bound offline sync

## Scope of this increment

Nexus currently stores one complete workspace snapshot per authenticated user in `public.nexus_user_data`. The client uses owner-only row-level security (RLS) and conditional updates against `updated_at`. The repository does not define a per-operation server table or server-side idempotency RPC. This PR therefore adds a durable, account-bound local outbox for complete workspace snapshots while retaining the existing cloud contract. It is a safe bridge, not a claim that event-level replication is complete.

## Local outbox and retry rules

- Each pending snapshot records a stable operation ID, immutable owner user ID, workspace entity/type, schema version, monotonically increasing local sequence, base server revision, timestamps, and tracker + Study Hub payload.
- Workspace and outbox writes use the existing rollback-capable multi-key localStorage transaction helper. If the outbox write fails, the related workspace write rolls back.
- Pending snapshots are coalesced per owner because the current server stores a single whole-workspace snapshot. The latest snapshot replaces older unsent snapshots while retaining the original base server revision.
- Network restoration (`online`), page return (`pageshow`), and foregrounding (`visibilitychange`) re-check pending work. Transient connection/upload failures retry with exponential backoff from 1.5 seconds up to 5 minutes; retries pause for a confirmed revision conflict, an explicit data-choice requirement, sign-out, or an unsafe preview origin.
- On reconnect, every pending snapshot is checked even when the normalized tracker and Study Hub state appears equal to the cloud; this prevents metadata-only differences from leaving an outbox item stranded while the UI says “Synced.” A queued snapshot is uploaded automatically only when the observed remote revision still equals its stored base revision (or both remain absent for a first insert). A matching remote payload is acknowledged as already committed, including after a lost write response; a newer remote revision is treated as a conflict and is not overwritten automatically.
- Account A and Account B have independent queue entries. An upload requires the authenticated user ID and persisted workspace owner to match. Signing out does not remove the queue; switching accounts leaves the inactive account's pending snapshot parked.
- A snapshot is acknowledged only after a read-back verifies that the remote payload exactly matches the queued payload. If a response is lost after a successful write, a retry can recognize the already-committed payload and acknowledge it without issuing a second logical snapshot update.
- If the remote revision differs from the queued base and the payload does not already match, automatic writes pause and the existing explicit data-choice flow is used. A newer local snapshot created during an in-flight upload remains queued and is rebased only after the older snapshot is verified.
- If an explicit restore replaces a workspace with a pending snapshot, Nexus asks for confirmation and archives the previous snapshot in local recovery metadata before queuing the restored result.
- Invalid queue bytes are quarantined during the next workspace commit rather than silently overwritten. If the recovery slot is already occupied, the transaction fails closed and preserves the existing bytes.

## Backup compatibility

Portable JSON backups continue to include tracker state, validated FSRS cards embedded in topics, and Study Hub feature state. Backup metadata states that the account-bound queue itself is not portable; importing a queue into another browser/account would violate ownership isolation. Restoring a backup queues the resulting workspace under the currently persisted owner. A replace restore asks before archiving an existing pending snapshot. Legacy schema-3 backups continue through the existing migration path.

## Validation and limitations

- Automated queue tests cover owner binding, per-account isolation, coalescing/base revision preservation, acknowledgements, in-flight newer snapshots, explicit recovery archives, corrupted queue quarantine, failed atomic writes, and guest data not being assigned to an account.
- The existing conditional snapshot write and exact read-back verification remain the only server-side retry protection. The retry policy is client-side: it improves eventual recovery while the page is open or returns to the foreground, but it is not a background sync worker and cannot run while the browser/app process is closed. This PR does not add server-side idempotency keys, per-record operation replication, append-only event replication, tombstones, or record-level conflict UI.
- Server authorization still depends on the existing `nexus_user_data` schema and RLS policies. No live Supabase schema or policy was changed. Manual synthetic-account tests on the preview passed for workspace persistence and A/B isolation. Real cross-browser/cross-device sync remains unverified, and the CI tests verify retry policy/wiring but are not a full browser-driven Supabase failure-injection test.
- The outbox stores a second copy of each owner's current pending workspace snapshot in localStorage. Large workspaces may approach browser storage quotas. A failed transaction rolls back and surfaces a save error; export a full JSON backup before continuing. A future IndexedDB migration should move workspace and queue together only after a tested recovery path is available.
- Do not test the preview against the production Supabase project. Do not merge until CI and the manual preview checklist pass.

## Account-switch display isolation

The account UI exposes the active Supabase user ID in the account element's title. A first-party guard compares that identity to the persisted workspace owner. If they differ, it covers and makes the app inert until the active account owns the loaded workspace. If a cloud load fails, the previous workspace remains stored but hidden; retrying reloads the active session, while signing out restores offline access to the previous workspace. This is a client-side display-safety barrier, not encryption of browser storage.
