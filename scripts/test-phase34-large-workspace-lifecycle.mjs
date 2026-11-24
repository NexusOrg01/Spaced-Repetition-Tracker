import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { webcrypto } from 'node:crypto';
import { chromium } from 'playwright';

const require = createRequire(import.meta.url);
if (!globalThis.crypto) globalThis.crypto = webcrypto;
const chunkStorage = require('../cloud-chunk-storage.js');
const backupUtils = require('../backup-restore-utils.js');
const merge = require('../workspace-sync-merge.js');
require('../entity-delta-sync.js');

const delta = globalThis.NexusEntityDeltaSync;
assert.ok(delta && typeof delta.createClient === 'function', 'entity-delta runtime must load');
const required = [
  'PHASE34_API_URL', 'PHASE34_ANON_KEY', 'PHASE34_DB_URL',
  'PHASE34_EMAIL_B', 'PHASE34_PASSWORD_B',
  'PHASE34_EMAIL_C', 'PHASE34_PASSWORD_C'
];
for (const name of required) assert.ok(process.env[name], 'Missing ephemeral local-test variable: ' + name);

const apiUrl = new URL(process.env.PHASE34_API_URL);
assert.equal(apiUrl.protocol, 'http:');
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(apiUrl.hostname));
assert.equal(apiUrl.port, '54321');
const databaseUrl = new URL(process.env.PHASE34_DB_URL);
assert.ok(['postgres:', 'postgresql:'].includes(databaseUrl.protocol));
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(databaseUrl.hostname),
  'The privileged fixture connection must be loopback-only.');
assert.equal(databaseUrl.port || '5432', '54322',
  'The privileged fixture connection must use the disposable local Supabase Postgres port.');
assert.equal(databaseUrl.pathname, '/postgres',
  'The privileged fixture connection must target the disposable local Supabase postgres database.');
assert.equal(apiUrl.username, '');
assert.equal(apiUrl.password, '');
assert.equal(apiUrl.search, '');
assert.equal(apiUrl.hash, '');

const API = apiUrl.origin;
const ANON = process.env.PHASE34_ANON_KEY;
const TARGET_BYTES = 26900000;
const INITIAL_TOPICS = 77144;
const INITIAL_HISTORY = 72001;
const LARGE_DELETE_COUNT = 12032;
const SUBJECT_THREE_TOPICS = 12032;
const SUBJECT_THREE_HISTORY = 12541;
const checks = [];
const check = (name, condition) => {
  assert.ok(condition, name);
  checks.push(name);
  console.log('PASS  ' + name);
};
const fail = (message, extra) => {
  const error = new Error(message + (extra ? ': ' + JSON.stringify(extra) : ''));
  return error;
};

class RestQuery {
  constructor(client, table) {
    this.client = client;
    this.table = table;
    this.method = 'GET';
    this.fields = '*';
    this.filters = [];
    this.orders = [];
    this.body = undefined;
    this.start = null;
    this.end = null;
    this.maxRows = null;
    this.prefer = [];
  }
  select(fields = '*') {
    this.fields = fields;
    if (this.method !== 'GET') this.prefer.push('return=representation');
    return this;
  }
  insert(rows) { this.method = 'POST'; this.body = rows; return this; }
  update(values) { this.method = 'PATCH'; this.body = values; return this; }
  delete() { this.method = 'DELETE'; return this; }
  eq(key, value) { this.filters.push([key, 'eq', value]); return this; }
  neq(key, value) { this.filters.push([key, 'neq', value]); return this; }
  lt(key, value) { this.filters.push([key, 'lt', value]); return this; }
  in(key, values) { this.filters.push([key, 'in', values]); return this; }
  order(key, options = {}) {
    this.orders.push(key + '.' + (options.ascending === false ? 'desc' : 'asc'));
    return this;
  }
  range(start, end) { this.start = start; this.end = end; return this; }
  limit(value) { this.maxRows = value; return this; }
  abortSignal(signal) { this.signal = signal; return this; }
  async execute() {
    const url = new URL('/rest/v1/' + this.table, API);
    if (this.method === 'GET' || this.method === 'DELETE' || this.method === 'PATCH' || this.prefer.includes('return=representation')) {
      url.searchParams.set('select', this.fields);
    }
    for (const [key, op, value] of this.filters) {
      const encoded = op === 'in' ? 'in.(' + value.join(',') + ')' : op + '.' + String(value);
      url.searchParams.append(key, encoded);
    }
    if (this.orders.length) url.searchParams.set('order', this.orders.join(','));
    if (this.maxRows !== null) url.searchParams.set('limit', String(this.maxRows));
    const headers = {
      apikey: ANON,
      Authorization: 'Bearer ' + this.client.token,
      'Content-Type': 'application/json'
    };
    if (this.prefer.length) headers.Prefer = [...new Set(this.prefer)].join(',');
    if (this.start !== null) {
      headers.Range = this.start + '-' + this.end;
      headers['Range-Unit'] = 'items';
    }
    const response = await fetch(url, {
      method: this.method,
      headers,
      body: this.body === undefined ? undefined : JSON.stringify(this.body),
      signal: this.signal
    });
    const raw = await response.text();
    let data = null;
    if (raw) {
      try { data = JSON.parse(raw); } catch { data = raw; }
    }
    if (!response.ok) {
      return { data: null, error: { status: response.status, code: data?.code || '', message: data?.message || String(raw).slice(0, 300) } };
    }
    return { data, error: null };
  }
  async maybeSingle() {
    const result = await this.execute();
    if (result.error) return result;
    const rows = Array.isArray(result.data) ? result.data : result.data ? [result.data] : [];
    if (rows.length > 1) return { data: null, error: { code: 'MULTIPLE_ROWS', message: 'Expected at most one row.' } };
    return { data: rows[0] || null, error: null };
  }
  then(resolve, reject) { return this.execute().then(resolve, reject); }
}

function makeClient(token, user) {
  const client = {
    token,
    user,
    auth: {
      async getUser() {
        const response = await fetch(API + '/auth/v1/user', {
          headers: { apikey: ANON, Authorization: 'Bearer ' + token }
        });
        const data = await response.json().catch(() => null);
        return response.ok
          ? { data: { user: data }, error: null }
          : { data: { user: null }, error: { code: 'AUTH_' + response.status } };
      }
    },
    async rpc(name, args = {}) {
      const response = await fetch(API + '/rest/v1/rpc/' + name, {
        method: 'POST',
        headers: {
          apikey: ANON,
          Authorization: 'Bearer ' + token,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(args)
      });
      const raw = await response.text();
      let data = null;
      if (raw) {
        try { data = JSON.parse(raw); } catch { data = raw; }
      }
      return response.ok
        ? { data, error: null }
        : { data: null, error: { status: response.status, code: data?.code || '', message: data?.message || String(raw).slice(0, 300) } };
    },
    from(table) { return new RestQuery(client, table); }
  };
  return client;
}

async function signIn(email, password) {
  const response = await fetch(API + '/auth/v1/token?grant_type=password', {
    method: 'POST',
    headers: { apikey: ANON, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password })
  });
  const data = await response.json().catch(() => ({}));
  assert.ok(response.ok && data.access_token && data.user,
    'Local disposable Auth sign-in failed (HTTP ' + response.status + '): ' +
    String(data.msg || data.message || data.error_description || data.error || 'unknown').slice(0, 180));
  return makeClient(data.access_token, data.user);
}

async function rpc(client, name, args = {}) {
  const result = await client.rpc(name, args);
  if (result.error) throw fail('RPC ' + name + ' failed', result.error);
  return result.data;
}

async function readSnapshotRow(client, ownerId) {
  const result = await client.from('nexus_user_data')
    .select('payload,updated_at')
    .eq('user_id', ownerId)
    .maybeSingle();
  if (result.error) throw fail('Could not read the owner snapshot row', result.error);
  assert.ok(result.data && result.data.payload && result.data.updated_at,
    'The owner snapshot row must exist');
  return result.data;
}

async function readAllGroups(client, afterRevision, expectedHead) {
  const groups = [];
  let after = afterRevision;
  let pages = 0;
  while (after < expectedHead) {
    const page = await rpc(client, 'nexus_read_entity_operations', {
      p_after_revision: after,
      p_limit_groups: 100,
      p_max_bytes: 1048576
    });
    assert.equal(page.mode, 'delta');
    assert.equal(page.snapshot_required, false, 'The active cursor must remain inside retention');
    assert.ok(Array.isArray(page.groups) && page.groups.length > 0, 'A non-empty contiguous page is required');
    assert.ok(page.next_revision > after, 'The remote reader must make revision progress');
    groups.push(...page.groups);
    after = page.next_revision;
    pages++;
    assert.ok(pages <= 1000, 'Remote group pagination must be bounded');
  }
  assert.equal(after, expectedHead);
  return { groups, pages };
}

async function publishOperation(client, operationId, expectedRevision, changes) {
  const result = await rpc(client, 'nexus_publish_entity_operation', {
    p_operation_id: operationId,
    p_expected_revision: expectedRevision,
    p_changes: changes
  });
  return result;
}

async function compactUntilComplete(client, ownerId, floor) {
  let totalOperations = 0;
  let totalReceipts = 0;
  for (let attempt = 0; attempt < 12; attempt++) {
    const result = await chunkStorage.compactDeltaOperations(client, ownerId, floor);
    assert.equal(result.ok, true, 'Bounded compaction call must succeed: ' + JSON.stringify(result));
    totalOperations += Number(result.deletedOperations) || 0;
    totalReceipts += Number(result.deletedReceipts) || 0;
    if (result.complete === true) {
      return { ...result, deletedOperations: totalOperations, deletedReceipts: totalReceipts, calls: attempt + 1 };
    }
  }
  throw fail('Bounded compaction did not converge within 12 calls');
}

function buildLargeWorkspace() {
  const topics = [];
  for (let i = 0; i < INITIAL_TOPICS; i++) {
    const subjectId = i >= INITIAL_TOPICS - SUBJECT_THREE_TOPICS
      ? 'subject-3'
      : i < Math.floor((INITIAL_TOPICS - SUBJECT_THREE_TOPICS) / 2) ? 'subject-1' : 'subject-2';
    topics.push({
      id: 'topic-' + String(i).padStart(6, '0'),
      subjectId,
      name: 'Topic ' + String(i).padStart(6, '0'),
      notes: 'n'.repeat(100)
    });
  }
  const history = [];
  for (let i = 0; i < INITIAL_HISTORY; i++) {
    const isSubjectThree = i < SUBJECT_THREE_HISTORY;
    const topicIndex = isSubjectThree
      ? INITIAL_TOPICS - SUBJECT_THREE_TOPICS + (i % SUBJECT_THREE_TOPICS)
      : (20000 + (i % 40000));
    history.push({
      id: 'history-' + String(i).padStart(6, '0'),
      topicId: 'topic-' + String(topicIndex).padStart(6, '0'),
      subjectId: isSubjectThree ? 'subject-3' : (topicIndex < Math.floor((INITIAL_TOPICS - SUBJECT_THREE_TOPICS) / 2) ? 'subject-1' : 'subject-2'),
      reviewedAt: '2026-01-01',
      rating: 3,
      note: 'review-record'
    });
  }
  const payload = {
    app: 'Nexus Spaced Repetition Tracker',
    schema: 4,
    exportedAt: '2026-11-16T03:00:00.000Z',
    __nexusDeltaSync: 'entity-delta-v1',
    state: {
      streams: [{ id: 'stream-1', name: 'General' }],
      subjects: [
        { id: 'subject-1', streamId: 'stream-1', name: 'Subject One' },
        { id: 'subject-2', streamId: 'stream-1', name: 'Subject Two' },
        { id: 'subject-3', streamId: 'stream-1', name: 'Subject Three' }
      ],
      topics,
      history,
      exams: [],
      settings: { theme: 'dark' }
    },
    featureState: {
      journal: [],
      papers: [],
      goals: [],
      studyLogs: [],
      settings: { dailyMinutes: 90 }
    }
  };
  let serialized = JSON.stringify(payload);
  const currentBytes = Buffer.byteLength(serialized, 'utf8');
  assert.ok(currentBytes < TARGET_BYTES, 'Fixture seed must remain below the 26.9 MB target before padding: ' + currentBytes);
  const padding = TARGET_BYTES - currentBytes;
  const each = Math.floor(padding / topics.length);
  const paddingTopic = topics.find(topic => topic.id === 'topic-000000');
  assert.ok(paddingTopic, 'The dedicated fixture padding topic must exist.');
  if (padding) paddingTopic.notes += 'x'.repeat(padding);
  assert.equal(
    topics.find(topic => topic.id === 'topic-050000')?.notes,
    'n'.repeat(100),
    'Ordinary fixture topics must remain fixed-size for the account-handoff UI edit.'
  );
  serialized = JSON.stringify(payload);
  assert.equal(Buffer.byteLength(serialized, 'utf8'), TARGET_BYTES,
    'The fixture must be exactly 26,900,000 UTF-8 bytes');
  return { payload, serialized };
}

async function verifyFinalWorkspace(payload) {
  const topics = payload.state.topics;
  const history = payload.state.history;
  assert.equal(topics.length, INITIAL_TOPICS - LARGE_DELETE_COUNT - SUBJECT_THREE_TOPICS);
  assert.equal(history.length, INITIAL_HISTORY - SUBJECT_THREE_HISTORY);
  assert.equal(payload.state.subjects.length, 2);
  assert.ok(!payload.state.subjects.some(row => row.id === 'subject-3'));
  assert.ok(!topics.some(row => row.subjectId === 'subject-3'));
  assert.ok(!history.some(row => row.subjectId === 'subject-3'));
  const topicIds = new Set(topics.map(row => row.id));
  for (let i = 0; i < LARGE_DELETE_COUNT; i++) {
    assert.ok(!topicIds.has('topic-' + String(i).padStart(6, '0')),
      'Deleted topic must not be resurrected: ' + i);
  }
  assert.ok(history.some(row => row.id === 'history-012541'),
    'Unrelated history immediately after the large subject cascade must survive');
  assert.ok(topics.some(row => row.id === 'topic-050000'),
    'Unrelated topic must survive large deletion and subject cascade');
}

const [clientA1, clientA2, clientB] = await Promise.all([
  signIn(process.env.PHASE34_EMAIL_C, process.env.PHASE34_PASSWORD_C),
  signIn(process.env.PHASE34_EMAIL_C, process.env.PHASE34_PASSWORD_C),
  signIn(process.env.PHASE34_EMAIL_B, process.env.PHASE34_PASSWORD_B)
]);
const ownerA = clientA1.user.id;
const ownerB = clientB.user.id;
assert.equal(clientA2.user.id, ownerA, 'A1 and A2 must share one owner');
assert.notEqual(ownerA, ownerB, 'Account B must remain isolated');
assert.notEqual(clientA1.token, clientA2.token, 'The two devices need independent Auth sessions');
check('Three independent authenticated sessions represent two devices and a separate account',
  !!clientA1.token && !!clientA2.token && !!clientB.token);

const stateA = await rpc(clientA1, 'nexus_get_entity_sync_state');
const stateB = await rpc(clientB, 'nexus_get_entity_sync_state');
assert.equal(stateA.mode, 'snapshot', 'Fixture C is intentionally untouched by the preceding A1/A2/B protocol test');
assert.equal(stateB.mode, 'snapshot', 'Unlisted fixture B must remain in snapshot mode after the preceding protocol test');
assert.equal(Number(stateB.head_revision), 0, 'An explicitly opted-out owner must not acquire a Delta revision');
const foreignPage = await rpc(clientB, 'nexus_read_entity_operations', {
  p_after_revision: 0, p_limit_groups: 50, p_max_bytes: 1048576
});
assert.equal(foreignPage.mode, 'snapshot');
assert.equal(foreignPage.groups.length, 0);
const enabled = await rpc(clientA1, 'nexus_enable_entity_delta', {
  p_expected_updated_at: stateA.snapshot_updated_at
});
assert.equal(enabled.ok, true);
assert.equal(enabled.mode, 'delta');
const baselineState = await rpc(clientA1, 'nexus_get_entity_sync_state');
const ownerBaseStamp = baselineState.snapshot_updated_at;
check('Auto-enrolled fixture C can enter Delta while explicitly opted-out account B remains snapshot-only',
  baselineState.mode === 'delta' && Number(baselineState.head_revision) === 0 &&
  stateB.mode === 'snapshot' && Number(stateB.head_revision) === 0 && foreignPage.mode === 'snapshot' && foreignPage.groups.length === 0);

console.log('Building the 77,144-topic / 72,001-history workspace…');
const { payload: initialPayload, serialized: initialSerialized } = buildLargeWorkspace();
assert.equal(Buffer.byteLength(initialSerialized, 'utf8'), TARGET_BYTES);
const initialPublication = await chunkStorage.writeDeltaSnapshot(
  clientA1, ownerA, initialPayload, Number(baselineState.head_revision), ownerBaseStamp
);
assert.equal(initialPublication.verified, true);
assert.equal(initialPublication.verifiedChunks, true);
assert.equal(initialPublication.manifest.totalBytes, TARGET_BYTES);
assert.equal(initialPublication.manifest.chunkCount, 103);
const initialRow = await readSnapshotRow(clientA1, ownerA);
const initialDownloaded = await chunkStorage.readSnapshot(clientA2, ownerA, initialRow.payload);
assert.equal(initialRow.updated_at, initialPublication.updated_at);
assert.equal(initialDownloaded.state.topics.length, INITIAL_TOPICS);
assert.equal(initialDownloaded.state.history.length, INITIAL_HISTORY);
assert.equal(await merge.sameAsync(initialPayload, initialDownloaded), true);
const initialStamp = initialRow.updated_at;
check('Client A publishes the exact 26.9 MB snapshot as 103 verified chunks',
  initialPublication.manifest.totalBytes === TARGET_BYTES && initialPublication.manifest.chunkCount === 103);
check('Client A2 independently downloads, reconstructs, hashes and verifies all 77,144 topics and 72,001 history rows',
  initialDownloaded.state.topics.length === INITIAL_TOPICS && initialDownloaded.state.history.length === INITIAL_HISTORY);

