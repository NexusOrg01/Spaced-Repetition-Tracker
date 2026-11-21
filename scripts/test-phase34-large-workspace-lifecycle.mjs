import assert from 'node:assert/strict';
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
  'PHASE34_API_URL', 'PHASE34_ANON_KEY',
  'PHASE34_EMAIL_B', 'PHASE34_PASSWORD_B',
  'PHASE34_EMAIL_C', 'PHASE34_PASSWORD_C'
];
for (const name of required) assert.ok(process.env[name], 'Missing ephemeral local-test variable: ' + name);

const apiUrl = new URL(process.env.PHASE34_API_URL);
assert.equal(apiUrl.protocol, 'http:');
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(apiUrl.hostname));
assert.equal(apiUrl.port, '54321');
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
const SUBJECT_THREE_TOPICS = 240;
const SUBJECT_THREE_HISTORY = 240;
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
      ? INITIAL_TOPICS - SUBJECT_THREE_TOPICS + i
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
  let remainder = padding % topics.length;
  for (const topic of topics) {
    const amount = each + (remainder > 0 ? 1 : 0);
    if (remainder > 0) remainder--;
    if (amount) topic.notes += 'x'.repeat(amount);
  }
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
  assert.ok(history.some(row => row.id === 'history-000240'),
    'Unrelated history must survive the complete subject deletion');
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
const subjectDelete = await publishOperation(
  clientA1, 'phase34-large-subject-delete-' + crypto.randomUUID(), revision, subjectThreeChanges
);
assert.equal(subjectDelete.ok, true);
revision = subjectDelete.revision;
check('More than 12,000 topic deletions publish as 13 bounded complete groups',
  LARGE_DELETE_COUNT === 12032 && deletionGroups === 13);
check('Complete subject deletion covers all 240 owned topics, 240 reviews and the subject row',
  subjectDelete.ok === true && subjectThreeChanges.length === 481);

