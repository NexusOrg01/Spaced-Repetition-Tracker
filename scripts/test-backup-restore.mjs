import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const require = createRequire(import.meta.url);
const {
  validateBackupState,
  sanitizeFocusState,
  sanitizeFsrsCard,
  normalizeFsrsSettings,
  normalizeFeatureState,
  mergeFeatureState,
  resolveReplaceFeatureState,
  commitLocalStorageAtomically,
  writeCloudSnapshot,
  csvCell,
  parseCsv
} = require('../backup-restore-utils.js');

const focusStart = '2026-10-19T10:00:00.000Z';
const focusPause = '2026-10-19T10:05:00.000Z';
assert.deepEqual(sanitizeFocusState({
  focusStartedAt: focusStart,
  focusPausedAt: focusPause,
  focusTopicId: 'topic-1',
  focusSubjectId: 'subject-1'
}), {
  focusStartedAt: focusStart,
  focusActualStartedAt: focusStart,
  focusPausedAt: focusPause,
  focusTopicId: 'topic-1',
  focusSubjectId: 'subject-1'
});
assert.deepEqual(sanitizeFocusState({ focusStartedAt: 'not-a-date', focusPausedAt: focusPause }), {
  focusStartedAt: null, focusActualStartedAt: null, focusPausedAt: null, focusTopicId: '', focusSubjectId: ''
}, 'invalid local timer timestamps must not poison app startup');
assert.equal(sanitizeFocusState({ focusStartedAt: focusStart, focusPausedAt: '2026-10-19T09:59:00.000Z' }).focusPausedAt,
  null, 'a pause timestamp earlier than the session start must be cleared');
assert.equal(sanitizeFocusState({ focusStartedAt: focusStart, focusPausedAt: null }).focusPausedAt, null,
  'an active timer must remain active when no pause timestamp is present');

const validBackup = {
  schema: 4,
  streams: [{ id: 's1', name: 'Commerce' }],
  subjects: [{ id: 'sub1', name: 'Economics', streamId: 's1' }],
  topics: [{ id: 't1', name: 'Demand', subjectId: 'sub1' }],
  history: [],
  exams: [],
  settings: { theme: 'system' }
};
assert.equal(validateBackupState(validBackup), validBackup, 'valid full backups should be accepted');
assert.throws(() => validateBackupState({ state: 'not a Nexus backup' }), /recognized Nexus backup/);
assert.throws(() => validateBackupState({ ...validBackup, topics: [{ name: 'Demand', subjectId: 'sub1' }] }), /malformed record/);
assert.throws(() => validateBackupState({ ...validBackup, settings: [] }), /settings.*must be an object/);
assert.throws(() => validateBackupState({ ...validBackup, history: 'not an array' }), /must be an array/);
assert.throws(() => validateBackupState({ ...validBackup, exams: [null] }), /malformed record/);

const fsrsCard = {
  stability: 42.5, difficulty: 6.2, reps: 8, lapses: 1,
  lastReview: '2026-10-18T00:00:00.000Z', due: '2026-11-01', intervalDays: 14
};
assert.deepEqual(sanitizeFsrsCard(fsrsCard), fsrsCard,
  'valid FSRS memory state must survive backup normalization exactly');
assert.equal(sanitizeFsrsCard({ stability: 0, difficulty: 5 }), undefined,
  'invalid FSRS memory cards must be discarded safely');
assert.deepEqual(sanitizeFsrsCard({
  stability: 999999, difficulty: 100, reps: -2, lapses: 'bad',
  lastReview: 'not-a-date', due: null, intervalDays: 999999
}), {
  stability: 36500, difficulty: 10, reps: 0, lapses: 0,
  lastReview: null, due: null, intervalDays: 36500
}, 'FSRS card values must be bounded and malformed dates sanitized');

const defaults = {
  version: 1,
  fsrsSettings: { request_retention: 0.9, maximum_interval: 120, enable_fuzz: false, w: null },
  settings: {
    dailyMinutes: 90, sessionMinutes: 25, scheduler: 'classic', weeklyReviewGoal: 100,
    backlogDays: 7, reminders: false, reminderTime: '08:00', maxInterval: 120,
    finalRevision: false, workloadDays: 7
  },
  syllabusTargets: {}, taskChecks: {}, journal: [], papers: [], goals: [], studyLogs: [],
  selectedTopicIds: [], lastBackupAt: '', lastReminderAt: '', focusStartedAt: null,
  focusActualStartedAt: null, focusPausedAt: null, focusTopicId: '', focusSubjectId: ''
};

