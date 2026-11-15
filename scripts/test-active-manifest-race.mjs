import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';

const PRODUCTION_PROJECT_REF = 'txugbdavblpettcnhcxl';
const LOCK_HOLD_SECONDS = 7.0;
const SECOND_SESSION_DELAY_SECONDS = 0.35;
const MIN_LOCK_WAIT_MS = 2500;
const READY_TIMEOUT_MS = 20000;
const databaseUrl = process.env.NEXUS_RACE_DATABASE_URL;

if (!databaseUrl) {
  console.log('Active-manifest race test skipped. Set NEXUS_RACE_DATABASE_URL to the disposable local Supabase Postgres URL to run it.');
  process.exit(0);
}

const connection = new URL(databaseUrl);
const host = connection.hostname.toLowerCase();
const username = decodeURIComponent(connection.username).toLowerCase();
const localDatabase = ['localhost', '127.0.0.1', '::1'].includes(host);

if (host.includes(PRODUCTION_PROJECT_REF) || username.includes(PRODUCTION_PROJECT_REF)) {
  throw new Error('Refusing to run the active-manifest race test against the production Nexus Supabase project.');
}
if (!localDatabase) {
  throw new Error('Refusing every remote database. This concurrency test may run only against disposable local Supabase on localhost/loopback.');
}
if (connection.port === '6543') {
  throw new Error('Transaction-pooler connections cannot hold the two independent test transactions. Use the direct or session-mode Postgres connection.');
}

const version = spawnSync('psql', ['--version'], { encoding: 'utf8' });
if (version.error || version.status !== 0) {
  throw new Error('psql is required to run the active-manifest race test.');
}