const beforeCompaction = await readAllGroups(clientA1, 0, revision);
const compactedWorkspace = delta.reconstructRemoteSnapshot(
  initialPayload, beforeCompaction.groups, 0, revision, { maxBytes: 16 * 1048576 }
);
assert.equal(compactedWorkspace.ok, true);
await verifyFinalWorkspace(compactedWorkspace.payload);
check('Remote reconstruction preserves 64,872 topics and 71,761 unrelated history records',
  compactedWorkspace.payload.state.topics.length === 64872 &&
  compactedWorkspace.payload.state.history.length === 71761);
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
assert.equal(recovery.remotePayload.state.topics.length, 64872);
assert.equal(recovery.remotePayload.state.history.length, 71761);
assert.equal(recovery.payload.state.topics.length, 64872);
assert.equal(recovery.payload.state.history.length, 71761);
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
  recovery.throughRevision === revision && recovery.payload.state.topics.length === 64872);
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
check('DLA-08E prepares an authenticated 26,900,000-byte snapshot-mode app fixture with 103 verified chunks',
  appFixturePublication.verifiedChunks === true &&
  appFixturePublication.manifest.totalBytes === TARGET_BYTES &&
  appFixturePublication.manifest.chunkCount === 103 &&
  appFixtureState.mode === 'snapshot');

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
    return page.evaluate(async ({ email, password }) => {
      const authClient = window.__nexusDla08AuthClient;
      if (!authClient) throw new Error('The isolated browser Auth client is unavailable.');
      const result = await authClient.auth.signInWithPassword({ email, password });
      if (result.error) throw new Error('Disposable browser sign-in failed: ' + result.error.message);
      if (!result.data || !result.data.user || !result.data.session) {
        throw new Error('Disposable browser sign-in did not return an authenticated session.');
      }
      return { userId: result.data.user.id, email: result.data.user.email };
    }, { email, password });
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

  const appEmailA = process.env.PHASE34_EMAIL_C;
  const appPasswordA = process.env.PHASE34_PASSWORD_C;
  const appEmailB = process.env.PHASE34_EMAIL_B;
  const appPasswordB = process.env.PHASE34_PASSWORD_B;
  assert.ok(appEmailA && appPasswordA && appEmailB && appPasswordB,
    'The isolated local browser fixture must provide both disposable account credentials.');

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
  await page.locator('#accountChoiceDialog [data-account-choice="replace"]').click();
  await waitForAccountAndStatus(appEmailA, ownerA, 'Synced', 180000);
  const initialEvents = await readAppDiagnostics();
  const initialCloudRead = initialEvents.slice().reverse().find(event =>
    event.stage === 'cloud-read' &&
    event.payloadUtf8Bytes === TARGET_BYTES &&
    event.chunkCount === 103
  );
  const initialVerification = initialEvents.slice().reverse().find(event =>
    event.stage === 'initial-sync-verification' && event.ok === true
  );
  assert.ok(initialCloudRead,
    'The real Nexus app must read the exact 26.9 MB / 103-chunk account-A fixture.');
  assert.ok(initialVerification && Number.isSafeInteger(initialVerification.durationMs),
    'The real Nexus app must record initial verified sync timing for account A.');

  const signedInB = await signInAppTestAccount(appEmailB, appPasswordB);
  assert.equal(signedInB.userId, ownerB);
  const accountBStartedAt = Date.now();
  await waitForAccountAndStatus(appEmailB, ownerB, 'Synced', 90000);
  const accountBReadyMs = Date.now() - accountBStartedAt;

  const accountAReturnStartedAt = Date.now();
  const accountAReturnStartedIso = new Date(accountAReturnStartedAt).toISOString();
  const returnedA = await signInAppTestAccount(appEmailA, appPasswordA);
  assert.equal(returnedA.userId, ownerA);
  await page.waitForFunction(({ email, userId }) => {
    const account = document.querySelector('#cloudAccount');
    const status = document.querySelector('#cloudStatus');
    if (!account || !status || account.textContent.trim() !== email) return false;
    if (localStorage.getItem('nexus.cloud.last-user-id') !== userId) return false;
    let events = [];
    try {
      const parsed = JSON.parse(localStorage.getItem('nexus.syncdiag.session.v1') || '[]');
      events = Array.isArray(parsed) ? parsed : [];
    } catch (_) {}
    return events.some(event =>
      event.stage === 'online-account-workspace-restored' &&
      event.workspace &&
      event.workspace.topicCount === 77144 &&
      event.workspace.reviewHistoryCount === 72001 &&
      Number.isSafeInteger(event.durationMs)
    );
  }, { email: appEmailA, userId: ownerA }, { timeout: 65000 });
  const cachedRevealWallMs = Date.now() - accountAReturnStartedAt;
  const returnEventsAtReveal = await readAppDiagnostics();
  const cachedRevealEvent = returnEventsAtReveal.slice().reverse().find(event =>
    event.stage === 'online-account-workspace-restored' &&
    event.workspace &&
    event.workspace.topicCount === INITIAL_TOPICS &&
    event.workspace.reviewHistoryCount === INITIAL_HISTORY
  );
  assert.ok(cachedRevealEvent, 'The returning owner’s large cached workspace restore must be diagnosed.');
  assert.ok(cachedRevealEvent.durationMs <= 30000,
    'The measured owner-scoped cache restore operation must finish within 30 seconds.');
  assert.ok(cachedRevealWallMs <= 30000,
    'The complete live A→B→A return must reveal the owner-verified cached workspace within 30 seconds.');

  let returnVerification = null;
  try {
    await page.waitForFunction(startedAt => {
      let events = [];
      try {
        const parsed = JSON.parse(localStorage.getItem('nexus.syncdiag.session.v1') || '[]');
        events = Array.isArray(parsed) ? parsed : [];
      } catch (_) {}
      return events.some(event =>
        event.stage === 'initial-sync-verification' &&
        typeof event.at === 'string' &&
        event.at >= startedAt
      );
    }, accountAReturnStartedIso, { timeout: 65000 });
    const afterVerification = await readAppDiagnostics();
    returnVerification = afterVerification.slice().reverse().find(event =>
      event.stage === 'initial-sync-verification' &&
      typeof event.at === 'string' &&
      event.at >= accountAReturnStartedIso
    ) || null;
  } catch (_) {
    returnVerification = null;
  }

  const returnStatus = await page.locator('#cloudStatus').textContent();
  const returnStatusText = String(returnStatus || '').trim();
  const returnSyncWallMs = Date.now() - accountAReturnStartedAt;
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
    returnStatusText === 'Synced'
  );
  const delayedWithinDeadline = !!(
    returnVerification &&
    returnVerification.ok === false &&
    returnVerification.durationMs <= 60000 &&
    explicitDelayedStates.has(returnStatusText)
  );
  assert.ok(returnVerification,
    'The returning account must reach a recorded verified or explicit delayed/error initialization outcome.');
  assert.ok(returnSyncWallMs <= 60000,
    'The account-return initialization must settle within the 60-second acceptance deadline.');
  assert.ok(verifiedWithinDeadline || delayedWithinDeadline,
    'The account-return outcome must be verified Synced or an explicit truthful delayed/error state within 60 seconds.');

  const returnCloudRead = returnEventsAtReveal.slice().reverse().find(event =>
    event.stage === 'cloud-read' && event.payloadUtf8Bytes === TARGET_BYTES && event.chunkCount === 103
  ) || (await readAppDiagnostics()).slice().reverse().find(event =>
    event.stage === 'cloud-read' && event.payloadUtf8Bytes === TARGET_BYTES && event.chunkCount === 103
  ) || null;

  appLevelTimingEvidence = {
    fixtureBytes: TARGET_BYTES,
    fixtureChunks: 103,
    topics: INITIAL_TOPICS,
    historyRows: INITIAL_HISTORY,
    initialAccountSyncMs: initialVerification.durationMs,
    initialRemoteReadMs: initialCloudRead.durationMs,
    accountBReadyMs,
    returningAccountOwnerMatch: true,
    cachedRevealWallMs,
    cachedRevealDurationMs: cachedRevealEvent.durationMs,
    returningCloudReadMs: returnCloudRead && Number.isSafeInteger(returnCloudRead.durationMs)
      ? returnCloudRead.durationMs : null,
    returnSyncVerificationMs: returnVerification.durationMs,
    returnSyncVerified: verifiedWithinDeadline,
    returnTerminalStatus: returnStatusText,
    returnSyncWallMs
  };
  assert.equal(pageErrors.length, 0,
    'The app-level A→B→A browser run must not raise uncaught JavaScript exceptions.');
  console.log('DLA-08E_APP_LEVEL_TIMING=' + JSON.stringify(appLevelTimingEvidence));
  check('DLA-08E real Nexus Web app reveals the returning 26.9 MB owner-verified workspace within 30 seconds',
    cachedRevealWallMs <= 30000 && cachedRevealEvent.durationMs <= 30000);
  check('DLA-08E real Nexus Web app verifies cloud sync or records an explicit delayed/error outcome within 60 seconds',
    verifiedWithinDeadline || delayedWithinDeadline);
} catch (error) {
  try {
    const diagnostics = await page.evaluate(() => ({
      account: document.querySelector('#cloudAccount')?.textContent || '',
      status: document.querySelector('#cloudStatus')?.textContent || '',
      ownerPresent: !!localStorage.getItem('nexus.cloud.last-user-id'),
      events: (() => {
        try { return JSON.parse(localStorage.getItem('nexus.syncdiag.session.v1') || '[]'); }
        catch (_) { return []; }
      })()
    }));
    console.log('DLA-08E_APP_LEVEL_FAILURE=' + JSON.stringify({
      message: String(error && error.message || error),
      diagnostics
    }));
  } catch (_) {
    console.log('DLA-08E_APP_LEVEL_FAILURE=' + String(error && error.message || error));
  }
  throw error;
} finally {
  await browser.close();
}

console.log('PASS — ' + checks.length + ' large-workspace two-device lifecycle assertions completed.');
console.log('Evidence: ' + JSON.stringify({
  ownerA,
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
