import assert from 'node:assert/strict';
import { resolvePreviewConfig } from './build.mjs';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const syntheticAnonKey = 'header.eyJyb2xlIjoiYW5vbiJ9.synthetic-anon-signature-123456';
const androidPreviewConfig = resolvePreviewConfig({
  VERCEL_ENV: 'preview',
  VERCEL_GIT_COMMIT_REF: 'android/capacitor-multistore-foundation',
  NEXUS_SUPABASE_URL: 'https://xuwfzibxhxzxxupprxsq.supabase.co',
  NEXUS_SUPABASE_ANON_KEY: syntheticAnonKey
});
assert.deepEqual(androidPreviewConfig, {
  url: 'https://xuwfzibxhxzxxupprxsq.supabase.co',
  key: syntheticAnonKey
}, 'the Android PR preview must receive only the isolated staging Supabase configuration');
assert.throws(() => resolvePreviewConfig({
  VERCEL_ENV: 'preview',
  VERCEL_GIT_COMMIT_REF: 'android/capacitor-multistore-foundation',
  NEXUS_SUPABASE_URL: 'https://txugbdavblpettcnhcxl.supabase.co',
  NEXUS_SUPABASE_ANON_KEY: syntheticAnonKey
}), /separate HTTPS Supabase project/, 'the Android PR preview must reject the production Supabase host');
assert.equal(resolvePreviewConfig({
  VERCEL_ENV: 'preview',
  VERCEL_GIT_COMMIT_REF: 'unlisted-preview-branch',
  NEXUS_SUPABASE_URL: 'https://xuwfzibxhxzxxupprxsq.supabase.co',
  NEXUS_SUPABASE_ANON_KEY: syntheticAnonKey
}), null, 'unlisted preview branches must remain offline-safe');
const index = readFileSync(resolve(root, 'index.html'), 'utf8');
const appCore = readFileSync(resolve(root, 'app-core.js'), 'utf8');
const studyHub = readFileSync(resolve(root, 'study-hub.js'), 'utf8');
const appSource = index + '\n' + appCore + '\n' + studyHub;
const cloudSync = readFileSync(resolve(root, 'cloud-sync.js'), 'utf8');
const cloudChunkStorage = readFileSync(resolve(root, 'cloud-chunk-storage.js'), 'utf8');
const chunkMigration = readFileSync(resolve(root, 'supabase/migrations/20261109052019_chunked_nexus_workspace_snapshots.sql'), 'utf8');
const chunkLimitMigration = readFileSync(resolve(root, 'supabase/migrations/20261109053246_tighten_nexus_workspace_chunk_limit.sql'), 'utf8');
const fsrsBundle = readFileSync(resolve(root, 'fsrs-bundle.js'), 'utf8');
const serviceWorker = readFileSync(resolve(root, 'sw.js'), 'utf8');
const workflow = readFileSync(resolve(root, '.github/workflows/validate-curricula.yml'), 'utf8');
const guard = readFileSync(resolve(root, 'workspace-isolation-guard.js'), 'utf8');

function section(source, startMarker, endMarker, label) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0, label + ': start marker missing');
  assert.ok(end > start, label + ': end marker missing');
  return source.slice(start, end);
}

const storageTag = '<script src="./nexus-storage.js"></script>';
const bootstrapTag = '<script src="./nexus-app-bootstrap.js"></script>';
assert.equal(index.split(storageTag).length - 1, 1, 'load the storage adapter exactly once');
assert.equal(index.split(bootstrapTag).length - 1, 1, 'load the storage-gated bootstrap exactly once');
assert.ok(index.indexOf(storageTag) >= 0 && index.indexOf(bootstrapTag) > index.indexOf(storageTag), 'load the storage adapter before the bootstrap');
const storageSource = readFileSync(resolve(root, 'nexus-storage.js'), 'utf8');
const backupUtils = readFileSync(resolve(root, 'backup-restore-utils.js'), 'utf8');
const bootstrap = readFileSync(resolve(root, 'nexus-app-bootstrap.js'), 'utf8');
const runtimeStart = bootstrap.indexOf('const RUNTIME_ASSETS = [');
const runtimeEnd = bootstrap.indexOf('];', runtimeStart);
assert.ok(runtimeStart >= 0 && runtimeEnd > runtimeStart, 'the bootstrap must define the ordered app runtime');
const runtimeBody = runtimeStart >= 0 && runtimeEnd > runtimeStart ? bootstrap.slice(runtimeStart, runtimeEnd) : '';
const runtimeAssets = [...runtimeBody.matchAll(/'([^']+)'/g)].map(match => match[1]);
assert.deepEqual(runtimeAssets, [
  'workspace-isolation-guard.js', 'backup-restore-utils.js', 'offline-sync-queue.js', 'curriculum-integrity.js',
  'explore-curriculum.js', 'app-core.js', 'fsrs-bundle.js', 'study-hub.js', 'nexus-build-config.js',
  'cloud-sync-recovery.js', 'workspace-sync-merge.js', 'cloud-chunk-storage.js', 'cloud-sync.js', 'nexus-app-inline.js'
], 'the isolation guard must install before any application module can hydrate local workspace data');
for (const asset of ['backup-restore-utils.js','offline-sync-queue.js','curriculum-integrity.js','explore-curriculum.js','app-core.js','study-hub.js','nexus-build-config.js','cloud-sync-recovery.js','workspace-sync-merge.js','cloud-chunk-storage.js','cloud-sync.js','workspace-isolation-guard.js','fsrs-bundle.js']) {
  assert.ok(!index.includes('<script src="./' + asset + '"></script>'), asset + ' must not load before the asynchronous storage bootstrap.');
}
assert.ok(storageSource.includes("const DB_NAME = 'nexus-workspace-v1'") && storageSource.includes('function commitLocalStorageEntries(entries)') && storageSource.includes('async function persistPending()'), 'the IndexedDB layer must expose the compatibility write path and durable flush logic');
assert.ok(storageSource.includes("const WORKSPACES = 'workspaces'") && storageSource.includes('function seedWorkspaceProjection') && storageSource.includes('getWorkspace: readWorkspace'), 'IndexedDB must retain verifiable owner-scoped workspace projections');
assert.ok(storageSource.includes('FALLBACK_JOURNAL_KEY') && storageSource.includes('function fallbackAtomicWrite(entries)') && storageSource.includes('valueHash(currentNativeValue)'), 'browser-storage fallback edits must be checksummed and reconciled before an older IndexedDB snapshot can overwrite them');
assert.ok(cloudSync.includes('async function recoverCachedWorkspaceForOfflineAccount(userId)') && cloudSync.includes('queue.getPending(localStorage,userId)') && cloudSync.includes('durable.getWorkspace(userId)') && cloudSync.includes('queue.getBase(localStorage,userId)'), 'offline sign-in must restore only the exact account’s pending/cache/base workspace');
const durableTrackerSave=section(appCore,'function save(options={}){','window.NexusRebuildEntityProjection=()=>{','durable tracker save');
assert.ok(durableTrackerSave.includes("textContent='Saving to this device…';") &&
  durableTrackerSave.includes('const durableFlush=storage.flush();') &&
  durableTrackerSave.includes('durableFlush.then(()=>{') &&
  durableTrackerSave.indexOf('durableFlush.then(()=>{') < durableTrackerSave.indexOf("textContent='Saved on this device';") &&
  durableTrackerSave.includes('}).catch(error=>{') &&
  durableTrackerSave.includes("textContent='Save failed — export backup';"),
  'the tracker must show a pending state and report success only after the durable storage promise resolves');
