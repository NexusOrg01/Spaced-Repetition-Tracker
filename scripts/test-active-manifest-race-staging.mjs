import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const STAGING_PROJECT_REF = 'xuwfzibxhxzxxupprxsq';
const PRODUCTION_PROJECT_REF = 'txugbdavblpettcnhcxl';
const databaseUrl = process.env.NEXUS_STAGING_DATABASE_URL;

if (!databaseUrl) {
  console.log('Active-manifest race test skipped. Set NEXUS_STAGING_DATABASE_URL to the isolated staging session/direct Postgres URL to run it.');
  process.exit(0);
}

const connection = new URL(databaseUrl);
const host = connection.hostname.toLowerCase();
const username = decodeURIComponent(connection.username).toLowerCase();
const localDatabase = ['localhost', '127.0.0.1', '::1'].includes(host);
const identifiesStaging = host.includes(STAGING_PROJECT_REF) || username.includes(STAGING_PROJECT_REF);

if (host.includes(PRODUCTION_PROJECT_REF) || username.includes(PRODUCTION_PROJECT_REF)) {
  throw new Error('Refusing to run the active-manifest race test against the production Nexus Supabase project.');
}
if (!localDatabase && !identifiesStaging) {
  throw new Error('Refusing an unrecognised database host. Use nexus-sync-staging or a local Supabase database.');
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
  PGSSLMODE: connection.searchParams.get('sslmode') || 'require',
  PGCONNECT_TIMEOUT: '10',
  PGAPPNAME: 'nexus-active-manifest-race-test',
  PGOPTIONS: '-c statement_timeout=20000'
};