const customFsrs = normalizeFsrsSettings({
  enabled: false, request_retention: 0.995, maximum_interval: 999,
  enable_fuzz: true, w: Array.from({ length: 21 }, (_, index) => index - 10)
}, defaults.fsrsSettings);
assert.equal(Object.hasOwn(customFsrs, 'enabled'), false, 'legacy enabled flags must be ignored; FSRS is always the active scheduler');
assert.equal(customFsrs.request_retention, 0.97, 'FSRS retention should be bounded');
assert.equal(customFsrs.maximum_interval, 120, 'FSRS max interval should respect the app limit');
assert.equal(customFsrs.enable_fuzz, true);
assert.equal(customFsrs.w.length, 21, 'valid custom FSRS weights should be preserved');
assert.throws(() => normalizeFsrsSettings([], defaults.fsrsSettings), /fsrsSettings.*must be an object/);
assert.throws(() => normalizeFsrsSettings({ w: [1, 2, 3] }, defaults.fsrsSettings), /must be null or contain 21 finite weights/);

const normalized = normalizeFeatureState({
  settings: { dailyMinutes: 999999, reminders: true, scheduler: 'unexpected', reminderTime: '99:99' },
  journal: [{ id: 'j1', text: 'review note' }],
  studyLogs: [{ minutes: 25 }],
  syllabusTargets: { subjectA: 12 },
  taskChecks: { '2026-10-19': ['taskA', 'taskA', 7] },
  selectedTopicIds: ['topicA', 7]
}, defaults);
assert.equal(normalized.settings.dailyMinutes, 1440, 'numeric settings should be bounded');
assert.equal(normalized.settings.reminders, true);
assert.equal(normalized.settings.scheduler, 'classic', 'unknown scheduler values should fall back safely');
assert.equal(normalized.settings.reminderTime, '08:00', 'invalid reminder times should fall back safely');
assert.equal(normalizeFeatureState({ settings: { reminderTime: '09:30' } }, defaults).settings.reminderTime, '09:30', 'valid reminder times should be preserved');
assert.equal(normalized.journal[0].id, 'j1');
assert.equal(normalized.studyLogs[0].id, 'studyLogs-restored-0', 'legacy feature records should receive stable IDs');
assert.deepEqual(normalized.taskChecks['2026-10-19'], ['taskA', '7']);
assert.deepEqual(normalized.selectedTopicIds, ['topicA', '7']);
assert.deepEqual(normalized.fsrsSettings, defaults.fsrsSettings, 'FSRS preferences should be present in every normalized full workspace');
assert.deepEqual(normalizeFeatureState({ fsrsSettings: customFsrs }, defaults).fsrsSettings, customFsrs, 'FSRS preferences should round-trip through the backup normalizer');
assert.throws(() => normalizeFeatureState({ fsrsSettings: null }, defaults), /fsrsSettings.*must be an object/);
assert.throws(() => normalizeFeatureState({ journal: {} }, defaults), /must be an array/);
assert.throws(() => normalizeFeatureState({ journal: null }, defaults), /must be an array/, 'explicit null must not silently clear journal data');
assert.throws(() => normalizeFeatureState({ settings: null }, defaults), /settings must be an object/);
assert.throws(() => normalizeFeatureState({ taskChecks: null }, defaults), /must be an object/);
assert.throws(() => normalizeFeatureState({ selectedTopicIds: null }, defaults), /must be an array/);
assert.throws(() => normalizeFeatureState({ taskChecks: { today: true } }, defaults), /task checklist/);
assert.throws(() => normalizeFeatureState({ settings: [] }, defaults), /settings must be an object/);
assert.throws(() => normalizeFeatureState(null, defaults), /Study Hub section must be an object/);

const localHubForLegacyRestore = {
  ...defaults,
  settings: { ...defaults.settings, reminders: true },
  journal: [{ id: 'local-only', text: 'keep this record' }]
};
const legacyReplaceFeatures = resolveReplaceFeatureState(
  false, localHubForLegacyRestore, normalizeFeatureState(undefined, defaults), defaults
);
assert.equal(legacyReplaceFeatures.settings.reminders, true,
  'replacing from a legacy backup without Study Hub data must preserve current Study Hub settings');
assert.deepEqual(legacyReplaceFeatures.journal.map(row => row.id), ['local-only'],
  'replacing from a legacy backup must not silently erase Study Hub records that were not in that backup');
