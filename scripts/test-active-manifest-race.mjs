import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';

const PRODUCTION_PROJECT_REF = 'txugbdavblpettcnhcxl';
const LOCK_HOLD_SECONDS = 4.0;
const SECOND_SESSION_DELAY_SECONDS = 0.35;
const MIN_LOCK_WAIT_MS = 2500;
const READY_TIMEOUT_MS = 20000;
const databaseUrl = process.env.NEXUS_RACE_DATABASE_URL;

if (!databaseUrl) {
  console.log('Snapshot-manifest race test skipped. Set NEXUS_RACE_DATABASE_URL to the disposable local Supabase Postgres URL to run it.');
  process.exit(0);
}

const connection = new URL(databaseUrl);
const host = connection.hostname.toLowerCase();
const username = decodeURIComponent(connection.username).toLowerCase();
const localDatabase = ['localhost', '127.0.0.1', '::1'].includes(host);

if (host.includes(PRODUCTION_PROJECT_REF) || username.includes(PRODUCTION_PROJECT_REF)) {
  throw new Error('Refusing to run the snapshot-manifest race test against the production Nexus Supabase project.');
}
if (!localDatabase) {
  throw new Error('Refusing every remote database. This concurrency test may run only against disposable local Supabase on localhost/loopback.');
}
if (connection.port === '6543') {
  throw new Error('Transaction-pooler connections cannot hold the two independent test transactions. Use the direct or session-mode Postgres connection.');
}

const psqlVersion = spawnSync('psql', ['--version'], { encoding: 'utf8' });
if (psqlVersion.error || psqlVersion.status !== 0) {
  throw new Error('psql is required to run the snapshot-manifest race test.');
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
  PGAPPNAME: 'nexus-snapshot-manifest-race-test',
  PGOPTIONS: '-c statement_timeout=30000'
};