const pgEnv = {
  ...process.env,
  PGHOST: host,
  PGPORT: connection.port || '5432',
  PGDATABASE: decodeURIComponent(connection.pathname.replace(/^\//, '') || 'postgres'),
  PGUSER: username,
  PGPASSWORD: decodeURIComponent(connection.password),
  PGSSLMODE: connection.searchParams.get('sslmode') || 'disable',
  PGCONNECT_TIMEOUT: '10',
  PGAPPNAME: 'nexus-active-manifest-race-test',
  PGOPTIONS: '-c statement_timeout=30000'
};

function startSqlSession(label, sql, applicationName, readyMarker = null) {
  const child = spawn('psql', [
    '-X',
    '-v', 'ON_ERROR_STOP=1',
    '-A',
    '-t',
    '-F', '\t',
    '-c', sql
  ], {
    env: { ...pgEnv, ...(applicationName ? { PGAPPNAME: applicationName } : {}) },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let stdout = '';
  let stderr = '';
  let readySeen = false;
  let completionSettled = false;
  let resolveReady;
  let rejectReady;
  let resolveCompletion;
  let rejectCompletion;

  const ready = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const completion = new Promise((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });
  // The caller always awaits completion, but this handler also prevents a
  // fast process failure from becoming an unhandled rejection while awaiting
  // its explicit lock-ready notice.
  completion.catch(() => {});

  child.stdout.setEncoding('utf8').on('data', value => {
    stdout += value;
  });
  child.stderr.setEncoding('utf8').on('data', value => {
    stderr += value;
    if (readyMarker && !readySeen && stderr.includes(readyMarker)) {
      readySeen = true;
      resolveReady();
    }
  });
  child.on('error', error => {
    const failure = new Error(label + ': ' + error.message);
    if (readyMarker && !readySeen) rejectReady(failure);
    if (!completionSettled) {
      completionSettled = true;
      rejectCompletion(failure);
    }
  });
  child.on('close', code => {
    if (readyMarker && !readySeen) {
      rejectReady(new Error(label + ' exited before emitting its lock-ready notice.\n' + stderr + '\n' + stdout));
    }
    if (completionSettled) return;
    completionSettled = true;
    if (code !== 0) {
      rejectCompletion(new Error(label + ' failed (psql exit ' + code + ').\n' + stderr + '\n' + stdout));
    } else {
      resolveCompletion({ stdout: stdout.trim(), stderr: stderr.trim() });
    }
  });

  return { child, ready, completion };
}

async function waitForLockReady(session, label) {
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(label + ': timed out waiting for the first transaction to acquire the workspace-row lock.')), READY_TIMEOUT_MS);
  });
  try {
    await Promise.race([session.ready, timeout]);
      // First publication has no parent workspace row to lock. Test the two
  // publisher/cleanup orderings for both first inserts and later updates.
  const firstWritePublisherOwner = randomUUID();
  const firstWriteCleanupOwner = randomUUID();
  const firstWritePublisherRevision = randomUUID();
  const firstWritePublisherStaleRevision = randomUUID();
  const firstWriteCleanupRevision = randomUUID();
  const firstWritePublisherData = 'first-write-publisher';
  const firstWritePublisherStaleData = 'stale-update-candidate';
  const firstWriteCleanupData = 'first-write-cleanup';
  const firstWriteManifest = (revisionId, chunkData) => JSON.stringify({
    __nexusStorage: 'chunked-v1',
    version: 1,
    revisionId,
    chunkCount: 1,
    totalBytes: Buffer.byteLength(chunkData),
    sha256: createHash('sha256').update(chunkData).digest('hex')
  });
  const publisherPayload = sqlJsonb(firstWriteManifest(firstWritePublisherRevision, firstWritePublisherData));
  const staleUpdatePayload = sqlJsonb(firstWriteManifest(firstWritePublisherStaleRevision, firstWritePublisherStaleData));
  const firstCleanupPayload = sqlJsonb(firstWriteManifest(firstWriteCleanupRevision, firstWriteCleanupData));
  const publisherEmail = 'nexus-first-write-publisher-' +
    firstWritePublisherOwner.replaceAll('-', '') + '@example.invalid';
  const cleanupEmail = 'nexus-first-write-cleanup-' +
    firstWriteCleanupOwner.replaceAll('-', '') + '@example.invalid';

  try {
    const seedFirstWrite = [
      'BEGIN;',
      "INSERT INTO auth.users (id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at) VALUES " +
        "('" + firstWritePublisherOwner + "', 'authenticated', 'authenticated', '" + publisherEmail + "', '', clock_timestamp(), '{}'::jsonb, '{}'::jsonb, clock_timestamp(), clock_timestamp()), " +
        "('" + firstWriteCleanupOwner + "', 'authenticated', 'authenticated', '" + cleanupEmail + "', '', clock_timestamp(), '{}'::jsonb, '{}'::jsonb, clock_timestamp(), clock_timestamp());",
      "INSERT INTO public.nexus_user_data_chunks (user_id, revision_id, chunk_index, chunk_count, chunk_bytes, chunk_data, created_at) VALUES " +
        "('" + firstWritePublisherOwner + "', '" + firstWritePublisherRevision + "', 0, 1, octet_length('" + firstWritePublisherData + "'), '" + firstWritePublisherData + "', clock_timestamp() - interval '8 days'), " +
        "('" + firstWritePublisherOwner + "', '" + firstWritePublisherStaleRevision + "', 0, 1, octet_length('" + firstWritePublisherStaleData + "'), '" + firstWritePublisherStaleData + "', clock_timestamp() - interval '8 days'), " +
        "('" + firstWriteCleanupOwner + "', '" + firstWriteCleanupRevision + "', 0, 1, octet_length('" + firstWriteCleanupData + "'), '" + firstWriteCleanupData + "', clock_timestamp() - interval '8 days');",
      'COMMIT;'
    ].join('\n');
    await runSql('seed two disposable first-write owners without workspace rows', seedFirstWrite);

    // INSERT wins: after the parent row is created, cleanup must re-read it
    // after waiting for the advisory lock and refuse to delete the active set.
    const publisherFirstSql = [
      'BEGIN;',
      "INSERT INTO public.nexus_user_data (user_id, payload, updated_at) VALUES ('" +
        firstWritePublisherOwner + "', " + publisherPayload + ', clock_timestamp());',
      'DO $race$',
      'BEGIN',
      "  RAISE NOTICE 'NEXUS_FIRST_WRITE_PUBLISHER_LOCK_HELD';",
      '  PERFORM pg_sleep(' + LOCK_HOLD_SECONDS + ');',
      'END',
      '$race$;',
      'COMMIT;'
    ].join('\n');
    const cleanupAfterFirstPublishSql = [
      'DO $race$',
      'DECLARE',
      '  v_started timestamptz;',
      '  v_blocked boolean := false;',
      'BEGIN',
      '  PERFORM pg_sleep(' + SECOND_SESSION_DELAY_SECONDS + ');',
      '  v_started := clock_timestamp();',
      '  BEGIN',
      "    DELETE FROM public.nexus_user_data_chunks WHERE user_id = '" +
        firstWritePublisherOwner + "' AND revision_id = '" + firstWritePublisherRevision + "';",
      "  EXCEPTION WHEN SQLSTATE '55000' THEN",
      '    v_blocked := true;',
      '  END;',
      '  IF NOT v_blocked THEN',
      "    RAISE EXCEPTION 'First-write cleanup deleted a manifest that had just become active.';",
      '  END IF;',
      "  RAISE NOTICE 'NEXUS_FIRST_WRITE_ACTIVE_DELETE_REJECTED=55000';",
      "  RAISE NOTICE 'NEXUS_RACE_OPERATION_MS=%', floor(extract(epoch FROM clock_timestamp() - v_started) * 1000);",
      'END',
      '$race$;'
    ].join('\n');
    const publisherFirstResults = await runConcurrentPair(
      'first insert publishes before candidate cleanup',
      publisherFirstSql,
      cleanupAfterFirstPublishSql,
      'NEXUS_FIRST_WRITE_PUBLISHER_LOCK_HELD',
      'nexus-first-snapshot-publisher',
      'nexus-first-snapshot-cleanup-after-publish'
    );
    assertObservedLockWait(publisherFirstResults[1], 'first-write publisher-first cleanup');
    assert.match(combinedOutput(publisherFirstResults[1]), /NEXUS_FIRST_WRITE_ACTIVE_DELETE_REJECTED=55000/);
    const publishedFirstState = await runSql(
      'verify first-write publisher-first state',
      "SELECT (SELECT payload ->> 'revisionId' FROM public.nexus_user_data WHERE user_id = '" +
        firstWritePublisherOwner + "') || E'\\t' || " +
      "(SELECT count(*)::text FROM public.nexus_user_data_chunks WHERE user_id = '" +
        firstWritePublisherOwner + "' AND revision_id = '" + firstWritePublisherRevision + "');"
    );
    assert.equal(publishedFirstState, firstWritePublisherRevision + '\t1',
      'first publication must remain active with its complete chunk set');

    // Existing workspace row: cleanup removes an inactive candidate first.
    // The waiting UPDATE must fail closed, leaving the former snapshot active.
    const updateCleanupFirstSql = [
      'BEGIN;',
      "DELETE FROM public.nexus_user_data_chunks WHERE user_id = '" +
        firstWritePublisherOwner + "' AND revision_id = '" + firstWritePublisherStaleRevision + "';",
      'DO $race$',
      'BEGIN',
      "  RAISE NOTICE 'NEXUS_EXISTING_CANDIDATE_CLEANUP_LOCK_HELD';",
      '  PERFORM pg_sleep(' + LOCK_HOLD_SECONDS + ');',
      'END',
      '$race$;',
      'COMMIT;'
    ].join('\n');
    const updateAfterCleanupSql = [
      'DO $race$',
      'DECLARE',
      '  v_started timestamptz;',
      '  v_rejected boolean := false;',
      'BEGIN',
      '  PERFORM pg_sleep(' + SECOND_SESSION_DELAY_SECONDS + ');',
      '  v_started := clock_timestamp();',
      '  BEGIN',
      '    UPDATE public.nexus_user_data SET payload = ' + staleUpdatePayload +
        ", updated_at = clock_timestamp() WHERE user_id = '" + firstWritePublisherOwner + "';",
      "  EXCEPTION WHEN SQLSTATE '23514' THEN",
      '    v_rejected := true;',
      '  END;',
      '  IF NOT v_rejected THEN',
      "    RAISE EXCEPTION 'An UPDATE published an incomplete snapshot candidate.';",
      '  END IF;',
      "  RAISE NOTICE 'NEXUS_EXISTING_CANDIDATE_UPDATE_REJECTED=23514';",
      "  RAISE NOTICE 'NEXUS_RACE_OPERATION_MS=%', floor(extract(epoch FROM clock_timestamp() - v_started) * 1000);",
      'END',
      '$race$;'
    ].join('\n');
    const updateRaceResults = await runConcurrentPair(
      'cleanup wins before an existing workspace candidate update',
      updateCleanupFirstSql,
      updateAfterCleanupSql,
      'NEXUS_EXISTING_CANDIDATE_CLEANUP_LOCK_HELD',
      'nexus-existing-candidate-cleanup-first',
      'nexus-existing-candidate-publisher-after-cleanup'
    );
    assertObservedLockWait(updateRaceResults[1], 'existing-row cleanup-first update');
    assert.match(combinedOutput(updateRaceResults[1]), /NEXUS_EXISTING_CANDIDATE_UPDATE_REJECTED=23514/);
    const updateRaceState = await runSql(
      'verify existing-row candidate cleanup state',
      "SELECT (SELECT payload ->> 'revisionId' FROM public.nexus_user_data WHERE user_id = '" +
        firstWritePublisherOwner + "') || E'\\t' || " +
      "(SELECT count(*)::text FROM public.nexus_user_data_chunks WHERE user_id = '" +
        firstWritePublisherOwner + "' AND revision_id = '" + firstWritePublisherRevision + "') || E'\\t' || " +
      "(SELECT count(*)::text FROM public.nexus_user_data_chunks WHERE user_id = '" +
        firstWritePublisherOwner + "' AND revision_id = '" + firstWritePublisherStaleRevision + "');"
    );
    assert.equal(updateRaceState, firstWritePublisherRevision + '\t1\t0',
      'the old active snapshot must remain readable when a replacement candidate was deleted');

    // No-parent cleanup wins: it removes an aged candidate and holds the
    // advisory lock. The first INSERT must wait and then reject the missing set.
    const cleanupFirstSql = [
      'BEGIN;',
      "DELETE FROM public.nexus_user_data_chunks WHERE user_id = '" +
        firstWriteCleanupOwner + "' AND revision_id = '" + firstWriteCleanupRevision + "';",
      'DO $race$',
      'BEGIN',
      "  RAISE NOTICE 'NEXUS_FIRST_WRITE_CLEANUP_LOCK_HELD';",
      '  PERFORM pg_sleep(' + LOCK_HOLD_SECONDS + ');',
      'END',
      '$race$;',
      'COMMIT;'
    ].join('\n');
    const firstInsertAfterCleanupSql = [
      'DO $race$',
      'DECLARE',
      '  v_started timestamptz;',
      '  v_rejected boolean := false;',
      'BEGIN',
      '  PERFORM pg_sleep(' + SECOND_SESSION_DELAY_SECONDS + ');',
      '  v_started := clock_timestamp();',
      '  BEGIN',
      "    INSERT INTO public.nexus_user_data (user_id, payload, updated_at) VALUES ('" +
        firstWriteCleanupOwner + "', " + firstCleanupPayload + ', clock_timestamp());',
      "  EXCEPTION WHEN SQLSTATE '23514' THEN",
      '    v_rejected := true;',
      '  END;',
      '  IF NOT v_rejected THEN',
      "    RAISE EXCEPTION 'An incomplete first-write candidate was allowed to become active.';",
      '  END IF;',
      "  RAISE NOTICE 'NEXUS_FIRST_WRITE_INCOMPLETE_PUBLICATION_REJECTED=23514';",
      "  RAISE NOTICE 'NEXUS_RACE_OPERATION_MS=%', floor(extract(epoch FROM clock_timestamp() - v_started) * 1000);",
      'END',
      '$race$;'
    ].join('\n');
    const cleanupFirstResults = await runConcurrentPair(
      'first insert waits for stale candidate cleanup',
      cleanupFirstSql,
      firstInsertAfterCleanupSql,
      'NEXUS_FIRST_WRITE_CLEANUP_LOCK_HELD',
      'nexus-first-snapshot-cleanup-first',
      'nexus-first-snapshot-publisher-after-cleanup'
    );
    assertObservedLockWait(cleanupFirstResults[1], 'first-write cleanup-first insert');
    assert.match(combinedOutput(cleanupFirstResults[1]), /NEXUS_FIRST_WRITE_INCOMPLETE_PUBLICATION_REJECTED=23514/);
    const cleanupFirstState = await runSql(
      'verify first-write cleanup-first state',
      "SELECT (SELECT count(*)::text FROM public.nexus_user_data WHERE user_id = '" +
        firstWriteCleanupOwner + "') || E'\\t' || " +
      "(SELECT count(*)::text FROM public.nexus_user_data_chunks WHERE user_id = '" +
        firstWriteCleanupOwner + "' AND revision_id = '" + firstWriteCleanupRevision + "');"
    );
    assert.equal(cleanupFirstState, '0\t0',
      'cleanup-first ordering must leave no parent manifest and no candidate chunks');
  } finally {
    const firstWriteOwnerList = "'" + firstWritePublisherOwner + "','" + firstWriteCleanupOwner + "'";
    await runSql('delete first-write race fixture owners through account cascade',
      'DELETE FROM auth.users WHERE id IN (' + firstWriteOwnerList + ');');
    const firstWriteLeftovers = await runSql(
      'verify first-write race fixture cascade',
      "SELECT (SELECT count(*) FROM auth.users WHERE id IN (" + firstWriteOwnerList + ")) || E'\\t' || " +
      "(SELECT count(*) FROM public.nexus_user_data WHERE user_id IN (" + firstWriteOwnerList + ")) || E'\\t' || " +
      "(SELECT count(*) FROM public.nexus_user_data_chunks WHERE user_id IN (" + firstWriteOwnerList + "));"
    );
    assert.equal(firstWriteLeftovers, '0\t0\t0',
      'first-write race owners and chunks must be removed by the normal account-deletion cascade');
  }

} catch (error) {
    session.child.kill('SIGTERM');
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

function combinedOutput(result) {
  return [result.stdout, result.stderr].filter(Boolean).join('\n');
}

async function runSqlDetailed(label, sql, applicationName) {
  const session = startSqlSession(label, sql, applicationName);
  return session.completion;
}

async function runSql(label, sql, applicationName) {
  const result = await runSqlDetailed(label, sql, applicationName);
  return combinedOutput(result);
}

async function runConcurrentPair(label, firstSql, secondSql, firstReadyMarker, firstApplicationName, secondApplicationName) {
  const firstSession = startSqlSession(label + ': first session', firstSql, firstApplicationName, firstReadyMarker);
  try {
    // Start the competing statement only after the first transaction has
    // emitted a notice from inside the transaction, immediately after it
    // acquired the workspace-row lock. This is deterministic and works with
    // Supavisor session mode without depending on pg_stat_activity visibility.
    await waitForLockReady(firstSession, label);
    const secondPromise = runSqlDetailed(label + ': second session', secondSql, secondApplicationName);
    const outcomes = await Promise.allSettled([firstSession.completion, secondPromise]);
    const failures = outcomes.filter(result => result.status === 'rejected');
    if (failures.length) {
      throw new AggregateError(failures.map(result => result.reason), label + ' did not complete cleanly.');
    }
    return outcomes.map(result => result.value);
  } catch (error) {
    await Promise.allSettled([firstSession.completion]);
    throw error;
  }
}

function assertObservedLockWait(result, label) {
  const match = combinedOutput(result).match(/NEXUS_RACE_OPERATION_MS=(\d+)/);
  assert.ok(match, label + ': the waiting SQL session did not report its measured operation duration.');
  const elapsedMs = Number(match[1]);
  assert.ok(
    elapsedMs >= MIN_LOCK_WAIT_MS,
    label + ': expected the competing SQL operation to wait at least ' + MIN_LOCK_WAIT_MS + ' ms for the held workspace-row lock, but it took ' + elapsedMs + ' ms.'
  );
}

const ownerId = randomUUID();
const revA = randomUUID();
const revB = randomUUID();
const revC = randomUUID();
const revD = randomUUID();
const email = 'nexus-active-manifest-race-' + ownerId.replaceAll('-', '') + '@example.invalid';
let seeded = false;

const chunkText = revisionId => revisionId === revA ? 'race-A'
  : revisionId === revB ? 'race-B'
  : revisionId === revC ? 'race-C'
  : revisionId === revD ? 'race-D'
  : null;
const manifestPayload = revisionId => {
  const chunk = chunkText(revisionId);
  if (!chunk) throw new Error('Unknown test revision.');
  return JSON.stringify({
    __nexusStorage: 'chunked-v1',
    version: 1,
    revisionId,
    chunkCount: 1,
    totalBytes: Buffer.byteLength(chunk),
    sha256: createHash('sha256').update(chunk).digest('hex')
  });
};
const sqlJsonb = value => "'" + value.replace(/'/g, "''") + "'::jsonb";
const updateManifest = revisionId =>
  "UPDATE public.nexus_user_data " +
  "SET payload = " + sqlJsonb(manifestPayload(revisionId)) + ", " +
  "updated_at = clock_timestamp() WHERE user_id = '" + ownerId + "';";

let primaryError;
try {
  const seedSql = [
    'BEGIN;',
    "INSERT INTO auth.users (id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)",
    "VALUES ('" + ownerId + "', 'authenticated', 'authenticated', '" + email + "', '', clock_timestamp(), '{}'::jsonb, '{}'::jsonb, clock_timestamp(), clock_timestamp());",
    "INSERT INTO public.nexus_user_data_chunks (user_id, revision_id, chunk_index, chunk_count, chunk_bytes, chunk_data, created_at) VALUES " +
      "('" + ownerId + "', '" + revA + "', 0, 1, octet_length('race-A'), 'race-A', clock_timestamp() - interval '8 days'), " +
      "('" + ownerId + "', '" + revB + "', 0, 1, octet_length('race-B'), 'race-B', clock_timestamp() - interval '8 days'), " +
      "('" + ownerId + "', '" + revC + "', 0, 1, octet_length('race-C'), 'race-C', clock_timestamp() - interval '8 days'), " +
      "('" + ownerId + "', '" + revD + "', 0, 1, octet_length('race-D'), 'race-D', clock_timestamp() - interval '8 days');",
    "INSERT INTO public.nexus_user_data (user_id, payload, updated_at) VALUES ('" + ownerId + "', " + sqlJsonb(manifestPayload(revA)) + ", clock_timestamp());",
    'COMMIT;'
  ].join('\n');
  await runSql('seed disposable owner and four chunk revisions', seedSql);
  seeded = true;

  const publisherFirstSql = [
    'BEGIN;',
    'DO $race$',
    'BEGIN',
    updateManifest(revB),
    "RAISE NOTICE 'NEXUS_RACE_LOCK_HELD';",
    'PERFORM pg_sleep(' + LOCK_HOLD_SECONDS + ');',
    'END',
    '$race$;',
    'COMMIT;'
  ].join('\n');
  const cleanupAfterPublisherSql = [
    'DO $race$',
    'DECLARE',
    '  v_started timestamptz;',
    '  v_deleted_revision uuid;',
    'BEGIN',
    '  PERFORM pg_sleep(' + SECOND_SESSION_DELAY_SECONDS + ');',
    '  v_started := clock_timestamp();',
    "  DELETE FROM public.nexus_user_data_chunks WHERE user_id = '" + ownerId + "' AND revision_id = '" + revA + "' RETURNING revision_id INTO v_deleted_revision;",
    "  RAISE NOTICE 'NEXUS_RACE_DELETED_REVISION=%', v_deleted_revision;",
    "  RAISE NOTICE 'NEXUS_RACE_OPERATION_MS=%', floor(extract(epoch FROM clock_timestamp() - v_started) * 1000);",
    'END',
    '$race$;'
  ].join('\n');
  const firstResults = await runConcurrentPair(
    'publisher wins the workspace-row lock',
    publisherFirstSql,
    cleanupAfterPublisherSql,
    'NEXUS_RACE_LOCK_HELD',
    'nexus-manifest-publisher-first',
    'nexus-manifest-cleanup-after-publisher'
  );
  assertObservedLockWait(firstResults[1], 'publisher-first cleanup');
  assert.ok(combinedOutput(firstResults[1]).includes(revA),
    'cleanup must wait for publication, re-read the new pointer, then remove only the now-stale revision');

  const afterPublisherFirstSql = [
    "SELECT (SELECT payload ->> 'revisionId' FROM public.nexus_user_data WHERE user_id = '" + ownerId + "') || E'\\t' ||",
    "(SELECT count(*)::text FROM public.nexus_user_data_chunks WHERE user_id = '" + ownerId + "' AND revision_id = '" + revA + "') || E'\\t' ||",
    "(SELECT count(*)::text FROM public.nexus_user_data_chunks WHERE user_id = '" + ownerId + "' AND revision_id = '" + revB + "');"
  ].join('\n');
  const afterPublisherFirst = await runSql('verify publisher-first ordering', afterPublisherFirstSql);
  assert.equal(afterPublisherFirst, revB + '\t0\t1',
    'publisher-first ordering must leave B active, remove A, and preserve all B chunks');

  await runSql('prepare delete-first ordering', updateManifest(revC));
  const cleanupFirstSql = [
    'BEGIN;',
    'DO $race$',
    'DECLARE',
    '  v_blocked boolean := false;',
    '  v_locked_user uuid;',
    'BEGIN',
    "  SELECT user_id INTO v_locked_user FROM public.nexus_user_data WHERE user_id = '" + ownerId + "' FOR UPDATE;",
    "  RAISE NOTICE 'NEXUS_RACE_LOCK_HELD';",
    '  BEGIN',
    "    DELETE FROM public.nexus_user_data_chunks WHERE user_id = '" + ownerId + "' AND revision_id = '" + revC + "';",
    '  EXCEPTION WHEN SQLSTATE \'55000\' THEN',
    '    v_blocked := true;',
    '  END;',
    '  IF NOT v_blocked THEN',
    "    RAISE EXCEPTION 'Expected active-manifest cleanup to fail with SQLSTATE 55000.';",
    '  END IF;',
    "  RAISE NOTICE 'NEXUS_RACE_LOCKED_OWNER=%', v_locked_user;",
    '  PERFORM pg_sleep(' + LOCK_HOLD_SECONDS + ');',
    'END',
    '$race$;',
    'COMMIT;'
  ].join('\n');
  const publisherAfterCleanupSql = [
    'DO $race$',
    'DECLARE',
    '  v_started timestamptz;',
    '  v_updated integer;',
    'BEGIN',
    '  PERFORM pg_sleep(' + SECOND_SESSION_DELAY_SECONDS + ');',
    '  v_started := clock_timestamp();',
    '  ' + updateManifest(revD),
    '  GET DIAGNOSTICS v_updated = ROW_COUNT;',
    '  IF v_updated <> 1 THEN',
    "    RAISE EXCEPTION 'Expected publisher to update exactly one workspace row; updated %.', v_updated;",
    '  END IF;',
    "  RAISE NOTICE 'NEXUS_RACE_PUBLISHER_UPDATED=%', v_updated;",
    "  RAISE NOTICE 'NEXUS_RACE_OPERATION_MS=%', floor(extract(epoch FROM clock_timestamp() - v_started) * 1000);",
    'END',
    '$race$;'
  ].join('\n');
  const secondResults = await runConcurrentPair(
    'cleanup holds the workspace-row lock first',
    cleanupFirstSql,
    publisherAfterCleanupSql,
    'NEXUS_RACE_LOCK_HELD',
    'nexus-manifest-cleanup-lock-first',
    'nexus-manifest-publisher-after-cleanup'
  );
  assert.ok(combinedOutput(secondResults[0]).includes(ownerId),
    'the cleanup session must lock the fixture workspace row');
  assertObservedLockWait(secondResults[1], 'cleanup-first publisher');
  assert.match(combinedOutput(secondResults[1]), /NEXUS_RACE_PUBLISHER_UPDATED=1/,
    'the waiting publisher must update exactly one workspace row after the lock-holding cleanup transaction commits');

  const afterCleanupFirstSql = [
    "SELECT (SELECT payload ->> 'revisionId' FROM public.nexus_user_data WHERE user_id = '" + ownerId + "') || E'\\t' ||",
    "(SELECT count(*)::text FROM public.nexus_user_data_chunks WHERE user_id = '" + ownerId + "' AND revision_id = '" + revC + "') || E'\\t' ||",
    "(SELECT count(*)::text FROM public.nexus_user_data_chunks WHERE user_id = '" + ownerId + "' AND revision_id = '" + revD + "') || E'\\t' ||",
    "(SELECT count(*)::text FROM public.nexus_user_data_chunks WHERE user_id = '" + ownerId + "' AND revision_id = '" + revB + "');"
  ].join('\n');
  const afterCleanupFirst = await runSql('verify cleanup-first ordering', afterCleanupFirstSql);
  assert.equal(afterCleanupFirst, revD + '\t1\t1\t1',
    'cleanup-first ordering must reject deletion of C, retain its chunk, and allow D to become active');

  const staleCleanupSql =
    "DELETE FROM public.nexus_user_data_chunks WHERE user_id = '" + ownerId + "' AND revision_id = '" + revC + "' RETURNING revision_id;";
  const staleCleanup = await runSql('retry cleanup after D publication', staleCleanupSql);
  assert.ok(staleCleanup.includes(revC),
    'the formerly active C revision must become cleanable only after D is published');

} catch (error) {
  primaryError = error;
} finally {
  if (seeded) {
    try {
      await runSql('remove disposable staging auth user and cascading workspace',
        "DELETE FROM auth.users WHERE id = '" + ownerId + "';");
      const remainingSql = [
        "SELECT (SELECT count(*)::text FROM auth.users WHERE id = '" + ownerId + "') || E'\\t' ||",
        "(SELECT count(*)::text FROM public.nexus_user_data WHERE user_id = '" + ownerId + "') || E'\\t' ||",
        "(SELECT count(*)::text FROM public.nexus_user_data_chunks WHERE user_id = '" + ownerId + "');"
      ].join('\n');
      const remaining = await runSql('verify disposable fixture cleanup', remainingSql);
      assert.equal(remaining, '0\t0\t0', 'the race-test owner and all of its rows must be removed');
    } catch (cleanupError) {
      if (primaryError) {
        throw new AggregateError([primaryError, cleanupError], 'The race test failed and fixture cleanup also failed.');
      }
      throw cleanupError;
    }
  }
}

if (primaryError) throw primaryError;
console.log('Snapshot-manifest integrity races passed: existing-row concurrency, first-write publication/cleanup concurrency, incomplete-candidate rejection, measured lock waits, and account-cascade fixture cleanup.');
,
      'BEGIN',
      "  RAISE NOTICE 'NEXUS_EXISTING_CANDIDATE_CLEANUP_LOCK_HELD';",
      '  PERFORM pg_sleep(' + LOCK_HOLD_SECONDS + ');',
      'END',
      '$race$;',
      'COMMIT;'
    ].join('\n');
    const existingCandidatePublisherAfterCleanupSql = [
      'DO $race    const firstWriteCleanupFirstSql = [
      'BEGIN;',
      "DELETE FROM public.nexus_user_data_chunks WHERE user_id = '" +
        firstWriteCleanupOwner + "' AND revision_id = '" + firstWriteCleanupRevision + "';",
      'DO $race$',
      'BEGIN',
      "  RAISE NOTICE 'NEXUS_FIRST_WRITE_CLEANUP_LOCK_HELD';",
      '  PERFORM pg_sleep(' + LOCK_HOLD_SECONDS + ');',
      'END',
      '$race$;',
      'COMMIT;'
    ].join('\n');
    const firstWritePublisherAfterCleanupSql = [
      'DO $race$',
      'DECLARE',
      '  v_started timestamptz;',
      '  v_rejected boolean := false;',
      'BEGIN',
      '  PERFORM pg_sleep(' + SECOND_SESSION_DELAY_SECONDS + ');',
      '  v_started := clock_timestamp();',
      '  BEGIN',
      "    INSERT INTO public.nexus_user_data (user_id, payload, updated_at) VALUES ('" +
        firstWriteCleanupOwner + "', " + firstWriteCleanupPayload + ', clock_timestamp());',
      "  EXCEPTION WHEN SQLSTATE '23514' THEN",
      '    v_rejected := true;',
      '  END;',
      '  IF NOT v_rejected THEN',
      "    RAISE EXCEPTION 'An incomplete first-write candidate was allowed to become active.';",
      '  END IF;',
      "  RAISE NOTICE 'NEXUS_FIRST_WRITE_INCOMPLETE_PUBLICATION_REJECTED=23514';",
      "  RAISE NOTICE 'NEXUS_RACE_OPERATION_MS=%', floor(extract(epoch FROM clock_timestamp() - v_started) * 1000);",
      'END',
      '$race$;'
    ].join('\n');
    const firstWriteCleanupResults = await runConcurrentPair(
      'first-write cleanup acquires the owner lock before publication',
      firstWriteCleanupFirstSql,
      firstWritePublisherAfterCleanupSql,
      'NEXUS_FIRST_WRITE_CLEANUP_LOCK_HELD',
      'nexus-first-snapshot-cleanup-first',
      'nexus-first-snapshot-publisher-after-cleanup'
    );
    assertObservedLockWait(firstWriteCleanupResults[1], 'first-write cleanup-first publication');
    assert.match(combinedOutput(firstWriteCleanupResults[1]), /NEXUS_FIRST_WRITE_INCOMPLETE_PUBLICATION_REJECTED=23514/,
      'publication must fail closed after cleanup removes an unpublished first-write candidate');
    const firstWriteCleanupState = await runSql(
      'verify first-write cleanup-first state',
      "SELECT (SELECT count(*)::text FROM public.nexus_user_data WHERE user_id = '" +
        firstWriteCleanupOwner + "') || E'\\\\t' || " +
      "(SELECT count(*)::text FROM public.nexus_user_data_chunks WHERE user_id = '" +
        firstWriteCleanupOwner + "' AND revision_id = '" + firstWriteCleanupRevision + "');"
    );
    assert.equal(firstWriteCleanupState, '0\\t0',
      'cleanup-first ordering must leave no parent manifest and no candidate chunks');
  } finally {
    const firstWriteOwnerList = "'" + firstWritePublisherOwner + "','" + firstWriteCleanupOwner + "'";
    await runSql('delete first-write race fixture owners through account cascade',
      'DELETE FROM auth.users WHERE id IN (' + firstWriteOwnerList + ');');
    const firstWriteLeftovers = await runSql(
      'verify first-write race fixture cascade',
      "SELECT (SELECT count(*) FROM auth.users WHERE id IN (" + firstWriteOwnerList + ")) || E'\\t' || " +
      "(SELECT count(*) FROM public.nexus_user_data WHERE user_id IN (" + firstWriteOwnerList + ")) || E'\\t' || " +
      "(SELECT count(*) FROM public.nexus_user_data_chunks WHERE user_id IN (" + firstWriteOwnerList + ');'
    );
    assert.equal(firstWriteLeftovers, '0\\t0\\t0',
      'first-write race owners and chunks must be removed by the normal account-deletion cascade');
  }

} catch (error) {
    session.child.kill('SIGTERM');
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

function combinedOutput(result) {
  return [result.stdout, result.stderr].filter(Boolean).join('\n');
}

async function runSqlDetailed(label, sql, applicationName) {
  const session = startSqlSession(label, sql, applicationName);
  return session.completion;
}

async function runSql(label, sql, applicationName) {
  const result = await runSqlDetailed(label, sql, applicationName);
  return combinedOutput(result);
}

async function runConcurrentPair(label, firstSql, secondSql, firstReadyMarker, firstApplicationName, secondApplicationName) {
  const firstSession = startSqlSession(label + ': first session', firstSql, firstApplicationName, firstReadyMarker);
  try {
    // Start the competing statement only after the first transaction has
    // emitted a notice from inside the transaction, immediately after it
    // acquired the workspace-row lock. This is deterministic and works with
    // Supavisor session mode without depending on pg_stat_activity visibility.
    await waitForLockReady(firstSession, label);
    const secondPromise = runSqlDetailed(label + ': second session', secondSql, secondApplicationName);
    const outcomes = await Promise.allSettled([firstSession.completion, secondPromise]);
    const failures = outcomes.filter(result => result.status === 'rejected');
    if (failures.length) {
      throw new AggregateError(failures.map(result => result.reason), label + ' did not complete cleanly.');
    }
    return outcomes.map(result => result.value);
  } catch (error) {
    await Promise.allSettled([firstSession.completion]);
    throw error;
  }
}

function assertObservedLockWait(result, label) {
  const match = combinedOutput(result).match(/NEXUS_RACE_OPERATION_MS=(\d+)/);
  assert.ok(match, label + ': the waiting SQL session did not report its measured operation duration.');
  const elapsedMs = Number(match[1]);
  assert.ok(
    elapsedMs >= MIN_LOCK_WAIT_MS,
    label + ': expected the competing SQL operation to wait at least ' + MIN_LOCK_WAIT_MS + ' ms for the held workspace-row lock, but it took ' + elapsedMs + ' ms.'
  );
}

const ownerId = randomUUID();
const revA = randomUUID();
const revB = randomUUID();
const revC = randomUUID();
const revD = randomUUID();
const email = 'nexus-active-manifest-race-' + ownerId.replaceAll('-', '') + '@example.invalid';
let seeded = false;

const chunkText = revisionId => revisionId === revA ? 'race-A'
  : revisionId === revB ? 'race-B'
  : revisionId === revC ? 'race-C'
  : revisionId === revD ? 'race-D'
  : null;
const manifestPayload = revisionId => {
  const chunk = chunkText(revisionId);
  if (!chunk) throw new Error('Unknown test revision.');
  return JSON.stringify({
    __nexusStorage: 'chunked-v1',
    version: 1,
    revisionId,
    chunkCount: 1,
    totalBytes: Buffer.byteLength(chunk),
    sha256: createHash('sha256').update(chunk).digest('hex')
  });
};
const sqlJsonb = value => "'" + value.replace(/'/g, "''") + "'::jsonb";
const updateManifest = revisionId =>
  "UPDATE public.nexus_user_data " +
  "SET payload = " + sqlJsonb(manifestPayload(revisionId)) + ", " +
  "updated_at = clock_timestamp() WHERE user_id = '" + ownerId + "';";

let primaryError;
try {
  const seedSql = [
    'BEGIN;',
    "INSERT INTO auth.users (id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)",
    "VALUES ('" + ownerId + "', 'authenticated', 'authenticated', '" + email + "', '', clock_timestamp(), '{}'::jsonb, '{}'::jsonb, clock_timestamp(), clock_timestamp());",
    "INSERT INTO public.nexus_user_data_chunks (user_id, revision_id, chunk_index, chunk_count, chunk_bytes, chunk_data, created_at) VALUES " +
      "('" + ownerId + "', '" + revA + "', 0, 1, octet_length('race-A'), 'race-A', clock_timestamp() - interval '8 days'), " +
      "('" + ownerId + "', '" + revB + "', 0, 1, octet_length('race-B'), 'race-B', clock_timestamp() - interval '8 days'), " +
      "('" + ownerId + "', '" + revC + "', 0, 1, octet_length('race-C'), 'race-C', clock_timestamp() - interval '8 days'), " +
      "('" + ownerId + "', '" + revD + "', 0, 1, octet_length('race-D'), 'race-D', clock_timestamp() - interval '8 days');",
    "INSERT INTO public.nexus_user_data (user_id, payload, updated_at) VALUES ('" + ownerId + "', " + sqlJsonb(manifestPayload(revA)) + ", clock_timestamp());",
    'COMMIT;'
  ].join('\n');
  await runSql('seed disposable owner and four chunk revisions', seedSql);
  seeded = true;

  const publisherFirstSql = [
    'BEGIN;',
    'DO $race$',
    'BEGIN',
    updateManifest(revB),
    "RAISE NOTICE 'NEXUS_RACE_LOCK_HELD';",
    'PERFORM pg_sleep(' + LOCK_HOLD_SECONDS + ');',
    'END',
    '$race$;',
    'COMMIT;'
  ].join('\n');
  const cleanupAfterPublisherSql = [
    'DO $race$',
    'DECLARE',
    '  v_started timestamptz;',
    '  v_deleted_revision uuid;',
    'BEGIN',
    '  PERFORM pg_sleep(' + SECOND_SESSION_DELAY_SECONDS + ');',
    '  v_started := clock_timestamp();',
    "  DELETE FROM public.nexus_user_data_chunks WHERE user_id = '" + ownerId + "' AND revision_id = '" + revA + "' RETURNING revision_id INTO v_deleted_revision;",
    "  RAISE NOTICE 'NEXUS_RACE_DELETED_REVISION=%', v_deleted_revision;",
    "  RAISE NOTICE 'NEXUS_RACE_OPERATION_MS=%', floor(extract(epoch FROM clock_timestamp() - v_started) * 1000);",
    'END',
    '$race$;'
  ].join('\n');
  const firstResults = await runConcurrentPair(
    'publisher wins the workspace-row lock',
    publisherFirstSql,
    cleanupAfterPublisherSql,
    'NEXUS_RACE_LOCK_HELD',
    'nexus-manifest-publisher-first',
    'nexus-manifest-cleanup-after-publisher'
  );
  assertObservedLockWait(firstResults[1], 'publisher-first cleanup');
  assert.ok(combinedOutput(firstResults[1]).includes(revA),
    'cleanup must wait for publication, re-read the new pointer, then remove only the now-stale revision');

  const afterPublisherFirstSql = [
    "SELECT (SELECT payload ->> 'revisionId' FROM public.nexus_user_data WHERE user_id = '" + ownerId + "') || E'\\t' ||",
    "(SELECT count(*)::text FROM public.nexus_user_data_chunks WHERE user_id = '" + ownerId + "' AND revision_id = '" + revA + "') || E'\\t' ||",
    "(SELECT count(*)::text FROM public.nexus_user_data_chunks WHERE user_id = '" + ownerId + "' AND revision_id = '" + revB + "');"
  ].join('\n');
  const afterPublisherFirst = await runSql('verify publisher-first ordering', afterPublisherFirstSql);
  assert.equal(afterPublisherFirst, revB + '\t0\t1',
    'publisher-first ordering must leave B active, remove A, and preserve all B chunks');

  await runSql('prepare delete-first ordering', updateManifest(revC));
  const cleanupFirstSql = [
    'BEGIN;',
    'DO $race$',
    'DECLARE',
    '  v_blocked boolean := false;',
    '  v_locked_user uuid;',
    'BEGIN',
    "  SELECT user_id INTO v_locked_user FROM public.nexus_user_data WHERE user_id = '" + ownerId + "' FOR UPDATE;",
    "  RAISE NOTICE 'NEXUS_RACE_LOCK_HELD';",
    '  BEGIN',
    "    DELETE FROM public.nexus_user_data_chunks WHERE user_id = '" + ownerId + "' AND revision_id = '" + revC + "';",
    '  EXCEPTION WHEN SQLSTATE \'55000\' THEN',
    '    v_blocked := true;',
    '  END;',
    '  IF NOT v_blocked THEN',
    "    RAISE EXCEPTION 'Expected active-manifest cleanup to fail with SQLSTATE 55000.';",
    '  END IF;',
    "  RAISE NOTICE 'NEXUS_RACE_LOCKED_OWNER=%', v_locked_user;",
    '  PERFORM pg_sleep(' + LOCK_HOLD_SECONDS + ');',
    'END',
    '$race$;',
    'COMMIT;'
  ].join('\n');
  const publisherAfterCleanupSql = [
    'DO $race$',
    'DECLARE',
    '  v_started timestamptz;',
    '  v_updated integer;',
    'BEGIN',
    '  PERFORM pg_sleep(' + SECOND_SESSION_DELAY_SECONDS + ');',
    '  v_started := clock_timestamp();',
    '  ' + updateManifest(revD),
    '  GET DIAGNOSTICS v_updated = ROW_COUNT;',
    '  IF v_updated <> 1 THEN',
    "    RAISE EXCEPTION 'Expected publisher to update exactly one workspace row; updated %.', v_updated;",
    '  END IF;',
    "  RAISE NOTICE 'NEXUS_RACE_PUBLISHER_UPDATED=%', v_updated;",
    "  RAISE NOTICE 'NEXUS_RACE_OPERATION_MS=%', floor(extract(epoch FROM clock_timestamp() - v_started) * 1000);",
    'END',
    '$race$;'
  ].join('\n');
  const secondResults = await runConcurrentPair(
    'cleanup holds the workspace-row lock first',
    cleanupFirstSql,
    publisherAfterCleanupSql,
    'NEXUS_RACE_LOCK_HELD',
    'nexus-manifest-cleanup-lock-first',
    'nexus-manifest-publisher-after-cleanup'
  );
  assert.ok(combinedOutput(secondResults[0]).includes(ownerId),
    'the cleanup session must lock the fixture workspace row');
  assertObservedLockWait(secondResults[1], 'cleanup-first publisher');
  assert.match(combinedOutput(secondResults[1]), /NEXUS_RACE_PUBLISHER_UPDATED=1/,
    'the waiting publisher must update exactly one workspace row after the lock-holding cleanup transaction commits');

  const afterCleanupFirstSql = [
    "SELECT (SELECT payload ->> 'revisionId' FROM public.nexus_user_data WHERE user_id = '" + ownerId + "') || E'\\t' ||",
    "(SELECT count(*)::text FROM public.nexus_user_data_chunks WHERE user_id = '" + ownerId + "' AND revision_id = '" + revC + "') || E'\\t' ||",
    "(SELECT count(*)::text FROM public.nexus_user_data_chunks WHERE user_id = '" + ownerId + "' AND revision_id = '" + revD + "') || E'\\t' ||",
    "(SELECT count(*)::text FROM public.nexus_user_data_chunks WHERE user_id = '" + ownerId + "' AND revision_id = '" + revB + "');"
  ].join('\n');
  const afterCleanupFirst = await runSql('verify cleanup-first ordering', afterCleanupFirstSql);
  assert.equal(afterCleanupFirst, revD + '\t1\t1\t1',
    'cleanup-first ordering must reject deletion of C, retain its chunk, and allow D to become active');

  const staleCleanupSql =
    "DELETE FROM public.nexus_user_data_chunks WHERE user_id = '" + ownerId + "' AND revision_id = '" + revC + "' RETURNING revision_id;";
  const staleCleanup = await runSql('retry cleanup after D publication', staleCleanupSql);
  assert.ok(staleCleanup.includes(revC),
    'the formerly active C revision must become cleanable only after D is published');

} catch (error) {
  primaryError = error;
} finally {
  if (seeded) {
    try {
      await runSql('remove disposable staging auth user and cascading workspace',
        "DELETE FROM auth.users WHERE id = '" + ownerId + "';");
      const remainingSql = [
        "SELECT (SELECT count(*)::text FROM auth.users WHERE id = '" + ownerId + "') || E'\\t' ||",
        "(SELECT count(*)::text FROM public.nexus_user_data WHERE user_id = '" + ownerId + "') || E'\\t' ||",
        "(SELECT count(*)::text FROM public.nexus_user_data_chunks WHERE user_id = '" + ownerId + "');"
      ].join('\n');
      const remaining = await runSql('verify disposable fixture cleanup', remainingSql);
      assert.equal(remaining, '0\t0\t0', 'the race-test owner and all of its rows must be removed');
    } catch (cleanupError) {
      if (primaryError) {
        throw new AggregateError([primaryError, cleanupError], 'The race test failed and fixture cleanup also failed.');
      }
      throw cleanupError;
    }
  }
}

if (primaryError) throw primaryError;
console.log('Snapshot-manifest integrity races passed: existing-row concurrency, first-write publication/cleanup concurrency, incomplete-candidate rejection, measured lock waits, and account-cascade fixture cleanup.');
,
      'DECLARE',
      '  v_started timestamptz;',
      '  v_rejected boolean := false;',
      'BEGIN',
      '  PERFORM pg_sleep(' + SECOND_SESSION_DELAY_SECONDS + ');',
      '  v_started := clock_timestamp();',
      '  BEGIN',
      '    ' + "UPDATE public.nexus_user_data SET payload = " + firstWritePublisherStalePayload +
        ", updated_at = clock_timestamp() WHERE user_id = '" + firstWritePublisherOwner + "';",
      "  EXCEPTION WHEN SQLSTATE '23514' THEN",
      '    v_rejected := true;',
      '  END;',
      '  IF NOT v_rejected THEN',
      "    RAISE EXCEPTION 'An UPDATE published an incomplete snapshot candidate.';",
      '  END IF;',
      "  RAISE NOTICE 'NEXUS_EXISTING_CANDIDATE_UPDATE_REJECTED=23514';",
      "  RAISE NOTICE 'NEXUS_RACE_OPERATION_MS=%', floor(extract(epoch FROM clock_timestamp() - v_started) * 1000);",
      'END',
      '$race$;'
    ].join('\n');
    const existingCandidateResults = await runConcurrentPair(
      'cleanup of an unpublished update candidate wins before manifest update',
      existingCandidateCleanupFirstSql,
      existingCandidatePublisherAfterCleanupSql,
      'NEXUS_EXISTING_CANDIDATE_CLEANUP_LOCK_HELD',
      'nexus-existing-candidate-cleanup-first',
      'nexus-existing-candidate-publisher-after-cleanup'
    );
    assertObservedLockWait(existingCandidateResults[1], 'existing-row cleanup-first update');
    assert.match(combinedOutput(existingCandidateResults[1]), /NEXUS_EXISTING_CANDIDATE_UPDATE_REJECTED=23514/,
      'the waiting UPDATE must reject the missing candidate');
    const existingCandidateState = await runSql(
      'verify existing-row candidate cleanup state',
      "SELECT (SELECT payload ->> 'revisionId' FROM public.nexus_user_data WHERE user_id = '" +
        firstWritePublisherOwner + "') || E'\\t' || " +
      "(SELECT count(*)::text FROM public.nexus_user_data_chunks WHERE user_id = '" +
        firstWritePublisherOwner + "' AND revision_id = '" + firstWritePublisherRevision + "') || E'\\t' || " +
      "(SELECT count(*)::text FROM public.nexus_user_data_chunks WHERE user_id = '" +
        firstWritePublisherOwner + "' AND revision_id = '" + firstWritePublisherStaleRevision + "');"
    );
    assert.equal(existingCandidateState, firstWritePublisherRevision + '\t1\t0',
      'an incomplete candidate must not replace the last complete active snapshot');

    const firstWriteCleanupFirstSql = [
      'BEGIN;',
      "DELETE FROM public.nexus_user_data_chunks WHERE user_id = '" +
        firstWriteCleanupOwner + "' AND revision_id = '" + firstWriteCleanupRevision + "';",
      'DO $race$',
      'BEGIN',
      "  RAISE NOTICE 'NEXUS_FIRST_WRITE_CLEANUP_LOCK_HELD';",
      '  PERFORM pg_sleep(' + LOCK_HOLD_SECONDS + ');',
      'END',
      '$race$;',
      'COMMIT;'
    ].join('\n');
    const firstWritePublisherAfterCleanupSql = [
      'DO $race$',
      'DECLARE',
      '  v_started timestamptz;',
      '  v_rejected boolean := false;',
      'BEGIN',
      '  PERFORM pg_sleep(' + SECOND_SESSION_DELAY_SECONDS + ');',
      '  v_started := clock_timestamp();',
      '  BEGIN',
      "    INSERT INTO public.nexus_user_data (user_id, payload, updated_at) VALUES ('" +
        firstWriteCleanupOwner + "', " + firstWriteCleanupPayload + ', clock_timestamp());',
      "  EXCEPTION WHEN SQLSTATE '23514' THEN",
      '    v_rejected := true;',
      '  END;',
      '  IF NOT v_rejected THEN',
      "    RAISE EXCEPTION 'An incomplete first-write candidate was allowed to become active.';",
      '  END IF;',
      "  RAISE NOTICE 'NEXUS_FIRST_WRITE_INCOMPLETE_PUBLICATION_REJECTED=23514';",
      "  RAISE NOTICE 'NEXUS_RACE_OPERATION_MS=%', floor(extract(epoch FROM clock_timestamp() - v_started) * 1000);",
      'END',
      '$race$;'
    ].join('\n');
    const firstWriteCleanupResults = await runConcurrentPair(
      'first-write cleanup acquires the owner lock before publication',
      firstWriteCleanupFirstSql,
      firstWritePublisherAfterCleanupSql,
      'NEXUS_FIRST_WRITE_CLEANUP_LOCK_HELD',
      'nexus-first-snapshot-cleanup-first',
      'nexus-first-snapshot-publisher-after-cleanup'
    );
    assertObservedLockWait(firstWriteCleanupResults[1], 'first-write cleanup-first publication');
    assert.match(combinedOutput(firstWriteCleanupResults[1]), /NEXUS_FIRST_WRITE_INCOMPLETE_PUBLICATION_REJECTED=23514/,
      'publication must fail closed after cleanup removes an unpublished first-write candidate');
    const firstWriteCleanupState = await runSql(
      'verify first-write cleanup-first state',
      "SELECT (SELECT count(*)::text FROM public.nexus_user_data WHERE user_id = '" +
        firstWriteCleanupOwner + "') || E'\\\\t' || " +
      "(SELECT count(*)::text FROM public.nexus_user_data_chunks WHERE user_id = '" +
        firstWriteCleanupOwner + "' AND revision_id = '" + firstWriteCleanupRevision + "');"
    );
    assert.equal(firstWriteCleanupState, '0\\t0',
      'cleanup-first ordering must leave no parent manifest and no candidate chunks');
  } finally {
    const firstWriteOwnerList = "'" + firstWritePublisherOwner + "','" + firstWriteCleanupOwner + "'";
    await runSql('delete first-write race fixture owners through account cascade',
      'DELETE FROM auth.users WHERE id IN (' + firstWriteOwnerList + ');');
    const firstWriteLeftovers = await runSql(
      'verify first-write race fixture cascade',
      "SELECT (SELECT count(*) FROM auth.users WHERE id IN (" + firstWriteOwnerList + ")) || E'\\t' || " +
      "(SELECT count(*) FROM public.nexus_user_data WHERE user_id IN (" + firstWriteOwnerList + ")) || E'\\t' || " +
      "(SELECT count(*) FROM public.nexus_user_data_chunks WHERE user_id IN (" + firstWriteOwnerList + ');'
    );
    assert.equal(firstWriteLeftovers, '0\\t0\\t0',
      'first-write race owners and chunks must be removed by the normal account-deletion cascade');
  }

} catch (error) {
    session.child.kill('SIGTERM');
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

function combinedOutput(result) {
  return [result.stdout, result.stderr].filter(Boolean).join('\n');
}

async function runSqlDetailed(label, sql, applicationName) {
  const session = startSqlSession(label, sql, applicationName);
  return session.completion;
}

async function runSql(label, sql, applicationName) {
  const result = await runSqlDetailed(label, sql, applicationName);
  return combinedOutput(result);
}

async function runConcurrentPair(label, firstSql, secondSql, firstReadyMarker, firstApplicationName, secondApplicationName) {
  const firstSession = startSqlSession(label + ': first session', firstSql, firstApplicationName, firstReadyMarker);
  try {
    // Start the competing statement only after the first transaction has
    // emitted a notice from inside the transaction, immediately after it
    // acquired the workspace-row lock. This is deterministic and works with
    // Supavisor session mode without depending on pg_stat_activity visibility.
    await waitForLockReady(firstSession, label);
    const secondPromise = runSqlDetailed(label + ': second session', secondSql, secondApplicationName);
    const outcomes = await Promise.allSettled([firstSession.completion, secondPromise]);
    const failures = outcomes.filter(result => result.status === 'rejected');
    if (failures.length) {
      throw new AggregateError(failures.map(result => result.reason), label + ' did not complete cleanly.');
    }
    return outcomes.map(result => result.value);
  } catch (error) {
    await Promise.allSettled([firstSession.completion]);
    throw error;
  }
}

function assertObservedLockWait(result, label) {
  const match = combinedOutput(result).match(/NEXUS_RACE_OPERATION_MS=(\d+)/);
  assert.ok(match, label + ': the waiting SQL session did not report its measured operation duration.');
  const elapsedMs = Number(match[1]);
  assert.ok(
    elapsedMs >= MIN_LOCK_WAIT_MS,
    label + ': expected the competing SQL operation to wait at least ' + MIN_LOCK_WAIT_MS + ' ms for the held workspace-row lock, but it took ' + elapsedMs + ' ms.'
  );
}

const ownerId = randomUUID();
const revA = randomUUID();
const revB = randomUUID();
const revC = randomUUID();
const revD = randomUUID();
const email = 'nexus-active-manifest-race-' + ownerId.replaceAll('-', '') + '@example.invalid';
let seeded = false;

const chunkText = revisionId => revisionId === revA ? 'race-A'
  : revisionId === revB ? 'race-B'
  : revisionId === revC ? 'race-C'
  : revisionId === revD ? 'race-D'
  : null;
const manifestPayload = revisionId => {
  const chunk = chunkText(revisionId);
  if (!chunk) throw new Error('Unknown test revision.');
  return JSON.stringify({
    __nexusStorage: 'chunked-v1',
    version: 1,
    revisionId,
    chunkCount: 1,
    totalBytes: Buffer.byteLength(chunk),
    sha256: createHash('sha256').update(chunk).digest('hex')
  });
};
const sqlJsonb = value => "'" + value.replace(/'/g, "''") + "'::jsonb";
const updateManifest = revisionId =>
  "UPDATE public.nexus_user_data " +
  "SET payload = " + sqlJsonb(manifestPayload(revisionId)) + ", " +
  "updated_at = clock_timestamp() WHERE user_id = '" + ownerId + "';";

let primaryError;
try {
  const seedSql = [
    'BEGIN;',
    "INSERT INTO auth.users (id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)",
    "VALUES ('" + ownerId + "', 'authenticated', 'authenticated', '" + email + "', '', clock_timestamp(), '{}'::jsonb, '{}'::jsonb, clock_timestamp(), clock_timestamp());",
    "INSERT INTO public.nexus_user_data_chunks (user_id, revision_id, chunk_index, chunk_count, chunk_bytes, chunk_data, created_at) VALUES " +
      "('" + ownerId + "', '" + revA + "', 0, 1, octet_length('race-A'), 'race-A', clock_timestamp() - interval '8 days'), " +
      "('" + ownerId + "', '" + revB + "', 0, 1, octet_length('race-B'), 'race-B', clock_timestamp() - interval '8 days'), " +
      "('" + ownerId + "', '" + revC + "', 0, 1, octet_length('race-C'), 'race-C', clock_timestamp() - interval '8 days'), " +
      "('" + ownerId + "', '" + revD + "', 0, 1, octet_length('race-D'), 'race-D', clock_timestamp() - interval '8 days');",
    "INSERT INTO public.nexus_user_data (user_id, payload, updated_at) VALUES ('" + ownerId + "', " + sqlJsonb(manifestPayload(revA)) + ", clock_timestamp());",
    'COMMIT;'
  ].join('\n');
  await runSql('seed disposable owner and four chunk revisions', seedSql);
  seeded = true;

  const publisherFirstSql = [
    'BEGIN;',
    'DO $race$',
    'BEGIN',
    updateManifest(revB),
    "RAISE NOTICE 'NEXUS_RACE_LOCK_HELD';",
    'PERFORM pg_sleep(' + LOCK_HOLD_SECONDS + ');',
    'END',
    '$race$;',
    'COMMIT;'
  ].join('\n');
  const cleanupAfterPublisherSql = [
    'DO $race$',
    'DECLARE',
    '  v_started timestamptz;',
    '  v_deleted_revision uuid;',
    'BEGIN',
    '  PERFORM pg_sleep(' + SECOND_SESSION_DELAY_SECONDS + ');',
    '  v_started := clock_timestamp();',
    "  DELETE FROM public.nexus_user_data_chunks WHERE user_id = '" + ownerId + "' AND revision_id = '" + revA + "' RETURNING revision_id INTO v_deleted_revision;",
    "  RAISE NOTICE 'NEXUS_RACE_DELETED_REVISION=%', v_deleted_revision;",
    "  RAISE NOTICE 'NEXUS_RACE_OPERATION_MS=%', floor(extract(epoch FROM clock_timestamp() - v_started) * 1000);",
    'END',
    '$race$;'
  ].join('\n');
  const firstResults = await runConcurrentPair(
    'publisher wins the workspace-row lock',
    publisherFirstSql,
    cleanupAfterPublisherSql,
    'NEXUS_RACE_LOCK_HELD',
    'nexus-manifest-publisher-first',
    'nexus-manifest-cleanup-after-publisher'
  );
  assertObservedLockWait(firstResults[1], 'publisher-first cleanup');
  assert.ok(combinedOutput(firstResults[1]).includes(revA),
    'cleanup must wait for publication, re-read the new pointer, then remove only the now-stale revision');

  const afterPublisherFirstSql = [
    "SELECT (SELECT payload ->> 'revisionId' FROM public.nexus_user_data WHERE user_id = '" + ownerId + "') || E'\\t' ||",
    "(SELECT count(*)::text FROM public.nexus_user_data_chunks WHERE user_id = '" + ownerId + "' AND revision_id = '" + revA + "') || E'\\t' ||",
    "(SELECT count(*)::text FROM public.nexus_user_data_chunks WHERE user_id = '" + ownerId + "' AND revision_id = '" + revB + "');"
  ].join('\n');
  const afterPublisherFirst = await runSql('verify publisher-first ordering', afterPublisherFirstSql);
  assert.equal(afterPublisherFirst, revB + '\t0\t1',
    'publisher-first ordering must leave B active, remove A, and preserve all B chunks');

  await runSql('prepare delete-first ordering', updateManifest(revC));
  const cleanupFirstSql = [
    'BEGIN;',
    'DO $race$',
    'DECLARE',
    '  v_blocked boolean := false;',
    '  v_locked_user uuid;',
    'BEGIN',
    "  SELECT user_id INTO v_locked_user FROM public.nexus_user_data WHERE user_id = '" + ownerId + "' FOR UPDATE;",
    "  RAISE NOTICE 'NEXUS_RACE_LOCK_HELD';",
    '  BEGIN',
    "    DELETE FROM public.nexus_user_data_chunks WHERE user_id = '" + ownerId + "' AND revision_id = '" + revC + "';",
    '  EXCEPTION WHEN SQLSTATE \'55000\' THEN',
    '    v_blocked := true;',
    '  END;',
    '  IF NOT v_blocked THEN',
    "    RAISE EXCEPTION 'Expected active-manifest cleanup to fail with SQLSTATE 55000.';",
    '  END IF;',
    "  RAISE NOTICE 'NEXUS_RACE_LOCKED_OWNER=%', v_locked_user;",
    '  PERFORM pg_sleep(' + LOCK_HOLD_SECONDS + ');',
    'END',
    '$race$;',
    'COMMIT;'
  ].join('\n');
  const publisherAfterCleanupSql = [
    'DO $race$',
    'DECLARE',
    '  v_started timestamptz;',
    '  v_updated integer;',
    'BEGIN',
    '  PERFORM pg_sleep(' + SECOND_SESSION_DELAY_SECONDS + ');',
    '  v_started := clock_timestamp();',
    '  ' + updateManifest(revD),
    '  GET DIAGNOSTICS v_updated = ROW_COUNT;',
    '  IF v_updated <> 1 THEN',
    "    RAISE EXCEPTION 'Expected publisher to update exactly one workspace row; updated %.', v_updated;",
    '  END IF;',
    "  RAISE NOTICE 'NEXUS_RACE_PUBLISHER_UPDATED=%', v_updated;",
    "  RAISE NOTICE 'NEXUS_RACE_OPERATION_MS=%', floor(extract(epoch FROM clock_timestamp() - v_started) * 1000);",
    'END',
    '$race$;'
  ].join('\n');
  const secondResults = await runConcurrentPair(
    'cleanup holds the workspace-row lock first',
    cleanupFirstSql,
    publisherAfterCleanupSql,
    'NEXUS_RACE_LOCK_HELD',
    'nexus-manifest-cleanup-lock-first',
    'nexus-manifest-publisher-after-cleanup'
  );
  assert.ok(combinedOutput(secondResults[0]).includes(ownerId),
    'the cleanup session must lock the fixture workspace row');
  assertObservedLockWait(secondResults[1], 'cleanup-first publisher');
  assert.match(combinedOutput(secondResults[1]), /NEXUS_RACE_PUBLISHER_UPDATED=1/,
    'the waiting publisher must update exactly one workspace row after the lock-holding cleanup transaction commits');

  const afterCleanupFirstSql = [
    "SELECT (SELECT payload ->> 'revisionId' FROM public.nexus_user_data WHERE user_id = '" + ownerId + "') || E'\\t' ||",
    "(SELECT count(*)::text FROM public.nexus_user_data_chunks WHERE user_id = '" + ownerId + "' AND revision_id = '" + revC + "') || E'\\t' ||",
    "(SELECT count(*)::text FROM public.nexus_user_data_chunks WHERE user_id = '" + ownerId + "' AND revision_id = '" + revD + "') || E'\\t' ||",
    "(SELECT count(*)::text FROM public.nexus_user_data_chunks WHERE user_id = '" + ownerId + "' AND revision_id = '" + revB + "');"
  ].join('\n');
  const afterCleanupFirst = await runSql('verify cleanup-first ordering', afterCleanupFirstSql);
  assert.equal(afterCleanupFirst, revD + '\t1\t1\t1',
    'cleanup-first ordering must reject deletion of C, retain its chunk, and allow D to become active');

  const staleCleanupSql =
    "DELETE FROM public.nexus_user_data_chunks WHERE user_id = '" + ownerId + "' AND revision_id = '" + revC + "' RETURNING revision_id;";
  const staleCleanup = await runSql('retry cleanup after D publication', staleCleanupSql);
  assert.ok(staleCleanup.includes(revC),
    'the formerly active C revision must become cleanable only after D is published');

} catch (error) {
  primaryError = error;
} finally {
  if (seeded) {
    try {
      await runSql('remove disposable staging auth user and cascading workspace',
        "DELETE FROM auth.users WHERE id = '" + ownerId + "';");
      const remainingSql = [
        "SELECT (SELECT count(*)::text FROM auth.users WHERE id = '" + ownerId + "') || E'\\t' ||",
        "(SELECT count(*)::text FROM public.nexus_user_data WHERE user_id = '" + ownerId + "') || E'\\t' ||",
        "(SELECT count(*)::text FROM public.nexus_user_data_chunks WHERE user_id = '" + ownerId + "');"
      ].join('\n');
      const remaining = await runSql('verify disposable fixture cleanup', remainingSql);
      assert.equal(remaining, '0\t0\t0', 'the race-test owner and all of its rows must be removed');
    } catch (cleanupError) {
      if (primaryError) {
        throw new AggregateError([primaryError, cleanupError], 'The race test failed and fixture cleanup also failed.');
      }
      throw cleanupError;
    }
  }
}

if (primaryError) throw primaryError;
console.log('Snapshot-manifest integrity races passed: existing-row concurrency, first-write publication/cleanup concurrency, incomplete-candidate rejection, measured lock waits, and account-cascade fixture cleanup.');