assert.ok(bootstrap.includes('registerServiceWorker();') && bootstrap.includes("navigator.serviceWorker.register('./sw.js', { scope: './' })"), 'the storage-gated bootstrap must register the service worker directly without waiting for the window load event');
assert.ok(cloudSync.includes('await durableStorage.flush()'), 'cloud uploads must wait for the IndexedDB write queue to commit before selecting a snapshot');
assert.ok(cloudSync.includes("{key:'nexus.fsrs.settings.v1',value:JSON.stringify(nextFeatures.fsrsSettings)}") && cloudSync.includes('NexusFSRS.setSettings(nextFeatures.fsrsSettings'), 'account hydration must persist and activate the account-scoped FSRS scheduler preferences');
assert.ok(fsrsBundle.includes('featureState.fsrsSettings = Object.assign({}, settings)') && fsrsBundle.includes('NexusSetFeatureState(featureState'), 'changing FSRS preferences must place them in the synchronized Study Hub state');
assert.ok(!fsrsBundle.includes('fsrsEnabled') && !fsrsBundle.includes('prevInterval') && !fsrsBundle.includes('old multiplier method') && fsrsBundle.includes('N.previewButtons(t || {})'), 'FSRS-6 must be the only topic-review scheduling path; legacy enable flags cannot select the old multiplier method');
assert.ok(fsrsBundle.includes('if (retentionControl) retentionControl.value = String(settings.request_retention)') && fsrsBundle.includes('if (maximumControl) maximumControl.value = String(settings.maximum_interval)'), 'backup/cloud-applied FSRS tuning values must refresh already-mounted controls');
assert.ok(backupUtils.includes('function normalizeFsrsSettings') && backupUtils.includes("fsrsSettings: normalizeFsrsSettings(input.fsrsSettings"), 'backup import/export normalization must validate FSRS settings');
assert.ok(cloudSync.includes('async function flushDurableLocalWrites()') && cloudSync.includes("await flushDurableLocalWrites();status('Synced');"), 'sync queue acknowledgements, bases, and cloud write verification metadata must be durable before a synced status is shown');
assert.ok(cloudSync.includes("await flushDurableLocalWrites();\n  ready=true;"), 'restoring a remote workspace must durably commit the associated merge base before marking the account ready');
const hydratedWorkspace = section(cloudSync, 'async function applyWorkspaceSnapshot(', 'async function applyRemote(', 'cloud workspace persistence');
const workspaceCommit = hydratedWorkspace.indexOf('await window.NexusBackupRestoreUtils.commitLocalStorageAtomically(localStorage,entries);');
const workspacePublish = hydratedWorkspace.indexOf('state=safeState;');
assert.ok(workspaceCommit >= 0 && workspacePublish > workspaceCommit, 'cloud/local workspace hydration must wait for the atomic durable commit before publishing the new in-memory state');
assert.ok(cloudSync.includes('async function applyRemote(payload,ownerId,serverVersion)') && cloudSync.includes('await applyWorkspaceSnapshot('), 'remote restore and account switching must await durable workspace hydration before reporting the account ready');
assert.ok(cloudSync.includes('async function applyLocalMerged(localPayload,remotePayload)') && cloudSync.includes('await applyLocalMerged('), 'manual merge must wait for its local durable commit before proceeding to upload or claiming success');
assert.ok(bootstrap.includes('await window.NexusStorage.bootstrap()') && bootstrap.includes('for (const asset of RUNTIME_ASSETS) await loadScript(asset)'), 'app modules must wait for storage initialization and load sequentially');
assert.ok(appSource.includes('window.NexusStorageKey = STORAGE_KEY;'), 'expose the primary storage key for shared transactions');
assert.ok(runtimeAssets.indexOf('workspace-sync-merge.js') >= 0 && runtimeAssets.indexOf('cloud-sync.js') > runtimeAssets.indexOf('workspace-sync-merge.js'), 'three-way merge engine must load before cloud sync runtime');
assert.ok(cloudSync.includes('reconcileConcurrentSnapshot(newUserId,remote)'), 'same-account pending snapshots on stale cloud revisions must attempt automatic merge before the workspace-choice fallback');
assert.ok(cloudSync.includes('queue.getBase(localStorage,userId)'), 'automatic conflict resolution must compare the last synced base, local edits, and cloud edits');
assert.ok(cloudSync.includes('conflicts:result.conflicts') && cloudSync.includes('conflictMetadata:{baseServerVersion:pending.baseServerVersion,remoteServerVersion:remoteStamp}'), 'overlapping edit alternatives must share the same atomic commit as the merge before cloud overwrite can happen');
assert.ok(cloudSync.includes("queue.rebaseWithBase(localStorage,userId,mergedSnapshot,remoteStamp,'automatic-three-way-merge'"), 'the merge snapshot, base, queue, local workspace and conflict archive are persisted in one transaction');
assert.ok(cloudSync.includes('workspaceEntries:[') && cloudSync.includes('{key:OWNER_KEY,value:String(userId)}'), 'the automatic merge transaction atomically writes tracker state, Study Hub state, and the account owner');
assert.ok(cloudSync.includes('const normalizedBase=savedBase?normalizeWorkspacePayload({...savedBase,schema:4}):null') && cloudSync.includes('const normalizedLocal=normalizeWorkspacePayload(pending.payload)') && cloudSync.includes('const normalizedRemote=normalizeWorkspacePayload(remote.payload,true)'), 'base, local, and cloud snapshots must be normalized before three-way comparison');
assert.ok(cloudSync.includes('function assertStableRecordIds(payload)'), 'malformed or ID-less records must fail closed before normalization can create new identities');