const topicA = initialDownloaded.state.topics[50000];
const topicB = initialDownloaded.state.topics[50001];
const editA = {
  collection: 'topics', id: topicA.id, operation: 'put', position: 50000,
  value: { ...topicA, name: 'Client A concurrent edit' }
};
const editB = {
  collection: 'topics', id: topicB.id, operation: 'put', position: 50001,
  value: { ...topicB, name: 'Client B concurrent edit' }
};
const operationA = 'phase34-large-a-' + crypto.randomUUID();
const operationB = 'phase34-large-b-' + crypto.randomUUID();
const raced = await Promise.all([
  publishOperation(clientA1, operationA, 0, [editA]),
  publishOperation(clientA2, operationB, 0, [editB])
]);
const winners = raced.filter(result => result.ok === true && result.replayed !== true);
const losers = raced.filter(result => result.ok === false && result.code === 'revision_conflict');
assert.equal(winners.length, 1, 'Exactly one concurrent writer must win');
assert.equal(losers.length, 1, 'Exactly one concurrent writer must receive a revision conflict');
const loserIndex = raced[0].ok ? 1 : 0;
const loserClient = loserIndex === 0 ? clientA1 : clientA2;
const loserOperation = loserIndex === 0 ? operationA : operationB;
const loserChange = loserIndex === 0 ? editA : editB;
const retry = await publishOperation(loserClient, loserOperation, 1, [loserChange]);
assert.equal(retry.ok, true);
assert.equal(retry.revision, 2);
check('Simultaneous A1/A2 edits produce one CAS winner and one explicit revision conflict',
  winners.length === 1 && losers.length === 1);
check('The losing device retries the same operation id successfully at revision 2',
  retry.ok === true && retry.revision === 2);

const concurrentRead = await readAllGroups(clientA1, 0, 2);
const concurrentRemote = delta.reconstructRemoteSnapshot(
  initialPayload, concurrentRead.groups, 0, 2, { maxBytes: 8 * 1048576 }
);
assert.equal(concurrentRemote.ok, true);
const offlineWorkspace = structuredClone(concurrentRemote.payload);
offlineWorkspace.state.topics[50000].notes = 'offline edit on device A2';
offlineWorkspace.state.topics[50001].name = 'Offline title wins locally';
offlineWorkspace.featureState.journal.push({
  id: 'journal-offline-001', title: 'Offline device journal', createdAt: '2026-11-16'
});
check('Device A2 retains an offline edit and an offline journal entry without publishing either',
  offlineWorkspace.state.topics[50000].notes === 'offline edit on device A2' &&
  offlineWorkspace.featureState.journal.length === 1);

let revision = 2;
const deletionIds = Array.from({ length: LARGE_DELETE_COUNT }, (_, i) =>
  'topic-' + String(i).padStart(6, '0'));
let deletionGroups = 0;
for (let offset = 0; offset < deletionIds.length; offset += 1000) {
  const changes = deletionIds.slice(offset, offset + 1000).map(id => ({
    collection: 'topics', id, operation: 'delete'
  }));
  const result = await publishOperation(
    clientA1,
    'phase34-large-delete-' + String(deletionGroups).padStart(2, '0') + '-' + crypto.randomUUID(),
    revision,
    changes
  );
  assert.equal(result.ok, true, 'Large topic-deletion group must publish at revision ' + (revision + 1));
  revision = result.revision;
  deletionGroups++;
}
assert.equal(deletionGroups, 13);
const subjectThreeTopicCount = initialPayload.state.topics
  .filter(row => row.subjectId === 'subject-3').length;
const subjectThreeHistoryCount = initialPayload.state.history
  .filter(row => row.subjectId === 'subject-3').length;
check('The large subject fixture reproduces exactly 24,573 topic and review-history records',
  subjectThreeTopicCount === 12032 && subjectThreeHistoryCount === 12541 &&
  subjectThreeTopicCount + subjectThreeHistoryCount === 24573);
const subjectThreeChanges = [];
for (let i = INITIAL_TOPICS - SUBJECT_THREE_TOPICS; i < INITIAL_TOPICS; i++) {
  subjectThreeChanges.push({
    collection: 'topics',
    id: 'topic-' + String(i).padStart(6, '0'),
    operation: 'delete'
  });
}
for (let i = 0; i < SUBJECT_THREE_HISTORY; i++) {
  subjectThreeChanges.push({
    collection: 'history',
    id: 'history-' + String(i).padStart(6, '0'),
    operation: 'delete'
  });
}
subjectThreeChanges.push({ collection: 'subjects', id: 'subject-3', operation: 'delete' });
let subjectDelete = null;
let subjectDeleteGroups = 0;
for (let offset = 0; offset < subjectThreeChanges.length; offset += 1000) {
  subjectDelete = await publishOperation(
    clientA1,
    'phase34-large-subject-delete-' + String(subjectDeleteGroups).padStart(2, '0') + '-' + crypto.randomUUID(),
    revision,
    subjectThreeChanges.slice(offset, offset + 1000)
  );
  assert.equal(subjectDelete.ok, true,
    'Large subject-deletion group must publish at revision ' + (revision + 1));
  revision = subjectDelete.revision;
  subjectDeleteGroups++;
}
check('More than 12,000 topic deletions publish as 13 bounded complete groups',
  LARGE_DELETE_COUNT === 12032 && deletionGroups === 13);
check('Complete subject deletion removes 12,032 topics and 12,541 reviews in 25 bounded groups',
  !!(subjectDelete && subjectDelete.ok === true) &&
  subjectThreeChanges.length === 24574 && subjectDeleteGroups === 25);

const beforeCompaction = await readAllGroups(clientA1, 0, revision);
const compactedWorkspace = delta.reconstructRemoteSnapshot(
  initialPayload, beforeCompaction.groups, 0, revision, { maxBytes: 16 * 1048576 }
);
assert.equal(compactedWorkspace.ok, true);
await verifyFinalWorkspace(compactedWorkspace.payload);
check('Remote reconstruction preserves exactly 53,080 topics and 59,460 unrelated history records',
  compactedWorkspace.payload.state.topics.length === 53080 &&
  compactedWorkspace.payload.state.history.length === 59460);
check('No deleted topic or deleted subject-owned review is resurrected',
  !compactedWorkspace.payload.state.topics.some(row => row.subjectId === 'subject-3') &&
  !compactedWorkspace.payload.state.history.some(row => row.subjectId === 'subject-3'));

const beforeSnapshotState = await rpc(clientA1, 'nexus_get_entity_sync_state');
const compactedPublication = await chunkStorage.writeDeltaSnapshot(
  clientA1, ownerA, compactedWorkspace.payload,
  Number(beforeSnapshotState.head_revision), beforeSnapshotState.snapshot_updated_at
);
assert.equal(compactedPublication.verified, true);
assert.equal(compactedPublication.snapshotRevision, revision);
assert.equal(compactedPublication.compactedThroughRevision, revision);
const compactionCleanup = await compactUntilComplete(clientA1, ownerA, revision);
assert.equal(compactionCleanup.complete, true);
const afterCompactionState = await rpc(clientA1, 'nexus_get_entity_sync_state');
assert.equal(Number(afterCompactionState.snapshot_revision), revision);
assert.equal(Number(afterCompactionState.compacted_through_revision), revision);
assert.equal(Number(afterCompactionState.head_revision), revision);
const remainingOpsAfterCompaction = await clientA1.from('nexus_workspace_operations')
  .select('revision').eq('user_id', ownerA);
const remainingReceiptsAfterCompaction = await clientA1.from('nexus_workspace_operation_receipts')
  .select('revision').eq('user_id', ownerA);
if (remainingOpsAfterCompaction.error) throw fail('Could not verify operation cleanup', remainingOpsAfterCompaction.error);
if (remainingReceiptsAfterCompaction.error) throw fail('Could not verify receipt cleanup', remainingReceiptsAfterCompaction.error);
assert.equal(remainingOpsAfterCompaction.data.length, 0);
assert.equal(remainingReceiptsAfterCompaction.data.length, 0);
check('A1 publishes a verified replacement snapshot and compacts the old operation history through revision ' + revision,
  compactedPublication.verified === true && compactionCleanup.complete === true &&
  remainingOpsAfterCompaction.data.length === 0 && remainingReceiptsAfterCompaction.data.length === 0);
const compactedSnapshotRow = await readSnapshotRow(clientA1, ownerA);
const compactedSnapshotReadBack = await chunkStorage.readSnapshot(
  clientA1, ownerA, compactedSnapshotRow.payload
);
await verifyFinalWorkspace(compactedSnapshotReadBack);
assert.deepEqual(
  compactedSnapshotReadBack.state.topics.map(row => row.id).sort(),
  compactedWorkspace.payload.state.topics.map(row => row.id).sort(),
  'The verified replacement snapshot must contain the exact surviving topic IDs after subject deletion.'
);
assert.deepEqual(
  compactedSnapshotReadBack.state.history.map(row => row.id).sort(),
  compactedWorkspace.payload.state.history.map(row => row.id).sort(),
  'The verified replacement snapshot must contain the exact surviving history IDs after subject deletion.'
);
check('Compacted cloud snapshot read-back matches exact topic/history IDs after the 24,573-record subject deletion',
  compactedSnapshotReadBack.state.topics.length === 53080 &&
  compactedSnapshotReadBack.state.history.length === 59460 &&
  !compactedSnapshotReadBack.state.subjects.some(row => row.id === 'subject-3'));

const remoteTailTopic = compactedWorkspace.payload.state.topics.find(row => row.id === 'topic-050001');
assert.ok(remoteTailTopic, 'The independent topic edited by both devices must remain after the large deletion');
const remoteTailPosition = compactedWorkspace.payload.state.topics.findIndex(row => row.id === remoteTailTopic.id);
const remoteTailChanges = [
  {
    collection: 'topics', id: remoteTailTopic.id, operation: 'put', position: remoteTailPosition,
    value: { ...remoteTailTopic, name: 'Remote title after compaction' }
  },
  {
    collection: 'journal', id: 'journal-remote-001', operation: 'put',
    position: compactedWorkspace.payload.featureState.journal.length,
    value: { id: 'journal-remote-001', title: 'Remote post-compaction journal', createdAt: '2026-11-16' }
  }
];
const tailOne = await publishOperation(
  clientA1, 'phase34-large-tail-1-' + crypto.randomUUID(), revision, [remoteTailChanges[0]]
);
assert.equal(tailOne.ok, true);
revision = tailOne.revision;
const tailTwo = await publishOperation(
  clientA1, 'phase34-large-tail-2-' + crypto.randomUUID(), revision, [remoteTailChanges[1]]
);
assert.equal(tailTwo.ok, true);
revision = tailTwo.revision;
check('Server advances with a contiguous two-revision Delta tail while A2 remains stale below the compaction floor',
  revision === Number(afterCompactionState.snapshot_revision) + 2 &&
  Number(afterCompactionState.compacted_through_revision) < revision);

let recoveredLocalWorkspace = offlineWorkspace;
const recoveryClient = delta.createClient({
  enabled: true,
  client: clientA2,
  getActiveOwner: async () => ownerA,
  getLocalOwner: async () => ownerA,
  getLocalBase: async () => ({ ...initialDownloaded, serverVersion: initialStamp }),
  getLocalWorkspace: async () => recoveredLocalWorkspace,
  getPendingSnapshot: async () => null,
  sameWorkspace: async (left, right) => merge.sameAsync(left, right),
  mergeWorkspace: (base, local, remote) => merge.mergeAsync(base, local, remote),
  readRemoteSnapshot: async ownerId => {
    assert.equal(ownerId, ownerA);
    const row = await readSnapshotRow(clientA2, ownerA);
    const payload = await chunkStorage.readSnapshot(clientA2, ownerA, row.payload);
    return { payload, updated_at: row.updated_at };
  }
});
const recovery = await recoveryClient.prepareConflictRecovery(ownerA, {
  maxGroups: 100,
  maxBytes: 16 * 1048576
});
assert.equal(recovery.ok, true, 'Stale-device snapshot reconstruction and three-way merge must succeed: ' + JSON.stringify(recovery));
assert.equal(recovery.baselineAdvanced, true);
assert.equal(recovery.snapshotRevision, Number(afterCompactionState.snapshot_revision));
assert.equal(recovery.expectedHeadRevision, revision);
assert.equal(recovery.groupCount, 2);
assert.equal(recovery.throughRevision, revision);
assert.equal(recovery.remotePayload.state.topics.length, 53080);
assert.equal(recovery.remotePayload.state.history.length, 59460);
assert.equal(recovery.payload.state.topics.length, 53080);
assert.equal(recovery.payload.state.history.length, 59460);
assert.equal(recovery.payload.state.topics.find(row => row.id === 'topic-050000').notes,
  'offline edit on device A2');
assert.equal(recovery.payload.state.topics.find(row => row.id === 'topic-050001').name,
  'Offline title wins locally');
assert.ok(recovery.conflicts.length > 0, 'Concurrent same-field edit must be archived as a conflict');
assert.ok(recovery.remotePayload.featureState.journal.some(row => row.id === 'journal-remote-001'));
assert.ok(recovery.payload.featureState.journal.some(row => row.id === 'journal-remote-001'));
assert.ok(recovery.payload.featureState.journal.some(row => row.id === 'journal-offline-001'));
await verifyFinalWorkspace(recovery.payload);
check('Stale A2 reconstructs the compacted snapshot plus both contiguous tail groups and merges offline edits',
  recovery.baselineAdvanced === true && recovery.groupCount === 2 &&
  recovery.throughRevision === revision && recovery.payload.state.topics.length === 53080);
check('Three-way recovery preserves the offline edit, local conflict winner and both independent journal additions',
  recovery.payload.state.topics.find(row => row.id === 'topic-050000').notes === 'offline edit on device A2' &&
  recovery.payload.state.topics.find(row => row.id === 'topic-050001').name === 'Offline title wins locally' &&
  recovery.payload.featureState.journal.some(row => row.id === 'journal-offline-001') &&
  recovery.payload.featureState.journal.some(row => row.id === 'journal-remote-001') &&
  recovery.conflicts.length > 0);

const beforeRecoveryState = await rpc(clientA2, 'nexus_get_entity_sync_state');
const recoveredPublication = await chunkStorage.writeDeltaSnapshot(
  clientA2, ownerA, recovery.payload,
  Number(beforeRecoveryState.head_revision), beforeRecoveryState.snapshot_updated_at
);
assert.equal(recoveredPublication.verified, true);
assert.equal(recoveredPublication.snapshotRevision, revision);
const finalCompaction = await compactUntilComplete(clientA2, ownerA, revision);
assert.equal(finalCompaction.complete, true);
recoveredLocalWorkspace = recovery.payload;

const [clientA1Restart, clientA2Restart] = await Promise.all([
  signIn(process.env.PHASE34_EMAIL_C, process.env.PHASE34_PASSWORD_C),
  signIn(process.env.PHASE34_EMAIL_C, process.env.PHASE34_PASSWORD_C)
]);
assert.equal(clientA1Restart.user.id, ownerA);
assert.equal(clientA2Restart.user.id, ownerA);
const [rowA1Restart, rowA2Restart] = await Promise.all([
  readSnapshotRow(clientA1Restart, ownerA),
  readSnapshotRow(clientA2Restart, ownerA)
]);
const [workspaceA1Restart, workspaceA2Restart] = await Promise.all([
  chunkStorage.readSnapshot(clientA1Restart, ownerA, rowA1Restart.payload),
  chunkStorage.readSnapshot(clientA2Restart, ownerA, rowA2Restart.payload)
]);
assert.equal(rowA1Restart.updated_at, rowA2Restart.updated_at);
assert.equal(await merge.sameAsync(workspaceA1Restart, workspaceA2Restart), true);
assert.equal(await merge.sameAsync(workspaceA2Restart, recoveredLocalWorkspace), true);
await verifyFinalWorkspace(workspaceA1Restart);
check('Both restarted devices download the same verified final workspace and compare equal',
  await merge.sameAsync(workspaceA1Restart, workspaceA2Restart));

const finalState = await rpc(clientA1Restart, 'nexus_get_entity_sync_state');
assert.equal(Number(finalState.head_revision), revision);
assert.equal(Number(finalState.snapshot_revision), revision);
assert.equal(Number(finalState.compacted_through_revision), revision);
const emptyTail = await rpc(clientA1Restart, 'nexus_read_entity_operations', {
  p_after_revision: revision, p_limit_groups: 100, p_max_bytes: 1048576
});
assert.equal(emptyTail.mode, 'delta');
assert.equal(emptyTail.snapshot_required, false);
assert.equal(emptyTail.next_revision, revision);
assert.equal(emptyTail.groups.length, 0);
const stableRecoveryClient = delta.createClient({
  enabled: true,
  client: clientA2Restart,
  getActiveOwner: async () => ownerA,
  getLocalOwner: async () => ownerA,
  getLocalBase: async () => ({ ...workspaceA2Restart, serverVersion: rowA2Restart.updated_at }),
  getLocalWorkspace: async () => workspaceA2Restart,
  getPendingSnapshot: async () => null,
  sameWorkspace: async (left, right) => merge.sameAsync(left, right),
  mergeWorkspace: (base, local, remote) => merge.mergeAsync(base, local, remote),
  readRemoteSnapshot: async () => ({ payload: workspaceA2Restart, updated_at: rowA2Restart.updated_at })
});
const stableRecovery = await stableRecoveryClient.prepareConflictRecovery(ownerA, { maxGroups: 100 });
assert.equal(stableRecovery.ok, true);
assert.equal(stableRecovery.groupCount, 0);
assert.equal(stableRecovery.throughRevision, revision);
check('Post-restart synchronization is idle with no residual Delta tail or repeated snapshot-recovery loop',
  emptyTail.groups.length === 0 && stableRecovery.groupCount === 0 &&
  Number(finalState.compacted_through_revision) === revision);

// DLA-03: downgrade only after a verified full checkpoint, full operation/receipt
// compaction, and matching cursor. First prove a stale CAS request is harmless.
const downgradeExpectedUpdatedAt = rowA1Restart.updated_at;
const staleDowngrade = await rpc(clientA1Restart, 'nexus_disable_entity_delta', {
  p_request_id: crypto.randomUUID(),
  p_expected_head_revision: revision + 1,
  p_expected_snapshot_updated_at: downgradeExpectedUpdatedAt,
  p_expected_snapshot_revision: revision,
  p_expected_compacted_through_revision: revision
});
assert.equal(staleDowngrade.ok, false);
assert.equal(staleDowngrade.code, 'revision_conflict');
const stateAfterRejectedDowngrade = await rpc(clientA1Restart, 'nexus_get_entity_sync_state');
assert.equal(stateAfterRejectedDowngrade.mode, 'delta');
const rejectedRow = await readSnapshotRow(clientA1Restart, ownerA);
assert.equal(rejectedRow.payload.__nexusDeltaSync, 'entity-delta-v1');
check('DLA-03 stale compare-and-swap is rejected without changing the active Delta snapshot',
  staleDowngrade.code === 'revision_conflict' && stateAfterRejectedDowngrade.mode === 'delta' &&
  rejectedRow.payload.__nexusDeltaSync === 'entity-delta-v1');