const fullReplaceFeatures = resolveReplaceFeatureState(
  true, localHubForLegacyRestore, { ...defaults, journal: [{ id: 'backup-only', text: 'from backup' }] }, defaults
);
assert.deepEqual(fullReplaceFeatures.journal.map(row => row.id), ['backup-only'],
  'a full backup that includes Study Hub state must still replace Study Hub records exactly');

const merged = mergeFeatureState(
  { ...defaults, settings: { ...defaults.settings, reminders: true }, journal: [{ id: 'same', text: 'local' }] },
  { ...defaults, settings: { ...defaults.settings, reminders: false }, journal: [{ id: 'same', text: 'imported' }, { id: 'new', text: 'new' }] },
  defaults,
  { settings: { reminders: false } }
);
assert.equal(merged.journal.length, 2, 'merge should deduplicate records by ID');
assert.equal(merged.journal[0].text, 'local', 'local data should win when IDs collide');
assert.equal(merged.settings.reminders, false, 'explicit imported settings should be applied');
const currentScheduler = { ...defaults.fsrsSettings };
const importedScheduler = { ...defaults.fsrsSettings, enabled: false, request_retention: 0.8 };
assert.deepEqual(mergeFeatureState({ ...defaults, fsrsSettings: currentScheduler }, { ...defaults, fsrsSettings: importedScheduler }, defaults, {}).fsrsSettings, currentScheduler, 'a merge must keep local FSRS preferences when the import does not explicitly include them');
assert.deepEqual(mergeFeatureState({ ...defaults, fsrsSettings: currentScheduler }, { ...defaults, fsrsSettings: importedScheduler }, defaults, { fsrsSettings: importedScheduler }).fsrsSettings, { ...defaults.fsrsSettings, request_retention: 0.8 }, 'explicit imported FSRS tuning should be merged while the retired enabled flag is ignored');
assert.ok(merged.settings.dailyMinutes === defaults.settings.dailyMinutes);

class MemoryStorage {
  constructor(initial, failKey = 'feature') { this.values = new Map(Object.entries(initial)); this.failOnce = true; this.failKey = failKey; }
  getItem(key) { return this.values.has(key) ? this.values.get(key) : null; }
  setItem(key, value) {
    if (key === this.failKey && this.failOnce) { this.failOnce = false; throw new Error('simulated quota failure'); }
    this.values.set(key, String(value));
  }
  removeItem(key) { this.values.delete(key); }
}
const storage = new MemoryStorage({ state: 'old-state', feature: 'old-feature', owner: 'old-owner' }, 'owner');
assert.throws(() => commitLocalStorageAtomically(storage, [
  { key: 'state', value: 'new-state' },
  { key: 'feature', value: 'new-feature' },
  { key: 'owner', value: 'new-owner' }
]), error => error.rollbackSucceeded === true && /previous saved data has been restored/.test(error.message));
assert.equal(storage.getItem('state'), 'old-state', 'partial restore should roll the main data back');
assert.equal(storage.getItem('feature'), 'old-feature', 'partial restore should preserve feature data');
assert.equal(storage.getItem('owner'), 'old-owner', 'failed account switch should restore the previous owner marker');

const successStorage = new MemoryStorage({});
successStorage.failOnce = false;
assert.equal(commitLocalStorageAtomically(successStorage, [
  { key: 'state', value: 'new-state' }, { key: 'feature', value: 'new-feature' }, { key: 'owner', value: 'new-owner' }
]), true);
assert.equal(successStorage.getItem('state'), 'new-state');
assert.equal(successStorage.getItem('feature'), 'new-feature');
assert.equal(successStorage.getItem('owner'), 'new-owner');

const parsedCsv = parseCsv('\uFEFFStream,Subject,Topic,Notes\r\nCommerce,Economics,"Demand, supply","Quoted ""idea""\r\ncontinued"\r\n');
assert.deepEqual(parsedCsv, [
  ['Stream', 'Subject', 'Topic', 'Notes'],
  ['Commerce', 'Economics', 'Demand, supply', 'Quoted "idea"\r\ncontinued']
], 'CSV parser should handle BOMs, commas, escaped quotes, multiline cells, and CRLF');
assert.throws(() => parseCsv('Topic,Notes\n"Unclosed,field'), /was not closed/);
assert.throws(() => parseCsv('Topic\nDemand "curve'), /quote inside an unquoted field/);
assert.throws(() => parseCsv('Topic\n"closed"x'), /unexpected character after a quoted field/);
assert.throws(() => parseCsv('Topic\n' + 'x'.repeat(10001)), /field longer than 10,000/);
assert.throws(() => parseCsv(Array(66).fill('x').join(',')), /more than 64 columns/);
assert.throws(() => parseCsv('Topic\n' + 'row\n'.repeat(10001)), /more than 10,000 data rows/);