assert.ok(cloudChunkStorage.includes('async function splitUtf8RangesAsync(') &&
  cloudChunkStorage.includes('await yieldToBrowser()') &&
  cloudChunkStorage.includes('async function verifySnapshotChunks(') &&
  !cloudChunkStorage.includes('await readSnapshot(client,userId,manifest)'),
  'chunk splitting must yield and upload verification must not reconstruct a second full parsed workspace');
const mergeInputs=section(cloudSync,'function normalizeWorkspacePayload(payload,repairCurriculum=false){','function nextCloudStamp(previous)','large merge input preparation');
assert.ok(mergeInputs.includes('state:payload.state') && mergeInputs.includes('if(!repairCurriculum&&Number(payload.schema)>=4)') &&
  mergeInputs.includes('repairCurriculum&&window.NexusRepairNormalizedCurriculumState?window.NexusRepairNormalizedCurriculumState(normalized):normalized') &&
  cloudSync.includes('normalizeWorkspacePayload(remote.payload,true)'),
  'three-way reconciliation must retain trusted local/base snapshots by reference while repairing legacy remote curriculum state before merge');
assert.ok(cloudSync.includes('async function sameWorkspace(a,b)') && cloudSync.includes('merger.sameAsync(') &&
  !cloudSync.includes('stableJson('),
  'workspace equality checks must use cooperative structural comparison instead of allocating giant JSON strings');
assert.ok(cloudSync.includes("syncDiag('upload-start',diagnosticWorkspace()") &&
  !cloudSync.includes("syncDiag('upload-start',snapshot()"),
  'diagnostic-only upload events must not deep-clone the entire workspace when diagnostics are disabled');

const overviewLargeWorkspace=section(studyHub,'async function prepareHomeConsistencyMetrics()','window.NexusPrepareHomeConsistencyMetrics=prepareHomeConsistencyMetrics;','cooperative Overview metrics preparation');
assert.ok(overviewLargeWorkspace.includes('const progressBySubject=new Map(),queue=[],upcomingQueue=[]') &&
  overviewLargeWorkspace.includes('if(low>=7)return;queue.splice(low,0,item);if(queue.length>7)queue.pop();') &&
  overviewLargeWorkspace.includes('for(let start=0;start<topicLength;start+=400)') &&
  !overviewLargeWorkspace.includes('topics.slice().sort('),
  'Overview summary queues must be prepared cooperatively while retaining only the visible seven topics');
const upcomingLargeWorkspace=section(appCore,'function renderUpcomingQueue(sharedMetrics=null){','function renderHistoryInsights()','bounded upcoming queue');
assert.ok(upcomingLargeWorkspace.includes('sharedMetrics?.upcomingQueue') &&
  upcomingLargeWorkspace.includes('insertSortedLimit(items,topic,7,compare)') &&
  !upcomingLargeWorkspace.includes('.sort(') &&
  appCore.includes('renderUpcomingQueue(sharedOverview)'),
  'the seven-row upcoming list must reuse the shared bounded selection and retain its safe fallback');
