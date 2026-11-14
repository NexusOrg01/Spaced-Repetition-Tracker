# Large-workspace cloud snapshots

## Format and publication

Small workspaces continue to use the existing `public.nexus_user_data.payload` JSONB snapshot. When a serialized workspace reaches 1 MiB, Nexus stores it as append-only rows in `public.nexus_user_data_chunks` (256 KiB UTF-8 chunks, inserted in batches of four and read back in pages of sixteen). The payload row then becomes the small active manifest.

The manifest is published by the existing conditional write against `nexus_user_data.updated_at`. Before publication, Nexus reads every new chunk back, checks indexes/counts/UTF-8 byte lengths, reconstructs the serialized JSON, and verifies SHA-256. Only after this succeeds does the client move the active manifest pointer. A concurrent device that publishes first causes the conditional update to fail; the losing revision remains unreferenced and is eligible for later cleanup.

## Security and compatibility

The chunk table has RLS policies for SELECT, INSERT, and DELETE restricted to `auth.uid() = user_id`; it has no client UPDATE grant. A database-side `BEFORE DELETE` trigger independently checks the current `nexus_user_data` manifest before allowing a chunk deletion. The trigger locks the parent workspace row, serializing the check with snapshot publication; it raises SQLSTATE `55000` when the target revision is still active. Therefore a stale or incorrect client-side cleanup filter cannot remove the active snapshot. The trigger function lives in the non-exposed `nexus_private` schema, pins an empty search path, and grants no schema/function access to browser roles. Explicit authenticated table grants are included because Supabase no longer automatically exposes newly created public tables after 30 October 2026. The auth.users foreign key cascades account deletion; the trigger permits this cascade after the auth.users parent row has been removed.

Once a row contains a chunk manifest, a database trigger rejects legacy full-payload updates. Older clients cannot reconstruct the manifest and therefore fail closed rather than replacing the active revision with a stale snapshot. New clients always continue using chunk storage for an account once its cloud row has moved to chunked format.

## Recovery and cleanup

A failed chunk upload never changes the active manifest. Partial and losing revisions are left untouched until they are older than seven days. After a successful publication, Nexus best-effort deletes up to 200 stale chunk rows per sync, excluding the active revision. The database trigger remains the final authority: it blocks deletion if a cleanup race or bad exclusion value targets the manifest that is active when the delete runs. Once another manifest is published, the previous revision becomes eligible for cleanup. Cleanup failure does not change the verified sync result.

Portable JSON backup/restore remains unchanged. The local outbox is acknowledged only after the pre-publication chunk integrity check and post-publication manifest read-back both succeed. Cloud reads reconstruct and verify all chunks before the workspace can be applied locally.

## Operational requirements

Apply the migration to the isolated staging project first. Never apply it to production until a reviewed release is explicitly approved. Keep PR #126 in draft until heavy-workspace, interrupted-upload, two-device revision-race, account-isolation, and Android WebView tests pass.