function startSqlSession(label, sql, applicationName, readyMarker = null) {
  const child = spawn('psql', [
    '-X', '-v', 'ON_ERROR_STOP=1', '-A', '-t', '-F', '\t', '-c', sql
  ], {
    env: { ...pgEnv, ...(applicationName ? { PGAPPNAME: applicationName } : {}) },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let stdout = '';
  let stderr = '';
  let readySeen = false;
  let settled = false;
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
  completion.catch(() => {});

  child.stdout.setEncoding('utf8').on('data', value => { stdout += value; });
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
    if (!settled) {
      settled = true;
      rejectCompletion(failure);
    }
  });
  child.on('close', code => {
    if (readyMarker && !readySeen) {
      rejectReady(new Error(label + ' exited before its lock-ready notice.\n' + stderr + '\n' + stdout));
    }
    if (settled) return;
    settled = true;
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
    timeoutId = setTimeout(() => reject(new Error(
      label + ': timed out waiting for the first transaction to acquire its lock.'
    )), READY_TIMEOUT_MS);
  });
  try {
    await Promise.race([session.ready, timeout]);
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
  return startSqlSession(label, sql, applicationName).completion;
}

async function runSql(label, sql, applicationName) {
  return combinedOutput(await runSqlDetailed(label, sql, applicationName));
}

async function runConcurrentPair(label, firstSql, secondSql, readyMarker, firstApplicationName, secondApplicationName) {
  const first = startSqlSession(label + ': first session', firstSql, firstApplicationName, readyMarker);
  try {
    await waitForLockReady(first, label);
    const secondPromise = runSqlDetailed(label + ': second session', secondSql, secondApplicationName);
    const outcomes = await Promise.allSettled([first.completion, secondPromise]);
    const failures = outcomes.filter(outcome => outcome.status === 'rejected');
    if (failures.length) {
      throw new AggregateError(failures.map(outcome => outcome.reason), label + ' did not complete cleanly.');
    }
    return outcomes.map(outcome => outcome.value);
  } catch (error) {
    await Promise.allSettled([first.completion]);
    throw error;
  }
}

function assertObservedLockWait(result, label) {
  const match = combinedOutput(result).match(/NEXUS_RACE_OPERATION_MS=(\d+)/);
  assert.ok(match, label + ': the competing SQL session did not report its measured operation duration.');
  const elapsedMs = Number(match[1]);
  assert.ok(
    elapsedMs >= MIN_LOCK_WAIT_MS,
    label + ': expected a wait of at least ' + MIN_LOCK_WAIT_MS + ' ms, but measured ' + elapsedMs + ' ms.'
  );
}

const quoteSql = value => "'" + String(value).replace(/'/g, "''") + "'";
const manifestFor = (revisionId, data) => JSON.stringify({
  __nexusStorage: 'chunked-v1',
  version: 1,
  revisionId,
  chunkCount: 1,
  totalBytes: Buffer.byteLength(data),
  sha256: createHash('sha256').update(data).digest('hex')
});
const jsonbFor = (revisionId, data) => quoteSql(manifestFor(revisionId, data)) + '::jsonb';
const chunkFor = (ownerId, revisionId, data) =>
  '(' + quoteSql(ownerId) + ',' + quoteSql(revisionId) +
  ',0,1,octet_length(' + quoteSql(data) + '),' + quoteSql(data) +
  ',clock_timestamp() - interval \'8 days\')';

const ownerA = randomUUID();
const ownerFirstPublish = randomUUID();
const ownerFirstCleanup = randomUUID();
const revA = randomUUID();
const revB = randomUUID();
const revC = randomUUID();
const revD = randomUUID();
const revFirstPublish = randomUUID();
const revUpdateCandidate = randomUUID();
const revFirstCleanup = randomUUID();
const dataA = 'race-A';
const dataB = 'race-B';
const dataC = 'race-C';
const dataD = 'race-D';
const dataFirstPublish = 'first-write-publisher';
const dataUpdateCandidate = 'stale-update-candidate';
const dataFirstCleanup = 'first-write-cleanup';
const stampA = '2026-11-01T00:00:00.000Z';
const stampB = '2026-11-01T00:00:01.000Z';
const stampC = '2026-11-01T00:00:02.000Z';

const emailA = 'nexus-manifest-race-' + ownerA.replaceAll('-', '') + '@example.invalid';
const emailFirstPublish = 'nexus-first-write-publisher-' + ownerFirstPublish.replaceAll('-', '') + '@example.invalid';
const emailFirstCleanup = 'nexus-first-write-cleanup-' + ownerFirstCleanup.replaceAll('-', '') + '@example.invalid';
let seeded = false;
let primaryError;

function publisherTransaction(label, ownerId, expectedStamp, nextStamp, revisionId, data, readyMarker) {
  const update = [
    'UPDATE public.nexus_user_data',
    'SET payload = ' + jsonbFor(revisionId, data) + ',',
    '    updated_at = ' + quoteSql(nextStamp) + '::timestamptz',
    'WHERE user_id = ' + quoteSql(ownerId),
    '  AND updated_at = ' + quoteSql(expectedStamp) + '::timestamptz;'
  ].join('\n');
  return [
    'BEGIN;',
    'DO $race$',
    'DECLARE v_updated integer;',
    'BEGIN',
    '  ' + update,
    '  GET DIAGNOSTICS v_updated = ROW_COUNT;',
    "  IF v_updated <> 1 THEN RAISE EXCEPTION 'Conditional snapshot update did not affect exactly one row.'; END IF;",
    "  RAISE NOTICE '" + readyMarker + "';",
    '  PERFORM pg_sleep(' + LOCK_HOLD_SECONDS + ');',
    'END',
    '$race$;',
    'COMMIT;'
  ].join('\n');
}

function publisherAttemptAfterCleanup(ownerId, expectedStamp, nextStamp, revisionId, data, expectedSqlState) {
  const update = [
    'UPDATE public.nexus_user_data',
    'SET payload = ' + jsonbFor(revisionId, data) + ',',
    '    updated_at = ' + quoteSql(nextStamp) + '::timestamptz',
    'WHERE user_id = ' + quoteSql(ownerId),
    '  AND updated_at = ' + quoteSql(expectedStamp) + '::timestamptz;'
  ].join('\n');
  return [
    'DO $race$',
    'DECLARE v_started timestamptz; v_updated integer := 0; v_rejected boolean := false;',
    'BEGIN',
    '  PERFORM pg_sleep(' + SECOND_SESSION_DELAY_SECONDS + ');',
    '  v_started := clock_timestamp();',
    '  BEGIN',
    '    ' + update,
    '    GET DIAGNOSTICS v_updated = ROW_COUNT;',
    "  EXCEPTION WHEN SQLSTATE '" + expectedSqlState + "' THEN",
    '    v_rejected := true;',
    '  END;',
    '  IF NOT v_rejected THEN RAISE EXCEPTION \'Expected snapshot publication rejection was not observed.\'; END IF;',
    "  RAISE NOTICE 'NEXUS_RACE_PUBLICATION_REJECTED=" + expectedSqlState + "';",
    "  RAISE NOTICE 'NEXUS_RACE_OPERATION_MS=%', floor(extract(epoch FROM clock_timestamp() - v_started) * 1000);",
    'END',
    '$race$;'
  ].join('\n');
}

function firstInsertTransaction(ownerId, revisionId, data, readyMarker) {
  return [
    'BEGIN;',
    'INSERT INTO public.nexus_user_data (user_id, payload, updated_at) VALUES (' +
      quoteSql(ownerId) + ',' + jsonbFor(revisionId, data) + ',clock_timestamp());',
    'DO $race$',
    'BEGIN',
    "  RAISE NOTICE '" + readyMarker + "';",
    '  PERFORM pg_sleep(' + LOCK_HOLD_SECONDS + ');',
    'END',
    '$race$;',
    'COMMIT;'
  ].join('\n');
}

function cleanupCandidateTransaction(ownerId, revisionId, readyMarker) {
  return [
    'BEGIN;',
    'DELETE FROM public.nexus_user_data_chunks WHERE user_id = ' + quoteSql(ownerId) +
      ' AND revision_id = ' + quoteSql(revisionId) + ';',
    'DO $race$',
    'BEGIN',
    "  RAISE NOTICE '" + readyMarker + "';",
    '  PERFORM pg_sleep(' + LOCK_HOLD_SECONDS + ');',
    'END',
    '$race$;',
    'COMMIT;'
  ].join('\n');
}

function cleanupActiveCandidateAttempt(ownerId, revisionId) {
  return [
    'DO $race$',
    'DECLARE v_started timestamptz; v_blocked boolean := false;',
    'BEGIN',
    '  PERFORM pg_sleep(' + SECOND_SESSION_DELAY_SECONDS + ');',
    '  v_started := clock_timestamp();',
    '  BEGIN',
    '    DELETE FROM public.nexus_user_data_chunks WHERE user_id = ' + quoteSql(ownerId) +
      ' AND revision_id = ' + quoteSql(revisionId) + ';',
    "  EXCEPTION WHEN SQLSTATE '55000' THEN",
    '    v_blocked := true;',
    '  END;',
    "  IF NOT v_blocked THEN RAISE EXCEPTION 'Cleanup deleted chunks for the active manifest.'; END IF;",
    "  RAISE NOTICE 'NEXUS_RACE_ACTIVE_DELETE_REJECTED=55000';",
    "  RAISE NOTICE 'NEXUS_RACE_OPERATION_MS=%', floor(extract(epoch FROM clock_timestamp() - v_started) * 1000);",
    'END',
    '$race$;'
  ].join('\n');
}

function insertAttemptAfterCleanup(ownerId, revisionId, data) {
  return [
    'DO $race$',
    'DECLARE v_started timestamptz; v_rejected boolean := false;',
    'BEGIN',
    '  PERFORM pg_sleep(' + SECOND_SESSION_DELAY_SECONDS + ');',
    '  v_started := clock_timestamp();',
    '  BEGIN',
    '    INSERT INTO public.nexus_user_data (user_id, payload, updated_at) VALUES (' +
      quoteSql(ownerId) + ',' + jsonbFor(revisionId, data) + ',clock_timestamp());',
    "  EXCEPTION WHEN SQLSTATE '23514' THEN",
    '    v_rejected := true;',
    '  END;',
    "  IF NOT v_rejected THEN RAISE EXCEPTION 'An incomplete first-write candidate became active.'; END IF;",
    "  RAISE NOTICE 'NEXUS_RACE_PUBLICATION_REJECTED=23514';",
    "  RAISE NOTICE 'NEXUS_RACE_OPERATION_MS=%', floor(extract(epoch FROM clock_timestamp() - v_started) * 1000);",
    'END',
    '$race$;'
  ].join('\n');
}

try {
  const users = [
    '(' + quoteSql(ownerA) + ",'authenticated','authenticated'," + quoteSql(emailA) + ",'',clock_timestamp(),'{}'::jsonb,'{}'::jsonb,clock_timestamp(),clock_timestamp())",
    '(' + quoteSql(ownerFirstPublish) + ",'authenticated','authenticated'," + quoteSql(emailFirstPublish) + ",'',clock_timestamp(),'{}'::jsonb,'{}'::jsonb,clock_timestamp(),clock_timestamp())",
    '(' + quoteSql(ownerFirstCleanup) + ",'authenticated','authenticated'," + quoteSql(emailFirstCleanup) + ",'',clock_timestamp(),'{}'::jsonb,'{}'::jsonb,clock_timestamp(),clock_timestamp())"
  ].join(',\n');
  const chunks = [
    chunkFor(ownerA, revA, dataA),
    chunkFor(ownerA, revB, dataB),
    chunkFor(ownerA, revC, dataC),
    chunkFor(ownerA, revD, dataD),
    chunkFor(ownerFirstPublish, revFirstPublish, dataFirstPublish),
    chunkFor(ownerFirstPublish, revUpdateCandidate, dataUpdateCandidate),
    chunkFor(ownerFirstCleanup, revFirstCleanup, dataFirstCleanup)
  ].join(',\n');

  const seedSql = [
    'BEGIN;',
    'INSERT INTO auth.users (id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at) VALUES ' + users + ';',
    'INSERT INTO public.nexus_user_data_chunks (user_id, revision_id, chunk_index, chunk_count, chunk_bytes, chunk_data, created_at) VALUES ' + chunks + ';',
    'INSERT INTO public.nexus_user_data (user_id, payload, updated_at) VALUES (' +
      quoteSql(ownerA) + ',' + jsonbFor(revA, dataA) + ',' + quoteSql(stampA) + '::timestamptz);',
    'COMMIT;'
  ].join('\n');
  await runSql('seed isolated snapshot manifest race owners and complete candidate sets', seedSql);
  seeded = true;

  // Existing workspace, publisher wins: cleanup waits, re-reads the pointer,
  // and may delete only the old revision A after B is active.
  const publisherFirst = publisherTransaction(
    'publisher first', ownerA, stampA, stampB, revB, dataB, 'NEXUS_PUBLISHER_FIRST_LOCK_HELD'
  );
  const cleanupOldAfterPublish = [
    'DO $race$',
    'DECLARE v_started timestamptz; v_deleted integer := 0;',
    'BEGIN',
    '  PERFORM pg_sleep(' + SECOND_SESSION_DELAY_SECONDS + ');',
    '  v_started := clock_timestamp();',
    '  DELETE FROM public.nexus_user_data_chunks WHERE user_id = ' + quoteSql(ownerA) +
      ' AND revision_id = ' + quoteSql(revA) + ';',
    '  GET DIAGNOSTICS v_deleted = ROW_COUNT;',
    "  IF v_deleted <> 1 THEN RAISE EXCEPTION 'Expected exactly one old-revision chunk to be reclaimed.'; END IF;",
    "  RAISE NOTICE 'NEXUS_RACE_OLD_REVISION_CLEANED=1';",
    "  RAISE NOTICE 'NEXUS_RACE_OPERATION_MS=%', floor(extract(epoch FROM clock_timestamp() - v_started) * 1000);",
    'END',
    '$race$;'
  ].join('\n');
  const firstPair = await runConcurrentPair(
    'publisher acquires the workspace row before old-revision cleanup',
    publisherFirst,
    cleanupOldAfterPublish,
    'NEXUS_PUBLISHER_FIRST_LOCK_HELD',
    'nexus-publisher-first',
    'nexus-cleanup-after-publisher'
  );
  assertObservedLockWait(firstPair[1], 'publisher-first stale cleanup');
  assert.match(combinedOutput(firstPair[1]), /NEXUS_RACE_OLD_REVISION_CLEANED=1/);
  const afterFirst = await runSql(
    'verify publisher-first state',
    `SELECT concat_ws(chr(9),
      (SELECT payload ->> 'revisionId' FROM public.nexus_user_data WHERE user_id = ${quoteSql(ownerA)}),
      (SELECT count(*)::text FROM public.nexus_user_data_chunks WHERE user_id = ${quoteSql(ownerA)} AND revision_id = ${quoteSql(revA)}),
      (SELECT count(*)::text FROM public.nexus_user_data_chunks WHERE user_id = ${quoteSql(ownerA)} AND revision_id = ${quoteSql(revB)})
    );`
  );
  assert.equal(afterFirst, revB + '\t0\t1',
    'publisher-first ordering must keep B active, reclaim A, and retain B');

  // Cleanup wins against an active manifest: the trigger rejects deleting B,
  // retains the workspace-row lock, and allows the waiting writer to publish C.
  const activeDeleteFirst = [
    'BEGIN;',
    'SELECT user_id FROM public.nexus_user_data WHERE user_id = ' + quoteSql(ownerA) + ' FOR UPDATE;',
    'DO $race$',
    'DECLARE v_blocked boolean := false;',
    'BEGIN',
    '  BEGIN',
    '    DELETE FROM public.nexus_user_data_chunks WHERE user_id = ' + quoteSql(ownerA) +
      ' AND revision_id = ' + quoteSql(revB) + ';',
    "  EXCEPTION WHEN SQLSTATE '55000' THEN",
    '    v_blocked := true;',
    '  END;',
    "  IF NOT v_blocked THEN RAISE EXCEPTION 'Active manifest cleanup was not rejected.'; END IF;",
    "  RAISE NOTICE 'NEXUS_ACTIVE_DELETE_FIRST_LOCK_HELD';",
    '  PERFORM pg_sleep(' + LOCK_HOLD_SECONDS + ');',
    'END',
    '$race$;',
    'COMMIT;'
  ].join('\n');
  // This publication is expected to succeed, so use a successful writer block.
  const publishCSuccess = [
    'DO $race$',
    'DECLARE v_started timestamptz; v_updated integer := 0;',
    'BEGIN',
    '  PERFORM pg_sleep(' + SECOND_SESSION_DELAY_SECONDS + ');',
    '  v_started := clock_timestamp();',
    '  UPDATE public.nexus_user_data SET payload = ' + jsonbFor(revC, dataC) +
      ', updated_at = ' + quoteSql(stampC) + '::timestamptz WHERE user_id = ' + quoteSql(ownerA) +
      ' AND updated_at = ' + quoteSql(stampB) + '::timestamptz;',
    '  GET DIAGNOSTICS v_updated = ROW_COUNT;',
    "  IF v_updated <> 1 THEN RAISE EXCEPTION 'The waiting writer did not publish C.'; END IF;",
    "  RAISE NOTICE 'NEXUS_RACE_PUBLISHER_UPDATED=1';",
    "  RAISE NOTICE 'NEXUS_RACE_OPERATION_MS=%', floor(extract(epoch FROM clock_timestamp() - v_started) * 1000);",
    'END',
    '$race$;'
  ].join('\n');
  const secondPair = await runConcurrentPair(
    'active-manifest cleanup attempt precedes valid publication',
    activeDeleteFirst,
    publishCSuccess,
    'NEXUS_ACTIVE_DELETE_FIRST_LOCK_HELD',
    'nexus-active-cleanup-first',
    'nexus-publisher-after-active-cleanup'
  );
  assertObservedLockWait(secondPair[1], 'active-delete-first publisher');
  assert.match(combinedOutput(secondPair[0]), /NEXUS_ACTIVE_DELETE_FIRST_LOCK_HELD/);
  assert.match(combinedOutput(secondPair[1]), /NEXUS_RACE_PUBLISHER_UPDATED=1/);
  const oldB = await runSql(
    'clean old B after C publication',
    'DELETE FROM public.nexus_user_data_chunks WHERE user_id = ' + quoteSql(ownerA) +
      ' AND revision_id = ' + quoteSql(revB) + ' RETURNING revision_id;'
  );
  assert.ok(oldB.includes(revB), 'B must become cleanable only after C is active');

  // Existing workspace, cleanup wins against an inactive candidate D. The
  // waiting conditional writer must reject D and preserve active snapshot C.
  const candidateCleanupFirst = cleanupCandidateTransaction(
    ownerA, revD, 'NEXUS_CANDIDATE_CLEANUP_FIRST_LOCK_HELD'
  );
  const publishDAfterCleanup = publisherAttemptAfterCleanup(
    ownerA, stampC, '2026-11-01T00:00:03.000Z', revD, dataD, '23514'
  );
  const thirdPair = await runConcurrentPair(
    'cleanup removes an unpublished update candidate before manifest publication',
    candidateCleanupFirst,
    publishDAfterCleanup,
    'NEXUS_CANDIDATE_CLEANUP_FIRST_LOCK_HELD',
    'nexus-candidate-cleanup-first',
    'nexus-candidate-publisher-after-cleanup'
  );
  assertObservedLockWait(thirdPair[1], 'existing-row candidate cleanup-first writer');
  assert.match(combinedOutput(thirdPair[1]), /NEXUS_RACE_PUBLICATION_REJECTED=23514/);
  const afterCandidateRace = await runSql(
    'verify incomplete update candidate was not published',
    `SELECT concat_ws(chr(9),
      (SELECT payload ->> 'revisionId' FROM public.nexus_user_data WHERE user_id = ${quoteSql(ownerA)}),
      (SELECT count(*)::text FROM public.nexus_user_data_chunks WHERE user_id = ${quoteSql(ownerA)} AND revision_id = ${quoteSql(revC)}),
      (SELECT count(*)::text FROM public.nexus_user_data_chunks WHERE user_id = ${quoteSql(ownerA)} AND revision_id = ${quoteSql(revD)})
    );`
  );
  assert.equal(afterCandidateRace, revC + '\t1\t0',
    'an incomplete update candidate must not replace the previous active snapshot');

  // First-write publisher wins: no parent row is visible while the insert is
  // in flight, so the shared owner advisory lock and post-lock re-read matter.
  const firstInsert = firstInsertTransaction(
    ownerFirstPublish, revFirstPublish, dataFirstPublish, 'NEXUS_FIRST_WRITE_PUBLISHER_LOCK_HELD'
  );
  const cleanupFirstPublished = cleanupActiveCandidateAttempt(ownerFirstPublish, revFirstPublish);
  const fourthPair = await runConcurrentPair(
    'first workspace INSERT precedes cleanup of its candidate chunks',
    firstInsert,
    cleanupFirstPublished,
    'NEXUS_FIRST_WRITE_PUBLISHER_LOCK_HELD',
    'nexus-first-write-publisher',
    'nexus-first-write-cleanup-after-publish'
  );
  assertObservedLockWait(fourthPair[1], 'first-write publisher-first cleanup');
  assert.match(combinedOutput(fourthPair[1]), /NEXUS_RACE_ACTIVE_DELETE_REJECTED=55000/);
  const afterFirstInsert = await runSql(
    'verify first-write publisher-first state',
    `SELECT concat_ws(chr(9),
      (SELECT payload ->> 'revisionId' FROM public.nexus_user_data WHERE user_id = ${quoteSql(ownerFirstPublish)}),
      (SELECT count(*)::text FROM public.nexus_user_data_chunks WHERE user_id = ${quoteSql(ownerFirstPublish)} AND revision_id = ${quoteSql(revFirstPublish)})
    );`
  );
  assert.equal(afterFirstInsert, revFirstPublish + '\t1',
    'first publication must remain active and retain its candidate chunks');

  // First-write cleanup wins: it deletes the stale candidate while the parent
  // row is absent. The waiting INSERT must then fail server-side with 23514.
  const cleanupFirstInsert = cleanupCandidateTransaction(
    ownerFirstCleanup, revFirstCleanup, 'NEXUS_FIRST_WRITE_CLEANUP_LOCK_HELD'
  );
  const publishAfterFirstCleanup = insertAttemptAfterCleanup(
    ownerFirstCleanup, revFirstCleanup, dataFirstCleanup
  );
  const fifthPair = await runConcurrentPair(
    'first-write cleanup removes a candidate before the workspace row exists',
    cleanupFirstInsert,
    publishAfterFirstCleanup,
    'NEXUS_FIRST_WRITE_CLEANUP_LOCK_HELD',
    'nexus-first-write-cleanup-first',
    'nexus-first-write-publisher-after-cleanup'
  );
  assertObservedLockWait(fifthPair[1], 'first-write cleanup-first insert');
  assert.match(combinedOutput(fifthPair[1]), /NEXUS_RACE_PUBLICATION_REJECTED=23514/);
  const afterFirstCleanup = await runSql(
    'verify first-write cleanup-first state',
    `SELECT concat_ws(chr(9),
      (SELECT count(*)::text FROM public.nexus_user_data WHERE user_id = ${quoteSql(ownerFirstCleanup)}),
      (SELECT count(*)::text FROM public.nexus_user_data_chunks WHERE user_id = ${quoteSql(ownerFirstCleanup)} AND revision_id = ${quoteSql(revFirstCleanup)})
    );`
  );
  assert.equal(afterFirstCleanup, '0\t0',
    'cleanup-first ordering must leave no parent manifest and no chunks');

} catch (error) {
  primaryError = error;
} finally {
  if (seeded) {
    try {
      const ownerList = [ownerA, ownerFirstPublish, ownerFirstCleanup].map(quoteSql).join(',');
      await runSql('remove disposable race owners through auth.users cascade',
        'DELETE FROM auth.users WHERE id IN (' + ownerList + ');');
      const leftovers = await runSql(
        'verify fixture account-cascade cleanup',
        `SELECT concat_ws(chr(9),
          (SELECT count(*) FROM auth.users WHERE id IN (${ownerList})),
          (SELECT count(*) FROM public.nexus_user_data WHERE user_id IN (${ownerList})),
          (SELECT count(*) FROM public.nexus_user_data_chunks WHERE user_id IN (${ownerList}))
        );`
      );
      assert.equal(leftovers, '0\t0\t0',
        'all disposable owners, manifests, and chunks must be removed by the normal account-deletion cascade');
    } catch (cleanupError) {
      if (primaryError) {
        primaryError = new AggregateError([primaryError, cleanupError],
          'The race test failed and account-cascade fixture cleanup also failed.');
      } else {
        primaryError = cleanupError;
      }
    }
  }
}

if (primaryError) throw primaryError;
console.log('General snapshot writer integrity passed: existing-row and first-write races in both orderings, incomplete-candidate rejection, measured lock waits, stale-revision cleanup, and account-deletion cascade.');