const plannerSource=section(studyHub,'let plannerMetricsCache=null,plannerBuildGeneration=0,plannerBuildPromise=null,plannerBuildContext=null,plannerUiBuildPromise=null;','function hubCard(','Study Hub cooperative planner');
assert.ok(plannerSource.includes('function buildPlan(limitBudget=true)') &&
  plannerSource.includes('function preparePlannerMetrics(limitBudget=true)') &&
  plannerSource.includes('priorityKeys=Array.from(buckets.keys()).sort') &&
  plannerSource.includes('for(let start=0;start<ts.length;start+=batchSize)') &&
  plannerSource.includes('window.NexusPreparePlannerMetrics=preparePlannerMetrics;') &&
  plannerSource.includes('plannerMetricsCache='),
  'planner ordering, workload estimates and calendar counts must be cached, built cooperatively and invalidated by workspace changes');
const plannerRender=section(studyHub,'function renderPlanner(){','function renderMastery()','Study Hub planner rendering');
assert.ok(plannerRender.includes('scheduledByDate=planner.scheduledByDate') &&
  plannerRender.includes('const remainingMins=planner.remainingMins') &&
  !plannerRender.includes('for(const topic of state.topics)') &&
  !plannerRender.includes('scheduledByDate=new Map()'),
  'planner rendering must reuse cached workload/calendar results without rescanning the full topic catalogue');
const topicHistoryCache=section(studyHub,'function getTopicHistoryStats(){','function featureMeta(t,topicStatus=status(t)){','bounded topic history cache');
assert.ok(topicHistoryCache.includes('item.recent') && topicHistoryCache.includes('recent.length>5') &&
  !topicHistoryCache.includes('item.hs.push'),
  'mastery metadata must retain only the latest five history records per topic plus aggregates');
assert.ok(cloudSync.includes("activeView.id==='view-studyhub'") &&
  !cloudSync.includes('if(window.NexusRenderHub)window.NexusRenderHub();'),
  'sync application must not render the hidden Study Hub and force expensive planner work during initial cloud restoration');

const snapshotVerifyCall=cloudChunkStorage.indexOf('await verifySnapshotChunks(');
const snapshotPublishCall=cloudChunkStorage.indexOf('await backupUtils.writeCloudSnapshot(');
assert.ok(cloudChunkStorage.includes('async function writeSnapshot(') &&
  snapshotVerifyCall>=0 && snapshotPublishCall>snapshotVerifyCall &&
  cloudChunkStorage.includes('await verifySnapshotChunks(client,userId,manifest,serialized,ranges,signal)') &&
  cloudChunkStorage.includes('sha256:await sha256(serialized)'),
  'large cloud snapshots must be read back against the exact source string and hashed before the manifest is conditionally published');
assert.ok(cloudChunkStorage.includes('const READ_BATCH_SIZE=16') && cloudChunkStorage.includes('offset+=READ_BATCH_SIZE'), 'large chunked snapshots must be read back in bounded pages rather than one oversized API response');
assert.ok(chunkMigration.includes('chunk_count <= 900') && chunkLimitMigration.includes('chunk_count <= 900'), 'the database and client must enforce the same bounded chunk-count limit');
assert.ok(cloudSync.includes('knownWrite.manifest') && cloudSync.includes('chunks.sameManifest(remote.payload,knownWrite.manifest)'), 'post-publication verification must reuse the already verified chunk manifest and avoid a second full workspace download');
assert.ok(cloudSync.includes("lastRemoteStorageMode==='chunked'") && cloudSync.includes('chunks.readSnapshot(client,uid,remote.payload,activeSignal)'), 'once an account publishes chunked storage, subsequent clients must continue reading and writing that format');
assert.ok(chunkMigration.includes('ENABLE ROW LEVEL SECURITY') && chunkMigration.includes('GRANT SELECT, INSERT, DELETE') && chunkMigration.includes('(SELECT auth.uid()) = user_id'), 'chunk storage must grant only required operations and restrict all access to the authenticated owner');
assert.ok(chunkMigration.includes('nexus_guard_chunked_snapshot_update') && chunkMigration.includes("ERRCODE = '55000'"), 'legacy clients must be prevented from overwriting a published chunk manifest');
const syncDiagnosticSummary=section(cloudSync,'function syncDiagSummary(payload){','function syncDiag(stage,payload,extra){','sync diagnostic summary');
assert.ok(syncDiagnosticSummary.includes('totalRecordCount') && syncDiagnosticSummary.includes('topicCount') &&
  !syncDiagnosticSummary.includes('JSON.stringify(payload)') &&
  !syncDiagnosticSummary.includes('serializedPayloadCharacters') &&
  !syncDiagnosticSummary.includes('serializedPayloadUtf8Bytes'),
  'sync diagnostics must use aggregate record counts and avoid a second full-workspace serialization allocation');
assert.ok(cloudSync.includes('Enable sync diagnostics') && cloudSync.includes('Download sync diagnostics (safe summary)') &&
  cloudSync.includes('workspace-merge-normalize-error') && cloudSync.includes('workspace-merge-commit-error'),
  'users must be able to enable/download safe diagnostics and the reconciliation failure stages must be captured');
