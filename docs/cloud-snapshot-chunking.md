# Large-workspace cloud snapshots

## Format and publication

Small workspaces continue to use the existing `public.nexus_user_data.payload` JSONB snapshot. When a serialized workspace reaches 1 MiB, Nexus stores it as immutable rows in `public.nexus_user_data_chunks` (256 KiB UTF-8 chunks, inserted in batches of four). The payload row then becomes the small active manifest.

The manifest is published by the existing conditional write against `nexus_user_data.updated_at`. Before publication, Nexus reads every new chunk back, checks indexes/counts/UTF-8 byte lengths, reconstructs the serialized JSON, and verifies SHA-256. Only after this succeeds does the client move the active manifest pointer. A concurrent device that publishes first causes the conditional update to fail; the losing revision remains unreferenced and is eligible for later cleanup.

## Security and compatibility

The chunk table has RLS policies for SELECT, INSERT, and DELETE restricted to `auth.uid() = user_id`; it has no client UPDATE grant, so chunk rows are immutable through the Data API. Explicit authenticated table grants are included because Supabase no longer automatically exposes newly created public tables after 30 October 2026. The auth.users foreign key cascades account deletion.

Once a row contains a chunk manifest, a database trigger rejects legacy full-payload updates. Older clients cannot reconstruct the manifest and therefore fail closed rather than replacing the active revision with a stale snapshot. New clients always continue using chunk storage for an account once its cloud row has moved to chunked format.

## Recovery and cleanup

A failed chunk upload never changes the active manifest. Partial and losing revisions are left untouched until they are older than seven days. After a successful publication, Nexus best-effort deletes up to 200 stale chunk rows per sync, excluding the active revision. Cleanup failure does not change the verified sync result.

Portable JSON backup/restore remains unchanged. The local outbox is acknowledged only after the pre-publication chunk integrity check and post-publication manifest read-back both succeed. Cloud reads reconstruct and verify all chunks before the workspace can be applied locally.

## Operational requirements

Apply the migration to the isolated staging project first. Never apply it to production until a reviewed release is explicitly approved. Keep PR #126 in draft until heavy-workspace, interrupted-upload, two-device revision-race, account-isolation, and Android WebView tests pass.