assert.equal(csvCell('ordinary text'), '"ordinary text"');
assert.equal(csvCell('He said "yes"'), '"He said ""yes"""');
assert.equal(csvCell('=1+1'), '"\'=1+1"', 'formula-leading cells must be exported as text');
assert.equal(csvCell('  =HYPERLINK("https://example.invalid")'), '"\'  =HYPERLINK(""https://example.invalid"")"',
  'leading whitespace must not bypass spreadsheet formula protection');
assert.equal(csvCell('+cmd'), '"\'+cmd"');
assert.equal(csvCell('-1+2'), '"\'-1+2"');
assert.equal(csvCell('@SUM(A1:A2)'), '"\'@SUM(A1:A2)"');
assert.equal(csvCell('safe, comma'), '"safe, comma"');

function mockCloudClient(result) {
  const calls = [];
  const client = {
    from(table) {
      calls.push({ kind: 'from', table });
      return {
        update(values) {
          calls.push({ kind: 'update', values });
          const query = {
            eq(column, value) { calls.push({ kind: 'eq', column, value }); return query; },
            select(columns) { calls.push({ kind: 'select', columns }); return Promise.resolve(result); }
          };
          return query;
        },
        insert(values) {
          calls.push({ kind: 'insert', values });
          return { select(columns) { calls.push({ kind: 'select', columns }); return Promise.resolve(result); } };
        }
      };
    }
  };
  return { client, calls };
}
const updatedCloud = mockCloudClient({ data: [{ updated_at: 'new-stamp' }], error: null });
assert.deepEqual(
  await writeCloudSnapshot(updatedCloud.client, 'user-1', { state: {} }, 'old-stamp', 'new-stamp'),
  { updated_at: 'new-stamp' }
);
assert.ok(updatedCloud.calls.some(call => call.kind === 'update'), 'existing cloud rows must use conditional UPDATE, not upsert');
assert.ok(updatedCloud.calls.some(call => call.kind === 'eq' && call.column === 'updated_at' && call.value === 'old-stamp'), 'updates must compare against the last observed timestamp');

const insertedCloud = mockCloudClient({ data: [{ updated_at: 'first-stamp' }], error: null });
await writeCloudSnapshot(insertedCloud.client, 'user-2', { state: {} }, null, 'first-stamp');
assert.ok(insertedCloud.calls.some(call => call.kind === 'insert'), 'new cloud rows must use INSERT so a race cannot overwrite an existing row');

const staleCloud = mockCloudClient({ data: [], error: null });
await assert.rejects(
  writeCloudSnapshot(staleCloud.client, 'user-1', { state: {} }, 'stale-stamp', 'new-stamp'),
  error => error.code === 'NEXUS_CLOUD_CONFLICT'
);
const racedInsert = mockCloudClient({ data: null, error: { code: '23505', message: 'duplicate key' } });
await assert.rejects(
  writeCloudSnapshot(racedInsert.client, 'user-1', { state: {} }, null, 'new-stamp'),
  error => error.code === 'NEXUS_CLOUD_CONFLICT'
);