assert.ok(cloudSync.includes('scheduleRetry();localStorage.setItem(OWNER_KEY,newUserId);lastUserId=newUserId;return;'), 'transient merge-verification races must use bounded automatic retry');
assert.ok(cloudSync.includes('sameWorkspace(remoteData,pendingForUser.payload)'), 'routine conflict detection must compare workspace contents, not exported-at metadata');
assert.ok(cloudSync.includes('function nextCloudStamp(previous)') && cloudSync.includes('policy.nextRevisionStamp(previous)'), 'revision creation must prevent same-millisecond writes from reusing a compare-and-swap version');
assert.ok(cloudSync.includes('reconcileOwnedWorkspace(newUserId,localPayload,remote)'), 'same-account stale workspace with no pending queue must load cloud or enter automatic merge, not the account-choice dialog');
assert.ok(cloudSync.includes('base&&typeof base.serverVersion===\'string\'?base.serverVersion:null'), 'recovery of unqueued local edits must use the base revision, not the just-fetched cloud revision');
assert.ok(cloudSync.includes('function downloadConflictRecovery()'), 'users must be able to download archived same-account conflict alternatives');
assert.ok(cloudSync.includes('queue.getConflictHistory(localStorage,owner)'), 'the conflict-recovery export must retrieve history for the selected account only');
assert.ok(cloudSync.includes('Download sync conflict recovery'), 'the user-facing recovery download control must be labelled clearly');
assert.ok(cloudSync.includes('conflicts:result.conflicts') && cloudSync.includes('queue.rebaseWithBase('), 'conflicting field values and merged workspace must be persisted before cloud overwrite is attempted');


assert.ok(appSource.includes('window.NexusFeatureStorageKey=FEATURE_KEY;'), 'expose the Study Hub storage key for shared transactions');
assert.ok(appSource.includes('window.NexusOfflineSyncQueue.commitWorkspace(localStorage'), 'tracker and Study Hub writes must atomically persist their account-bound pending snapshot');
assert.ok(cloudSync.includes("window.NexusOfflineSyncQueue.rebase(localStorage,newUserId,snapshot(),lastRemoteStamp,'user-merge')"), 'an explicit merge must rebase the pending snapshot on the observed cloud revision');
assert.ok(appSource.includes('fsrs:window.NexusBackupRestoreUtils.sanitizeFsrsCard(t.fsrs)'), 'topic normalization must preserve validated FSRS memory state from full backups');
assert.ok(appSource.includes('window.NexusNormalizeFeatureState=value=>'), 'cloud data must use the shared Study Hub normalizer');
assert.ok(appSource.includes('window.NexusMergeFeatureState=(current,imported,rawImported)=>'), 'cloud data must use the shared Study Hub merge helper');

const restore = section(studyHub, 'async function restoreOrMerge(file){', 'function formatElapsed(ms)', 'JSON restore');
const restoreCommit = restore.indexOf('NexusOfflineSyncQueue.commitWorkspace(localStorage,');
const repairImportedState = restore.indexOf('window.NexusRepairCurriculumState(nextState)');
const serializeImportedState = restore.indexOf('const serializedState=JSON.stringify(nextState);');
const restoreAssignment = restore.indexOf('state=nextState;');
assert.ok(restore.includes('window.NexusBackupRestoreUtils.validateBackupState(raw)'), 'validate backup records before normalization can silently discard malformed entries');
assert.ok(appSource.includes('const csvCell=v=>window.NexusBackupRestoreUtils.csvCell(v);') && appSource.includes('function csvCellHub(v){return window.NexusBackupRestoreUtils.csvCell(v);}') && appSource.includes('row.map(value=>window.NexusBackupRestoreUtils.csvCell(value))'), 'all tracker, Study Hub, and analytics CSV exports must share formula-safe cell encoding');
assert.ok(restoreCommit >= 0 && restoreAssignment > restoreCommit, 'persist both backup sections before replacing in-memory app state');
assert.ok(repairImportedState >= 0 && serializeImportedState > repairImportedState && restoreCommit > serializeImportedState, 'repair inferred curriculum install intent before serializing and queueing a restored workspace');
assert.ok(restore.includes('window.NexusCloudSync.schedule()'), 'schedule cloud sync only after a successful restore commit');
const backupPayloadSource = section(studyHub, 'function backupPayload(){', 'function fullBackup()', 'schema 4 full backup export');
assert.ok(backupPayloadSource.includes("schema:4,exportedAt:new Date().toISOString(),state:backupState,featureState:fsState,syncMetadata:syncStatus"), 'full backups must include schema 4, Study Hub state, and account-bound queue metadata without importing the queue itself');
assert.ok(backupPayloadSource.includes('window.NexusRepairCurriculumState(state)') &&
  appCore.includes('const streams=raw.streams.filter(s=>s&&s.id&&s.name).map(s=>') &&
  appCore.includes('const subjects=raw.subjects.filter(s=>s&&s.id&&s.name).map((s,i)=>') &&
  appCore.includes('const topics=raw.topics.filter(t=>t&&t.name).map(t=>normalizeTopic') &&
  appCore.includes('const cleanHistory=Array.isArray(raw.history)?raw.history.slice(0,200000).map('),
  'full backups must infer curriculum intent on freshly normalized workspace records without mutating the live workspace or adding a redundant full JSON clone');