function runSql(label, sql) {
  return new Promise((resolve, reject) => {
    const child = spawn('psql', [
      '-X',
      '-v', 'ON_ERROR_STOP=1',
      '-A',
      '-t',
      '-F', '\t',
      '-c', sql
    ], { env: pgEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', value => { stdout += value; });
    child.stderr.setEncoding('utf8').on('data', value => { stderr += value; });
    child.on('error', error => reject(new Error(label + ': ' + error.message)));
    child.on('close', code => {
      if (code !== 0) {
        reject(new Error(label + ' failed (psql exit ' + code + ').\n' + stderr + '\n' + stdout));
      } else {
        resolve(stdout.trim());
      }
    });
  });
}

async function runConcurrentPair(label, first, second) {
  const results = await Promise.allSettled([
    runSql(label + ': first session', first),
    runSql(label + ': second session', second)
  ]);
  const failures = results.filter(result => result.status === 'rejected');
  if (failures.length) {
    throw new AggregateError(failures.map(result => result.reason), label + ' did not complete cleanly.');
  }
  return results.map(result => result.value);
}

const ownerId = randomUUID();
const revA = randomUUID();
const revB = randomUUID();
const revC = randomUUID();
const revD = randomUUID();
const email = 'nexus-active-manifest-race-' + ownerId.replaceAll('-', '') + '@example.invalid';
let seeded = false;

const updateManifest = revisionId =>
  "UPDATE public.nexus_user_data " +
  "SET payload = jsonb_build_object('__nexusStorage', 'chunked-v1', 'revisionId', '" + revisionId + "'), " +
  "updated_at = clock_timestamp() WHERE user_id = '" + ownerId + "';";

try {
  const seedSql = [
    'BEGIN;',
    "INSERT INTO auth.users (id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)",
    "VALUES ('" + ownerId + "', 'authenticated', 'authenticated', '" + email + "', '', clock_timestamp(), '{}'::jsonb, '{}'::jsonb, clock_timestamp(), clock_timestamp());",
    "INSERT INTO public.nexus_user_data (user_id, payload, updated_at) VALUES ('" + ownerId + "', jsonb_build_object('__nexusStorage', 'chunked-v1', 'revisionId', '" + revA + "'), clock_timestamp());",
    "INSERT INTO public.nexus_user_data_chunks (user_id, revision_id, chunk_index, chunk_count, chunk_bytes, chunk_data, created_at) VALUES " +
      "('" + ownerId + "', '" + revA + "', 0, 1, octet_length('race-A'), 'race-A', clock_timestamp() - interval '8 days'), " +
      "('" + ownerId + "', '" + revB + "', 0, 1, octet_length('race-B'), 'race-B', clock_timestamp() - interval '8 days'), " +
      "('" + ownerId + "', '" + revC + "', 0, 1, octet_length('race-C'), 'race-C', clock_timestamp() - interval '8 days'), " +
      "('" + ownerId + "', '" + revD + "', 0, 1, octet_length('race-D'), 'race-D', clock_timestamp() - interval '8 days');",
    'COMMIT;'
  ].join('\n');
  await runSql('seed disposable owner and four chunk revisions', seedSql);
  seeded = true;

  const publisherFirstSql = [
    'BEGIN;',
    updateManifest(revB),
    'SELECT pg_sleep(2.0);',
    'COMMIT;'
  ].join('\n');
  const cleanupAfterPublisherSql = [
    'SELECT pg_sleep(0.35);',
    "DELETE FROM public.nexus_user_data_chunks WHERE user_id = '" + ownerId + "' AND revision_id = '" + revA + "' RETURNING revision_id;"
  ].join('\n');
  const firstResults = await runConcurrentPair(
    'publisher wins the workspace-row lock',
    publisherFirstSql,
    cleanupAfterPublisherSql
  );
  assert.match(firstResults[0], /UPDATE 1/, 'the first publisher must update exactly one workspace row');
  assert.ok(firstResults[1].includes(revA),
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
    "SELECT user_id FROM public.nexus_user_data WHERE user_id = '" + ownerId + "' FOR UPDATE;",
    'DO $race$',
    'DECLARE',
    '  v_blocked boolean := false;',
    'BEGIN',
    '  BEGIN',
    "    DELETE FROM public.nexus_user_data_chunks WHERE user_id = '" + ownerId + "' AND revision_id = '" + revC + "';",
    "  EXCEPTION WHEN SQLSTATE '55000' THEN",
    '    v_blocked := true;',
    '  END;',
    '  IF NOT v_blocked THEN',
    "    RAISE EXCEPTION 'Expected active-manifest cleanup to fail with SQLSTATE 55000.';",
    '  END IF;',
    '  PERFORM pg_sleep(2.0);',
    'END',
    '$race$;',
    'COMMIT;'
  ].join('\n');
  const publisherAfterCleanupSql = [
    'BEGIN;',
    'SELECT pg_sleep(0.35);',
    updateManifest(revD),
    'COMMIT;'
  ].join('\n');
  const secondResults = await runConcurrentPair(
    'cleanup holds the workspace-row lock first',
    cleanupFirstSql,
    publisherAfterCleanupSql
  );
  assert.ok(secondResults[0].includes(ownerId), 'the cleanup session must lock the fixture workspace row');
  assert.match(secondResults[1], /UPDATE 1/,
    'the waiting publisher must complete after the lock-holding cleanup transaction commits');

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

  console.log('Active-manifest concurrency race test passed: publisher-first and cleanup-first orderings.');
} finally {
  if (seeded) {
    await runSql('remove disposable staging auth user and cascading workspace',
      "DELETE FROM auth.users WHERE id = '" + ownerId + "';");
  }
  const remainingSql = [
    "SELECT (SELECT count(*)::text FROM auth.users WHERE id = '" + ownerId + "') || E'\\t' ||",
    "(SELECT count(*)::text FROM public.nexus_user_data WHERE user_id = '" + ownerId + "') || E'\\t' ||",
    "(SELECT count(*)::text FROM public.nexus_user_data_chunks WHERE user_id = '" + ownerId + "');"
  ].join('\n');
  const remaining = await runSql('verify disposable fixture cleanup', remainingSql);
  assert.equal(remaining, '0\t0\t0', 'the race-test owner and all of its rows must be removed');
}