const studyHubSource=readFileSync(new URL('../study-hub.js',import.meta.url),'utf8');
const exportStart=studyHubSource.indexOf('  function csvCellHub(v){');
const exportEnd=studyHubSource.indexOf('  function parseCsvHub(text){',exportStart);
assert.ok(exportStart>=0&&exportEnd>exportStart,'Study Hub CSV export functions must remain testable');
const exportedFiles=[],exportMessages=[];
const exportSandbox={
 window:{NexusBackupRestoreUtils:{csvCell}},
 fsState:{selectedTopicIds:['topic-export']},
 state:{topics:[{
  id:'topic-export',name:'Demand, supply',notes:'=1+1',lastReviewed:'2026-05-01',
  lastRating:5,dueDate:'2026-05-08',reviewCount:4
 }]},
 today:()=> '2026-11-16',
 subjectDisplay:()=>({stream:'Commerce',subject:'Economics'}),
 status:()=> 'due',
 downloadBlob:(filename,text,type)=>exportedFiles.push({filename,text,type}),
 notify:message=>exportMessages.push(String(message))
};
vm.runInNewContext(
 studyHubSource.slice(exportStart,exportEnd)+'\nthis.runHubExport=exportHubCsv;',
 exportSandbox
);
exportSandbox.runHubExport('selected');
assert.equal(exportedFiles.length,1,'selected-topic CSV export must generate one download');
assert.equal(exportedFiles[0].filename,'nexus-selected-topics-2026-11-16.csv');
assert.equal(exportedFiles[0].type,'text/csv;charset=utf-8');
const exportedRows=parseCsv(exportedFiles[0].text);
assert.deepEqual(exportedRows[0],[
 'Stream','Subject','Topic','Notes','Last reviewed','Last rating','Next due','Review count','Status'
]);
assert.equal(exportedRows[1][0],'Commerce');
assert.equal(exportedRows[1][1],'Economics');
assert.equal(exportedRows[1][2],'Demand, supply');
assert.equal(exportedRows[1][3],"'=1+1",
 'CSV export must neutralize spreadsheet-formula-leading notes');
assert.equal(exportedRows[1][7],'4');
assert.deepEqual(exportMessages,['Study Hub CSV exported.']);

const importStart=exportEnd;
const importEnd=studyHubSource.indexOf('  function backupPayload(){',importStart);
assert.ok(importEnd>importStart,'Study Hub CSV import function must remain testable');
const importState={
 streams:[{id:'stream-commerce',name:'Commerce'}],
 subjects:[{id:'subject-economics',name:'Economics',streamId:'stream-commerce',order:0}],
 topics:[{id:'topic-demand',name:'Demand',subjectId:'subject-economics',notes:'existing'}],
 history:[],exams:[],settings:{}
};
const featureState={journal:[{id:'journal-existing'}],papers:[],goals:[],studyLogs:[]};
const importCommits=[],importMessages=[];
let generatedId=0,projectionRebuilds=0,cloudSchedules=0,renderCount=0;
const saveStatus={textContent:'',style:{}};
const importSandbox={
 window:{
  NexusBackupRestoreUtils:{parseCsv,commitLocalStorageAtomically:()=>true},
  NexusStorageKey:'tracker-storage-key',
  NexusWorkspaceEntityRevisionEntry:()=>({key:'entity-revision',value:'rev-import'}),
  NexusOfflineSyncQueue:{
   commitWorkspace(storage,entries,payload,options){
    importCommits.push({entries,payload,options});
   }
  },
  NexusGetFeatureState:()=>featureState,
  NexusRebuildEntityProjection:async()=>{projectionRebuilds++;},
  NexusCloudSync:{schedule(){cloudSchedules++;}}
 },
 state:importState,fsState:featureState,localStorage:{},
 clone:value=>JSON.parse(JSON.stringify(value)),
 fid:()=> 'generated-'+(++generatedId),
 today:()=> '2026-11-16',
 safeDate:value=>/^\\d{4}-\\d{2}-\\d{2}$/.test(String(value||'')),
 $:id=>id==='saveStatus'?saveStatus:null,
 notify:message=>importMessages.push(String(message)),
 renderAll:()=>{renderCount++;},
 console:{warn(){},error(){}},
 alert:message=>{throw new Error(String(message));}
};
vm.createContext(importSandbox);
vm.runInContext(
 studyHubSource.slice(importStart,importEnd)+'\nthis.runHubImport=importTopicCsv;',
 importSandbox
);
const importCsv=[
 'Stream,Subject,Topic,Notes,Last reviewed,Last rating,Next due,Interval days,Review count',
 'Commerce,Economics,Demand,duplicate,2026-05-01,4,2026-05-08,7,5',
 'Commerce,Economics,Supply,"quoted, note",2026-05-02,4,2026-05-09,7,6',
 'Arts,Accounting,Double entry,=1+1,invalid-date,9,invalid-date,999,100001',
 ',,,missing topic,,,,'
].join('\\n');
await importSandbox.runHubImport({
 name:'topics.csv',size:importCsv.length,text:async()=>importCsv
});
assert.equal(importCommits.length,1,'valid CSV import must commit one atomic workspace transaction');
const committed=importCommits[0];
assert.equal(committed.options.returnOperationPayload,false);
assert.deepEqual(Array.from(committed.entries,entry=>entry.key).sort(),['entity-revision','tracker-storage-key']);
assert.equal(committed.payload.state.streams.length,2);
assert.equal(committed.payload.state.subjects.length,2);
assert.equal(committed.payload.state.topics.length,3);
const importedSupply=committed.payload.state.topics.find(topic=>topic.name==='Supply');
assert.ok(importedSupply,'CSV import must add the non-duplicate topic');
assert.equal(importedSupply.subjectId,'subject-economics',
 'CSV import must preserve the existing stream/subject relationship');