assert.ok(appCore.includes("if(typeof window.NexusExportFullBackup==='function'){window.NexusExportFullBackup();return;}"), 'the main Backup button and menu must delegate to the same schema-4 full backup exporter');
assert.ok(studyHub.includes('window.NexusCreateBackupPayload=backupPayload;') && studyHub.includes('window.NexusExportFullBackup=fullBackup;'), 'Study Hub must expose the canonical complete backup payload and export action');
assert.ok(!appCore.includes("schema:3,exportedAt:new Date().toISOString(),state}"), 'the main backup path must not emit the obsolete schema-3 tracker-only packet');
assert.ok(restore.includes("{key:'nexus.fsrs.cards.v1',value:serializedCards}") && restore.includes("{key:'nexus.fsrs.settings.v1',value:serializedFsrsSettings}"), 'restore must atomically align both FSRS cache keys with the restored tracker and Study Hub payload');
assert.ok(restore.includes('window.NexusFSRS.setSettings(nextFeatures.fsrsSettings,{syncFeature:false,persist:false})'), 'restore must activate imported FSRS settings immediately, without a second independent write');
assert.ok(cloudSync.includes("{key:'nexus.fsrs.cards.v1',value:JSON.stringify(Object.fromEntries((safeState.topics||[]).filter(topic=>topic&&topic.fsrs).map(topic=>[String(topic.id),topic.fsrs])))}"), 'cloud hydration must align its compatibility FSRS cache to the authoritative topic memory state');
const completeResetSection = section(studyHub, 'resetAll=async function(){', '// Gentle reminder check', 'complete tracker and Study Hub reset');
assert.ok(completeResetSection.includes("reason:'manual-reset'") && completeResetSection.includes('archivePending:true'), 'reset must archive an older unsynced snapshot before queuing the empty workspace');
assert.ok(completeResetSection.includes("{key:'nexus.fsrs.cards.v1',value:'{}'}") && completeResetSection.includes('nexus.fsrs.settings.v1') && completeResetSection.includes('window.NexusFSRS.setSettings'), 'reset must clear cached FSRS cards and restore default scheduler preferences');
assert.ok(completeResetSection.includes('await storage.flush()') && completeResetSection.includes('window.NexusCloudSync.schedule()'), 'reset must await durable local writes before scheduling cloud propagation');
assert.ok(appCore.includes("$('resetBtn').addEventListener('click',()=>{refreshDeletionChoiceUi();$('workspaceDeletionDialog').showModal();});") && appCore.includes("$('workspaceResetOnlyBtn').addEventListener('click',()=>{$('workspaceDeletionDialog').close();resetAll();});"), 'the existing Danger Zone button must open the deletion choice and preserve its separate workspace-only reset action');
assert.ok(index.includes('the empty workspace syncs to your cloud account') && index.includes('Restore lets you choose REPLACE') && index.includes('durable local copy on this device'), 'storage, restore, and workspace-only deletion UI help must reflect actual workspace behavior');
assert.ok(!index.includes('does not automatically sync between devices') && !index.includes('This is a simple scheduler, not FSRS.'), 'the setup copy must not retain contradictory sync or legacy scheduler claims');
const dangerScreen = section(index, '<div id="dangerZoneStandalone"', '<dialog id="reviewDialog">', 'Danger Zone screen');
const setupView = section(index, '<section class="view" id="view-setup">', '<!-- RECALL STUDY HUB ADDON START -->', 'settings view');
assert.ok(index.includes('Danger Zone: Review History / Data Deletion'), 'the Danger Zone entry must identify review-history, workspace, and account deletion actions');
assert.ok(dangerScreen.includes('Every saved review is an input to your rating graphs, review counts, averages and detailed PDF/CSV history. Deleting one entry removes that event from future analytics. Clearing all history removes every saved review event.') && dangerScreen.includes('Topic schedules and next-due dates may remain unchanged.</strong> Use Undo immediately after an accidental deletion, or restore a backup that contains the records. Do not delete history just to reset a chart.'), 'the existing red Review History warning copy must remain unchanged');
assert.ok(!setupView.includes('id="resetBtn"'), 'the workspace reset button must no longer appear in Settings');
const historySectionEnd = dangerScreen.indexOf('</section>', dangerScreen.indexOf('<section id="view-history"'));
const resetSectionStart = dangerScreen.indexOf('<section class="danger-account-reset-section"');
const resetWarning = dangerScreen.indexOf('id="dangerAccountResetWarningTitle"');
const resetCard = dangerScreen.indexOf('id="resetBtn"');
assert.ok(historySectionEnd >= 0 && resetSectionStart > historySectionEnd && resetWarning > resetSectionStart && resetCard > resetWarning, 'the deletion section and its dedicated warning must follow and remain separate from Review History');
assert.ok(dangerScreen.includes('id="workspaceDeletionDialog"') && dangerScreen.includes('id="workspaceResetOnlyBtn"') && dangerScreen.includes('id="accountDeleteChoiceBtn"'), 'the existing Danger Zone entry must provide distinct workspace-only and account-and-workspace deletion choices');
assert.ok(dangerScreen.includes('Neither option can remotely erase offline copies on other devices') && dangerScreen.includes('Your account and sign-in remain active'), 'deletion warnings must distinguish workspace-only reset from permanent account deletion and disclose other-device copies');
assert.ok(restore.includes("archivePending:mode==='REPLACE'"), 'replace restore must archive the prior pending snapshot after explicit confirmation');