const downgradeRequest = {
  p_request_id: crypto.randomUUID(),
  p_expected_head_revision: revision,
  p_expected_snapshot_updated_at: downgradeExpectedUpdatedAt,
  p_expected_snapshot_revision: revision,
  p_expected_compacted_through_revision: revision
};
// Simulate the client losing the HTTP response after PostgreSQL commits. The
// caller sees a timeout, retries the exact same request ID, and gets the receipt.
const originalA1Rpc = clientA1Restart.rpc.bind(clientA1Restart);
let dropDowngradeResponse = true;
clientA1Restart.rpc = async (name, args) => {
  const response = await originalA1Rpc(name, args);
  if (name === 'nexus_disable_entity_delta' && dropDowngradeResponse) {
    dropDowngradeResponse = false;
    return { data: null, error: { code: '57014', message: 'simulated lost response after commit' } };
  }
  return response;
};
const lostDowngradeResponse = await clientA1Restart.rpc('nexus_disable_entity_delta', downgradeRequest);
assert.equal(lostDowngradeResponse.error.code, '57014');
clientA1Restart.rpc = originalA1Rpc;
const replayedDowngrade = await rpc(clientA1Restart, 'nexus_disable_entity_delta', downgradeRequest);
assert.equal(replayedDowngrade.ok, true);
assert.equal(replayedDowngrade.already_applied, true);
assert.equal(replayedDowngrade.mode, 'snapshot');
assert.equal(replayedDowngrade.still_snapshot, true);

const [stateAfterDowngrade, rowAfterDowngrade] = await Promise.all([
  rpc(clientA1Restart, 'nexus_get_entity_sync_state'),
  readSnapshotRow(clientA1Restart, ownerA)
]);
assert.equal(stateAfterDowngrade.mode, 'snapshot');
assert.equal(Number(stateAfterDowngrade.head_revision), revision);
assert.equal(Number(stateAfterDowngrade.snapshot_revision), revision);
assert.equal(Number(stateAfterDowngrade.compacted_through_revision), revision);
assert.equal(rowAfterDowngrade.updated_at, stateAfterDowngrade.snapshot_updated_at);
assert.equal(rowAfterDowngrade.updated_at, downgradeExpectedUpdatedAt,
  'DLA-03 marker-only transition must preserve the checkpoint timestamp used by both local cursors');
assert.equal(Object.prototype.hasOwnProperty.call(rowAfterDowngrade.payload, '__nexusDeltaSync'), false);
assert.equal(chunkStorage.isManifest(rowAfterDowngrade.payload), true,
  'DLA-03 must retain the immutable active chunk manifest while stripping only the Delta marker');
const downgradedWorkspaceA1 = await chunkStorage.readSnapshot(
  clientA1Restart, ownerA, rowAfterDowngrade.payload
);
assert.equal(await merge.sameAsync(downgradedWorkspaceA1, workspaceA1Restart), true,
  'the snapshot payload must be byte-verified/reconstructable and logically equal to the checkpoint');
check('DLA-03 commits an aligned owner-only snapshot downgrade and retains the verified chunk snapshot',
  stateAfterDowngrade.mode === 'snapshot' &&
  Number(stateAfterDowngrade.head_revision) === Number(stateAfterDowngrade.snapshot_revision) &&
  Number(stateAfterDowngrade.snapshot_revision) === Number(stateAfterDowngrade.compacted_through_revision) &&
  !Object.prototype.hasOwnProperty.call(rowAfterDowngrade.payload, '__nexusDeltaSync') &&
  chunkStorage.isManifest(rowAfterDowngrade.payload));

const staleA2PageAfterDowngrade = await rpc(clientA2, 'nexus_read_entity_operations', {
  p_after_revision: 2, p_limit_groups: 100, p_max_bytes: 1048576
});
assert.equal(staleA2PageAfterDowngrade.mode, 'snapshot');
assert.equal(staleA2PageAfterDowngrade.groups.length, 0);
const rowA2AfterDowngrade = await readSnapshotRow(clientA2, ownerA);
assert.equal(rowA2AfterDowngrade.updated_at, stateAfterDowngrade.snapshot_updated_at);
const downgradedWorkspaceA2 = await chunkStorage.readSnapshot(
  clientA2, ownerA, rowA2AfterDowngrade.payload
);
assert.equal(await merge.sameAsync(downgradedWorkspaceA2, downgradedWorkspaceA1), true);
check('The stale offline second device is forced off Delta reads and can recover the exact marker-free snapshot',
  staleA2PageAfterDowngrade.mode === 'snapshot' &&
  staleA2PageAfterDowngrade.groups.length === 0 &&
  await merge.sameAsync(downgradedWorkspaceA2, downgradedWorkspaceA1));

const foreignSnapshotRows = await clientB.from('nexus_user_data')
  .select('user_id').eq('user_id', ownerA);
const foreignChunkRows = await clientB.from('nexus_user_data_chunks')
  .select('chunk_index').eq('user_id', ownerA).eq('revision_id', rowA2Restart.payload.revisionId);
assert.equal(foreignSnapshotRows.error, null);
assert.equal(foreignChunkRows.error, null);
assert.equal(foreignSnapshotRows.data.length, 0);
assert.equal(foreignChunkRows.data.length, 0);
const finalForeignState = await rpc(clientB, 'nexus_get_entity_sync_state');
assert.equal(finalForeignState.mode, 'snapshot');
assert.equal(Number(finalForeignState.head_revision), 0);
const finalForeignPage = await rpc(clientB, 'nexus_read_entity_operations', {
  p_after_revision: 0, p_limit_groups: 50, p_max_bytes: 1048576
});
assert.equal(finalForeignPage.mode, 'snapshot');
assert.equal(finalForeignPage.groups.length, 0);
check('Unlisted account B cannot read C snapshot/chunks and remains snapshot-only',
  foreignSnapshotRows.data.length === 0 && foreignChunkRows.data.length === 0 &&
  finalForeignState.mode === 'snapshot' && Number(finalForeignState.head_revision) === 0 &&
  finalForeignPage.mode === 'snapshot' && finalForeignPage.groups.length === 0);


console.log('Preparing the exact 26.9 MB snapshot for DLA-08E app-level A→B→A acceptance…');
const appFixturePayload = structuredClone(initialPayload);
delete appFixturePayload.__nexusDeltaSync;
let appFixtureSerialized = JSON.stringify(appFixturePayload);
const appFixtureBytesBeforePadding = Buffer.byteLength(appFixtureSerialized, 'utf8');
const appFixturePadding = TARGET_BYTES - appFixtureBytesBeforePadding;
assert.ok(appFixturePadding >= 0, 'The marker-free app fixture must fit within the exact 26.9 MB target.');
appFixturePayload.state.topics[0].notes += 'x'.repeat(appFixturePadding);
appFixtureSerialized = JSON.stringify(appFixturePayload);
assert.equal(Buffer.byteLength(appFixtureSerialized, 'utf8'), TARGET_BYTES);
const beforeAppFixtureRow = await readSnapshotRow(clientA1Restart, ownerA);
const appFixturePublication = await chunkStorage.writeSnapshot(
  clientA1Restart, ownerA, appFixturePayload, beforeAppFixtureRow.updated_at,
  new Date().toISOString(), backupUtils, appFixtureSerialized
);
assert.equal(appFixturePublication.manifest.totalBytes, TARGET_BYTES);
assert.equal(appFixturePublication.manifest.chunkCount, 103);
const appFixtureRow = await readSnapshotRow(clientA1Restart, ownerA);
const appFixtureReadback = await chunkStorage.readSnapshot(clientA1Restart, ownerA, appFixtureRow.payload);
assert.equal(await merge.sameAsync(appFixturePayload, appFixtureReadback), true);
const appFixtureState = await rpc(clientA1Restart, 'nexus_get_entity_sync_state');
assert.equal(appFixtureState.mode, 'snapshot');
assert.equal(appFixtureReadback.state.topics.length, INITIAL_TOPICS);
assert.equal(appFixtureReadback.state.history.length, INITIAL_HISTORY);

// The previous authenticated Delta lifecycle intentionally downgraded this
// disposable owner and persisted an explicit opt-out. Re-enable only this
// synthetic owner in the disposable local Supabase database so the real app
// can exercise account handoff while Account A is actually in Delta mode.
assert.match(ownerA, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  'The local allowlist update must target a validated disposable UUID.');
const localEligibilitySql = `
INSERT INTO nexus_private.entity_delta_pilot_allowlist (user_id, enabled, reason)
VALUES ('${ownerA}'::uuid, true, 'DLA-08E isolated app-level Delta handoff regression')
ON CONFLICT (user_id) DO UPDATE
SET enabled = true,
    reason = EXCLUDED.reason,
    updated_at = clock_timestamp();
`;
const localPsqlEnv = {
  ...process.env,
  PGHOST: databaseUrl.hostname,
  PGPORT: databaseUrl.port || '5432',
  PGUSER: decodeURIComponent(databaseUrl.username),
  PGPASSWORD: decodeURIComponent(databaseUrl.password),
  PGDATABASE: databaseUrl.pathname.slice(1)
};
execFileSync('psql', ['-X', '-v', 'ON_ERROR_STOP=1'], {
  input: localEligibilitySql,
  encoding: 'utf8',
  env: localPsqlEnv,
  stdio: ['pipe', 'pipe', 'pipe']
});
const appDeltaEnable = await rpc(clientA1Restart, 'nexus_enable_entity_delta', {
  p_expected_updated_at: appFixtureRow.updated_at
});
assert.equal(appDeltaEnable.ok, true);
assert.equal(appDeltaEnable.mode, 'delta');
const appFixtureDeltaState = await rpc(clientA1Restart, 'nexus_get_entity_sync_state');
assert.equal(appFixtureDeltaState.mode, 'delta');
const appFixtureDeltaRow = await readSnapshotRow(clientA1Restart, ownerA);
assert.equal(appFixtureDeltaRow.payload.__nexusDeltaSync, 'entity-delta-v1');
const appFixtureDeltaReadback = await chunkStorage.readSnapshot(
  clientA1Restart, ownerA, appFixtureDeltaRow.payload
);
assert.equal(appFixtureDeltaReadback.state.topics.length, INITIAL_TOPICS);
assert.equal(appFixtureDeltaReadback.state.history.length, INITIAL_HISTORY);
check('DLA-08E prepares an authenticated 26,900,000-byte Delta-enabled app fixture with 103 verified chunks',
  appFixturePublication.verifiedChunks === true &&
  appFixturePublication.manifest.totalBytes === TARGET_BYTES &&
  appFixturePublication.manifest.chunkCount === 103 &&
  appFixtureDeltaState.mode === 'delta' &&
  appFixtureDeltaRow.payload.__nexusDeltaSync === 'entity-delta-v1' &&
  appFixtureDeltaReadback.state.topics.length === INITIAL_TOPICS &&
  appFixtureDeltaReadback.state.history.length === INITIAL_HISTORY);