assert.equal(importedSupply.notes,'quoted, note');
const importedAccounting=committed.payload.state.topics.find(topic=>topic.name==='Double entry');
assert.ok(importedAccounting,'CSV import must create a new topic for a new stream/subject');
const importedSubject=committed.payload.state.subjects.find(subject=>subject.id===importedAccounting.subjectId);
assert.equal(importedSubject.name,'Accounting');
assert.equal(committed.payload.state.streams.find(stream=>stream.id===importedSubject.streamId).name,'Arts');
assert.equal(importedAccounting.lastRating,null,'out-of-range CSV ratings must be discarded');
assert.equal(importedAccounting.lastReviewed,'','invalid review dates must be discarded');
assert.equal(importedAccounting.dueDate,'','invalid due dates must be discarded');
assert.equal(importedAccounting.intervalDays,365,'CSV interval values must be bounded');
assert.equal(importedAccounting.reviewCount,100000,'CSV review counts must be bounded');
assert.deepEqual(committed.payload.featureState,featureState,
 'CSV import must preserve the current Study Hub feature state');
assert.equal(projectionRebuilds,1);
assert.equal(cloudSchedules,1);
assert.equal(renderCount,1);
assert.equal(saveStatus.textContent,'Saved on this device');
assert.deepEqual(importMessages,['CSV import complete: 2 added, 1 duplicates skipped, 1 invalid rows skipped.']);

const commitsBeforeInvalid=importCommits.length;
await assert.rejects(
 importSandbox.runHubImport({name:'duplicate-headers.csv',size:20,text:async()=>'Topic,Topic\\nA,B'}),
 /duplicate column names/
);
assert.equal(importCommits.length,commitsBeforeInvalid,
 'invalid CSV headers must fail before changing or queueing workspace data');
await assert.rejects(
 importSandbox.runHubImport({name:'too-large.csv',size:5*1024*1024+1,text:async()=>''}),
 /5 MiB or smaller/
);
assert.equal(importCommits.length,commitsBeforeInvalid,
 'oversized CSV input must be rejected before a workspace transaction');

const backupStart=studyHubSource.indexOf('  function backupPayload(){');
const backupEnd=studyHubSource.indexOf('  window.NexusCreateBackupPayload=backupPayload;',backupStart);
assert.ok(backupStart>=0&&backupEnd>backupStart,'full Study Hub JSON backup payload builder must remain testable');
const backupTracker={streams:[{id:'s'}],subjects:[{id:'sub'}],topics:[{id:'t'}],history:[],exams:[],settings:{}};
const backupFeatures={journal:[{id:'j'}],papers:[{id:'p'}],goals:[{id:'g'}],studyLogs:[{id:'l'}]};
const backupSandbox={
 state:backupTracker,fsState:backupFeatures,localStorage:{getItem:key=>key==='nexus.cloud.last-user-id'?'account-a':null},
 window:{
  NexusRepairCurriculumState:value=>value,
  NexusOfflineSyncQueue:{summary:()=>({pendingForOwner:true,localSequence:7,archivedForOwner:1})}
 },
 Date
};
vm.createContext(backupSandbox);
vm.runInContext(
 studyHubSource.slice(backupStart,backupEnd)+'\nthis.buildHubBackup=backupPayload;',
 backupSandbox
);
const fullBackupPayload=backupSandbox.buildHubBackup();
assert.equal(fullBackupPayload.schema,4);
assert.deepEqual(JSON.parse(JSON.stringify(fullBackupPayload.state)),backupTracker);
assert.deepEqual(JSON.parse(JSON.stringify(fullBackupPayload.featureState)),backupFeatures);
assert.equal(fullBackupPayload.syncMetadata.accountBoundQueueExcluded,true);
assert.equal(fullBackupPayload.syncMetadata.pendingForOwner,true);
assert.equal(Object.hasOwn(fullBackupPayload,'pending'),false,
 'the portable backup must not embed the account-bound offline queue');

console.log('Backup/restore safety tests passed.');