const cloud = section(cloudSync, 'function applyWorkspaceSnapshot(nextState,rawFeatures,ownerId){', 'async function initializeSession(s)', 'cloud workspace hydration');
const cloudCommit = cloud.indexOf('commitLocalStorageAtomically(localStorage,entries)');
const cloudCompact = cloud.indexOf('window.NexusOfflineSyncQueue.compactMetadata(localStorage)');
assert.ok(cloudCompact >= 0 && cloudCommit > cloudCompact, 'compact legacy sync snapshots before cloud hydration writes the restored workspace');

const cloudAssignment = cloud.indexOf('state=safeState;');
assert.ok(cloudCommit >= 0 && cloudAssignment > cloudCommit, 'persist cloud workspace before replacing in-memory state');
assert.ok(cloud.includes('entries.push({key:OWNER_KEY,value:String(ownerId)})'), 'account owner marker shares the workspace transaction');
assert.ok(cloud.includes('function applyRemote(payload,ownerId,serverVersion)'), 'cloud hydration accepts an account owner and the matching cloud revision to commit atomically');
assert.ok(cloud.includes('window.NexusMergeFeatureState(localFeatures,remoteFeatures,{})'), 'local/cloud merges must preserve non-conflicting Study Hub records while local values win conflicts');
assert.ok(cloud.includes('window.NexusSetFeatureState(nextFeatures,{persist:false,render:false})'), 'hydration does not perform a second, independent feature-state write');
assert.ok(cloud.includes('function resetToEmpty(ownerId){') && cloud.includes('applyWorkspaceSnapshot(emptyState(),{},ownerId)'), 'new-account reset commits the owner marker with the empty workspace');
assert.ok(cloudSync.includes('resetToEmpty(newUserId)'), 'account switching must pass the new owner into every clean-workspace reset');
assert.ok(cloudSync.includes('if(owner&&owner!==newUserId){'), 'only a workspace already owned by another account may bypass the data-choice flow');
assert.ok(cloudSync.includes('if(localHasWork){') && cloudSync.includes('let choice=await chooseLocalData();') && cloudSync.includes("status('Data choice required')"), 'unassigned offline work must enter the explicit three-way choice before account initialization can replace it');
assert.ok(cloudSync.includes('applyWorkspaceSnapshot(normalizeState(localPayload.state),window.NexusNormalizeFeatureState(localPayload.featureState||{}),newUserId);owner=newUserId;'), 'the selected offline workspace must be assigned to the account atomically before merge or upload');
assert.ok(cloudSync.includes('function enqueueInitialSnapshot(ownerId)') && (cloudSync.match(/enqueueInitialSnapshot\(newUserId\)/g)||[]).length>=3, 'new-account initial state must be queued before cloud insert for lost-response recovery');
assert.ok(cloudSync.includes('The cloud backup was not rewritten.'), 'loading an existing cloud copy must not needlessly update its remote revision');
assert.ok(cloudSync.includes('applyRemote(remote.payload,newUserId,remote.updated_at||null)'), 'account switch passes the active user and matching cloud revision into atomic hydration');
const upload = section(cloudSync, 'async function upload(){', 'function schedule(){', 'account-bound upload');
assert.ok(upload.includes('queue.getPending(localStorage,uploadUserId)'), 'cloud upload must drain only the pending snapshot for the active account');
assert.ok(upload.includes('localStorage.getItem(OWNER_KEY)!==uploadUserId'), 'cloud writes must stop if the persisted workspace owner differs from the active account');
assert.ok(upload.includes('pending.baseServerVersion'), 'queued writes must compare against their captured base revision');
assert.ok(upload.includes('queue.acknowledge(localStorage,uploadUserId,pending.operationId'), 'queue entries are acknowledged only after a matching remote snapshot is verified');
assert.ok(upload.includes('queue.rebase(localStorage,uploadUserId,snapshot(),lastRemoteStamp'), 'a newer local snapshot created during an upload must remain queued and be rebased after verification');
assert.ok(upload.includes('const actualStamp=before&&before.updated_at?before.updated_at:null;'), 'queued writes must check the latest remote revision before attempting a write');
assert.ok(cloudSync.includes("status('Cloud conflict')") && cloudSync.includes("ready=false;status('Cloud conflict')"), 'a detected cloud conflict must pause automatic uploads');
assert.ok(cloudSync.includes("conflict.code='NEXUS_CLOUD_CONFLICT'"), 'verification mismatches must be treated as cloud conflicts');
assert.ok(cloudSync.includes("else{ready=false;status('Sync error')"), 'transient cloud failures must expose an error state while automatic retry preserves pending data');