console.log('Launching the Nexus Web app in Chromium against disposable local Supabase…');
const browser = await chromium.launch({
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage']
});
let appLevelTimingEvidence = null;
let page = null;
try {
  const context = await browser.newContext({
    serviceWorkers: 'block',
    viewport: { width: 1280, height: 900 }
  });
  page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(String(error && error.message || error)));
  await page.goto('http://127.0.0.1:4173/index.html?nexusSyncDiag=1', {
    waitUntil: 'domcontentloaded'
  });
  await page.waitForFunction(() =>
    !!(window.supabase && typeof window.supabase.createClient === 'function') &&
    !!document.querySelector('#cloudStatus') &&
    !!document.querySelector('#cloudAccount'),
  null, { timeout: 30000 });
  await page.waitForFunction(() => {
    const status = document.querySelector('#cloudStatus');
    return !!status && !/^Connecting/i.test(status.textContent.trim());
  }, null, { timeout: 30000 });

  await page.evaluate(({ api, anon }) => {
    window.__nexusDla08AuthClient = window.supabase.createClient(api, anon, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: false
      }
    });
  }, { api: API, anon: ANON });

  async function signInAppTestAccount(email, password) {
    return page.evaluate(async ({ email, password, api, anon }) => {
      // A hard refresh replaces the page's JavaScript realm, including this
      // isolated test-only Auth client. Recreate it lazily on the current page
      // before driving the next account handoff; keep the app's normal shared
      // Supabase storage key so its own auth listener observes the sign-in.
      let authClient = window.__nexusDla08AuthClient;
      if (!authClient) {
        if (!window.supabase || typeof window.supabase.createClient !== 'function') {
          throw new Error('The browser Supabase SDK is unavailable after navigation.');
        }
        authClient = window.supabase.createClient(api, anon, {
          auth: {
            persistSession: true,
            autoRefreshToken: true,
            detectSessionInUrl: false
          }
        });
        window.__nexusDla08AuthClient = authClient;
      }
      const result = await authClient.auth.signInWithPassword({ email, password });
      if (result.error) throw new Error('Disposable browser sign-in failed: ' + result.error.message);
      if (!result.data || !result.data.user || !result.data.session) {
        throw new Error('Disposable browser sign-in did not return an authenticated session.');
      }
      return { userId: result.data.user.id, email: result.data.user.email };
    }, { email, password, api: API, anon: ANON });
  }

  async function waitForAccountAndStatus(email, userId, requiredStatus, timeoutMs) {
    await page.waitForFunction(({ email, userId, requiredStatus }) => {
      const account = document.querySelector('#cloudAccount');
      const status = document.querySelector('#cloudStatus');
      if (!account || !status || account.textContent.trim() !== email) return false;
      if (localStorage.getItem('nexus.cloud.last-user-id') !== userId) return false;
      return requiredStatus === 'any' ||
        status.textContent.trim() === requiredStatus;
    }, { email, userId, requiredStatus }, { timeout: timeoutMs });
  }

  async function readAppDiagnostics() {
    return page.evaluate(() => {
      try {
        const rows = JSON.parse(localStorage.getItem('nexus.syncdiag.session.v1') || '[]');
        return Array.isArray(rows) ? rows : [];
      } catch (_) {
        return [];
      }
    });
  }

  function safeTimingEvents(events, startedAt) {
    const stages = new Set([
      'cloud-manifest-read','cloud-chunk-pages-read','cloud-chunk-validation',
      'cloud-snapshot-assembly','cloud-snapshot-hash','cloud-snapshot-parse',
      'cloud-chunk-read','cloud-chunk-read-skipped','cloud-sync-mode-read',
      'local-storage-flush','workspace-snapshot-current','workspace-comparison','workspace-comparison-reuse',
      'workspace-merge-complete','workspace-local-commit','workspace-render',
      'same-account-workspace-restored','projection-check-start','projection-readiness',
      'projection-reuse','projection-rebuild','entity-projection-rebuild','projection-deferred-to-upload',
      'delta-sync-result','initialize-status-watchdog','sync-retry-scheduled','snapshot-recovery-progress',
      'pending-snapshot-remote-readback','pending-snapshot-acknowledged','initial-sync-verification'
    ]);
    const numericFields = [
      'durationMs','pageCount','completedPageCount','rowsRead','chunkCount',
      'payloadUtf8Bytes','maxPageDurationMs','minPageDurationMs','comparisonPassesSaved',
      'pendingLocalSequence','pendingLocalChangeCount','retryDelayMs','retryAttempt','delayMs','attempt','snapshotRevision','headRevision',
      'projectionBatchCount','projectionRowsWritten','projectionWriteDurationMs',
      'projectionPruneDurationMs','projectionPruneRowsScanned','projectionPruneRowsRemoved',
      'projectionOutboxPruneDurationMs','projectionOutboxPruneRowsRemoved',
      'projectionTransactionWaitDurationMs','projectionTransactionCount',
      'projectionKeyRangeWaitDurationMs','projectionRowGenerationDurationMs',
      'projectionSerializationDurationMs'
    ];
    const booleanFields = [
      'ok','ready','ownerVerified','timedOut','same','chunkDataIncluded','hasPayload',
      'projectionRebuildAttempted','projectionRebuildOk','projectionRevisionMatches','reused',
      'remoteReadbackVerified','pendingLocalChangesPreserved','acknowledged','retryScheduled','alreadyScheduled','pendingSnapshotClear',
      'retryable','snapshotRequired','candidateDigestMatches','expectedHeadRevisionMatches',
      'snapshotRevisionMatches','baseUpdatedAtMatches','exactAlreadyPublishedSnapshotMatches',
      'remotePayloadMatches','remotePayloadDigestMatches','remoteStateMatches','remoteUpdatedAtMatches',
      'remoteSnapshotRevisionMatches','remoteHeadRevisionMatches','remoteCompactedThroughMatches',
      'pendingOutboxProofPresent','pendingOutboxOverlayApplied','remoteSnapshotPresent',
      'remoteUpdatedAtMatchesState','remotePayloadShapeValid','remotePayloadDeltaMarkerMatches',
      'remoteManifestDeltaMarkerMatches','manifestDeltaMarker','payloadDeltaMarkerBeforeRestore',
      'payloadDeltaMarkerAfterRestore','deltaMarkerRestored'
    ];
    return events.filter(event =>
      event && typeof event.at === 'string' && Date.parse(event.at) >= startedAt &&
      stages.has(event.stage)
    ).map(event => {
      const row = {
        stage: event.stage,
        elapsedMs: Math.max(0,Date.parse(event.at)-startedAt)
      };
      for (const key of numericFields) {
        if (event[key] === null) row[key] = null;
        else if (Number.isSafeInteger(event[key]) && event[key] >= 0) row[key] = event[key];
      }
      if (Number.isSafeInteger(event.durationMs)) {
        row.startElapsedMs = Math.max(0,row.elapsedMs-event.durationMs);
      }
      for (const key of booleanFields) {
        if (typeof event[key] === 'boolean') row[key] = event[key];
      }
      for (const key of ['storageMode','syncMode','projectionRebuildMode','projectionSerializationMode','errorCategory','statusAfterWatchdog','recoveryStep','progressPhase','failureReason','failureStage','failureCode','failureName']) {
        if (typeof event[key] === 'string') row[key] = event[key];
      }
      const topicCount = event.workspace && event.workspace.topicCount;
      const historyRows = event.workspace && event.workspace.reviewHistoryCount;
      if (Number.isSafeInteger(topicCount) && topicCount >= 0) row.topicCount = topicCount;
      if (Number.isSafeInteger(historyRows) && historyRows >= 0) row.historyRows = historyRows;
      return row;
    });
  }

  async function readHeapUsageBytes() {
    return page.evaluate(() => {
      const memory = performance && performance.memory;
      return memory && Number.isSafeInteger(memory.usedJSHeapSize)
        ? memory.usedJSHeapSize : null;
    });
  }

  const appEmailA = process.env.PHASE34_EMAIL_C;
  const appPasswordA = process.env.PHASE34_PASSWORD_C;
  const appEmailB = process.env.PHASE34_EMAIL_B;
  const appPasswordB = process.env.PHASE34_PASSWORD_B;
  assert.ok(appEmailA && appPasswordA && appEmailB && appPasswordB,
    'The isolated local browser fixture must provide both disposable account credentials.');

  const initialAccountStartedAt = Date.now();
  const signedInA = await signInAppTestAccount(appEmailA, appPasswordA);
  assert.equal(signedInA.userId, ownerA);
  // The disposable browser context starts empty, while fixture A deliberately
  // contains an existing cloud snapshot. Resolve the normal first-login choice
  // exactly as a user would when restoring this account's cloud copy. This creates
  // the owner-verified local cache required for the subsequent A→B→A handoff test.
  await page.waitForFunction(() => {
    const dialog = document.querySelector('#accountChoiceDialog');
    return !!(dialog && dialog.open);
  }, null, { timeout: 30000 });
  // Explicitly capture and accept the one expected confirmation for restoring
  // the synthetic cloud backup into this brand-new empty browser profile.
  const restoreConfirmationPromise = page.waitForEvent('dialog', { timeout: 10000 }).then(async dialog => {
    const details = {
      type: dialog.type(),
      message: dialog.message()
    };
    console.log('DLA-08E_INITIAL_RESTORE_CONFIRMATION=' + JSON.stringify(details));
    try {
      assert.equal(details.type, 'confirm',
        'The initial disposable cloud restore must present a confirmation dialog.');
      assert.match(details.message,
        /FINAL CONFIRMATION: replace this device’s offline workspace with this account’s cloud backup/,
        'The restore confirmation must be the expected device-only cloud-to-local restore.');
      await dialog.accept();
    } catch (error) {
      await dialog.dismiss().catch(() => {});
      throw error;
    }
    return details;
  });
  const coldHeapBeforeBytes = await readHeapUsageBytes();
  const restoreClickPromise = page.locator('#accountChoiceDialog [data-account-choice="replace"]').click();
  const [restoreConfirmationDetails] = await Promise.all([
    restoreConfirmationPromise,
    restoreClickPromise
  ]);
  const initialRestoreConfirmedAt = Date.now();
  // The cloud snapshot is committed and owner-bound before projection work begins.
  // Verify the workspace unlocks promptly even while Delta's local projection rebuild
  // and the final cloud synchronization continue.
  await page.waitForFunction(({ email, userId }) => {
    const account = document.querySelector('#cloudAccount');
    const app = document.querySelector('.app');
    const lock = document.getElementById('workspaceIsolationLock');
    return !!account && account.textContent.trim() === email &&
      localStorage.getItem('nexus.cloud.last-user-id') === userId &&
      document.documentElement.dataset.workspaceAuth === 'ready' &&
      !!app && app.inert === false && !!lock && lock.hidden === true;
  }, { email: appEmailA, userId: ownerA }, { timeout: 30000 });
  const initialWorkspaceRevealMs = Date.now() - initialRestoreConfirmedAt;
  const initialWorkspaceRevealStatus = String(
    await page.locator('#cloudStatus').textContent() || ''
  ).trim();
  assert.ok(initialWorkspaceRevealMs <= 30000,
    'A first-time cloud restore must reveal the correct owner-bound workspace within 30 seconds.');
  await waitForAccountAndStatus(appEmailA, ownerA, 'Synced', 180000);
  const initialRestoreToVerifiedMs = Date.now() - initialRestoreConfirmedAt;
  const initialSignInToVerifiedMs = Date.now() - initialAccountStartedAt;
  const initialEvents = await readAppDiagnostics();
  const coldHeapAfterBytes = await readHeapUsageBytes();
  const initialCloudRead = initialEvents.slice().reverse().find(event =>
    event.stage === 'cloud-read' &&
    event.payloadUtf8Bytes === TARGET_BYTES &&
    event.chunkCount === 103
  );
  const initialManifestRead = initialEvents.slice().reverse().find(event =>
    event.stage === 'cloud-manifest-read' &&
    event.chunkCount === 103 &&
    event.payloadUtf8Bytes === TARGET_BYTES
  ) || null;
  const initialCloudChunkRead = initialEvents.slice().reverse().find(event =>
    event.stage === 'cloud-chunk-read' &&
    event.chunkCount === 103 &&
    event.payloadUtf8Bytes === TARGET_BYTES
  ) || null;
  const initialChunkPagesRead = initialEvents.slice().reverse().find(event =>
    event.stage === 'cloud-chunk-pages-read' &&
    event.chunkCount === 103 &&
    event.payloadUtf8Bytes === TARGET_BYTES
  ) || null;
  const initialChunkValidation = initialEvents.slice().reverse().find(event =>
    event.stage === 'cloud-chunk-validation' && event.chunkCount === 103
  ) || null;
  const initialSnapshotAssembly = initialEvents.slice().reverse().find(event =>
    event.stage === 'cloud-snapshot-assembly' && event.chunkCount === 103
  ) || null;
  const initialSnapshotHash = initialEvents.slice().reverse().find(event =>
    event.stage === 'cloud-snapshot-hash'
  ) || null;
  const initialSnapshotParse = initialEvents.slice().reverse().find(event =>
    event.stage === 'cloud-snapshot-parse'
  ) || null;
  // Bind the terminal verification event to the authenticated initialization
  // started by this sign-in. A first-time large restore may hit the bounded
  // initialization deadline, leave a truthful local-ready/unverified state, and
  // then reach Synced through the scheduled Delta retry. Do not mistake that
  // expected two-stage path for a missing success event or require the first
  // initialization attempt itself to finish successfully.
  const initialInitializationStarted = initialEvents.slice().reverse().find(event =>
    event.stage === 'initialize-start' && event.hasSession === true
  ) || null;
  const initialVerification = initialEvents.find(event =>
    event.stage === 'initial-sync-verification' &&
    initialInitializationStarted &&
    Date.parse(event.at) >= Date.parse(initialInitializationStarted.at)
  ) || null;
  const initialWatchdog = initialEvents.find(event =>
    event.stage === 'initialize-status-watchdog' &&
    initialInitializationStarted &&
    Date.parse(event.at) >= Date.parse(initialInitializationStarted.at) &&
    (!initialVerification || Date.parse(event.at) <= Date.parse(initialVerification.at))
  ) || null;
  const initialColdDeadline = initialEvents.find(event =>
    event.stage === 'initialize-sync-deadline' &&
    initialInitializationStarted &&
    Date.parse(event.at) >= Date.parse(initialInitializationStarted.at) &&
    (!initialVerification || Date.parse(event.at) <= Date.parse(initialVerification.at))
  ) || null;
  const initialRetryDeltaVerification = initialVerification && initialVerification.ok !== true
    ? initialEvents.find(event =>
        event.stage === 'delta-sync-result' &&
        Date.parse(event.at) > Date.parse(initialVerification.at) &&
        event.ok === true &&
        event.skipped !== true
      ) || null
    : null;
  const initialProjectionReadiness = initialEvents.slice().reverse().find(event =>
    event.stage === 'projection-readiness' && Number.isSafeInteger(event.durationMs)
  ) || null;
  const initialProjectionReuse = initialEvents.slice().reverse().find(event =>
    event.stage === 'projection-reuse' && Number.isSafeInteger(event.durationMs)
  ) || null;
  const initialProjectionRebuild = initialEvents.slice().reverse().find(event =>
    event.stage === 'entity-projection-rebuild' && Number.isSafeInteger(event.durationMs)
  ) || null;
  if(initialProjectionRebuild){
    for(const field of [
      'projectionBatchCount','projectionRowsWritten','projectionWriteDurationMs',
      'projectionPruneDurationMs','projectionPruneRowsScanned','projectionPruneRowsRemoved',
      'projectionOutboxPruneDurationMs','projectionOutboxPruneRowsRemoved',
      'projectionTransactionWaitDurationMs','projectionTransactionCount',
      'projectionKeyRangeWaitDurationMs','projectionRowGenerationDurationMs'
    ]){
      assert.ok(Number.isSafeInteger(initialProjectionRebuild[field])&&initialProjectionRebuild[field]>=0,
        'the cold restore must serialize the projection rebuild subphase metric '+field);
    }
    assert.ok(Object.prototype.hasOwnProperty.call(initialProjectionRebuild,'projectionSerializationDurationMs'),
      'the cold restore report must explicitly serialize the projection serialization timing field');
    if(initialProjectionRebuild.projectionSerializationDurationMs===null){
      assert.equal(initialProjectionRebuild.projectionSerializationMode,
        'indexeddb-structured-clone-in-write-transaction',
        'an unmeasured structured-clone phase must be explicitly identified rather than silently omitted');
    }else{
      assert.ok(Number.isSafeInteger(initialProjectionRebuild.projectionSerializationDurationMs)&&
        initialProjectionRebuild.projectionSerializationDurationMs>=0,
        'a separately measurable serialization phase must expose a non-negative duration');
    }
  }
  const initialDeltaSyncResult = initialEvents.slice().reverse().find(event =>
    event.stage === 'delta-sync-result' && event.ok === true &&
    Number.isSafeInteger(event.durationMs) && initialInitializationStarted &&
    Date.parse(event.at) >= Date.parse(initialInitializationStarted.at)
  ) || null;
  assert.ok(initialCloudRead,
    'The real Nexus app must read the exact 26.9 MB / 103-chunk account-A fixture.');
  assert.ok(initialManifestRead && Number.isSafeInteger(initialManifestRead.durationMs),
    'the cold restore must record manifest retrieval separately from chunk reconstruction');
  assert.ok(initialCloudChunkRead && Number.isSafeInteger(initialCloudChunkRead.durationMs),
    'the cold restore must record the complete chunk reconstruction duration');
  assert.ok(initialChunkPagesRead && initialChunkPagesRead.ok === true &&
    initialChunkPagesRead.pageCount > 0 &&
    initialChunkPagesRead.completedPageCount === initialChunkPagesRead.pageCount &&
    initialChunkPagesRead.rowsRead === 103 &&
    initialChunkPagesRead.chunkDataIncluded === true,
    'the cold restore must measure every chunk page request and confirm all 103 data-bearing rows were retrieved');
  assert.ok(initialChunkValidation && initialChunkValidation.ok === true,
    'the cold restore must record successful structural, byte-length and manifest-size validation');
  assert.ok(initialSnapshotAssembly && initialSnapshotAssembly.ok === true,
    'the cold restore must record successful chunk-string assembly');
  assert.ok(initialSnapshotHash && initialSnapshotHash.ok === true,
    'the cold restore must record successful SHA-256 verification');
  assert.ok(initialSnapshotParse && initialSnapshotParse.ok === true,
    'the cold restore must record successful JSON reconstruction and shape validation');
  assert.ok(initialInitializationStarted,
    'The real Nexus app must record the authenticated Account A initialization start.');
  assert.ok(initialVerification && Number.isSafeInteger(initialVerification.durationMs),
    'The real Nexus app must record the terminal outcome and duration of Account A initial verification.');
  if(initialVerification&&initialVerification.durationMs>=60000){
    assert.ok(initialColdDeadline,
      'A cold restore exceeding 60 seconds must record its explicit delayed/error deadline.');
    assert.equal(initialColdDeadline.delayMs,60000);
    assert.equal(initialColdDeadline.statusAfterWatchdog,'Sync pending',
      'an owner-verified local workspace must remain explicitly pending beyond 60 seconds');
    assert.equal(initialColdDeadline.ownerMatches,true);
    assert.equal(initialColdDeadline.retryScheduled,true,
      'the 60-second cold-restore deadline must retain a bounded retry');
    assert.ok(initialColdDeadline.retryDelayMs===null||
      (initialColdDeadline.retryDelayMs>0&&initialColdDeadline.retryDelayMs<=300000),
      'the 60-second retry must remain capped at five minutes');
    assert.notEqual(initialColdDeadline.statusAfterWatchdog,'Synced',
      'the 60-second deadline must never claim unverified cloud convergence');
  }
  assert.ok(initialProjectionReadiness,
    'The cold restore must separately time the owner-scoped entity projection readiness check.');
  assert.ok(initialProjectionReuse || initialProjectionRebuild,
    'The cold restore must record whether the owner-scoped entity projection was reused or rebuilt.');
  assert.ok(initialDeltaSyncResult,
    'The cold restore must separately time its complete authenticated Delta synchronization.');
  assert.ok(
    initialVerification.ok === true ||
    (initialVerification.timedOut === true &&
      initialVerification.ready === true &&
      !!initialRetryDeltaVerification),
    'A slow first-time restore may leave loading at its bounded watchdog, but it must subsequently complete a successful authenticated Delta retry before this fixture proceeds.'
  );
  let initialWatchdogDelayMs = null;
  let initialWatchdogOutcome = 'not-needed';
  let initialWatchdogStatus = 'not-needed';
  let initialRetryScheduled = false;
  let initialRetryDelayMs = null;
  if (initialVerification.durationMs >= 30000) {
    assert.ok(initialInitializationStarted && initialWatchdog,
      'A first-time restore exceeding 30 seconds must record the watchdog decision, even when the status already left loading.');
    initialWatchdogDelayMs = Date.parse(initialWatchdog.at) - Date.parse(initialInitializationStarted.at);
    assert.ok(Number.isFinite(initialWatchdogDelayMs) && initialWatchdogDelayMs <= 40000,
      'The initial restore must leave or confirm its loading state by the 30-second watchdog deadline.');
    assert.notEqual(initialWorkspaceRevealStatus, 'Synced',
      'the status indicator must not claim cloud verification at the point the local workspace first becomes available.');
    assert.equal(initialWatchdog.watchdogOutcome, 'local-ready-unverified',
      'A durably restored and owner-verified workspace must be reported as locally ready while cloud verification continues.');
    assert.equal(initialWatchdog.ready, true,
      'The first-restore watchdog must distinguish local workspace readiness from cloud verification completion.');
    const ownerVerifiedReveal = initialEvents.slice().reverse().find(event =>
      event.stage === 'workspace-render' &&
      event.ownerVerified === true &&
      event.durationMs >= 0 &&
      Date.parse(event.at) <= Date.parse(initialWatchdog.at)
    );
    assert.ok(ownerVerifiedReveal,
      'The first-restore watchdog may report local readiness only after an owner-verified workspace render.');
    initialWatchdogOutcome = initialWatchdog.watchdogOutcome;
    initialWatchdogStatus = initialWatchdog.statusAfterWatchdog || 'not-recorded';
    assert.equal(initialWatchdogStatus,'Sync pending',
      'A cold restore beyond the watchdog must remain explicitly pending, never falsely Synced.');
    assert.equal(initialWatchdog.retryScheduled,true,
      'The cold-restore watchdog must leave a bounded retry scheduled.');
    const initialRetryEvent = initialEvents.slice().reverse().find(event =>
      event.stage === 'sync-retry-scheduled' && event.retryScheduled === true &&
      typeof event.at === 'string' &&
      Math.abs(Date.parse(event.at)-Date.parse(initialWatchdog.at)) <= 5000
    ) || null;
    assert.ok(initialRetryEvent,
      'The cold-restore watchdog must record its bounded retry schedule.');
    initialRetryScheduled = true;
    initialRetryDelayMs = Number.isSafeInteger(initialRetryEvent.delayMs)
      ? initialRetryEvent.delayMs : null;
    if (initialRetryDelayMs !== null) assert.ok(initialRetryDelayMs > 0 && initialRetryDelayMs <= 300000,
      'Cold-restore retry delay must remain capped at five minutes.');
  }

  // Reproduce a real browser hard refresh while the 26.9 MB workspace is
  // already owned by Account A. The owner-bound local copy must be revealed
  // promptly, and a matching verified cloud manifest must not trigger a second
  // 103-chunk download or a redundant local snapshot replacement.
  const sameAccountRefreshStartedAt = Date.now();
  await page.reload({ waitUntil: 'domcontentloaded' });
  const warmHeapBeforeBytes = await readHeapUsageBytes();
  await page.waitForFunction(({ email, userId }) => {
    const account = document.querySelector('#cloudAccount');
    const app = document.querySelector('.app');
    const lock = document.getElementById('workspaceIsolationLock');
    return !!account && account.textContent.trim() === email &&
      localStorage.getItem('nexus.cloud.last-user-id') === userId &&
      document.documentElement.dataset.workspaceAuth === 'ready' &&
      !!app && app.inert === false && !!lock && lock.hidden === true;
  }, { email: appEmailA, userId: ownerA }, { timeout: 20000 });
  const sameAccountRefreshWorkspaceRevealMs = Date.now() - sameAccountRefreshStartedAt;
  const sameAccountRefreshRevealStatus = String(
    await page.locator('#cloudStatus').textContent() || ''
  ).trim();
  assert.ok(sameAccountRefreshWorkspaceRevealMs <= 10000,
    'A same-account hard refresh must reveal the owner-bound local workspace within 10 seconds.');
  assert.notEqual(sameAccountRefreshRevealStatus, 'Account verification delayed',
    'A verified same-account cache must not fall behind the 30-second account-verification watchdog.');
  await waitForAccountAndStatus(appEmailA, ownerA, 'Synced', 60000);
  const sameAccountRefreshToVerifiedMs = Date.now() - sameAccountRefreshStartedAt;
  const warmHeapAfterBytes = await readHeapUsageBytes();
  const sameAccountRefreshEvents = await readAppDiagnostics();
  // Anchor event filtering to the app's own ISO clock. The browser and Node
  // clocks can differ slightly during a hard reload, so a Node-only cutoff can
  // accidentally discard the terminal verification event even when the UI is Synced.
  const sameAccountCacheRestore = sameAccountRefreshEvents.find(event =>
    event.stage === 'same-account-workspace-restored' && event.ownerVerified === true
  ) || null;
  const sameAccountRefreshEventStartAt = sameAccountCacheRestore && typeof sameAccountCacheRestore.at === 'string'
    ? Date.parse(sameAccountCacheRestore.at) : sameAccountRefreshStartedAt;
  const sameAccountRefreshEventsAfterStart = sameAccountRefreshEvents.filter(event =>
    typeof event.at === 'string' && Date.parse(event.at) >= sameAccountRefreshEventStartAt
  );
  const sameAccountChunkReuse = sameAccountRefreshEventsAfterStart.find(event =>
    event.stage === 'cloud-chunk-read-skipped' &&
    event.reason === 'verified_local_baseline_matches_remote_manifest'
  ) || null;
  const sameAccountFullChunkRead = sameAccountRefreshEventsAfterStart.find(event =>
    event.stage === 'cloud-chunk-read'
  ) || null;
  const sameAccountVerification = sameAccountRefreshEventsAfterStart.find(event =>
    event.stage === 'initial-sync-verification' && event.ok === true && event.ready === true
  ) || null;
  const warmManifestRead = sameAccountRefreshEventsAfterStart.find(event =>
    event.stage === 'cloud-manifest-read' && event.ok === true
  ) || null;
  const warmChunkPagesRead = sameAccountRefreshEventsAfterStart.find(event =>
    event.stage === 'cloud-chunk-pages-read'
  ) || null;
  const warmProjectionReadiness = sameAccountRefreshEventsAfterStart.find(event =>
    event.stage === 'projection-readiness' && Number.isSafeInteger(event.durationMs)
  ) || null;
  const warmProjectionReuse = sameAccountRefreshEventsAfterStart.find(event =>
    event.stage === 'projection-reuse' && Number.isSafeInteger(event.durationMs)
  ) || null;
  const warmProjectionRebuild = sameAccountRefreshEventsAfterStart.find(event =>
    event.stage === 'entity-projection-rebuild' && Number.isSafeInteger(event.durationMs)
  ) || null;
  const warmDeltaSyncResult = sameAccountRefreshEventsAfterStart.find(event =>
    event.stage === 'delta-sync-result' && event.ok === true &&
    Number.isSafeInteger(event.durationMs)
  ) || null;
  const warmWorkspaceComparisonEvents = sameAccountRefreshEventsAfterStart.filter(event =>
    event.stage === 'workspace-comparison' && Number.isSafeInteger(event.durationMs)
  );
  const warmWorkspaceComparisonReuseEvents = sameAccountRefreshEventsAfterStart.filter(event =>
    event.stage === 'workspace-comparison-reuse' && event.reused === true &&
    event.comparisonPassesSaved === 1 && event.ownerVerified === true
  );
  const warmStageTimings = safeTimingEvents(sameAccountRefreshEventsAfterStart,sameAccountRefreshEventStartAt);
  const coldStageTimings = safeTimingEvents(initialEvents,initialRestoreConfirmedAt);
  const browserEnvironment = await page.evaluate(() => ({
    online: navigator.onLine,
    platform: navigator.platform || null,
    hardwareConcurrency: Number.isSafeInteger(navigator.hardwareConcurrency)
      ? navigator.hardwareConcurrency : null,
    deviceMemoryGb: Number.isFinite(navigator.deviceMemory)
      ? navigator.deviceMemory : null
  }));
  assert.ok(sameAccountCacheRestore,
    'A same-account hard refresh must expose the existing owner-verified local workspace before remote snapshot reconstruction.');
  assert.ok(sameAccountChunkReuse,
    'A matching verified cloud manifest must reuse the saved baseline instead of downloading all immutable chunks.');
  assert.equal(sameAccountFullChunkRead, null,
    'A matching same-account snapshot baseline must not be downloaded again on hard refresh.');
  assert.ok(sameAccountVerification,
    'The same-account hard refresh must finish authenticated Delta verification and return to Synced.');
  assert.ok(warmManifestRead && Number.isSafeInteger(warmManifestRead.durationMs),
    'the warm restore must revalidate the same cloud manifest');
  assert.equal(warmChunkPagesRead,null,
    'the warm restore must reuse the verified owner-bound baseline without downloading the 103 chunks again');
  assert.ok(warmProjectionReadiness && (warmProjectionReuse || warmProjectionRebuild),
    'The warm restore must record owner-scoped projection readiness and whether it was reused or rebuilt.');
  assert.ok(warmDeltaSyncResult,
    'The warm restore must separately time its complete authenticated Delta synchronization.');
  assert.equal(warmWorkspaceComparisonEvents.length,2,
    'The warm return must retain its independent pending/cloud comparison and perform the local/cloud comparison only once.');
  assert.ok(warmWorkspaceComparisonReuseEvents.length>=1,
    'The same-account reconciliation decision must reuse the revision-fenced comparison result instead of repeating a 26.9 MB deep comparison.');
  console.log('DLA-08E_SAME_ACCOUNT_HARD_REFRESH=' + JSON.stringify({
    workspaceRevealMs: sameAccountRefreshWorkspaceRevealMs,
    revealStatus: sameAccountRefreshRevealStatus,
    verified: true,
    fullChunkDownloadRepeated: false
  }));
  console.log('DLA-09B_COLD_WARM_RESTORE_TIMING=' + JSON.stringify({
    run: {
      id: process.env.GITHUB_RUN_ID || null,
      number: process.env.GITHUB_RUN_NUMBER || null,
      branch: process.env.GITHUB_HEAD_REF || null,
      workflowSha: process.env.GITHUB_SHA || null
    },
    environment: {
      runnerOS: process.env.RUNNER_OS || null,
      runnerArch: process.env.RUNNER_ARCH || null,
      browser: 'Chromium',
      browserVersion: browser.version(),
      online: browserEnvironment.online,
      platform: browserEnvironment.platform,
      hardwareConcurrency: browserEnvironment.hardwareConcurrency,
      deviceMemoryGb: browserEnvironment.deviceMemoryGb
    },
    fixture: {
      id: 'nexus-large-workspace-synthetic-v1',
      bytes: TARGET_BYTES,
      chunks: 103,
      topics: INITIAL_TOPICS,
      historyRows: INITIAL_HISTORY
    },
    sameFixtureAndEnvironment: true,
    cold: {
      mode: 'first-time restore into a new browser profile',
      totalToVerifiedMs: initialRestoreToVerifiedMs,
      signInToVerifiedMs: initialSignInToVerifiedMs,
      workspaceRevealMs: initialWorkspaceRevealMs,
      manifestReadMs: initialManifestRead.durationMs,
      chunkPagesReadMs: initialChunkPagesRead.durationMs,
      chunkPageCount: initialChunkPagesRead.pageCount,
      chunkReadTotalMs: initialCloudChunkRead.durationMs,
      chunkValidationMs: initialChunkValidation.durationMs,
      snapshotAssemblyMs: initialSnapshotAssembly.durationMs,
      sha256Ms: initialSnapshotHash.durationMs,
      jsonParseMs: initialSnapshotParse.durationMs,
      projectionReadinessMs: initialProjectionReadiness.durationMs,
      projectionOutcome: initialProjectionReuse ? 'reused' : 'rebuilt',
      projectionRebuildMs: initialProjectionRebuild ? initialProjectionRebuild.durationMs : null,
      deltaSyncMs: initialDeltaSyncResult.durationMs,
      finalVerificationMs: initialVerification.durationMs,
      watchdogDelayMs: initialWatchdogDelayMs,
      memory: {
        available: Number.isSafeInteger(coldHeapBeforeBytes) && Number.isSafeInteger(coldHeapAfterBytes),
        beforeBytes: coldHeapBeforeBytes,
        afterBytes: coldHeapAfterBytes,
        deltaBytes: Number.isSafeInteger(coldHeapBeforeBytes) && Number.isSafeInteger(coldHeapAfterBytes)
          ? coldHeapAfterBytes-coldHeapBeforeBytes : null
      },
      stageTimings: coldStageTimings
    },
    warm: {
      mode: 'same-owner hard refresh with verified local baseline reuse',
      totalToVerifiedMs: sameAccountRefreshToVerifiedMs,
      workspaceRevealMs: sameAccountRefreshWorkspaceRevealMs,
      manifestReadMs: warmManifestRead.durationMs,
      projectionReadinessMs: warmProjectionReadiness.durationMs,
      projectionOutcome: warmProjectionReuse ? 'reused' : 'rebuilt',
      projectionRebuildMs: warmProjectionRebuild ? warmProjectionRebuild.durationMs : null,
      deltaSyncMs: warmDeltaSyncResult.durationMs,
      chunkDownloadSkipped: !!sameAccountChunkReuse,
      chunkPagesReadMs: warmChunkPagesRead && Number.isSafeInteger(warmChunkPagesRead.durationMs)
        ? warmChunkPagesRead.durationMs : null,
      finalVerificationMs: sameAccountVerification.durationMs,
      workspaceComparisonPasses: warmWorkspaceComparisonEvents.length,
      workspaceComparisonDurationMs: warmWorkspaceComparisonEvents.reduce((total,event)=>total+event.durationMs,0),
      workspaceComparisonPassesSaved: warmWorkspaceComparisonReuseEvents.reduce((total,event)=>total+event.comparisonPassesSaved,0),
      memory: {
        available: Number.isSafeInteger(warmHeapBeforeBytes) && Number.isSafeInteger(warmHeapAfterBytes),
        beforeBytes: warmHeapBeforeBytes,
        afterBytes: warmHeapAfterBytes,
        deltaBytes: Number.isSafeInteger(warmHeapBeforeBytes) && Number.isSafeInteger(warmHeapAfterBytes)
          ? warmHeapAfterBytes-warmHeapBeforeBytes : null
      },
      stageTimings: warmStageTimings
    }
  }));

  // Start a same-owner A verification while its large cached workspace is
  // already visible. Hold the first authenticated remote-state read, Delta
  // operation read, or recovery-snapshot publication actually reached by the
  // cursor-mismatch path. Switching to B must cancel A's work without dropping
  // A's pending snapshot or blocking B.
  let initialARecoveryBoundaryHeld = false;
  let releaseInitialARecoveryBoundary = null;
  let initialARecoveryBoundaryRpc = null;
  const initialARecoveryBoundaryPattern =
    /\/rest\/v1\/rpc\/(?:nexus_get_entity_sync_state|nexus_read_entity_operations|nexus_publish_entity_snapshot)(?:\?|$)/;
  const holdInitialARecoveryBoundary = async route => {
    const requestUrl = new URL(route.request().url());
    const rpcName = requestUrl.pathname.split('/').pop();
    if (!initialARecoveryBoundaryHeld && [
      'nexus_get_entity_sync_state',
      'nexus_read_entity_operations',
      'nexus_publish_entity_snapshot'
    ].includes(rpcName)) {
      initialARecoveryBoundaryHeld = true;
      initialARecoveryBoundaryRpc = rpcName;
      console.log('DLA09E_RECOVERY_BOUNDARY_HELD=' + JSON.stringify({
        rpc: rpcName,
        path: requestUrl.pathname
      }));
      await new Promise(resolve => { releaseInitialARecoveryBoundary = resolve; });
    }
    try { await route.continue(); } catch (_) {}
  };
  const initialAReadPattern = /\/rest\/v1\/rpc\/(?:nexus_get_entity_sync_state|nexus_read_entity_operations|nexus_publish_entity_snapshot)(?:\?|$)/;

  // The initial page load has already verified Account A's current Delta head.
  // Advance the disposable server by one independent operation. Account A's
  // verified cursor must remain behind so recovery must read the new remote head
  // before it can publish a replacement snapshot.
  const appInitialCursor = await page.evaluate(async ownerId => {
    const result = await window.NexusStorage.readWorkspaceEntityDeltaCursor(ownerId);
    if (!result || result.ok !== true || !result.cursor) {
      throw new Error('The restored Account A Delta cursor is unavailable.');
    }
    return {
      ownerId: result.cursor.ownerId,
      publishRevision: Number(result.cursor.publishRevision),
      remoteHeadRevision: Number(result.cursor.remoteHeadRevision),
      requiresPull: result.cursor.requiresPull
    };
  }, ownerA);
  assert.equal(appInitialCursor.ownerId, ownerA);
  const stateBeforeRemoteRead = await rpc(clientA1Restart, 'nexus_get_entity_sync_state');
  assert.equal(stateBeforeRemoteRead.mode, 'delta');
  assert.equal(appInitialCursor.publishRevision, Number(stateBeforeRemoteRead.head_revision));
  assert.equal(appInitialCursor.remoteHeadRevision, Number(stateBeforeRemoteRead.head_revision));
  assert.equal(appInitialCursor.requiresPull, false);

  // Do not let an older pending save or outbox group satisfy this regression.
  // The test must start with a clean, already-verified Account A baseline.
  await page.waitForFunction(async ({ ownerId, expectedHead }) => {
    const queue = window.NexusOfflineSyncQueue;
    const storage = window.NexusStorage;
    if (!queue || !storage || queue.hasPending(localStorage, ownerId)) return false;
    const cursorResult = await storage.readWorkspaceEntityDeltaCursor(ownerId);
    if (!cursorResult || cursorResult.ok !== true || !cursorResult.cursor) return false;
    if (Number(cursorResult.cursor.publishRevision) !== expectedHead ||
        Number(cursorResult.cursor.remoteHeadRevision) !== expectedHead ||
        cursorResult.cursor.requiresPull === true) return false;
    const outbox = await storage.readWorkspaceEntityOutboxGroups(
      ownerId, Number(cursorResult.cursor.acknowledgedSequence), 1000, 1048576
    );
    return !!outbox && outbox.ownerId === ownerId && Array.isArray(outbox.groups) &&
      outbox.groups.length === 0 && outbox.hasMore !== true && outbox.snapshotRequired !== true;
  }, { ownerId: ownerA, expectedHead: Number(stateBeforeRemoteRead.head_revision) }, { timeout: 90000 });

  // Install the hold only after the clean baseline is established. This avoids
  // parking an unrelated initial-load RPC before the remote trigger is created.
  await page.route(initialARecoveryBoundaryPattern, holdInitialARecoveryBoundary);

  // Locate the topic by its generated ID, not by array position: the
  // snapshot decoder is free to reconstruct topic arrays in a different order,
  // and the exact-size padding is attached to one special topic.
  const remoteReadTopic = appFixtureReadback.state.topics.find(topic =>
    topic && topic.id === 'topic-050000'
  );
  assert.ok(remoteReadTopic,
    'The remote-read trigger must use the generated Account A topic-050000.');
  const remoteReadTopicNotes = String(remoteReadTopic.notes || '');
  assert.equal(remoteReadTopicNotes, 'n'.repeat(100),
    'The remote-read trigger must use a normal fixed-size fixture topic.');
  const remoteReadTopicPosition = appFixtureReadback.state.topics.indexOf(remoteReadTopic);
  const changedRemoteReadTopicNotes = (remoteReadTopicNotes[0] === 'x' ? 'y' : 'x') +
    remoteReadTopicNotes.slice(1);
  const remoteReadOperation = await publishOperation(
    clientA1Restart,
    'phase34-app-read-trigger-' + crypto.randomUUID(),
    Number(stateBeforeRemoteRead.head_revision),
    [{
      collection: 'topics',
      id: remoteReadTopic.id,
      operation: 'put',
      position: remoteReadTopicPosition,
      value: { ...remoteReadTopic, notes: changedRemoteReadTopicNotes }
    }]
  );
  assert.equal(remoteReadOperation.ok, true,
    'The isolated remote Delta operation must publish successfully before the browser handoff race.');
  assert.equal(Number(remoteReadOperation.revision), Number(stateBeforeRemoteRead.head_revision) + 1);
  const cursorAfterRemoteTrigger = await page.evaluate(async ownerId => {
    const result = await window.NexusStorage.readWorkspaceEntityDeltaCursor(ownerId);
    if (!result || result.ok !== true || !result.cursor) {
      throw new Error('The remote-read trigger unexpectedly removed Account A\'s verified cursor.');
    }
    return {
      publishRevision: Number(result.cursor.publishRevision),
      remoteHeadRevision: Number(result.cursor.remoteHeadRevision),
      requiresPull: result.cursor.requiresPull === true
    };
  }, ownerA);
  assert.equal(cursorAfterRemoteTrigger.publishRevision, appInitialCursor.publishRevision,
    'the independent remote operation must remain unread until the held authenticated read begins');
  console.log('DLA09E_REMOTE_TRIGGER_CURSOR_PROOF=' + JSON.stringify({
    ownerId: ownerA,
    initialPublishRevision: appInitialCursor.publishRevision,
    cursorAfterRemoteTrigger,
    serverHeadRevision: Number(remoteReadOperation.revision)
  }));

  // Topic cards are rendered lazily only while Library is the active view.
  // Open it explicitly and wait for the normal edit controls before driving
  // the real UI save path below.
  await page.locator('button.tab[data-view="topics"]').click();
  await page.waitForFunction(() =>
    !!document.querySelector('#topicGrid button[data-action="edit-topic"]'),
  null, { timeout: 30000 });


  const initialAPendingResult = await page.evaluate(async ({ ownerA, remoteReadTopicId }) => {
    const owner = localStorage.getItem('nexus.cloud.last-user-id');
    if (owner !== ownerA) throw new Error('Account A no longer owns the local workspace before the interrupted verification test.');

    // Exercise the real app save path. A durable, non-overlapping local topic edit
    // creates both the compatibility pending snapshot and its IndexedDB Delta
    // outbox group. Verify the exact edit in all three local representations before
    // allowing the account handoff to begin.
    const state = JSON.parse(localStorage.getItem('recall.study.tracker.v1') || '{}');
    const candidates = Array.from(document.querySelectorAll(
      '#topicGrid button[data-action="edit-topic"]'
    ));
    const editButton = candidates.find(button => {
      if (!button.dataset.id || button.dataset.id === 'topic-000000') return false;
      const topic = Array.isArray(state.topics)
        ? state.topics.find(row => String(row.id) === button.dataset.id)
        : null;
      return !!topic && String(topic.notes || '') === 'n'.repeat(100) &&
        String(topic.id) !== remoteReadTopicId;
    });
    if (!editButton) throw new Error('A normal-sized existing Account A topic is not available for the local handoff edit.');

    editButton.click();
    const dialog = document.getElementById('topicDialog');
    if (!dialog || !dialog.open) throw new Error('The existing topic edit dialog did not open.');
    const nameInput = document.getElementById('topicNameInput');
    const notesInput = document.getElementById('topicNotesInput');
    const form = document.getElementById('topicForm');
    if (!nameInput || !notesInput || !form) throw new Error('The normal topic save form is unavailable.');
    const originalLocalNotes = String(notesInput.value || '');
    if (originalLocalNotes !== 'n'.repeat(100)) {
      throw new Error('The local handoff edit must target a normal fixed-size fixture topic.');
    }
    // Change one ASCII byte only so the 26,900,000-byte return fixture remains exact.
    const expectedNotes = (originalLocalNotes[0] === 'x' ? 'y' : 'x') + originalLocalNotes.slice(1);
    notesInput.value = expectedNotes;
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));

    const projectionReady = await window.NexusStorage.waitForWorkspaceEntitySync(ownerA);
    if (!projectionReady || projectionReady.ok !== true ||
        projectionReady.workspaceRevision !== projectionReady.projectionWorkspaceRevision) {
      throw new Error('The local handoff edit did not reach a revision-current owner-bound IndexedDB projection: ' +
        String(projectionReady && projectionReady.reason || 'unknown projection readiness state'));
    }
    // waitForWorkspaceEntitySync returns readiness metadata only. Read the actual
    // active generation separately so this assertion verifies stored record content,
    // not a nonexistent state property on the readiness result.
    const projection = await window.NexusStorage.readWorkspaceEntities(ownerA);
    if (!projection || projection.ownerId !== ownerA || !projection.generation ||
        !projection.state || typeof projection.state !== 'object') {
      throw new Error('The active owner-bound IndexedDB projection could not be read after its readiness check.');
    }
    const cursorResult = await window.NexusStorage.readWorkspaceEntityDeltaCursor(ownerA);
    if (!cursorResult || cursorResult.ok !== true || !cursorResult.cursor) {
      throw new Error('The local handoff edit lost Account A\'s Delta cursor.');
    }
    const outbox = await window.NexusStorage.readWorkspaceEntityOutboxGroups(
      ownerA, Number(cursorResult.cursor.acknowledgedSequence), 1000, 1048576
    );
    const pending = window.NexusOfflineSyncQueue?.getPending(localStorage, ownerA) || null;
    const localState = JSON.parse(localStorage.getItem('recall.study.tracker.v1') || '{}');
    const localTopic = Array.isArray(localState.topics)
      ? localState.topics.find(row => String(row.id) === String(editButton.dataset.id)) : null;
    const pendingTopic = Array.isArray(pending?.payload?.state?.topics)
      ? pending.payload.state.topics.find(row => String(row.id) === String(editButton.dataset.id)) : null;
    const projectionTopic = Array.isArray(projection.state?.topics)
      ? projection.state.topics.find(row => String(row.id) === String(editButton.dataset.id)) : null;
    const changes = Array.isArray(outbox?.groups)
      ? outbox.groups.flatMap(group => Array.isArray(group.changes) ? group.changes : []) : [];
    const outboxChange = changes.find(change =>
      change.collection === 'topics' && String(change.id) === String(editButton.dataset.id) &&
      change.operation === 'put'
    );
    return {
      owner,
      editedTopicId: editButton.dataset.id,
      expectedNotes,
      projectionOwnerId: projection.ownerId,
      projectionGeneration: projection.generation,
      projectionRevision: projection.revision,
      projectionRowCount: projection.rowCount,
      projectionWorkspaceRevision: projectionReady.projectionWorkspaceRevision,
      localNotes: localTopic?.notes ?? null,
      pendingNotes: pendingTopic?.notes ?? null,
      projectionNotes: projectionTopic?.notes ?? null,
      outboxNotes: outboxChange?.value?.notes ?? null,
      outboxOperation: outboxChange?.operation || null,
      pending: !!pending,
      pendingOperationId: pending?.operationId || null,
      pendingLocalSequence: Number.isSafeInteger(Number(pending?.localSequence)) ? Number(pending.localSequence) : null,
      localOutboxGroupCount: Array.isArray(outbox?.groups) ? outbox.groups.length : 0,
      outboxOwner: outbox?.ownerId || null,
      outboxGeneration: outbox?.generation || null,
      cursorGeneration: cursorResult.cursor.generation,
      cursorPublishRevision: Number(cursorResult.cursor.publishRevision),
      cursorRemoteHeadRevision: Number(cursorResult.cursor.remoteHeadRevision)
    };
  }, { ownerA, remoteReadTopicId: remoteReadTopic.id });
  const expectedAccountANotes = 'x' + 'n'.repeat(99);
  console.log('DLA09E_PRE_HANDOFF_EDIT_PROOF=' + JSON.stringify(initialAPendingResult));
  assert.equal(initialAPendingResult.owner, ownerA);
  assert.equal(initialAPendingResult.pending, true,
    'the interrupted A verification must have a durable owner-bound pending snapshot');
  assert.ok(initialAPendingResult.localOutboxGroupCount > 0,
    'the interrupted A verification must also retain a real local Delta outbox group');
  assert.equal(initialAPendingResult.localNotes, expectedAccountANotes,
    'the exact local edit must be present in the compatibility workspace before handoff');
  assert.equal(initialAPendingResult.pendingNotes, expectedAccountANotes,
    'the exact local edit must be present in the pending compatibility snapshot before handoff');
  assert.equal(initialAPendingResult.projectionNotes, expectedAccountANotes,
    'the exact local edit must be present in the active owner-bound projection before handoff');
  assert.equal(initialAPendingResult.outboxNotes, expectedAccountANotes,
    'the exact local edit must be present in the durable Delta outbox before handoff');
  assert.equal(initialAPendingResult.outboxOperation, 'put');
  assert.equal(initialAPendingResult.outboxOwner, ownerA);
  assert.equal(initialAPendingResult.outboxGeneration, initialAPendingResult.cursorGeneration,
    'the parked edit must be tied to the active owner-bound manifest generation');
  await page.waitForFunction(() =>
    String(document.querySelector('#cloudStatus')?.textContent || '').trim() === 'Syncing...',
  null, { timeout: 30000 });
  for (let i = 0; i < 3600 && !initialARecoveryBoundaryHeld; i++) await page.waitForTimeout(25);
  assert.equal(initialARecoveryBoundaryHeld, true,
    'the test must hold Account A at an authenticated recovery read or snapshot-publication boundary');
  assert.ok([
    'nexus_get_entity_sync_state',
    'nexus_read_entity_operations',
    'nexus_publish_entity_snapshot'
  ].includes(initialARecoveryBoundaryRpc),
  'the held Account A boundary must be a recognized remote-state, operation-read, or snapshot-publication RPC');
  const signedInB = await signInAppTestAccount(appEmailB, appPasswordB);
  assert.equal(signedInB.userId, ownerB);
  const accountBStartedAt = Date.now();
  await waitForAccountAndStatus(appEmailB, ownerB, 'Synced', 90000);
  const accountBReadyMs = Date.now() - accountBStartedAt;
  // Keep A's original recovery boundary held until B has independently reached
  // Synced. Releasing it now detects a stale completion that would otherwise
  // acknowledge or overwrite A's queue after its session epoch has been revoked.
  if (releaseInitialARecoveryBoundary) releaseInitialARecoveryBoundary();
  await page.unroute(initialARecoveryBoundaryPattern, holdInitialARecoveryBoundary);
  const parkedAPending = await page.evaluate(ownerA =>
    !!window.NexusOfflineSyncQueue?.hasPending(localStorage, ownerA), ownerA);
  assert.equal(parkedAPending, true,
    'switching to Account B must park rather than discard Account A pending verification work, even after B is synced');

  // Reproduce the owner's key middle step: Account B edits while offline,
  // reconnects, and must have that edit verified before a rapid return to A.
  const accountBOfflineEditId = 'dla08-b-offline-reconnect-topic';
  const accountBOfflineEditStartedAt = Date.now();
  await context.setOffline(true);
  await page.waitForFunction(() => navigator.onLine === false, null, { timeout: 10000 });
  const offlineEditResult = await page.evaluate(({ ownerB, topicId }) => {
    const owner = localStorage.getItem('nexus.cloud.last-user-id');
    if (owner !== ownerB) throw new Error('The offline edit is not owned by Account B.');
    const state = JSON.parse(localStorage.getItem('recall.study.tracker.v1') || '{}');
    const featureState = JSON.parse(localStorage.getItem('recall.study.features.v1') || '{}');
    if (!Array.isArray(state.topics)) throw new Error('Account B tracker workspace is unavailable.');
    state.topics.push({
      id: topicId,
      name: 'Account B offline reconnect regression',
      subjectId: state.subjects?.[0]?.id || 'subject-general',
      notes: 'Created offline; must be acknowledged after reconnect',
      custom: true,
      createdAt: '2026-11-22',
      lastReviewed: '',
      lastRating: null,
      dueDate: '',
      intervalDays: 0,
      reviewCount: 0,
      streak: 0,
      lapses: 0,
      archived: false
    });
    if (!window.NexusCloudSync || typeof window.NexusCloudSync.recordLocalSave !== 'function') {
      throw new Error('The real account-bound local-save queue is unavailable.');
    }
    window.NexusCloudSync.recordLocalSave({ state, featureState });
    return {
      owner,
      queued: !!window.NexusOfflineSyncQueue?.hasPending(localStorage, ownerB),
      topicCount: state.topics.length
    };
  }, { ownerB, topicId: accountBOfflineEditId });
  assert.equal(offlineEditResult.owner, ownerB,
    'the offline edit must remain associated with Account B');
  assert.equal(offlineEditResult.queued, true,
    'Account B offline edits must be durably queued before reconnect');
  await context.setOffline(false);
  await page.waitForFunction(() => navigator.onLine === true, null, { timeout: 10000 });
  await waitForAccountAndStatus(appEmailB, ownerB, 'Synced', 60000);
  await page.waitForFunction(owner => {
    try {
      return !window.NexusOfflineSyncQueue.hasPending(localStorage, owner);
    } catch (_) {
      return false;
    }
  }, ownerB, { timeout: 90000 });
  const accountBOfflineSyncMs = Date.now() - accountBOfflineEditStartedAt;
  assert.ok(accountBOfflineSyncMs <= 60000,
    'Account B offline edits must reach verified Synced within the 60-second reconnect target');
  const accountBOfflineRow = await readSnapshotRow(clientB, ownerB);
  const accountBOfflineVerified = accountBOfflineRow?.payload?.__nexusStorage === 'chunked-v1'
    ? await chunkStorage.readSnapshot(clientB, ownerB, accountBOfflineRow.payload)
    : accountBOfflineRow?.payload;
  assert.ok(accountBOfflineVerified?.state?.topics?.some(topic => topic.id === accountBOfflineEditId),
    'Account B offline edit must be present in the verified cloud snapshot after reconnect');

  // Reproduce the outstanding DLA-09A case: a durable cursor from an older
  // projection generation must trigger snapshot recovery, not be silently reset.
  // This is an isolated browser IndexedDB mutation; the remote fixture is disposable.
  const accountACursorMismatchInjection = await page.evaluate(async ownerId => {
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open('nexus-workspace-v1');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('Could not open Nexus IndexedDB for the cursor-mismatch regression.'));
      request.onblocked = () => reject(new Error('Nexus IndexedDB is blocked during the cursor-mismatch regression.'));
    });
    const key = 'workspace-entity-delta-cursor:' + encodeURIComponent(ownerId);
    try {
      return await new Promise((resolve, reject) => {
        const transaction = database.transaction(['migrationMeta'], 'readwrite');
        const store = transaction.objectStore('migrationMeta');
        const request = store.get(key);
        let result = null;
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor || cursor.ownerId !== ownerId || typeof cursor.generation !== 'string') {
            try { transaction.abort(); } catch (_) {}
            return;
          }
          const corruptedGeneration = 'dla09-stale-generation-' + Date.now();
          store.put({ ...cursor, generation: corruptedGeneration });
          result = {
            ownerId,
            originalGeneration: cursor.generation,
            corruptedGeneration
          };
        };
        request.onerror = () => { try { transaction.abort(); } catch (_) {} };
        transaction.oncomplete = () => resolve(result);
        transaction.onerror = () => reject(transaction.error || new Error('The cursor-mismatch transaction failed.'));
        transaction.onabort = () => reject(transaction.error || new Error('The cursor-mismatch transaction was aborted.'));
      });
    } finally {
      database.close();
    }
  }, ownerA);
  assert.equal(accountACursorMismatchInjection.ownerId, ownerA,
    'the returning Account A must have a durable Delta cursor before the mismatch is injected');
  assert.notEqual(accountACursorMismatchInjection.originalGeneration,
    accountACursorMismatchInjection.corruptedGeneration,
    'the test must make the cursor generation differ from the active manifest generation');

  // Instrument the exact pending-state acknowledgement boundary. The queue
  // must still contain Account A's parked edit when the remote read-back proof
  // is emitted; no compatibility acknowledgement may precede that proof.
  const accountAAckGuard = await page.evaluate(ownerId => {
    const queue = window.NexusOfflineSyncQueue;
    if (!queue || typeof queue.getPending !== 'function' ||
        typeof queue.acknowledge !== 'function' ||
        typeof queue.commitVerifiedEntityDeltaSnapshot !== 'function') {
      return { installed: false, pending: false };
    }
    const getPending = queue.getPending.bind(queue);
    const originalAcknowledge = queue.acknowledge.bind(queue);
    const originalCommit = queue.commitVerifiedEntityDeltaSnapshot.bind(queue);
    const proofStartedAt = new Date().toISOString();
    const trace = { acknowledgements: [], recoveryCommits: [] };
    const readbackProof = pending => {
      if (!pending) return null;
      try {
        const parsed = JSON.parse(localStorage.getItem('nexus.syncdiag.session.v1') || '[]');
        const event = Array.isArray(parsed) ? parsed.slice().reverse().find(event =>
          event && event.at >= proofStartedAt &&
          (event.stage === 'pending-snapshot-remote-readback' ||
            (event.stage === 'snapshot-recovery-progress' &&
             event.recoveryStep === 'verify-pending-snapshot-readback' &&
             event.progressPhase === 'completed')) &&
          event.remoteReadbackVerified === true &&
          event.pendingLocalChangesPreserved === true &&
          event.pendingOutboxOverlayApplied === true &&
          Number(event.pendingLocalSequence) === Number(pending.localSequence) &&
          Number.isSafeInteger(Number(event.pendingLocalChangeCount))
        ) : null;
        return event ? {
          pendingLocalChangesPreserved: true,
          pendingOutboxOverlayApplied: true,
          pendingLocalChangeCount: Number(event.pendingLocalChangeCount)
        } : null;
      } catch (_) { return null; }
    };
    queue.acknowledge = function(storage, targetOwner, ...args) {
      if (targetOwner === ownerId) {
        const pending = getPending(storage, targetOwner);
        if (pending) {
          const proof = readbackProof(pending);
          trace.acknowledgements.push({
            pendingBefore: true,
            remoteReadbackVerifiedBeforeAck: !!proof,
            pendingLocalChangesPreservedBeforeAck: !!proof?.pendingLocalChangesPreserved,
            pendingOutboxOverlayAppliedBeforeAck: !!proof?.pendingOutboxOverlayApplied,
            pendingLocalChangeCountBeforeAck: proof?.pendingLocalChangeCount ?? null,
            pendingLocalSequence: Number(pending.localSequence)
          });
        }
      }
      return originalAcknowledge.apply(this, arguments);
    };
    queue.commitVerifiedEntityDeltaSnapshot = function(storage, targetOwner, ...args) {
      if (targetOwner === ownerId) {
        const pending = getPending(storage, targetOwner);
        if (pending) {
          const proof = readbackProof(pending);
          trace.recoveryCommits.push({
            pendingBefore: true,
            remoteReadbackVerifiedBeforeCommit: !!proof,
            pendingLocalChangesPreservedBeforeCommit: !!proof?.pendingLocalChangesPreserved,
            pendingOutboxOverlayAppliedBeforeCommit: !!proof?.pendingOutboxOverlayApplied,
            pendingLocalChangeCountBeforeCommit: proof?.pendingLocalChangeCount ?? null,
            pendingLocalSequence: Number(pending.localSequence)
          });
        }
      }
      return originalCommit.apply(this, arguments);
    };
    window.__dla09PendingAckTrace = trace;
    return { installed: true, pending: !!getPending(localStorage, ownerId) };
  }, ownerA);
  assert.equal(accountAAckGuard.installed, true,
    'the exact Account A pending acknowledgement boundary must be instrumented');
  assert.equal(accountAAckGuard.pending, true,
    'the parked Account A edit must remain pending before cursor-mismatch recovery starts');

  const accountAReturnStartedAt = Date.now();
  const accountAReturnStartedIso = new Date(accountAReturnStartedAt).toISOString();
  const onlineAtAccountReturn = await page.evaluate(() => navigator.onLine === true);
  assert.equal(onlineAtAccountReturn, true,
    'The A→B→A acceptance run must execute in an online browser context.');
  let returnAReadHeld = false;
  let releaseReturnARead = null;
  let returnAReadRpc = null;
  const holdReturnARead = async route => {
    const requestUrl = new URL(route.request().url());
    const rpc = requestUrl.pathname.split('/').pop();
    const recoveryStarted = await page.evaluate(() => {
      try {
        const events = JSON.parse(localStorage.getItem('nexus.syncdiag.session.v1') || '[]');
        return Array.isArray(events) && events.some(event => event && event.stage === 'snapshot-recovery-start');
      } catch (_) { return false; }
    });
    if (!returnAReadHeld && recoveryStarted &&
        ['nexus_get_entity_sync_state','nexus_read_entity_operations','nexus_publish_entity_snapshot'].includes(rpc)) {
      returnAReadHeld = true;
      returnAReadRpc = rpc;
      console.log('DLA09E_RETURN_A_READ_HELD=' + JSON.stringify({account:'A',rpc}));
      await new Promise(resolve => { releaseReturnARead = resolve; });
    }
    try { await route.continue(); } catch (_) {}
  };
  await page.route(initialAReadPattern, holdReturnARead);
  const returnedA = await signInAppTestAccount(appEmailA, appPasswordA);
  assert.equal(returnedA.userId, ownerA);
  // The compatibility workspace is rendered before projection reuse/rebuild
  // finishes. Measure that actual owner-verified render, not the later helper
  // completion event, which would incorrectly include projection work.
  await page.waitForFunction(({ email, userId, startedAt }) => {
    const account = document.querySelector('#cloudAccount');
    if (!account || account.textContent.trim() !== email) return false;
    if (localStorage.getItem('nexus.cloud.last-user-id') !== userId) return false;
    let events = [];
    try {
      const parsed = JSON.parse(localStorage.getItem('nexus.syncdiag.session.v1') || '[]');
      events = Array.isArray(parsed) ? parsed : [];
    } catch (_) {}
    return events.some(event =>
      event.stage === 'workspace-render' &&
      typeof event.at === 'string' &&
      event.at >= startedAt &&
      event.ownerVerified === true &&
      event.ok === true &&
      event.workspace &&
      event.workspace.topicCount === 77144 &&
      event.workspace.reviewHistoryCount === 72001 &&
      Number.isSafeInteger(event.durationMs)
    );
  }, { email: appEmailA, userId: ownerA, startedAt: accountAReturnStartedIso }, { timeout: 65000 });
  const returnEventsAtReveal = await readAppDiagnostics();
  const cachedRenderEvent = returnEventsAtReveal.slice().reverse().find(event =>
    event.stage === 'workspace-render' &&
    typeof event.at === 'string' &&
    event.at >= accountAReturnStartedIso &&
    event.ownerVerified === true &&
    event.ok === true &&
    event.workspace &&
    event.workspace.topicCount === INITIAL_TOPICS &&
    event.workspace.reviewHistoryCount === INITIAL_HISTORY
  );
  assert.ok(cachedRenderEvent,
    'The returning owner’s exact large cached workspace must be rendered with owner verification.');
  const cachedRevealWallMs = Date.parse(cachedRenderEvent.at) - accountAReturnStartedAt;
  const cachedRevealDurationMs = cachedRenderEvent.durationMs;
  assert.ok(cachedRevealWallMs <= 30000,
    'The complete live A→B→A return must reveal the owner-verified cached workspace within 30 seconds.');
  assert.ok(cachedRevealDurationMs <= 30000,
    'The owner-verified compatibility render operation must finish within 30 seconds.');

  // Hold the returning Account A Delta read while exercising real application
  // navigation. This proves that a large owner-verified workspace remains
  // usable and its views can render before cloud verification reaches Synced.
  let navigationDuringSyncEvidence = null;
  try {
    for (let i = 0; i < 2400 && !returnAReadHeld; i++) await page.waitForTimeout(25);
    assert.equal(returnAReadHeld, true,
      'the returning Account A sync must reach the deliberately held authenticated remote-read boundary');
    const mismatchRecoveryStarted = await page.evaluate(({ ownerId, startedAt }) => {
      let events = [];
      try {
        const parsed = JSON.parse(localStorage.getItem('nexus.syncdiag.session.v1') || '[]');
        events = Array.isArray(parsed) ? parsed : [];
      } catch (_) {}
      return events.some(event =>
        event.stage === 'snapshot-recovery-start' &&
        typeof event.at === 'string' &&
        event.at >= startedAt &&
        event.triggerReason === 'local_delta_cursor_mismatch'
      );
    }, { ownerId: ownerA, startedAt: accountAReturnStartedIso });
    assert.equal(mismatchRecoveryStarted, true,
      'a stale-generation cursor must enter the explicit snapshot-recovery path before the held remote read is released');
    const statusBeforeNavigation = String(await page.locator('#cloudStatus').textContent() || '').trim();
    assert.notEqual(statusBeforeNavigation, 'Synced',
      'holding the returning account remote read must keep the UI from claiming cloud verification');

    const navigationStartedAt = Date.now();
    const navigationViews = ['overview', 'studyhub', 'topics'];
    for (const view of navigationViews) {
      await page.locator('button.tab[data-view="' + view + '"]').click();
      await page.waitForFunction(viewName => {
        const panel = document.getElementById('view-' + viewName);
        const button = document.querySelector('button.tab[data-view="' + viewName + '"]');
        return !!panel && panel.classList.contains('active') &&
          !!button && button.getAttribute('aria-selected') === 'true';
      }, view, { timeout: 15000 });
      if (view === 'overview') {
        await page.waitForFunction(() => {
          const stats = document.getElementById('statsGrid');
          return !!stats && stats.children.length > 0;
        }, null, { timeout: 15000 });
      } else if (view === 'studyhub') {
        await page.waitForFunction(() => {
          const content = document.getElementById('hubContent');
          return !!content && content.children.length > 0;
        }, null, { timeout: 15000 });
      } else if (view === 'topics') {
        await page.waitForFunction(() => {
          const grid = document.getElementById('topicGrid');
          return !!grid && grid.children.length > 0;
        }, null, { timeout: 15000 });
      }
    }
    const navigationDuringSyncMs = Date.now() - navigationStartedAt;
    const navigationState = await page.evaluate(ownerId => ({
      owner: localStorage.getItem('nexus.cloud.last-user-id'),
      workspaceAuth: document.documentElement.dataset.workspaceAuth || '',
      status: String(document.querySelector('#cloudStatus')?.textContent || '').trim(),
      activeView: document.querySelector('.view.active')?.id || '',
      topicCards: document.querySelectorAll('#topicGrid button[data-action="edit-topic"]').length
    }), ownerA);
    assert.equal(navigationState.owner, ownerA,
      'navigation during Account A verification must retain the verified Account A owner');
    assert.equal(navigationState.workspaceAuth, 'ready',
      'navigation during sync must keep the owner-verified cached workspace available');
    assert.notEqual(navigationState.status, 'Synced',
      'navigation must not turn an in-flight remote verification into a false Synced state');
    assert.equal(navigationState.activeView, 'view-topics',
      'the final Library view must remain selected after rendering during sync');
    assert.ok(navigationState.topicCards > 0,
      'the large Library topic list must render while cloud verification is still held');
    assert.ok(navigationDuringSyncMs <= 30000,
      'Home, Study Hub and Library must remain navigable and render within 30 seconds during sync');
    navigationDuringSyncEvidence = {
      views: navigationViews,
      durationMs: navigationDuringSyncMs,
      ownerVerified: navigationState.workspaceAuth === 'ready' && navigationState.owner === ownerA,
      remoteReadRpc: returnAReadRpc,
      statusWhileReadHeld: navigationState.status,
      finalView: navigationState.activeView,
      topicCards: navigationState.topicCards
    };
    check('DLA-09E keeps Home, Study Hub and Library navigable and rendered during held Account A verification',
      navigationDuringSyncEvidence.ownerVerified &&
      navigationDuringSyncEvidence.statusWhileReadHeld !== 'Synced' &&
      navigationDuringSyncEvidence.topicCards > 0);
    console.log('DLA-09E_NAVIGATION_DURING_SYNC=' + JSON.stringify(navigationDuringSyncEvidence));
  } finally {
    if (releaseReturnARead) releaseReturnARead();
    await page.unroute(initialAReadPattern, holdReturnARead);
  }

  // A successful verification event ends the wait early. Otherwise observe the
  // full 60-second deadline so a watchdog-delayed state is measured rather than
  // misclassified as a missing event.
  await page.waitForFunction(({ startedAt, deadlineMs }) => {
    let events = [];
    try {
      const parsed = JSON.parse(localStorage.getItem('nexus.syncdiag.session.v1') || '[]');
      events = Array.isArray(parsed) ? parsed : [];
    } catch (_) {}
    const verified = events.some(event =>
      event.stage === 'initial-sync-verification' &&
      typeof event.at === 'string' &&
      event.at >= startedAt &&
      event.ok === true &&
      Number.isSafeInteger(event.durationMs) &&
      event.durationMs <= deadlineMs
    );
    return verified || Date.now() - Date.parse(startedAt) >= deadlineMs;
  }, { startedAt: accountAReturnStartedIso, deadlineMs: 60000 }, { timeout: 65000 });

  const deadlineEvents = await readAppDiagnostics();
  const returnStatusAtDeadline = String(
    await page.locator('#cloudStatus').textContent() || ''
  ).trim();
  const returnSyncWallMsAtDeadline = Date.now() - accountAReturnStartedAt;
  const returnVerification = deadlineEvents.slice().reverse().find(event =>
    event.stage === 'initial-sync-verification' &&
    typeof event.at === 'string' &&
    event.at >= accountAReturnStartedIso &&
    event.ok === true &&
    Number.isSafeInteger(event.durationMs) &&
    event.durationMs <= 60000
  ) || null;
  const watchdogEvent = deadlineEvents.find(event =>
    (event.stage === 'initialize-status-watchdog' ||
      event.stage === 'sync-verification-watchdog') &&
    typeof event.at === 'string' &&
    event.at >= accountAReturnStartedIso
  ) || null;
  const explicitDelayedStates = new Set([
    'Sync pending',
    'Account verification delayed',
    'Sync delayed - local data ready',
    'Sync unavailable',
    'Sync not verified',
    'Automatic merge not verified',
    'Account handoff paused'
  ]);
  const verifiedWithinDeadline = !!(
    returnVerification &&
    returnVerification.ok === true &&
    returnVerification.durationMs <= 60000 &&
    returnStatusAtDeadline === 'Synced'
  );
  const delayedWithinDeadline = !!(
    explicitDelayedStates.has(returnStatusAtDeadline) &&
    returnSyncWallMsAtDeadline <= 65000 &&
    watchdogEvent &&
    Date.parse(watchdogEvent.at) - accountAReturnStartedAt <= 60000 &&
    returnStatusAtDeadline !== 'Synced'
  );
  assert.ok(verifiedWithinDeadline || delayedWithinDeadline,
    'A→B→A must either verify within 60 seconds or expose a truthful delayed state by the deadline.');
  if (!verifiedWithinDeadline) {
    await page.waitForFunction(startedAt => {
      try {
        const parsed = JSON.parse(localStorage.getItem('nexus.syncdiag.session.v1') || '[]');
        return Array.isArray(parsed) && parsed.some(event =>
          event && event.stage === 'initial-sync-verification' &&
          typeof event.at === 'string' && event.at >= startedAt && event.ok === true
        );
      } catch (_) { return false; }
    }, accountAReturnStartedIso, { timeout: 180000 });
    await waitForAccountAndStatus(appEmailA, ownerA, 'Synced', 30000);
  }
  const afterDeadline = await readAppDiagnostics();
  const returnCursorMismatchRecoveryStart = afterDeadline.slice().reverse().find(event =>
    event.stage === 'snapshot-recovery-start' &&
    typeof event.at === 'string' &&
    event.at >= accountAReturnStartedIso &&
    event.triggerReason === 'local_delta_cursor_mismatch'
  ) || null;
  const returnCursorMismatchRecoveryComplete = afterDeadline.slice().reverse().find(event =>
    event.stage === 'snapshot-recovery-complete' &&
    typeof event.at === 'string' &&
    event.at >= accountAReturnStartedIso &&
    event.ok === true
  ) || null;
  const returnCursorMismatchRecoveryVerification = afterDeadline.slice().reverse().find(event =>
    event.stage === 'delta-recovery-verification' &&
    typeof event.at === 'string' &&
    event.at >= accountAReturnStartedIso &&
    event.ok === true &&
    event.recoveryTriggerReason === 'local_delta_cursor_mismatch'
  ) || null;
  const returnVerificationAny = afterDeadline.slice().reverse().find(event =>
    event.stage === 'initial-sync-verification' &&
    typeof event.at === 'string' &&
    event.at >= accountAReturnStartedIso
  ) || null;
  const returnStatus = await page.locator('#cloudStatus').textContent();
  const returnStatusText = String(returnStatus || '').trim();
  const returnSyncWallMs = Date.now() - accountAReturnStartedAt;
  const returnTerminalOutcomeMs = verifiedWithinDeadline
    ? returnVerification.durationMs
    : watchdogEvent
      ? Date.parse(watchdogEvent.at) - accountAReturnStartedAt
      : null;
  const accountAPendingAfterReturn = await page.evaluate(ownerA =>
    !!window.NexusOfflineSyncQueue?.hasPending(localStorage, ownerA), ownerA);
  assert.equal(accountAPendingAfterReturn, false,
    'Account A pending verification must be acknowledged only after its returning cloud snapshot is verified');
  const returnCursorState = await page.evaluate(async ownerId => {
    const cursorResult = await window.NexusStorage.readWorkspaceEntityDeltaCursor(ownerId);
    if (!cursorResult || cursorResult.ok !== true || !cursorResult.cursor) {
      return { ok: false, reason: cursorResult && cursorResult.reason || 'cursor-unavailable' };
    }
    const outbox = await window.NexusStorage.readWorkspaceEntityOutboxGroups(
      ownerId, Number(cursorResult.cursor.acknowledgedSequence), 1000, 1048576
    );
    return {
      ok: true,
      generation: cursorResult.generation,
      cursorGeneration: cursorResult.cursor.generation,
      generationMatches: cursorResult.cursor.generation === cursorResult.generation,
      publishRevision: Number(cursorResult.cursor.publishRevision),
      remoteHeadRevision: Number(cursorResult.cursor.remoteHeadRevision),
      requiresPull: cursorResult.cursor.requiresPull,
      outboxOwner: outbox && outbox.ownerId || null,
      outboxGeneration: outbox && outbox.generation || null,
      outboxGroups: outbox && Array.isArray(outbox.groups) ? outbox.groups.length : null,
      outboxHasMore: !!(outbox && outbox.hasMore === true),
      outboxSnapshotRequired: !!(outbox && outbox.snapshotRequired === true)
    };
  }, ownerA);
  assert.equal(returnCursorState.ok, true,
    'cursor mismatch recovery must publish a readable replacement cursor');
  assert.equal(returnCursorState.generationMatches, true,
    'the recovered cursor must be bound to the active manifest generation');
  assert.equal(returnCursorState.publishRevision, returnCursorState.remoteHeadRevision,
    'the recovered cursor must reach the verified remote head');
  assert.equal(returnCursorState.requiresPull, false,
    'the recovered cursor must not retain an unprocessed remote tail');
  assert.equal(returnCursorState.outboxOwner, ownerA);
  assert.equal(returnCursorState.outboxGeneration, returnCursorState.generation);
  assert.equal(returnCursorState.outboxGroups, 0,
    'the recovered cursor must not leave unacknowledged local Delta operations');
  assert.equal(returnCursorState.outboxHasMore, false);
  assert.equal(returnCursorState.outboxSnapshotRequired, false);
  assert.ok(returnStatusAtDeadline !== 'Synced' || verifiedWithinDeadline,
    'The app must never show Synced without successful initial cloud verification at the 60-second deadline.');

  const pendingAckTrace = await page.evaluate(() => window.__dla09PendingAckTrace || null);
  const pendingAckChecks = pendingAckTrace
    ? [
        ...pendingAckTrace.acknowledgements.filter(item => item.pendingBefore),
        ...pendingAckTrace.recoveryCommits.filter(item => item.pendingBefore)
      ]
    : [];
  const pendingAckProofVerified = pendingAckChecks.length > 0 &&
    pendingAckChecks.every(item =>
      (item.remoteReadbackVerifiedBeforeAck === true || item.remoteReadbackVerifiedBeforeCommit === true) &&
      (item.pendingLocalChangesPreservedBeforeAck === true || item.pendingLocalChangesPreservedBeforeCommit === true) &&
      (item.pendingOutboxOverlayAppliedBeforeAck === true || item.pendingOutboxOverlayAppliedBeforeCommit === true) &&
      Number.isSafeInteger(Number(item.pendingLocalChangeCountBeforeAck ?? item.pendingLocalChangeCountBeforeCommit)) &&
      Number(item.pendingLocalChangeCountBeforeAck ?? item.pendingLocalChangeCountBeforeCommit) > 0
    );
  assert.ok(pendingAckProofVerified,
    'Account A pending state must remain present until an exact remote snapshot/read-back proof is recorded.');

  const returnCloudChunkRead = afterDeadline.slice().reverse().find(event =>
    event.stage === 'cloud-chunk-read' &&
    typeof event.at === 'string' && event.at >= accountAReturnStartedIso &&
    event.payloadUtf8Bytes === TARGET_BYTES &&
    event.chunkCount === 103
  ) || null;
  const returnCloudRead = afterDeadline.slice().reverse().find(event =>
    event.stage === 'cloud-read' &&
    typeof event.at === 'string' && event.at >= accountAReturnStartedIso &&
    event.payloadUtf8Bytes === TARGET_BYTES &&
    event.chunkCount === 103
  ) || null;
  const returnProjectionCompletion = afterDeadline.slice().reverse().find(event =>
    (event.stage === 'projection-reuse' || event.stage === 'projection-rebuild') &&
    typeof event.at === 'string' && event.at >= accountAReturnStartedIso &&
    event.ownerVerified === true
  ) || null;
  const returnProjectionDeferred = afterDeadline.slice().reverse().find(event =>
    event.stage === 'projection-deferred-to-upload' &&
    typeof event.at === 'string' && event.at >= accountAReturnStartedIso &&
    event.ownerVerified === true
  ) || null;
  const returnProjectionRebuild = afterDeadline.slice().reverse().find(event =>
    event.stage === 'projection-rebuild' &&
    typeof event.at === 'string' && event.at >= accountAReturnStartedIso
  ) || null;
  const returnDeltaSyncVerified = afterDeadline.slice().reverse().find(event =>
    event.stage === 'delta-sync-result' &&
    typeof event.at === 'string' && event.at >= accountAReturnStartedIso &&
    event.ok === true && event.skipped !== true
  ) || null;
  const returnWorkspaceSnapshotCurrent = afterDeadline.slice().reverse().find(event =>
    event.stage === 'workspace-snapshot-current' &&
    typeof event.at === 'string' && event.at >= accountAReturnStartedIso
  ) || null;
  const phaseStages = new Set([
    'account-handoff-outgoing-checkpoint',
    'cloud-chunk-read',
    'cloud-read',
    'workspace-comparison',
    'workspace-comparison-reuse',
    'workspace-local-commit',
    'projection-check-start',
    'projection-readiness',
    'workspace-snapshot-current',
    'projection-reuse',
    'projection-rebuild',
    'entity-projection-rebuild',
    'projection-deferred-to-upload',
    'delta-sync-result',
    'workspace-render',
    'snapshot-recovery-start',
    'snapshot-recovery-progress',
    'snapshot-recovery-complete',
    'delta-recovery-verification',
    'initialize-status-watchdog',
    'initial-sync-verification'
  ]);
  const phaseTimings = afterDeadline.filter(event =>
    typeof event.at === 'string' &&
    event.at >= accountAReturnStartedIso &&
    phaseStages.has(event.stage)
  ).map(event => ({
    stage: event.stage,
    elapsedMs: Math.max(0, Date.parse(event.at) - accountAReturnStartedAt),
    durationMs: Number.isSafeInteger(event.durationMs) ? event.durationMs : null,
    ok: typeof event.ok === 'boolean' ? event.ok : null,
    ownerVerified: typeof event.ownerVerified === 'boolean' ? event.ownerVerified : null,
    ready: typeof event.ready === 'boolean' ? event.ready : null,
    timedOut: typeof event.timedOut === 'boolean' ? event.timedOut : null,
    chunkCount: Number.isSafeInteger(event.chunkCount) ? event.chunkCount : null,
    payloadUtf8Bytes: Number.isSafeInteger(event.payloadUtf8Bytes) ? event.payloadUtf8Bytes : null,
    projectionBatchCount: Number.isSafeInteger(event.projectionBatchCount) ? event.projectionBatchCount : null,
    projectionRowsWritten: Number.isSafeInteger(event.projectionRowsWritten) ? event.projectionRowsWritten : null,
    projectionWriteDurationMs: Number.isSafeInteger(event.projectionWriteDurationMs) ? event.projectionWriteDurationMs : null,
    projectionPruneDurationMs: Number.isSafeInteger(event.projectionPruneDurationMs) ? event.projectionPruneDurationMs : null,
    projectionPruneRowsScanned: Number.isSafeInteger(event.projectionPruneRowsScanned) ? event.projectionPruneRowsScanned : null,
    projectionPruneRowsRemoved: Number.isSafeInteger(event.projectionPruneRowsRemoved) ? event.projectionPruneRowsRemoved : null,
    projectionOutboxPruneDurationMs: Number.isSafeInteger(event.projectionOutboxPruneDurationMs) ? event.projectionOutboxPruneDurationMs : null,
    projectionOutboxPruneRowsRemoved: Number.isSafeInteger(event.projectionOutboxPruneRowsRemoved) ? event.projectionOutboxPruneRowsRemoved : null,
    topicCount: Number.isSafeInteger(event.workspace?.topicCount) ? event.workspace.topicCount : null,
    historyRows: Number.isSafeInteger(event.workspace?.reviewHistoryCount) ? event.workspace.reviewHistoryCount : null,
    projectionRebuildMode: typeof event.projectionRebuildMode === 'string' ? event.projectionRebuildMode : null,
    same: typeof event.same === 'boolean' ? event.same : null,
    reused: typeof event.reused === 'boolean' ? event.reused : null,
    comparisonPassesSaved: Number.isSafeInteger(event.comparisonPassesSaved) ? event.comparisonPassesSaved : null,
    reason: typeof event.reason === 'string' ? event.reason : null,
    triggerReason: typeof event.triggerReason === 'string' ? event.triggerReason : null,
    recoveryTriggerReason: typeof event.recoveryTriggerReason === 'string' ? event.recoveryTriggerReason : null,
    verificationReason: typeof event.verificationReason === 'string' ? event.verificationReason : null
  }));
  const expectedReturnPhases = [
    'workspace-render',
    'snapshot-recovery-start',
    'snapshot-recovery-complete',
    'delta-recovery-verification',
    'delta-sync-result',
    'initial-sync-verification'
  ];
  const phasesNotObservedByDeadline = expectedReturnPhases.filter(stage =>
    !deadlineEvents.some(event => event.stage === stage &&
      typeof event.at === 'string' && event.at >= accountAReturnStartedIso)
  );
  appLevelTimingEvidence = {
    fixtureBytes: TARGET_BYTES,
    fixtureChunks: 103,
    topics: INITIAL_TOPICS,
    historyRows: INITIAL_HISTORY,
    networkMode: 'online Chromium against disposable local Supabase',
    browserOnline: onlineAtAccountReturn,
    initialSignInToVerifiedMs,
    initialRestoreToVerifiedMs,
    initialWorkspaceRevealMs,
    initialWorkspaceRevealStatus,
    initialInitializationDurationMs: initialVerification.durationMs,
    initialInitializationVerified: initialVerification.ok === true,
    initialInitializationTimedOut: initialVerification.timedOut === true,
    initialRetryDeltaVerified: !!initialRetryDeltaVerification,
    initialAUploadVerificationInterrupted: initialARecoveryBoundaryHeld,
    initialARecoveryBoundaryRpc,
    initialAPendingParkedAcrossSwitch: parkedAPending,
    initialWatchdogDelayMs,
    initialWatchdogOutcome,
    initialWatchdogStatus,
    initialRetryScheduled,
    initialRetryDelayMs,
    initialRemoteReadMs: initialCloudRead.durationMs,
    accountBReadyMs,
    accountBOfflineSyncMs,
    accountBOfflineEditVerified: !!accountBOfflineVerified?.state?.topics?.some(topic => topic.id === accountBOfflineEditId),
    navigationDuringSync: navigationDuringSyncEvidence,
    returningAccountOwnerVerified: cachedRenderEvent.ownerVerified === true,
    cachedRevealWallMs,
    cachedRevealDurationMs,
    returningCloudChunkReadMs: returnCloudChunkRead && Number.isSafeInteger(returnCloudChunkRead.durationMs)
      ? returnCloudChunkRead.durationMs : null,
    returningCloudReadMs: returnCloudRead && Number.isSafeInteger(returnCloudRead.durationMs)
      ? returnCloudRead.durationMs : null,
    returnSyncVerificationMs: returnVerificationAny && Number.isSafeInteger(returnVerificationAny.durationMs)
      ? returnVerificationAny.durationMs : null,
    returnSyncVerified: returnVerificationAny?.ok === true,
    returnDelayedWithinDeadline: delayedWithinDeadline,
    returnStatusAtDeadline,
    returnFinalStatus: returnStatusText,
    returnSyncWallMsAtDeadline,
    pendingAckProofVerified,
    pendingAckTrace,
    accountAPendingClearedAfterReturn: !accountAPendingAfterReturn,
    cursorMismatchInjected: accountACursorMismatchInjection,
    cursorMismatchRecoveryStarted: !!returnCursorMismatchRecoveryStart,
    cursorMismatchRecoveryCompleted: !!returnCursorMismatchRecoveryComplete,
    cursorMismatchRecoveryVerified: !!returnCursorMismatchRecoveryVerification,
    cursorMismatchRecoveryDurationMs: returnCursorMismatchRecoveryComplete &&
      Number.isSafeInteger(returnCursorMismatchRecoveryComplete.durationMs)
        ? returnCursorMismatchRecoveryComplete.durationMs : null,
    cursorAfterRecovery: returnCursorState,
    returnVerificationEventPendingAtDeadline: !returnVerification,
    returnTerminalStatus: returnStatusAtDeadline,
    returnTerminalOutcomeMs,
    returnSyncWallMs,
    projectionCheckStarted: phaseTimings.some(event => event.stage === 'projection-check-start'),
    projectionCompletedByDeadline: deadlineEvents.some(event =>
      (event.stage === 'projection-reuse' || event.stage === 'projection-rebuild') &&
      typeof event.at === 'string' && event.at >= accountAReturnStartedIso &&
      event.ownerVerified === true
    ),
    projectionDeferredToUpload: !!returnProjectionDeferred,
    projectionRebuiltByDeadline: deadlineEvents.some(event =>
      event.stage === 'projection-rebuild' &&
      typeof event.at === 'string' && event.at >= accountAReturnStartedIso
    ),
    returningDeltaSyncVerified: !!returnDeltaSyncVerified,
    projectionReadinessReason: phaseTimings.find(event => event.stage === 'projection-readiness')?.reason || null,
    workspaceSnapshotCurrent: returnWorkspaceSnapshotCurrent?.same ?? null,
    phasesNotObservedByDeadline,
    phaseTimings
  };
  assert.ok(returnDeltaSyncVerified && returnDeltaSyncVerified.ok === true &&
    returnDeltaSyncVerified.skipped !== true,
    'The returning Account A must complete an authenticated Delta sync rather than take the snapshot-mode fallback.');
  if (returnProjectionRebuild) {
    assert.equal(returnProjectionRebuild.ownerVerified, true,
      'Any returning Delta projection rebuild must remain owner-verified.');
  }
  const accountBRowAfterAReturn = await readSnapshotRow(clientB, ownerB);
  const accountBPayloadAfterAReturn = accountBRowAfterAReturn?.payload?.__nexusStorage === 'chunked-v1'
    ? await chunkStorage.readSnapshot(clientB, ownerB, accountBRowAfterAReturn.payload)
    : accountBRowAfterAReturn?.payload;
  assert.ok(accountBPayloadAfterAReturn?.state?.topics?.some(topic => topic.id === accountBOfflineEditId),
    'returning to Account A must not remove Account B’s already verified offline edit');
  const accountASyncStateAfterReturn = await rpc(clientA1Restart, 'nexus_get_entity_sync_state');
  const accountBSyncStateAfterReturn = await rpc(clientB, 'nexus_get_entity_sync_state');
  assert.equal(accountASyncStateAfterReturn.mode, 'delta',
    'Account A must remain in Delta mode after the app-level handoff and verification.');
  assert.equal(accountBSyncStateAfterReturn.mode, 'snapshot',
    'Account B must remain outside Delta mode after its offline reconnect sync.');
  const accountARowAfterReturn = await readSnapshotRow(clientA1Restart, ownerA);
  assert.equal(accountARowAfterReturn.updated_at,accountASyncStateAfterReturn.snapshot_updated_at,
    'the remote snapshot row and authenticated sync-state proof must refer to the same committed timestamp');
  assert.equal(Number(accountASyncStateAfterReturn.snapshot_revision),
    Number(accountASyncStateAfterReturn.head_revision),
    'the exact parked edit must be committed at the verified remote head revision');
  assert.equal(Number(accountASyncStateAfterReturn.compacted_through_revision),
    Number(accountASyncStateAfterReturn.snapshot_revision),
    'the committed remote snapshot must compact through the verified revision');
  assert.equal(accountARowAfterReturn.payload.__nexusDeltaSync, 'entity-delta-v1');
  const accountAPayloadAfterReturn = await chunkStorage.readSnapshot(clientA1Restart, ownerA, accountARowAfterReturn.payload);
  assert.equal(accountAPayloadAfterReturn.state.topics.length, INITIAL_TOPICS,
    'Account A must retain its complete 77,144-topic cloud workspace after Account B’s offline sync');
  assert.equal(accountAPayloadAfterReturn.state.history.length, INITIAL_HISTORY,
    'Account A must retain its complete 72,001-row review history after Account B’s offline sync');
  assert.equal(accountAPayloadAfterReturn.state.topics.some(topic => topic.id === accountBOfflineEditId), false,
    'Account B’s offline edit must never appear in Account A’s cloud workspace');
  const accountALocalEditedTopicAfterReturn = accountAPayloadAfterReturn.state.topics.find(topic =>
    topic && topic.id === initialAPendingResult.editedTopicId
  );
  const accountARemoteEditedTopicAfterReturn = accountAPayloadAfterReturn.state.topics.find(topic =>
    topic && topic.id === remoteReadTopic.id
  );
  assert.ok(accountALocalEditedTopicAfterReturn,
    'cursor mismatch recovery must preserve Account A’s parked local edit');
  assert.equal(accountALocalEditedTopicAfterReturn.notes, 'x' + 'n'.repeat(99),
    'cursor mismatch recovery must publish Account A’s exact local edit');
  assert.ok(accountARemoteEditedTopicAfterReturn,
    'cursor mismatch recovery must preserve the independent remote Account A operation');
  assert.equal(accountARemoteEditedTopicAfterReturn.notes, changedRemoteReadTopicNotes,
    'cursor mismatch recovery must retain the remote Account A change while merging the parked local edit');
  check('DLA-09A cursor-generation mismatch recovery preserves local and remote Account A edits',
    !!returnCursorMismatchRecoveryStart &&
    !!returnCursorMismatchRecoveryComplete &&
    !!returnCursorMismatchRecoveryVerification &&
    returnCursorState.generationMatches === true &&
    returnCursorState.publishRevision === returnCursorState.remoteHeadRevision &&
    returnCursorState.outboxGroups === 0 &&
    accountALocalEditedTopicAfterReturn.notes === 'x' + 'n'.repeat(99) &&
    accountARemoteEditedTopicAfterReturn.notes === changedRemoteReadTopicNotes &&
    pendingAckProofVerified);
  console.log('DLA-09A_CURSOR_MISMATCH_RECOVERY=' + JSON.stringify({
    injected: accountACursorMismatchInjection,
    recoveryStarted: !!returnCursorMismatchRecoveryStart,
    recoveryCompleted: !!returnCursorMismatchRecoveryComplete,
    recoveryVerified: !!returnCursorMismatchRecoveryVerification,
    recoveryDurationMs: returnCursorMismatchRecoveryComplete && returnCursorMismatchRecoveryComplete.durationMs || null,
    cursor: returnCursorState,
    localEditPreserved: accountALocalEditedTopicAfterReturn.notes === 'x' + 'n'.repeat(99),
    remoteEditPreserved: accountARemoteEditedTopicAfterReturn.notes === changedRemoteReadTopicNotes,
    pendingAckProofVerified,pendingAckTrace
  }));
  check('DLA-08E app-level Delta handoff leaves Account A in Delta and Account B snapshot-only with isolated workspaces',
    accountASyncStateAfterReturn.mode === 'delta' &&
    accountBSyncStateAfterReturn.mode === 'snapshot' &&
    !accountAPayloadAfterReturn.state.topics.some(topic => topic.id === accountBOfflineEditId) &&
    !!accountBPayloadAfterAReturn?.state?.topics?.some(topic => topic.id === accountBOfflineEditId));
  assert.ok(returnDeltaSyncVerified && returnDeltaSyncVerified.ok === true,
    'The returning account must complete authenticated Delta operation reconciliation after cached workspace reveal.');
  assert.equal(pageErrors.length, 0,
    'The app-level A→B→A browser run must not raise uncaught JavaScript exceptions.');
  console.log('DLA-08E_APP_LEVEL_TIMING=' + JSON.stringify(appLevelTimingEvidence));
  check('DLA-08E real Nexus Web app renders the returning 26.9 MB owner-verified workspace within 30 seconds',
    cachedRevealWallMs <= 30000 && cachedRevealDurationMs <= 30000);
  check('DLA-09E A→B→A either verifies within 60 seconds or exposes a truthful delayed state and then recovers',
    (verifiedWithinDeadline || delayedWithinDeadline) &&
    returnVerificationAny?.ok === true &&
    returnStatusText === 'Synced' &&
    !accountAPendingAfterReturn);
} catch (error) {
  try {
    const diagnostics = await page.evaluate(() => {
      let events = [];
      try {
        const parsed = JSON.parse(localStorage.getItem('nexus.syncdiag.session.v1') || '[]');
        events = Array.isArray(parsed) ? parsed : [];
      } catch (_) {}
      const recentStages = events.slice(-40).map(event => {
        const row = { stage: typeof event.stage === 'string' ? event.stage : 'unknown' };
        for (const key of ['durationMs','pageCount','completedPageCount','rowsRead',
          'chunkCount','payloadUtf8Bytes','maxPageDurationMs','minPageDurationMs',
          'projectionBatchCount','projectionRowsWritten','projectionWriteDurationMs',
          'projectionPruneDurationMs','projectionPruneRowsScanned','projectionPruneRowsRemoved',
          'projectionOutboxPruneDurationMs','projectionOutboxPruneRowsRemoved',
          'projectionTransactionWaitDurationMs','projectionTransactionCount',
          'projectionKeyRangeWaitDurationMs','projectionRowGenerationDurationMs',
          'projectionSerializationDurationMs']) {
          if (Number.isSafeInteger(event[key]) && event[key] >= 0) row[key] = event[key];
        }
        for (const key of ['ok','ready','ownerVerified','timedOut','chunkDataIncluded',
          'retryable','snapshotRequired','candidateDigestMatches','expectedHeadRevisionMatches',
          'snapshotRevisionMatches','baseUpdatedAtMatches','exactAlreadyPublishedSnapshotMatches',
          'remotePayloadMatches','remotePayloadDigestMatches','remoteStateMatches','remoteUpdatedAtMatches',
          'remoteSnapshotRevisionMatches','remoteHeadRevisionMatches','remoteCompactedThroughMatches',
          'pendingOutboxProofPresent','pendingOutboxOverlayApplied','pendingLocalChangesPreserved',
          'remoteReadbackVerified','remoteSnapshotPresent','remoteUpdatedAtMatchesState',
          'remotePayloadShapeValid','remotePayloadDeltaMarkerMatches','remoteManifestDeltaMarkerMatches',
          'manifestDeltaMarker','payloadDeltaMarkerBeforeRestore','payloadDeltaMarkerAfterRestore',
          'deltaMarkerRestored']) {
          if (typeof event[key] === 'boolean') row[key] = event[key];
        }
        for (const key of ['recoveryStep','progressPhase','failureReason','recoveryReason','syncMode']) {
          if (typeof event[key] === 'string') row[key] = event[key];
        }
        return row;
      });
      return {
        accountPresent: !!document.querySelector('#cloudAccount')?.textContent?.trim(),
        status: document.querySelector('#cloudStatus')?.textContent || '',
        ownerPresent: !!localStorage.getItem('nexus.cloud.last-user-id'),
        eventCount: events.length,
        recentStages
      };
    });
    console.log('DLA-09B_APP_LEVEL_FAILURE=' + JSON.stringify({
      errorName: error && typeof error.name === 'string' ? error.name : 'Error',
      diagnostics
    }));
  } catch (_) {
    console.log('DLA-09B_APP_LEVEL_FAILURE=' +
      (error && typeof error.name === 'string' ? error.name : 'Error'));
  }
  throw error;
} finally {
  await browser.close();
}

console.log('PASS — ' + checks.length + ' large-workspace two-device lifecycle assertions completed.');
console.log('Evidence: ' + JSON.stringify({
  initialBytes: TARGET_BYTES,
  initialChunks: initialPublication.manifest.chunkCount,
  initialTopics: INITIAL_TOPICS,
  initialHistory: INITIAL_HISTORY,
  concurrentRevision: 2,
  deletedTopics: LARGE_DELETE_COUNT,
  subjectThreeDeletedTopics: SUBJECT_THREE_TOPICS,
  subjectThreeDeletedHistory: SUBJECT_THREE_HISTORY,
  deletionGroups,
  preCompactionRevision: Number(afterCompactionState.snapshot_revision),
  staleDeviceCursorRevision: 2,
  recoveryTailGroups: recovery.groupCount,
  recoveryTailThroughRevision: recovery.throughRevision,
  finalRevision: revision,
  finalTopics: workspaceA1Restart.state.topics.length,
  finalHistory: workspaceA1Restart.state.history.length,
  conflictCount: recovery.conflicts.length,
  cleanupCalls: compactionCleanup.calls + finalCompaction.calls,
  checks: checks.length
}));
