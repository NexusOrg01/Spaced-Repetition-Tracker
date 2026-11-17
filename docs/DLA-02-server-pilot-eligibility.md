# DLA-02 — Server-side Entity Delta pilot eligibility

**Implementation branch:** `feat/dla-02-server-pilot-eligibility`  
**Dependency:** DLA-01 hosted QA gate / QA-01 staging workspace  
**Environment boundary:** isolated `nexus-sync-staging` only; no production changes  
**State boundary:** eligibility is not activation; the designated workspace remains in snapshot mode until DLA-03 and DLA-04 are accepted.

## Security design

Standalone activation migration `supabase/pilot-migrations/20261117083717_add_entity_delta_pilot_eligibility.sql` creates `nexus_private.entity_delta_pilot_allowlist`. The table is empty after migration and every row defaults to `enabled=false`. The primary key is the Auth owner UUID and deletion of an Auth identity cascades to its eligibility row.

The table is not exposed to browser roles. `PUBLIC`, `anon`, `authenticated`, and `service_role` have no `nexus_private` schema usage or table privileges. The security-definer enablement RPC reads the allowlist as its existing ``postgres`-owned function; it returns `pilot_not_enabled` before inspecting or changing a workspace when the authenticated owner is not explicitly enabled.

The six reviewed Delta RPCs are executable by `authenticated` only. `PUBLIC`, `anon`, and `service_role` remain revoked. The three Delta bookkeeping tables retain owner-filtered authenticated `SELECT` only; direct insert, update, delete and truncate are revoked. The six RPCs continue to use `auth.uid()` and the caller's own workspace/state checks.

The migration itself does not insert an account, change a workspace mode, or add this migration to the OPS-01 production schema-install allowlist. It is a separate activation/security migration. The committed production 11-file allowlist is not expanded.

## Staging operator procedure

Only run the following after the migration has been reviewed, the exact QA owner identity has been reconciled against QA-01 and the latest task ledger, and an owner-approved staging action has been recorded. The live staging allowlist already has an enabled row; do not repeat the INSERT as a routine merge step. Do not run this procedure against `nexus-spaced-repetition` or any production environment.

1. Confirm the intended staging Auth identity and workspace owner by a read-only query. Verify the workspace's mode is `snapshot`.
2. Insert exactly that owner into the private allowlist with an explicit reason. Use the owner UUID obtained from the live staging Auth record; never copy a UUID from this document or a different environment.

~~~sql
INSERT INTO nexus_private.entity_delta_pilot_allowlist (user_id, enabled, reason)
VALUES (
  '<confirmed-staging-owner-uuid>'::uuid,
  true,
  'DLA-01 owner-designated staging QA account; existing login, not a synthetic Auth identity'
)
ON CONFLICT (user_id) DO UPDATE
SET enabled = EXCLUDED.enabled,
    reason = EXCLUDED.reason,
    updated_at = clock_timestamp();
~~~

3. Re-read the allowlist and confirm exactly one enabled owner.
4. Re-read `public.nexus_workspace_sync_state` and confirm the designated owner and every other workspace remain in `snapshot` mode with zero Delta revisions.
5. Re-read function ACLs, private-schema privileges, and table write grants. Do not call `nexus_enable_entity_delta` as a persistent hosted action until DLA-03 is implemented and tested. The rollback-only test may exercise enablement inside a transaction that is always rolled back.

The row is an eligibility decision only. It does not mean the user has been switched to Delta. DLA-03 must provide the verified owner-scoped downgrade/kill switch before any hosted Delta pilot; DLA-04 must then run the full two-device test matrix and cleanup report.

## QA identity reconciliation — outstanding

The QA-01 owner-approved completion evidence records a specific scope decision: reuse the supplied existing staging login/workspace, rather than create a fifth Auth user. That supersedes the earlier roadmap wording that requested a new synthetic QA owner.

A later read-only inspection of live `nexus-sync-staging` on 17 November 2026 found a different current state:

- 5 Auth users, 5 workspace payloads and 5 sync-state rows.
- Four pre-existing owners/workspaces have 5,495 chunk rows in total.
- One additional Auth user and workspace were created on 17 November; that workspace currently has no chunk rows.
- The private allowlist has two rows: one enabled and one disabled. The enabled row belongs to the additional same-day Auth user.
- All five workspaces remain in `snapshot` mode; there are zero Delta operation rows and zero receipt rows.

This read-only inventory confirms that the additional identity and enabled allowlist row exist, but it does not establish that creating and enabling this fifth identity was authorized under the QA-01 scope decision. The latest task tracker accordingly leaves hosted identity reconciliation pending. Do not describe the fifth identity as owner-approved, do not delete or reassign either allowlist row, and do not change staging data as part of a code merge. Before DLA-04, the owner must reconcile the difference and record the accepted QA owner/workspace in the active ledger.

## Tests

The rollback-only `supabase/tests/nexus_entity_delta_authenticated_rpc.sql` test verifies:

- the six RPC grants exist for `authenticated` but not `anon` or `service_role`;
- an explicitly allowlisted synthetic owner can enable and publish within the transaction;
- an unlisted owner receives `pilot_not_enabled`, cannot publish, and creates no operation/receipt rows;
- authenticated users cannot use `nexus_private` or directly mutate sync-state, operations, or receipt tables;
- the final rollback removes all synthetic users, allowlist rows, mode changes, operations, and receipts.

The local authenticated browser suite additionally uses A1/A2 for one allowlisted owner, an unlisted owner B that cannot enable or publish, and a separate allowlisted disposable owner C for the 26.9 MB lifecycle. All local test identities and allowlist rows are deleted during teardown.

## Completion boundary

DLA-02 may be reported as implemented only after migration contract checks, rollback-only authenticated SQL, fresh local Supabase/Chromium CI, and isolated staging ACL/eligibility verification pass. DLA-03 and DLA-04 remain separate tasks. No production migration, grant, Delta activation, deployment or merge is authorized by this document.

## Documentation correction — function owner and identity boundary

The security-definer enablement routine is owned by the database migration owner (`postgres` in the isolated Supabase migration/test environment); its empty `search_path` and schema-qualified object references are intentional. The earlier phrase “postgres)-owned function” was a typographical error.

**Identity boundary:** QA-01 authorized reuse of the existing staging login/workspace, not creation of a fifth Auth user. A later read-only inventory recorded an additional fifth user/workspace and an enabled allowlist row for that identity, but the tracker leaves that identity reconciliation pending. The observed identity is not accepted as the QA owner. Do not execute the illustrative allowlist INSERT/UPSERT as part of code merge, and do not alter either existing allowlist row or staging workspace until the owner records a resolution.