const accountChoice = section(cloudSync, 'async function initializeSession(s){', 'async function sameWorkspace(a,b)', 'account-choice cancellation safeguards');
const destructiveChoiceGuard = accountChoice.indexOf("while(choice==='replace-cloud'||choice==='replace'){");
const choiceExecution = accountChoice.indexOf("if(choice==='merge'){");
assert.ok(destructiveChoiceGuard >= 0 && choiceExecution > destructiveChoiceGuard, 'confirm destructive account choices before applying or uploading workspace data');
const destructiveGuard = accountChoice.slice(destructiveChoiceGuard, choiceExecution);
assert.ok(destructiveGuard.includes("choice=await chooseLocalData();"), 'cancelling a destructive confirmation must reopen the three-way account choice');
assert.ok(destructiveGuard.includes('Your offline data has not been changed.'), 'cancellation must explicitly preserve the offline workspace');
assert.ok(destructiveGuard.includes('Unsynced local changes that are not in the cloud will be lost.'), 'replacing local data with cloud data must warn about unsynced local changes');
assert.ok(destructiveGuard.includes('no cloud backup is available to restore it.'), 'starting clean without a cloud backup must warn about local data loss');
assert.ok(!destructiveGuard.includes('applyRemote(') && !destructiveGuard.includes('resetToEmpty(') && !destructiveGuard.includes('upload()'), 'cancelling must not apply cloud data, clear local data, or upload anything');
assert.ok(!accountChoice.includes('Cloud replacement cancelled; the account cloud data was loaded.'), 'cancelled cloud replacement must never silently replace local data');
assert.ok(accountChoice.includes('lastRemoteStamp=remote&&remote.payload?remote.updated_at:null;'), 'confirmed cloud replacement must retain the observed revision for conditional writes');
assert.ok(accountChoice.includes("if(choice==='merge'){lastRemoteStamp=remote&&remote.payload?remote.updated_at:null;await applyLocalMerged("), 'merging with an existing cloud backup must use the fetched revision for a conditional write');

assert.ok(serviceWorker.includes("const CACHE_PREFIX='nexus-rating-analytics-';") && serviceWorker.includes("const CACHE_NAME=CACHE_PREFIX+'v32';"), 'cache version must advance after updating the Danger Zone deletion flow');
assert.ok(serviceWorker.includes("'./nexus-storage.js'") && serviceWorker.includes("'./nexus-app-bootstrap.js'") && serviceWorker.includes("'./nexus-app-inline.js'") && serviceWorker.includes("'./app-core.js'") && serviceWorker.includes("'./study-hub.js'") && serviceWorker.includes("'./explore-curriculum.js'") && serviceWorker.includes("'./backup-restore-utils.js'") && serviceWorker.includes("'./offline-sync-queue.js'") && serviceWorker.includes("'./workspace-isolation-guard.js'") && serviceWorker.includes("'./nexus-build-config.js'") && serviceWorker.includes("'./cloud-sync-recovery.js'") && serviceWorker.includes("'./cloud-sync.js'"), 'offline app shell must cache the storage bootstrap and dependent app scripts');
const networkFirstSources = serviceWorker.split('const networkFirst=')[1]?.split(';')[0] || '';
assert.ok(networkFirstSources.includes("url.pathname.endsWith('/nexus-storage.js')") && networkFirstSources.includes("url.pathname.endsWith('/nexus-app-bootstrap.js')") && networkFirstSources.includes("url.pathname.endsWith('/nexus-app-inline.js')") && networkFirstSources.includes("url.pathname.endsWith('/app-core.js')") && networkFirstSources.includes("url.pathname.endsWith('/study-hub.js')") && networkFirstSources.includes("url.pathname.endsWith('/explore-curriculum.js')") && networkFirstSources.includes("url.pathname.endsWith('/backup-restore-utils.js')") && networkFirstSources.includes("url.pathname.endsWith('/offline-sync-queue.js')") && networkFirstSources.includes("url.pathname.endsWith('/workspace-isolation-guard.js')") && networkFirstSources.includes("url.pathname.endsWith('/fsrs-bundle.js')") && networkFirstSources.includes("url.pathname.endsWith('/nexus-build-config.js')") && networkFirstSources.includes("url.pathname.endsWith('/cloud-sync-recovery.js')") && networkFirstSources.includes("url.pathname.endsWith('/cloud-sync.js')"), 'critical storage/bootstrap/FSRS scripts must revalidate online and fall back to cache offline');
assert.ok(workflow.includes('node scripts/test-offline-sync-queue.mjs') && workflow.includes('node scripts/test-cloud-sync-recovery.mjs') && workflow.includes('node scripts/test-workspace-isolation-guard.mjs') && workflow.includes('node scripts/test-data-safety-wiring.mjs'), 'CI must run the queue and integration-wiring checks');


const isolationOverlayAt = index.indexOf('id="workspaceIsolationLock"');
assert.ok(isolationOverlayAt >= 0 && runtimeAssets[0] === 'workspace-isolation-guard.js', 'install the workspace isolation guard before any app module can hydrate local data');
assert.ok(index.includes('data-workspace-auth="pending"') && index.includes('html[data-workspace-auth="pending"] .app { visibility: hidden !important; }'), 'hide the app from the first paint until account ownership is resolved');
assert.ok(index.includes('<div id="workspaceIsolationLock" aria-hidden="false" role="dialog"'), 'the isolation overlay must be visible in the initial HTML, before JavaScript loads');
assert.ok(appSource.includes('aria-modal="true"') && appSource.includes('workspaceIsolationSignOut') && appSource.includes('workspaceIsolationSignInGoogle') && appSource.includes('workspaceIsolationSignInEmail'), 'the isolation overlay must provide safe account recovery actions');
assert.ok(!appSource.includes('workspaceIsolationRetry') && !guard.includes('location.reload'), 'account recovery must not restart the vulnerable page-load sequence');
assert.ok(guard.includes('LAST_AUTH_KEY') && guard.includes('offline-mismatch') && guard.includes('offline-unassigned'), 'confirmed sign-out must not reveal a workspace owned by a different or unassigned account');

assert.ok(cloudSync.includes("if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',startCloudSyncUi,{once:true});else startCloudSyncUi();"), 'cloud sync must initialize controls whether its deferred module loads before or after DOMContentLoaded');
console.log('Data-safety integration wiring checks passed.');
