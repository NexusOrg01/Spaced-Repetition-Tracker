(function(){'use strict';
const CFG_KEY='nexus.cloud.config.v1',OWNER_KEY='nexus.cloud.last-user-id',DEFAULT_CONFIG={url:'https://txugbdavblpettcnhcxl.supabase.co',key:'sb_publishable_sQkKOf-CfHlG7mvA2sFjIg_qcezI2Fa'},STAGING_CONFIG={url:'https://xuwfzibxhxzxxupprxsq.supabase.co',key:'sb_publishable_UE11M6ghcrdBaRKZUjzsVQ_tOGVc1zw'};
const LIVE_SUPABASE_URL='https://txugbdavblpettcnhcxl.supabase.co',LIVE_APP_HOST='spaced-repetition-tracker-delta.vercel.app';
function isPreviewDeploymentOrigin(){const host=location.hostname.toLowerCase();return host!==LIVE_APP_HOST&&(host.endsWith('.vercel.app')||host.endsWith('.netlify.app'));}
const SYNC_DIAG_ENABLED=(()=>{try{const requested=new URLSearchParams(location.search).get('nexusSyncDiag')==='1';if(requested){localStorage.setItem('nexus.syncdiag.enabled','1');sessionStorage.setItem('nexus.syncdiag.enabled','1');}return requested||localStorage.getItem('nexus.syncdiag.enabled')==='1'||sessionStorage.getItem('nexus.syncdiag.enabled')==='1';}catch(_){return false;}})();
const SYNC_DIAG_KEY='nexus.syncdiag.session.v1';
function syncDiagSummary(payload){
 const s=payload&&payload.state&&typeof payload.state==='object'?payload.state:{};
 const settings=s.settings&&typeof s.settings==='object'?s.settings:{};
 const installed=Array.isArray(settings.installedCurricula)?settings.installedCurricula:[];
 const deleted=Array.isArray(settings.curriculumTombstones)?settings.curriculumTombstones:[];
 const packInstalled=installed.filter(x=>typeof x==='string'&&(x==='installed:pack:sl-al-commerce-si'||x.startsWith('installed:subject:sl-al-commerce-si:')||x.startsWith('installed:topic:sl-al-commerce-si:')));
 const packDeleted=deleted.filter(x=>typeof x==='string'&&x.startsWith('deleted:')&&x.includes(':sl-al-commerce-si:')||x==='deleted:pack:sl-al-commerce-si');
 const features=payload&&payload.featureState&&typeof payload.featureState==='object'?payload.featureState:{};
 const counts={streamCount:Array.isArray(s.streams)?s.streams.length:0,subjectCount:Array.isArray(s.subjects)?s.subjects.length:0,topicCount:Array.isArray(s.topics)?s.topics.length:0,reviewHistoryCount:Array.isArray(s.history)?s.history.length:0,examCount:Array.isArray(s.exams)?s.exams.length:0,journalCount:Array.isArray(features.journal)?features.journal.length:0,paperCount:Array.isArray(features.papers)?features.papers.length:0,goalCount:Array.isArray(features.goals)?features.goals.length:0,studyLogCount:Array.isArray(features.studyLogs)?features.studyLogs.length:0};
 counts.totalRecordCount=Object.values(counts).reduce((total,count)=>total+count,0);
 // Diagnostics deliberately avoid serializing the workspace: a large snapshot must
 // not allocate another full-size string merely to describe a sync failure.
 return {hasPackInstallIntent:packInstalled.length>0,packInstallMarkerCount:packInstalled.length,packDeletionMarkerCount:packDeleted.length,...counts,hasSettings:!!s.settings};
}
function syncDiag(stage,payload,extra){
 if(!SYNC_DIAG_ENABLED)return;
 try{const rows=JSON.parse(localStorage.getItem(SYNC_DIAG_KEY)||'[]');rows.push({at:new Date().toISOString(),stage,...(payload?{workspace:syncDiagSummary(payload)}:{}),...(extra||{})});localStorage.setItem(SYNC_DIAG_KEY,JSON.stringify(rows.slice(-80)));}catch(_){}
}
function downloadSyncDiagnostics(){
 if(!SYNC_DIAG_ENABLED)return;
 let events=[];try{events=JSON.parse(localStorage.getItem(SYNC_DIAG_KEY)||'[]');}catch(_){}
 const report={app:'Nexus sync diagnostic',schema:3,generatedAt:new Date().toISOString(),note:'Contains stage names, aggregate workspace record counts, timings and safe error codes/messages. It does not contain account identifiers, credentials, topic names or study content.',events};
 const blob=new Blob([JSON.stringify(report,null,2)],{type:'application/json'}),url=URL.createObjectURL(blob),link=document.createElement('a');
 link.href=url;link.download='nexus-sync-diagnostics.json';document.body.appendChild(link);link.click();link.remove();URL.revokeObjectURL(url);
}
function installSyncDiagnosticsButton(){
 const help=el('cloudHelpText'),anchor=help&&help.parentNode?help:null;
 const place=button=>{
  if(anchor){button.style.marginTop='8px';button.style.marginRight='8px';anchor.insertAdjacentElement('afterend',button);}
  else if(document.body){button.style.position='fixed';button.style.zIndex='99999';button.style.right='12px';button.style.bottom='12px';button.style.maxWidth='calc(100vw - 24px)';button.style.boxShadow='0 2px 12px rgba(0,0,0,.25)';document.body.appendChild(button);}
 };
 let toggle=el('nexusSyncDiagnosticsToggle');
 if(!toggle){
  toggle=document.createElement('button');toggle.id='nexusSyncDiagnosticsToggle';toggle.type='button';toggle.className='btn btn-sm';
  toggle.addEventListener('click',()=>{
   try{
    if(SYNC_DIAG_ENABLED){localStorage.removeItem('nexus.syncdiag.enabled');sessionStorage.removeItem('nexus.syncdiag.enabled');}
    else{localStorage.setItem('nexus.syncdiag.enabled','1');sessionStorage.setItem('nexus.syncdiag.enabled','1');}
    location.reload();
   }catch(error){console.warn('Nexus sync diagnostics could not be toggled.',error);}
  });
  place(toggle);
 }
 toggle.textContent=SYNC_DIAG_ENABLED?'Disable sync diagnostics':'Enable sync diagnostics';
 toggle.title=SYNC_DIAG_ENABLED?'Stop recording additional sync diagnostics. Download the report before disabling.':'Enable safe local sync diagnostics and reload Nexus before reproducing the sync problem.';
 if(SYNC_DIAG_ENABLED){
  let download=el('nexusSyncDiagnosticsDownload');
  if(!download){
   download=document.createElement('button');download.id='nexusSyncDiagnosticsDownload';download.type='button';download.className='btn btn-sm';download.textContent='Download sync diagnostics (safe summary)';download.addEventListener('click',downloadSyncDiagnostics);place(download);
   syncDiag('diagnostics-enabled');
  }
 }
}

function isUnsafeCloudOrigin(){const host=location.hostname.toLowerCase(),url=String(config().url||'').trim();let cloudHost='';try{cloudHost=new URL(url).hostname.toLowerCase();}catch(_){}return cloudHost===new URL(LIVE_SUPABASE_URL).hostname&&host!=='spaced-repetition-tracker-delta.vercel.app'&&host!=='kkmalithmalshan2000-png.github.io';}
function previewCloudBlockedMessage(){status('Preview · cloud sync disabled');say('Cloud sync is disabled on this preview/local copy to protect real cloud data. Nexus still works offline. To test cloud sync, configure a separate Supabase test project on this device.');}
let client=null,session=null,syncing=false,ready=false,deletingAccount=false,deletionServiceCheckedUser=null,deletionServiceAvailable=false,timer=null,retryTimer=null,retryAttempt=0,lastRemoteStamp=null,lastRemoteStorageMode='legacy',supabaseLoadPromise=null,pendingSync=false,lastUserId=null,initializing=false,initializingUserId=null,queuedSession=null,hasQueuedSession=false;
const el=id=>document.getElementById(id),status=m=>{if(el('cloudStatus'))el('cloudStatus').textContent=m;if(m==='Synced')clearRetry();},say=m=>{if(el('cloudHelpText'))el('cloudHelpText').textContent=m;updateConflictRecoveryButton();},config=()=>{if(isPreviewDeploymentOrigin())return {...STAGING_CONFIG};try{return {...DEFAULT_CONFIG,...JSON.parse(localStorage.getItem(CFG_KEY)||'{}')}}catch(_){return {...DEFAULT_CONFIG}}};
// The callback must return to the exact deployment that initiated sign-in. If Supabase rejects this origin, fix its redirect allow-list; do not pin a callback to an older preview.
function authRedirectUrl(){const target=new URL(location.pathname,location.origin);target.search='';target.hash='';return target.href;}
function conflictRecoveryOwner(){return session&&session.user&&session.user.id||localStorage.getItem(OWNER_KEY)||'';}
function updateConflictRecoveryButton(){
 const help=el('cloudHelpText'),queue=window.NexusOfflineSyncQueue;
 if(!help||!queue||typeof help.insertAdjacentElement!=='function')return;
 let button=el('nexusConflictRecoveryDownload');
 if(!button){
  button=document.createElement('button');button.id='nexusConflictRecoveryDownload';button.type='button';
  button.className='btn btn-sm';button.style.marginTop='8px';button.textContent='Download sync conflict recovery';
  button.addEventListener('click',downloadConflictRecovery);
  help.insertAdjacentElement('afterend',button);
 }
 try{
  const owner=conflictRecoveryOwner(),history=owner?queue.getConflictHistory(localStorage,owner):[];
  const count=history.reduce((total,item)=>total+(Array.isArray(item.conflicts)?item.conflicts.length:0),0);
  button.hidden=count===0;
  button.textContent=count?'Download sync conflict recovery ('+count+')':'Download sync conflict recovery';
  button.title='Download saved alternatives from overlapping offline/cloud edits. This archive is stored only in this browser/device for the signed-in account. It is not uploaded or synced to other devices. Download it before clearing this browser’s site data.';
 }catch(error){button.hidden=true;console.warn('Nexus conflict recovery archive could not be read.',error);}
}
function downloadConflictRecovery(){
 const queue=window.NexusOfflineSyncQueue,owner=conflictRecoveryOwner();
 if(!queue||!owner)return;
 try{
  const history=queue.getConflictHistory(localStorage,owner);
  if(!history.length){updateConflictRecoveryButton();return;}
  const data={app:'Nexus Spaced Repetition Tracker',type:'sync-conflict-recovery',schema:1,exportedAt:new Date().toISOString(),note:'This file records alternatives from same-account offline/cloud conflicts. The current workspace kept the deterministic merge result. The archived values are provided for manual inspection and recovery. This archive is stored only in the browser/device that detected the conflict and is not uploaded or synced to other devices.',conflictRecovery:history};
  const blob=new Blob([JSON.stringify(data,null,2)],{type:'application/json'});
  const url=URL.createObjectURL(blob),link=document.createElement('a');
  link.href=url;link.download='nexus-sync-conflict-recovery-'+new Date().toISOString().replace(/[:.]/g,'-')+'.json';
  document.body.appendChild(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
 }catch(error){status('Conflict recovery download failed');say('The conflict archive remains in this browser but could not be downloaded. Make a normal JSON backup and try again.');console.error('Nexus conflict recovery download failed',error);}
}
function clearRetry(){if(retryTimer){clearTimeout(retryTimer);retryTimer=null;}retryAttempt=0;}
function scheduleRetry(){if(retryTimer||isUnsafeCloudOrigin()||(typeof navigator!=='undefined'&&!navigator.onLine))return;const text=el('cloudStatus')?el('cloudStatus').textContent:'';const policy=window.NexusCloudSyncRecovery;if(policy&&!policy.shouldRetry(text))return;if(!policy&&/(cloud conflict|data choice required|account queue paused|not signed in)/i.test(text))return;const delay=policy?policy.retryDelay(retryAttempt):Math.min(300000,1500*Math.pow(2,Math.min(retryAttempt,8)));retryAttempt=Math.min(retryAttempt+1,8);retryTimer=setTimeout(()=>{retryTimer=null;if(typeof navigator!=='undefined'&&!navigator.onLine)return;if(syncing||initializing){scheduleRetry();return;}connect();},delay);}
function resumeAfterConnectivity(){if(isUnsafeCloudOrigin()||(typeof navigator!=='undefined'&&!navigator.onLine))return;const text=el('cloudStatus')?el('cloudStatus').textContent:'';const policy=window.NexusCloudSyncRecovery;if(policy&&!policy.shouldRetry(text))return;if(syncing){pendingSync=true;return;}if(initializing)return;if(session&&ready){let pending=false;try{pending=!!(window.NexusOfflineSyncQueue&&window.NexusOfflineSyncQueue.hasPending(localStorage,session.user.id));}catch(e){status('Sync error');say('The local sync queue could not be read. Local data is preserved. Nexus will retry safely.');scheduleRetry();return;}if(pending)schedule();else status('Synced');}else connect();}
function loadSupabaseLibrary(){if(window.supabase&&window.supabase.createClient)return Promise.resolve();if(supabaseLoadPromise)return supabaseLoadPromise;supabaseLoadPromise=new Promise((resolve,reject)=>{const script=document.createElement('script');script.src='https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.3';script.async=true;script.onload=()=>window.supabase&&window.supabase.createClient?resolve():reject(new Error('Supabase client did not initialize.'));script.onerror=()=>reject(new Error('Could not load Supabase client. Check internet access.'));document.head.appendChild(script);});return supabaseLoadPromise;}
function setControls(){const previewBlocked=isUnsafeCloudOrigin(),logged=!!session,connected=logged&&ready&&!initializing,busy=logged&&!connected;if(logged&&ready&&deletionServiceCheckedUser!==session.user.id)checkAccountDeletionService();const google=el('cloudGoogleSignInBtn'),email=el('cloudEmailSignInBtn'),out=el('cloudSignOutBtn');if(out){out.disabled=!logged;out.setAttribute('aria-disabled',String(!logged));}if(google){google.hidden=false;google.disabled=logged||previewBlocked;google.classList.toggle('auth-signin-busy',logged);google.setAttribute('aria-disabled',String(logged||previewBlocked));google.setAttribute('aria-label','Sign in with Google');const label=google.querySelector('span');if(label)label.textContent='Sign in with Google';}if(email){email.hidden=false;email.disabled=logged||previewBlocked;email.classList.toggle('auth-signin-busy',logged);email.setAttribute('aria-disabled',String(logged||previewBlocked));email.setAttribute('aria-label','Sign in with email');const label=email.querySelector('span');if(label)label.textContent='Sign in with email';}if(el('cloudAccount'))el('cloudAccount').textContent=previewBlocked?'Preview/local copy — cloud sync disabled':logged?(session.user.email||'Signed-in account'):'Not signed in — offline mode is available';if(el('cloudAccount'))el('cloudAccount').title=previewBlocked?'Use a separate Supabase test project to test cloud sync here.':logged?'Account ID: '+session.user.id:'Your data stays on this device while signed out.';if(previewBlocked)previewCloudBlockedMessage();updateConflictRecoveryButton();installSyncDiagnosticsButton();if(window.NexusRefreshDeletionOptions)window.NexusRefreshDeletionOptions();}
function snapshot(){return {app:'Nexus Spaced Repetition Tracker',schema:4,exportedAt:new Date().toISOString(),state:clone(state),featureState:window.NexusGetFeatureState?window.NexusGetFeatureState():{}};}
function diagnosticWorkspace(){return {state,featureState:window.NexusGetFeatureState?window.NexusGetFeatureState():{}};}
function assertStableRecordIds(payload){
 const validate=(section,fields,label)=>{
  if(!section||typeof section!=='object')return;
  for(const field of fields){
   if(section[field]===undefined)continue;
   if(!Array.isArray(section[field]))throw new Error('Cannot safely sync malformed '+label+'.'+field+' records.');
   for(const row of section[field]){
    if(!row||typeof row!=='object'||Array.isArray(row)||row.id===undefined||row.id===null||String(row.id)==='')throw new Error('Cannot safely sync a '+label+'.'+field+' record without a stable ID. Local data is preserved. Export a backup and repair the record before syncing.');
   }
  }
 };
 validate(payload.state,['streams','subjects','topics','history','exams'],'tracker');
 validate(payload.featureState,['journal','papers','goals','studyLogs'],'Study Hub');
}
function normalizeWorkspacePayload(payload,repairCurriculum=false){
 if(!payload||!payload.state||!Array.isArray(payload.state.streams))throw new Error('A valid workspace snapshot is required for automatic reconciliation.');
 assertStableRecordIds(payload);
 // Current-schema local and base snapshots are already normalized. Keep their large
 // state arrays by reference, but normalize the comparatively small Study Hub payload.
 // Legacy states and remote snapshots still receive the full state normalization pass.
 const features=window.NexusNormalizeFeatureState(Object.prototype.hasOwnProperty.call(payload,'featureState')?payload.featureState:undefined);
 if(!repairCurriculum&&Number(payload.schema)>=4)return {...payload,state:payload.state,featureState:features};
 const normalized=normalizeState(payload.state);
 const safeState=repairCurriculum&&window.NexusRepairCurriculumState?window.NexusRepairCurriculumState(normalized):normalized;
 return {...payload,state:safeState,featureState:features};
}
function nextCloudStamp(previous){
 const policy=window.NexusCloudSyncRecovery;
 if(policy&&typeof policy.nextRevisionStamp==='function')return policy.nextRevisionStamp(previous);
 const now=Date.now(),prior=Date.parse(previous||'');
 return new Date(Number.isFinite(prior)?Math.max(now,prior+1):now).toISOString();
}
async function assertActiveUser(userId){const {data,error}=await client.auth.getSession();if(error)throw error;const activeId=data&&data.session&&data.session.user?data.session.user.id:null;if(activeId!==userId||!session||session.user.id!==userId)throw new Error('The active account changed during sync. No cloud data was applied or written. Retry the account connection.');}
async function fetchRemote(userId,knownWrite){
 const uid=userId||(session&&session.user&&session.user.id),startedAt=Date.now();
 if(!client||!uid)throw new Error('No active account is available for cloud sync.');
 const {data,error}=await client.from('nexus_user_data').select('payload,updated_at').eq('user_id',uid).maybeSingle();
 const durationMs=Date.now()-startedAt;
 if(error){syncDiag('cloud-read-error',null,{errorCode:String(error.code||'unknown'),durationMs});throw error;}
 let remote=data;
 if(remote&&remote.payload&&remote.payload.__nexusStorage==='chunked-v1'){
  const chunks=window.NexusCloudChunkStorage;
  if(!chunks||!chunks.isManifest(remote.payload))throw new Error('The cloud workspace uses an unsupported chunked format. Local data and pending changes remain preserved.');
  lastRemoteStorageMode='chunked';
  if(knownWrite&&knownWrite.verifiedChunks&&knownWrite.manifest&&chunks.sameManifest(remote.payload,knownWrite.manifest)){
   // The upload helper already read back and SHA-256-verified every immutable chunk
   // before publishing this manifest. Confirming the active manifest here completes
   // the post-publication read-back without downloading the same large payload twice.
   remote={...remote,payload:knownWrite.payload,storageMode:'chunked',chunkManifest:remote.payload};
  }else{
   try{
    const reconstructed=await chunks.readSnapshot(client,uid,remote.payload);
    remote={...remote,payload:reconstructed,storageMode:'chunked',chunkManifest:remote.payload};
   }catch(chunkError){
    syncDiag('cloud-chunk-read-error',null,{errorCode:String(chunkError&&chunkError.code||'unknown'),errorMessage:String(chunkError&&chunkError.message||'unknown').slice(0,120)});
    throw chunkError;
   }
  }
 }else{
  lastRemoteStorageMode='legacy';
  if(remote)remote={...remote,storageMode:'legacy'};
 }
 syncDiag('cloud-read',remote&&remote.payload,{hasPayload:!!(remote&&remote.payload),hasUpdatedAt:!!(remote&&remote.updated_at),durationMs,storageMode:remote&&remote.storageMode||'empty'});
 return remote;
}
async function writeRemoteSnapshot(userId,payload,expectedStamp,stamp){
 const startedAt=Date.now();
 try{
  const chunks=window.NexusCloudChunkStorage;
  const serialized=JSON.stringify(payload);
  const serializedBytes=chunks?chunks.utf8ByteLength(serialized):(typeof TextEncoder==='function'?new TextEncoder().encode(serialized).length:serialized.length);
  if(chunks&&(lastRemoteStorageMode==='chunked'||serializedBytes>=chunks.CHUNK_THRESHOLD_BYTES)){
   const result=await chunks.writeSnapshot(client,userId,payload,expectedStamp,stamp,window.NexusBackupRestoreUtils,serialized);
   syncDiag('cloud-write-complete',payload,{durationMs:Date.now()-startedAt,storageMode:'chunked',chunkCount:result.manifest.chunkCount,payloadUtf8Bytes:result.manifest.totalBytes});
   return result;
  }
  const result=await window.NexusBackupRestoreUtils.writeCloudSnapshot(client,userId,payload,expectedStamp,stamp);
  syncDiag('cloud-write-complete',payload,{durationMs:Date.now()-startedAt,storageMode:'legacy',payloadUtf8Bytes:serializedBytes});
  return result;
 }catch(error){
  syncDiag('cloud-write-error',payload,{durationMs:Date.now()-startedAt,errorCode:String(error&&error.code||'unknown'),errorMessage:String(error&&error.message||'unknown').slice(0,120),storageMode:lastRemoteStorageMode});
  throw error;
 }
}
function rebuildOversizedOfflineQueue(queue,ownerId,payload,baseServerVersion,reason){
 if(!queue||typeof queue.commitWorkspace!=='function'||typeof queue.getPending!=='function'||!window.NexusStorageKey||!window.NexusFeatureStorageKey)throw new Error('Safe offline queue recovery is unavailable.');
 if(localStorage.getItem(OWNER_KEY)!==ownerId)throw new Error('The active account no longer owns this workspace. Offline queue recovery stopped.');
 const features=payload&&payload.featureState?payload.featureState:{};
 queue.commitWorkspace(localStorage,[
  {key:window.NexusStorageKey,value:JSON.stringify(payload.state)},
  {key:window.NexusFeatureStorageKey,value:JSON.stringify(features)}
 ],{app:'Nexus Spaced Repetition Tracker',schema:4,exportedAt:new Date().toISOString(),state:clone(payload.state),featureState:clone(features)},
 {baseServerVersion:baseServerVersion||null,returnOperationPayload:false});
 const pending=queue.getPending(localStorage,ownerId);
 if(!pending||pending.ownerUserId!==ownerId)throw new Error('The rebuilt offline snapshot could not be verified for this account.');
 syncDiag('offline-queue-rebuilt-after-size-limit',pending.payload,{reason:reason||'sync',priorQueueRetainedForRecovery:true});
 return pending;
}
function emptyState(){return {schema:3,streams:[{id:'stream-general',name:'General'}],subjects:[{id:'subject-general',name:'General',streamId:'stream-general',order:0}],topics:[],exams:[],history:[],settings:{theme:'system',intervalCap:120,installedCurricula:[],curriculumTombstones:[]}};}
function mergeState(local,remote){
 const l=normalizeState(local),r=normalizeState(remote);
 const union=(a,b)=>{const m=new Map();for(const x of b||[])m.set(String(x.id),clone(x));for(const x of a||[])m.set(String(x.id),clone(x));return Array.from(m.values());};
 const unionStrings=(a,b)=>Array.from(new Set([...(Array.isArray(a)?a:[]),...(Array.isArray(b)?b:[])].filter(x=>typeof x==='string'&&x.length>0))).slice(-5000);
 const streams=union(l.streams,r.streams),subjects=union(l.subjects,r.subjects),topics=union(l.topics,r.topics),exams=union(l.exams,r.exams),history=union(l.history,r.history);
 if(!streams.length)streams.push({id:'stream-general',name:'General'});
 const streamIds=new Set(streams.map(x=>x.id));
 for(const sub of subjects)if(!streamIds.has(sub.streamId))sub.streamId=streams[0].id;
 const subjectIds=new Set(subjects.map(x=>x.id));
 for(const t of topics)if(!subjectIds.has(t.subjectId)){
  const fallback=subjects[0]||{id:'subject-general',name:'General',streamId:streams[0].id,order:0};
  if(!subjectIds.has(fallback.id))subjects.push(fallback);
  t.subjectId=fallback.id;
 }
 const mergedState={...r,streams,subjects,topics,exams,history,settings:{
  ...r.settings,...l.settings,
  installedCurricula:unionStrings(r.settings?.installedCurricula,l.settings?.installedCurricula),
  curriculumTombstones:unionStrings(r.settings?.curriculumTombstones,l.settings?.curriculumTombstones)
 }};
 if(window.NexusCurriculumIntegrity&&typeof window.NexusCurriculumIntegrity.reconcileMergedIntents==='function'){
  window.NexusCurriculumIntegrity.reconcileMergedIntents(null,l,r,mergedState);
 }
 return normalizeState(mergedState);
}
function hasLocalWork(s){if(!s)return false;const core=s.state||s||{},f=s.featureState||{};const coreWork=!!(core.topics?.length||core.history?.length||core.exams?.length||core.streams?.length>1||core.subjects?.length>1);const featureWork=['journal','papers','goals','studyLogs','selectedTopicIds'].some(k=>Array.isArray(f[k])&&f[k].length>0)||Object.keys(f.syllabusTargets||{}).length>0||Object.keys(f.taskChecks||{}).length>0||!!(f.lastBackupAt||f.lastReminderAt||f.focusStartedAt||f.focusPausedAt||f.focusTopicId||f.focusSubjectId);const defaults={dailyMinutes:90,sessionMinutes:25,scheduler:'classic',weeklyReviewGoal:100,backlogDays:7,reminders:false,reminderTime:'08:00',maxInterval:120,finalRevision:false,workloadDays:7};const settings=f.settings||{};const settingsWork=Object.keys(defaults).some(k=>settings[k]!==undefined&&settings[k]!==defaults[k]);return coreWork||featureWork||settingsWork;}
async function hasUnassignedWorkspaceChanges(owner,newUserId,localPayload){
 const queue=window.NexusOfflineSyncQueue;
 if(!owner||owner===newUserId)return hasLocalWork(localPayload);
 const priorBase=queue?queue.getBase(localStorage,owner):null;
 // The outbox is mutable: saves made while signed out can update the previous owner's
 // pending snapshot. It is therefore not a trustworthy ownership baseline. Compare the
 // current device workspace with the last verified cloud baseline instead. If no verified
 // baseline exists, conservatively require an explicit choice whenever local work exists.
 return priorBase?!(await sameWorkspace(localPayload,priorBase)):hasLocalWork(localPayload);
}
function chooseLocalData(){return new Promise(resolve=>{const dlg=el('accountChoiceDialog');if(!dlg){resolve('cancel');return;}let done=false;const onCancel=e=>e.preventDefault();const finish=v=>{if(done)return;done=true;dlg.removeEventListener('cancel',onCancel);if(dlg.open)dlg.close();resolve(v);};dlg.addEventListener('cancel',onCancel);dlg.querySelectorAll('[data-account-choice]').forEach(b=>b.onclick=()=>finish(b.dataset.accountChoice));if(!dlg.open)dlg.showModal();});}
async function flushDurableLocalWrites(){
 const storage=window.NexusStorage,startedAt=Date.now();
 if(storage&&typeof storage.isEnabled==='function'&&storage.isEnabled()&&typeof storage.flush==='function')await storage.flush();
 syncDiag('local-storage-flush',null,{durationMs:Date.now()-startedAt,storageEnabled:!!(storage&&typeof storage.isEnabled==='function'&&storage.isEnabled())});
}
async function applyWorkspaceSnapshot(nextState,rawFeatures,ownerId){
  if(!window.NexusBackupRestoreUtils||!window.NexusStorageKey||!window.NexusFeatureStorageKey||!window.NexusNormalizeFeatureState||!window.NexusSetFeatureState)throw new Error('Safe local workspace storage is unavailable. Cloud data was not applied.');
  const safeState=window.NexusRepairCurriculumState?window.NexusRepairCurriculumState(nextState):nextState;
  const previousOwner=localStorage.getItem(OWNER_KEY)||'';
  const inputFeatures=rawFeatures&&typeof rawFeatures==='object'&&!Array.isArray(rawFeatures)?rawFeatures:{};
  const featureInput={...inputFeatures};
  if(ownerId&&previousOwner&&previousOwner!==String(ownerId)&&!Object.prototype.hasOwnProperty.call(featureInput,'fsrsSettings')){
    // Do not carry account A's device-only scheduler preference into account B when
    // B's older cloud snapshot predates the FSRS-settings field.
    featureInput.fsrsSettings={request_retention:0.9,maximum_interval:120,enable_fuzz:false,w:null};
  }
  const nextFeatures=window.NexusNormalizeFeatureState(featureInput);
  // Legacy cloud snapshots and older cached runtimes may not expose FSRS preferences.
  // The scheduler-settings compatibility key must always receive a valid JSON value.
  if(!nextFeatures.fsrsSettings||typeof nextFeatures.fsrsSettings!=='object'||Array.isArray(nextFeatures.fsrsSettings))nextFeatures.fsrsSettings={request_retention:0.9,maximum_interval:120,enable_fuzz:false,w:null};
  const entries=[
    {key:window.NexusStorageKey,value:JSON.stringify(safeState)},
    {key:window.NexusFeatureStorageKey,value:JSON.stringify(nextFeatures)},
    {key:'nexus.fsrs.cards.v1',value:JSON.stringify(Object.fromEntries((safeState.topics||[]).filter(topic=>topic&&topic.fsrs).map(topic=>[String(topic.id),topic.fsrs])))},
     {key:'nexus.fsrs.settings.v1',value:JSON.stringify(nextFeatures.fsrsSettings)}
  ];
  if(ownerId)entries.push({key:OWNER_KEY,value:String(ownerId)});
  // Free redundant snapshot space before applying a cloud workspace to this browser.
  if(window.NexusOfflineSyncQueue&&typeof window.NexusOfflineSyncQueue.compactMetadata==='function')window.NexusOfflineSyncQueue.compactMetadata(localStorage);
  await window.NexusBackupRestoreUtils.commitLocalStorageAtomically(localStorage,entries);
  state=safeState;
  if(window.NexusFSRS&&typeof window.NexusFSRS.setSettings==='function')window.NexusFSRS.setSettings(nextFeatures.fsrsSettings,{syncFeature:false,persist:false});
  window.NexusSetFeatureState(nextFeatures,{persist:false,render:false,applyFsrs:false});
  renderAll();
  const activeView=typeof document!=='undefined'&&typeof document.querySelector==='function'?document.querySelector('.view.active'):null;if(activeView&&activeView.id==='view-studyhub'&&window.NexusRenderHub)window.NexusRenderHub();
  return true;
}
async function applyRemote(payload,ownerId,serverVersion){
  if(!payload||!payload.state||!Array.isArray(payload.state.streams))throw new Error('Cloud backup format is invalid.');
  ready=false;
  // applyWorkspaceSnapshot performs the one required normalize/repair pass itself.
  await applyWorkspaceSnapshot(payload.state,payload.featureState,ownerId);
  if(ownerId&&window.NexusOfflineSyncQueue){
   const appliedFeatures=window.NexusGetFeatureState?window.NexusGetFeatureState():{};
   window.NexusOfflineSyncQueue.rememberBase(localStorage,ownerId,{state,featureState:appliedFeatures},serverVersion||null);
  }
  await flushDurableLocalWrites();
  ready=true;
}
async function applyLocalMerged(localPayload,remotePayload){
  const nextState=mergeState(localPayload.state,remotePayload?.state||emptyState());
  const remoteFeatures=remotePayload?.featureState||{},localFeatures=localPayload.featureState||{};
  // Keep local settings and same-ID records, while preserving non-conflicting Study Hub records from cloud.
  const nextFeatures=window.NexusMergeFeatureState(localFeatures,remoteFeatures,{});
  ready=false;
  await applyWorkspaceSnapshot(nextState,nextFeatures);
  ready=true;
}
async function resetToEmpty(ownerId){
  ready=false;
  await applyWorkspaceSnapshot(emptyState(),{},ownerId);
}
function enqueueInitialSnapshot(ownerId){const queue=window.NexusOfflineSyncQueue;if(!queue||!window.NexusStorageKey||!window.NexusFeatureStorageKey)throw new Error('Safe offline snapshot queue is unavailable.');if(localStorage.getItem(OWNER_KEY)!==ownerId)throw new Error('The initial snapshot owner could not be verified.');if(queue.hasPending(localStorage,ownerId))return;const featureState=window.NexusGetFeatureState?window.NexusGetFeatureState():{};queue.commitWorkspace(localStorage,[{key:window.NexusStorageKey,value:JSON.stringify(state)},{key:window.NexusFeatureStorageKey,value:JSON.stringify(featureState)}],snapshot(),{baseServerVersion:null});}
async function reconcileConcurrentSnapshot(userId,initialRemote){
 const queue=window.NexusOfflineSyncQueue,merger=window.NexusWorkspaceSyncMerge;
 if(!queue||!merger||!userId)return {ok:false,conflicts:0,reason:'Automatic merge helpers are unavailable.'};
 let remote=initialRemote,totalConflicts=0;
 for(let attempt=0;attempt<3;attempt++){
  await assertActiveUser(userId);
  const pending=queue.getPending(localStorage,userId);
  if(!pending)return {ok:true,conflicts:totalConflicts};
  // Equality of the current local/cloud snapshots is insufficient when both are
  // missing an install intent retained by the last verified base. Do not acknowledge
  // this incomplete snapshot as healthy; force the three-way repair path below.
  const missingBaselineCurriculumIntent=hasMissingBaselineCurriculumIntent(userId,pending.payload,remote&&remote.payload);
  if(remote&&remote.payload&&(await sameWorkspace(remote.payload,pending.payload))&&!missingBaselineCurriculumIntent){
   queue.rememberBase(localStorage,userId,remote.payload,remote.updated_at||null);
   queue.acknowledge(localStorage,userId,pending.operationId,pending.baseServerVersion,remote.updated_at||null);
   lastRemoteStamp=remote.updated_at||null;
   return {ok:true,conflicts:totalConflicts};
  }
  const remoteStamp=remote&&remote.updated_at?remote.updated_at:null;
  if((pending.baseServerVersion||null)===(remoteStamp||null)&&!missingBaselineCurriculumIntent){
   lastRemoteStamp=remoteStamp;ready=true;
   const uploaded=await upload();
   if(uploaded)return {ok:true,conflicts:totalConflicts};
   if((el('cloudStatus')?.textContent||'')!=='Cloud conflict')return {ok:false,conflicts:totalConflicts,reason:'The automatic merge upload could not be verified.'};
   remote=await fetchRemote(userId);
   continue;
  }
  if(!remote||!remote.payload||!remote.payload.state)return {ok:false,conflicts:totalConflicts,reason:'The current cloud workspace could not be loaded.'};
  const savedBase=queue.getBase(localStorage,userId);
  const normalizedBase=savedBase?normalizeWorkspacePayload(savedBase):null;
  const normalizedLocal=normalizeWorkspacePayload(pending.payload);
  const normalizedRemote=normalizeWorkspacePayload(remote.payload,true);
  status('Reconciling cloud changes…');
  const mergeStartedAt=Date.now();
  const usedCooperativeMerge=typeof merger.mergeAsync==='function';
  syncDiag('workspace-merge-start',null,{cooperative:usedCooperativeMerge,baseTopicCount:normalizedBase&&normalizedBase.state&&normalizedBase.state.topics?.length||0,localTopicCount:normalizedLocal.state.topics?.length||0,remoteTopicCount:normalizedRemote.state.topics?.length||0});
  let result;
  try{
   result=usedCooperativeMerge
    ?await merger.mergeAsync(normalizedBase,normalizedLocal,normalizedRemote)
    :merger.merge(normalizedBase,normalizedLocal,normalizedRemote);
  }catch(error){
   syncDiag('workspace-merge-error',null,{durationMs:Date.now()-mergeStartedAt,errorCode:String(error&&error.code||'unknown'),errorMessage:String(error&&error.message||'unknown').slice(0,120)});
   throw error;
  }
  // Cooperative merging yields to the UI. Revalidate both account and outbox version
  // before committing, because the user may have made another local edit while it ran.
  await assertActiveUser(userId);
  const latestPending=queue.getPending(localStorage,userId);
  if(!latestPending||latestPending.operationId!==pending.operationId){
   syncDiag('workspace-merge-restarted',null,{reason:'local-outbox-changed-during-merge',durationMs:Date.now()-mergeStartedAt});
   remote=await fetchRemote(userId);
   continue;
  }
  syncDiag('workspace-merge-complete',null,{durationMs:Date.now()-mergeStartedAt,cooperative:usedCooperativeMerge,conflictCount:result.conflicts.length});
  const normalizeStartedAt=Date.now();
  syncDiag('workspace-merge-normalize-start',null,{topicCount:result.payload.state.topics?.length||0});
  let nextState,nextFeatures;
  try{
   nextState=normalizeState(result.payload.state);
   nextFeatures=window.NexusNormalizeFeatureState(result.payload.featureState||{});
  }catch(error){
   syncDiag('workspace-merge-normalize-error',null,{durationMs:Date.now()-normalizeStartedAt,errorCode:String(error&&error.code||'unknown'),errorMessage:String(error&&error.message||'unknown').slice(0,120)});
   throw error;
  }
  syncDiag('workspace-merge-normalize-complete',null,{durationMs:Date.now()-normalizeStartedAt,topicCount:nextState.topics?.length||0});
  if(!window.NexusBackupRestoreUtils||!window.NexusStorageKey||!window.NexusFeatureStorageKey||!window.NexusSetFeatureState)throw new Error('Atomic workspace reconciliation is unavailable; local changes were preserved.');
  // nextState and nextFeatures are newly normalized objects and are not mutated before
  // rebaseWithBase serializes them. Avoid a second full clone of a very large workspace.
  const mergedSnapshot={app:'Nexus Spaced Repetition Tracker',schema:4,exportedAt:new Date().toISOString(),state:nextState,featureState:nextFeatures};
  const commitStartedAt=Date.now();
  syncDiag('workspace-merge-commit-start',null,{topicCount:nextState.topics?.length||0,conflictCount:result.conflicts.length});
  let rebased;
  try{
   rebased=queue.rebaseWithBase(localStorage,userId,mergedSnapshot,remoteStamp,'automatic-three-way-merge',
    {state:normalizedRemote.state,featureState:normalizedRemote.featureState},
    {workspaceEntries:[
      {key:window.NexusStorageKey,value:JSON.stringify(nextState)},
      {key:window.NexusFeatureStorageKey,value:JSON.stringify(nextFeatures)},
      {key:OWNER_KEY,value:String(userId)}
     ],
     conflicts:result.conflicts,
     conflictMetadata:{baseServerVersion:pending.baseServerVersion,remoteServerVersion:remoteStamp}
    });
  }catch(error){
   syncDiag('workspace-merge-commit-error',null,{durationMs:Date.now()-commitStartedAt,errorCode:String(error&&error.code||'unknown'),errorMessage:String(error&&error.message||'unknown').slice(0,120)});
   throw error;
  }
  syncDiag('workspace-merge-commit-complete',null,{durationMs:Date.now()-commitStartedAt});

  // Storage, outbox, new base, and losing conflict alternatives now commit together.
  // Do not switch the in-memory workspace until the durable transaction succeeds.
  state=nextState;
  window.NexusSetFeatureState(nextFeatures,{persist:false,render:false});
  renderAll();
  const activeView=typeof document!=='undefined'&&typeof document.querySelector==='function'?document.querySelector('.view.active'):null;if(activeView&&activeView.id==='view-studyhub'&&window.NexusRenderHub)window.NexusRenderHub();
  if(rebased.archivedConflicts){totalConflicts+=rebased.archivedConflicts;updateConflictRecoveryButton();}
  lastRemoteStamp=remoteStamp;ready=true;
  const uploaded=await upload();
  if(uploaded)return {ok:true,conflicts:totalConflicts};
  if((el('cloudStatus')?.textContent||'')!=='Cloud conflict')return {ok:false,conflicts:totalConflicts,reason:'The merge is saved locally, but cloud verification did not finish.'};
  remote=await fetchRemote(userId);
 }
 return {ok:false,conflicts:totalConflicts,reason:'The cloud changed repeatedly during merge. Local edits remain queued and are preserved.'};
}
function hasMissingBaselineCurriculumIntent(userId,localPayload,remotePayload){
 const queue=window.NexusOfflineSyncQueue;
 const base=queue&&userId?queue.getBase(localStorage,userId):null;
 const baseState=base&&base.state;
 if(!baseState||!baseState.settings)return false;
 const markers=value=>new Set(Array.isArray(value?.settings?.installedCurricula)?value.settings.installedCurricula:[]);
 const tombstones=value=>new Set(Array.isArray(value?.settings?.curriculumTombstones)?value.settings.curriculumTombstones:[]);
 const baseline=markers(baseState),current=new Set([...markers(localPayload?.state),...markers(remotePayload?.state)]);
 const deleted=new Set([...tombstones(localPayload?.state),...tombstones(remotePayload?.state)]);
 const packs=window.NexusCurriculumPacks||[];
 for(const marker of baseline){
  if(!marker.startsWith('installed:')||current.has(marker))continue;
  const token=marker.slice('installed:'.length),parts=token.split(':');
  const scope=parts[0],packId=parts[1];
  if(!packId||deleted.has('deleted:pack:'+packId))continue;
  if(scope==='pack'){
   const pack=packs.find(item=>String(item.id)===packId);
   if(!pack||!Array.isArray(pack.subjects))return true;
   // A full-pack marker is intentionally replaced with per-subject markers
   // when a subject is deleted. Only reconcile if an unaffected subject's
   // install intent has also disappeared.
   if(pack.subjects.some(subject=>!deleted.has('deleted:subject:'+packId+':'+subject.id)&&
      !current.has('installed:subject:'+packId+':'+subject.id)))return true;
   continue;
  }
  if(scope==='subject'){
   const subjectId=parts[2];
   if(subjectId&&!deleted.has('deleted:subject:'+packId+':'+subjectId))return true;
   continue;
  }
  if(scope==='topic'){
   const subjectId=parts[2];
   const nameToken=parts.slice(3).join(':');
   if(subjectId&&!deleted.has('deleted:subject:'+packId+':'+subjectId)&&
      !deleted.has('deleted:topic:'+packId+':'+subjectId+':'+nameToken))return true;
  }
 }
 return false;
}
async function reconcileOwnedWorkspace(userId,localPayload,remote){
 const queue=window.NexusOfflineSyncQueue;
 if(!queue||!userId||!localPayload||!remote)return {ok:false,conflicts:0,reason:'Safe same-account reconciliation is unavailable.'};
 const base=queue.getBase(localStorage,userId);
 // A locally clean workspace is not proof that a newer cloud snapshot is complete.
 // In particular, a partial cloud snapshot may omit every untouched row from an
 // installed catalogue. Always run same-account differences through the three-way
 // merge, even when local equals the last synced base. The merge keeps remote edits
 // while preserving explicit local install intent; curriculum repair then rebuilds
 // omitted catalogue rows unless an explicit deletion tombstone applies.
 const baseVersion=base&&typeof base.serverVersion==='string'?base.serverVersion:null;
 queue.rebase(localStorage,userId,localPayload,baseVersion,'automatic-reconciliation-of-cloud-differences');
 return reconcileConcurrentSnapshot(userId,remote);
}
async function checkpointPreviousAccountWorkspace(ownerId,targetUserId,payload){
 if(!ownerId||ownerId===targetUserId)return false;
 const storage=localStorage,queue=window.NexusOfflineSyncQueue;
 if(storage.getItem(OWNER_KEY)!==ownerId)throw new Error('The previous workspace owner changed during account handoff. No workspace was switched.');
 if(!queue||typeof queue.commitWorkspace!=='function'||typeof queue.getPending!=='function'||typeof queue.getBase!=='function'||!window.NexusStorageKey||!window.NexusFeatureStorageKey)throw new Error('Safe per-account offline recovery is unavailable. The previous workspace remains active.');
 if(!payload||!payload.state||!payload.featureState)throw new Error('The previous account snapshot is incomplete. No workspace was switched.');
 const existingPending=queue.getPending(storage,ownerId),verifiedBase=queue.getBase(storage,ownerId);
 const baseVersion=existingPending?existingPending.baseServerVersion:(verifiedBase&&typeof verifiedBase.serverVersion==='string'?verifiedBase.serverVersion:queue.getStamp(storage,ownerId));
 const checkpoint={app:'Nexus Spaced Repetition Tracker',schema:4,exportedAt:new Date().toISOString(),state:clone(payload.state),featureState:clone(payload.featureState)};
 queue.commitWorkspace(storage,[
  {key:window.NexusStorageKey,value:JSON.stringify(checkpoint.state)},
  {key:window.NexusFeatureStorageKey,value:JSON.stringify(checkpoint.featureState)}
 ],checkpoint,{baseServerVersion:baseVersion,returnOperationPayload:false});
 const verified=queue.getPending(storage,ownerId);
 if(!verified||verified.ownerUserId!==ownerId||!(await sameWorkspace(verified.payload,checkpoint)))throw new Error('The previous account’s pending snapshot could not be verified. The account switch was stopped.');
 return true;
}
async function recoverCachedWorkspaceForOfflineAccount(userId){
 if(!userId||!session||!session.user||session.user.id!==userId)return null;
 try{await assertActiveUser(userId);}catch(_){return null;}
 const currentOwner=localStorage.getItem(OWNER_KEY)||'';
 const queue=window.NexusOfflineSyncQueue;
 if(currentOwner===userId){
  // The ordinary initialization path reads the outbox before this recovery hook.
  // When an older compact queue exceeds its decoder limit, rebuild it only from
  // this already-active account's current local snapshot; never substitute another user.
  try{if(queue&&typeof queue.getPending==='function')queue.getPending(localStorage,userId);}
  catch(error){
   if(!error||error.code!=='NEXUS_OFFLINE_QUEUE_TOO_LARGE')throw error;
   rebuildOversizedOfflineQueue(queue,userId,snapshot(),
    queue&&typeof queue.getStamp==='function'?queue.getStamp(localStorage,userId):lastRemoteStamp,
    'active-account-initialization');
   syncDiag('offline-account-queue-rebuilt',diagnosticWorkspace(),{source:'active-local-workspace'});
  }
  return 'active';
 }
 let payload=null,source='',oversizedQueueDetected=false;
 // An account-bound queued snapshot is newer than the last confirmed base.
 try{
  const pending=queue&&queue.getPending(localStorage,userId);
  if(pending&&pending.ownerUserId===userId&&pending.payload&&pending.payload.state&&pending.payload.featureState){
   payload={state:pending.payload.state,featureState:pending.payload.featureState};source='pending';
  }
 }catch(error){
  oversizedQueueDetected=!!(error&&error.code==='NEXUS_OFFLINE_QUEUE_TOO_LARGE');
  syncDiag('offline-account-pending-unavailable',null,{errorCode:String(error&&error.code||'unknown'),errorMessage:String(error&&error.message||'unknown').slice(0,100)});
 }
 // The durable projection is keyed by account and cannot be used for another user.
 if(!payload){
  try{
   const durable=window.NexusStorage;
   if(durable&&typeof durable.isEnabled==='function'&&durable.isEnabled()&&typeof durable.getWorkspace==='function'){
    const cached=await durable.getWorkspace(userId);
    if(cached&&cached.ownerId===userId&&cached.state&&cached.featureState){
     payload={state:cached.state,featureState:cached.featureState};source='indexeddb';
    }
   }
  }catch(error){syncDiag('offline-account-workspace-unavailable',null,{errorMessage:String(error&&error.message||'unknown').slice(0,100)});}
 }
 if(!payload){
  try{
   const base=queue&&queue.getBase(localStorage,userId);
   if(base&&base.state&&base.featureState){
    payload={state:base.state,featureState:base.featureState};source='verified-base';
   }
  }catch(error){syncDiag('offline-account-base-unavailable',null,{errorMessage:String(error&&error.message||'unknown').slice(0,100)});}
 }
 if(!payload)return null;
 const normalizedState=normalizeState(payload.state);
 const normalizedFeatures=window.NexusNormalizeFeatureState(payload.featureState);
 await applyWorkspaceSnapshot(normalizedState,normalizedFeatures,userId);
 if(oversizedQueueDetected){
  rebuildOversizedOfflineQueue(queue,userId,snapshot(),
   queue&&typeof queue.getStamp==='function'?queue.getStamp(localStorage,userId):null,
   'restored-account-workspace');
 }
 syncDiag('offline-account-workspace-restored',{state:normalizedState,featureState:normalizedFeatures},{source,queueRebuilt:oversizedQueueDetected});
 return source||'indexeddb';
}
async function initializeSession(s){syncDiag('initialize-start',diagnosticWorkspace(),{hasSession:!!(s&&s.user),ownerPresent:!!localStorage.getItem(OWNER_KEY)});const requestedSession=s||null,requestedUserId=requestedSession&&requestedSession.user?requestedSession.user.id:null;if(initializing){if(requestedUserId!==initializingUserId){queuedSession=requestedSession;hasQueuedSession=true;}return;}initializing=true;initializingUserId=requestedUserId;try{const newSession=requestedSession,newUserId=requestedUserId;session=newSession;ready=false;lastRemoteStamp=null;clearTimeout(timer);setControls();if(!session){status(client?'Not signed in · offline ready':'Offline ready');say('You can continue studying offline. Your local data remains on this device when you sign out.');return;}status('Loading account…');await assertActiveUser(newUserId);let owner=localStorage.getItem(OWNER_KEY)||'',localPayload=snapshot();const remote=await fetchRemote(newUserId);syncDiag('initialize-after-cloud-read',remote&&remote.payload,{remoteHasPayload:!!(remote&&remote.payload)});await assertActiveUser(newUserId);
// The cloud read is asynchronous: the user may save a local change while it is in flight.
// Re-snapshot before making any account-choice or overwrite decision so a newer offline
// Commerce install (or other study work) cannot be replaced by this stale pre-request copy.
const latestLocalPayload=snapshot();if(!(await sameWorkspace(localPayload,latestLocalPayload)))localPayload=latestLocalPayload;owner=localStorage.getItem(OWNER_KEY)||'';
if(window.NexusOfflineSyncQueue)window.NexusOfflineSyncQueue.rememberStamp(localStorage,newUserId,remote&&remote.updated_at||null);let pendingForUser=window.NexusOfflineSyncQueue?window.NexusOfflineSyncQueue.getPending(localStorage,newUserId):null;let adoptedUnassignedLocalWorkspace=false;if(!owner&&hasLocalWork(localPayload)){const accountPayload=pendingForUser&&pendingForUser.payload&&pendingForUser.payload.state?pendingForUser.payload:(remote&&remote.payload&&remote.payload.state?remote.payload:{state:emptyState(),featureState:{}});const mergedState=mergeState(localPayload.state,accountPayload.state);const mergedFeatures=window.NexusMergeFeatureState(localPayload.featureState||{},accountPayload.featureState||{},{});await applyWorkspaceSnapshot(mergedState,mergedFeatures,newUserId);const baseVersion=pendingForUser?(pendingForUser.baseServerVersion||null):(remote&&remote.updated_at||null);if(!window.NexusOfflineSyncQueue||typeof window.NexusOfflineSyncQueue.rebase!=='function')throw new Error('Safe account-bound offline sync queue is unavailable. The guest workspace remains saved locally.');window.NexusOfflineSyncQueue.rebase(localStorage,newUserId,snapshot(),baseVersion,'merge-unassigned-local-workspace');pendingForUser=window.NexusOfflineSyncQueue.getPending(localStorage,newUserId);owner=newUserId;localPayload=snapshot();adoptedUnassignedLocalWorkspace=true;}if(pendingForUser&&owner!==newUserId&&!hasUnassignedWorkspaceChanges(owner,newUserId,localPayload)){await applyWorkspaceSnapshot(normalizeState(pendingForUser.payload.state),window.NexusNormalizeFeatureState(pendingForUser.payload.featureState||{}),newUserId);owner=newUserId;localPayload=snapshot();}if(pendingForUser&&remote&&remote.payload&&(await sameWorkspace(remote.payload,pendingForUser.payload))&&!hasMissingBaselineCurriculumIntent(newUserId,pendingForUser.payload,remote.payload)){window.NexusOfflineSyncQueue.rememberBase(localStorage,newUserId,remote.payload,remote.updated_at||null);window.NexusOfflineSyncQueue.acknowledge(localStorage,newUserId,pendingForUser.operationId,pendingForUser.baseServerVersion,remote.updated_at);pendingForUser=null;}if(owner&&owner!==newUserId){
 // Account handoff: checkpoint the previous owner's latest local workspace before
 // loading the target account. The checkpoint stays bound to the previous owner and
 // must never be uploaded through the new session.
 const previousOwner=owner;
 const previousAccountHasChanges=await hasUnassignedWorkspaceChanges(previousOwner,newUserId,localPayload);
 if(previousAccountHasChanges)await checkpointPreviousAccountWorkspace(previousOwner,newUserId,localPayload);
 if(pendingForUser){
  // Restore only the target account's own pending snapshot, then reconcile it against
  // that account's current cloud revision. Do not run the generic cross-account choice.
  await applyWorkspaceSnapshot(normalizeState(pendingForUser.payload.state),window.NexusNormalizeFeatureState(pendingForUser.payload.featureState||{}),newUserId);
  owner=newUserId;localPayload=snapshot();
  const handoffReconciliation=await reconcileConcurrentSnapshot(newUserId,remote);
  if(!handoffReconciliation.ok){
   ready=false;status('Automatic merge not verified');
   say((handoffReconciliation.reason||'This account workspace could not be reconciled safely.')+' The previous account’s offline changes remain separately queued. The target account’s local snapshot is preserved; sync is paused.');
   localStorage.setItem(OWNER_KEY,newUserId);lastUserId=newUserId;return;
  }
  ready=true;lastUserId=newUserId;localStorage.setItem(OWNER_KEY,newUserId);
  say('Loaded this account’s workspace. Any pending changes from the previous account remain isolated and will sync when that account is active again.');
  await flushDurableLocalWrites();status('Synced');return;
 }
 const targetBase=window.NexusOfflineSyncQueue?window.NexusOfflineSyncQueue.getBase(localStorage,newUserId):null;
 if(targetBase){
  // The target account has no outbox entry, but this device remembers its last
  // verified snapshot. Use it as the local side of a three-way recovery in case the
  // cloud snapshot is newer or incomplete, rather than throwing that baseline away.
  await applyWorkspaceSnapshot(normalizeState(targetBase.state),window.NexusNormalizeFeatureState(targetBase.featureState||{}),newUserId);
  window.NexusOfflineSyncQueue.rebase(localStorage,newUserId,snapshot(),targetBase.serverVersion||null,'account-switch-baseline-reconciliation');
  const handoffReconciliation=await reconcileConcurrentSnapshot(newUserId,remote);
  if(!handoffReconciliation.ok){
   ready=false;status('Automatic merge not verified');
   say((handoffReconciliation.reason||'This account workspace could not be reconciled safely.')+' The previous account’s offline changes remain separately queued. The target account’s local snapshot is preserved; sync is paused.');
   localStorage.setItem(OWNER_KEY,newUserId);lastUserId=newUserId;return;
  }
  ready=true;lastUserId=newUserId;localStorage.setItem(OWNER_KEY,newUserId);
  say('Restored this account’s last verified workspace and reconciled it with the latest cloud data. Previous-account changes remain isolated.');
  await flushDurableLocalWrites();status('Synced');return;
 }
 if(remote&&remote.payload){
  await applyRemote(remote.payload,newUserId,remote.updated_at||null);lastRemoteStamp=remote.updated_at||null;
  if(window.NexusOfflineSyncQueue)window.NexusOfflineSyncQueue.rememberStamp(localStorage,newUserId,lastRemoteStamp);
  ready=true;say('Loaded this account’s cloud workspace. Offline changes belonging to the previous account remain saved separately.');
 }else{
  await resetToEmpty(newUserId);if(window.NexusOfflineSyncQueue)window.NexusOfflineSyncQueue.rememberStamp(localStorage,newUserId,null);
  ready=true;enqueueInitialSnapshot(newUserId);
  const firstUpload=await upload();
  if(!firstUpload){ready=false;status('Sync not verified');say('This account’s empty workspace is saved locally but its cloud state is not verified. Previous-account changes remain preserved; reconnect to retry.');localStorage.setItem(OWNER_KEY,newUserId);lastUserId=newUserId;return;}
  say('Created a new workspace for this account. Previous-account changes remain saved separately and were not uploaded.');
 }
 localStorage.setItem(OWNER_KEY,newUserId);lastUserId=newUserId;
 if(ready){await flushDurableLocalWrites();status('Synced');}
 return;
}
const localData={state:localPayload.state,featureState:localPayload.featureState||{}},remoteData=remote&&remote.payload?{state:remote.payload.state,featureState:remote.payload.featureState||{}}:null;let localHasWork=(pendingForUser?(!remoteData||!(await sameWorkspace(localData,remoteData))):(remoteData?!(await sameWorkspace(localData,remoteData)):hasLocalWork(localPayload)));let pendingAutomaticallySynced=false,cloudWorkspaceAutoLoaded=false;if(adoptedUnassignedLocalWorkspace){
// The guest workspace has already been explicitly classified as this first account's
// local workspace above. Do not send it through the generic local-vs-cloud choice dialog
// a second time: that dialog can restore an empty cloud and discard the curriculum on refresh.
ready=true;const adoptedUpload=await upload();if(!adoptedUpload){lastUserId=newUserId;localStorage.setItem(OWNER_KEY,newUserId);return;}pendingForUser=null;localHasWork=false;pendingAutomaticallySynced=true;
}if(!pendingForUser&&owner===newUserId&&remoteData&&(!(await sameWorkspace(localData,remoteData))||hasMissingBaselineCurriculumIntent(newUserId,localPayload,remote.payload))){const reconciliation=await reconcileOwnedWorkspace(newUserId,localPayload,remote);if(!reconciliation.ok){ready=false;status('Automatic merge not verified');say((reconciliation.reason||'The same-account workspace could not be reconciled safely.')+' Local data is preserved. Do not clear this browser’s data.');if(/cloud changed repeatedly|upload could not be verified|verification did not finish/i.test(reconciliation.reason||''))scheduleRetry();localStorage.setItem(OWNER_KEY,newUserId);lastUserId=newUserId;return;}localHasWork=false;pendingAutomaticallySynced=!reconciliation.cloudLoaded;cloudWorkspaceAutoLoaded=!!reconciliation.cloudLoaded;if(reconciliation.conflicts){say('This account’s offline and cloud changes were automatically merged. '+reconciliation.conflicts+' overlapping edit(s) were archived for recovery.');}else if(reconciliation.cloudLoaded){say('Loaded this account’s newer cloud workspace automatically. This device had no unsynced local changes.');}else{say('This account’s local and cloud changes were automatically merged and verified.');}}if(pendingForUser&&owner===newUserId&&remoteData&&(((pendingForUser.baseServerVersion||null)!==(remote.updated_at||null)&&!(await sameWorkspace(remoteData,pendingForUser.payload)))||hasMissingBaselineCurriculumIntent(newUserId,pendingForUser.payload,remote.payload))){const reconciliation=await reconcileConcurrentSnapshot(newUserId,remote);if(!reconciliation.ok){ready=false;status('Automatic merge not verified');say((reconciliation.reason||'The local changes are preserved, but the merged cloud state is not verified.')+' Your offline work remains queued. Do not clear this browser’s data.');if(/cloud changed repeatedly|upload could not be verified|verification did not finish/i.test(reconciliation.reason||''))scheduleRetry();localStorage.setItem(OWNER_KEY,newUserId);lastUserId=newUserId;return;}pendingForUser=null;localHasWork=false;pendingAutomaticallySynced=true;if(reconciliation.conflicts){say('Offline and cloud changes were automatically merged. '+reconciliation.conflicts+' overlapping field edit(s) used local-device precedence. Alternate values were saved in this device’s conflict recovery archive.');}else{say('Offline and cloud changes were automatically merged and verified. Independent edits were combined without a workspace-choice dialog.');}}if(pendingForUser&&owner===newUserId&&window.NexusCloudSyncRecovery&&window.NexusCloudSyncRecovery.canAutoResumePending(pendingForUser,remote&&remote.updated_at||null)){lastRemoteStamp=remote&&remote.updated_at||null;ready=true;const autoUploaded=await upload();if(!autoUploaded){ready=false;return;}pendingForUser=null;localHasWork=false;pendingAutomaticallySynced=true;say('Offline changes were automatically uploaded and verified for this account.');}if(localHasWork){let choice=await chooseLocalData();if(choice==='cancel'){ready=false;status('Data choice required');say('Your offline data is preserved. Choose one of the available data options before cloud sync can continue.');return;}while(choice==='replace-cloud'||choice==='replace'){const confirmed=choice==='replace-cloud'?confirm('FINAL CONFIRMATION: overwrite this account’s entire cloud backup with the offline data on this device? Download a backup first if needed.'):remote&&remote.payload?confirm('FINAL CONFIRMATION: replace this device’s offline workspace with this account’s cloud backup? Unsynced local changes that are not in the cloud will be lost. Download a backup first if needed.'):confirm('FINAL CONFIRMATION: start this account with a clean workspace? This will replace the offline data on this device, and no cloud backup is available to restore it. Download a backup first if needed.');if(confirmed)break;ready=false;status('Data choice required');say('Cancelled. Your offline data has not been changed. Choose an option below to continue.');choice=await chooseLocalData();if(choice==='cancel'){ready=false;status('Data choice required');say('Your offline data is preserved. Choose one of the available data options before cloud sync can continue.');return;}}if(choice==='merge'&&owner&&owner!==newUserId&&!confirm('This device was previously associated with a different account. Merging will copy the entire local workspace, which may include data from that previous account, into the newly signed-in account. Continue only if that is what you intend.')){ready=false;status('Data choice required');say('Merge cancelled. The local workspace is preserved and has not been uploaded to this account.');return;}await applyWorkspaceSnapshot(normalizeState(localPayload.state),window.NexusNormalizeFeatureState(localPayload.featureState||{}),newUserId);owner=newUserId;localPayload=snapshot();if(choice==='merge'){lastRemoteStamp=remote&&remote.payload?remote.updated_at:null;await applyLocalMerged(localPayload,remote&&remote.payload?remote.payload:null);if(window.NexusOfflineSyncQueue)window.NexusOfflineSyncQueue.rebase(localStorage,newUserId,snapshot(),lastRemoteStamp,'user-merge');ready=true;const uploaded=await upload();if(uploaded){say(remote&&remote.payload?'Offline work was merged with this account’s cloud data.':'Offline work was kept and uploaded as this account’s first backup.');}else{ready=false;status('Sync not verified');say('The merge is saved locally, but cloud sync was not verified. Your local data is preserved. Reconnect and retry before assuming the cloud has it.');}}else if(choice==='replace-cloud'){lastRemoteStamp=remote&&remote.payload?remote.updated_at:null;if(window.NexusOfflineSyncQueue)window.NexusOfflineSyncQueue.rebase(localStorage,newUserId,snapshot(),lastRemoteStamp,'user-confirmed-cloud-replace');ready=true;const uploaded=await upload();if(uploaded){say('Verified: the cloud backup now matches this device’s offline data.');}else{ready=false;status('Cloud replacement not verified');say('The cloud replacement was NOT confirmed. Your offline data remains on this device. Reconnect and retry the data choice. Do not assume the cloud was updated.');}}else{if(pendingForUser&&window.NexusOfflineSyncQueue)window.NexusOfflineSyncQueue.archive(localStorage,newUserId,'user-selected-cloud-restore');if(remote&&remote.payload){await applyRemote(remote.payload,newUserId,remote.updated_at||null);lastRemoteStamp=remote.updated_at;if(window.NexusOfflineSyncQueue)window.NexusOfflineSyncQueue.rememberStamp(localStorage,newUserId,lastRemoteStamp);ready=true;say('This device now contains the verified cloud workspace. The cloud backup was not rewritten.');}else{await resetToEmpty(newUserId);if(window.NexusOfflineSyncQueue)window.NexusOfflineSyncQueue.rememberStamp(localStorage,newUserId,null);ready=true;enqueueInitialSnapshot(newUserId);const uploaded=await upload();if(!uploaded)say('A clean workspace was saved locally, but its cloud state is not yet verified. Nexus will retry automatically.');else say('Started this account with a clean workspace. Offline work was not uploaded.');}}}else if(cloudWorkspaceAutoLoaded){say('Loaded this account’s newer cloud workspace automatically.');}else if(pendingAutomaticallySynced){say('Offline work was uploaded and verified for this account.');}else if(remote&&remote.payload){await applyRemote(remote.payload,newUserId,remote.updated_at||null);lastRemoteStamp=remote.updated_at;if(window.NexusOfflineSyncQueue)window.NexusOfflineSyncQueue.rememberStamp(localStorage,newUserId,lastRemoteStamp);say('Loaded this account’s cloud data. Future changes sync automatically.');}else{await resetToEmpty(newUserId);ready=true;enqueueInitialSnapshot(newUserId);const uploaded=await upload();if(!uploaded)say('A clean workspace was saved locally, but its cloud state is not yet verified. Nexus will retry automatically.');else say('A clean workspace was created for this account.');}localStorage.setItem(OWNER_KEY,newUserId);lastUserId=newUserId;if(ready){await flushDurableLocalWrites();status('Synced');}syncDiag('initialize-finished',diagnosticWorkspace(),{ready,remoteHadPayload:!!(remote&&remote.payload)});}catch(e){
 syncDiag('initialize-error',diagnosticWorkspace(),{errorMessage:String(e&&e.message||'unknown').slice(0,120)});
 ready=false;
 let offlineWorkspaceSource=null;
 if(requestedUserId&&session&&session.user&&session.user.id===requestedUserId){
  try{offlineWorkspaceSource=await recoverCachedWorkspaceForOfflineAccount(requestedUserId);}catch(recoveryError){syncDiag('offline-account-recovery-error',null,{errorMessage:String(recoveryError&&recoveryError.message||'unknown').slice(0,120)});}
 }
 if(offlineWorkspaceSource==='active'){
  status('Offline · local workspace');
  say('Cloud is unavailable. This account’s current local workspace remains available on this device. Changes will stay local and queued until sync is verified.');
 }else if(offlineWorkspaceSource){
  status('Offline · local workspace loaded');
  say('Cloud is unavailable. Loaded this account’s own saved workspace from '+(offlineWorkspaceSource==='pending'?'its pending offline snapshot':offlineWorkspaceSource==='verified-base'?'its last verified local baseline':'this device’s durable workspace')+'. Changes remain local until the cloud can be checked.');
 }else{
  status('Sync unavailable');
  say('Cloud sync error: '+((e&&e.message)||'unknown error')+'. Local changes are preserved and sync is paused. If you signed into another account while offline, its workspace is not cached here. The previous account remains protected and hidden. Reconnect to load the correct account.');
 }
 console.error('Nexus account initialization failed',e);scheduleRetry();
}finally{syncDiag('initialize-settled',diagnosticWorkspace(),{hasSession:!!(session&&session.user),ready,ownerPresent:!!localStorage.getItem(OWNER_KEY)});initializing=false;initializingUserId=null;setControls();if(hasQueuedSession){const nextSession=queuedSession;queuedSession=null;hasQueuedSession=false;setTimeout(()=>initializeSession(nextSession),0);}}}

async function sameWorkspace(a,b){if(!a||!b)return false;const merger=window.NexusWorkspaceSyncMerge;if(!merger||typeof merger.sameAsync!=='function')throw new Error('Safe large-workspace comparison is unavailable.');return merger.sameAsync({state:a.state||{},featureState:a.featureState||{}},{state:b.state||{},featureState:b.featureState||{}});}
async function upload(){
 if(deletingAccount||!localQueueHealthy||!client||!session||!ready)return false;
 if(syncing){pendingSync=true;return false;}
 const uploadUserId=session.user.id;
 async function assertUploadOwner(){await assertActiveUser(uploadUserId);if(localStorage.getItem(OWNER_KEY)!==uploadUserId)throw new Error('The local workspace owner changed during sync. The pending snapshot was not applied to another account.');}
 if(localStorage.getItem(OWNER_KEY)!==uploadUserId){ready=false;status('Account queue paused');say('The active account does not own this local workspace. No cloud write was attempted. Reconnect to the correct account.');return false;}
 syncing=true;status('Syncing…');syncDiag('upload-start',diagnosticWorkspace(),{hasQueue:!!window.NexusOfflineSyncQueue});let uploaded=false,retryReconcileAfterConflict=false,attemptedPayload=null,attemptedOperationId=null,attemptedBase=null,attemptedPriorStamp=null;
 const queue=window.NexusOfflineSyncQueue;
 try{
  const durableStorage=window.NexusStorage;if(durableStorage&&typeof durableStorage.isEnabled==='function'&&durableStorage.isEnabled()&&typeof durableStorage.flush==='function')await durableStorage.flush();
   const {data:authData,error:authError}=await client.auth.getUser();
  if(authError)throw new Error('Supabase could not verify the active login before cloud write: '+authError.message);
  if(!authData.user||authData.user.id!==uploadUserId||!session||session.user.id!==uploadUserId)throw new Error('The active Google/account session changed or could not be verified. Cloud write paused to protect the other account. Sign in again and retry.');
  let pending=null;
  if(queue){
   try{pending=queue.getPending(localStorage,uploadUserId);}
   catch(error){
    if(error&&error.code!=='NEXUS_OFFLINE_QUEUE_TOO_LARGE')throw error;
    pending=rebuildOversizedOfflineQueue(queue,uploadUserId,snapshot(),lastRemoteStamp,'upload-start');
   }
  }
  const priorStamp=lastRemoteStamp;attemptedPriorStamp=priorStamp;
  // Rebuild catalogue-owned rows before any cloud write. Commit the repaired workspace and
  // matching outbox snapshot together so an old queued snapshot cannot remove local pack rows.
  if(window.NexusRepairCurriculumState&&window.NexusStorageKey&&queue){
   const beforeRepairState=state;
   state=window.NexusRepairCurriculumState(state);
   if(!(await sameWorkspace({state:beforeRepairState,featureState:{}},{state,featureState:{}}))){
    const repairPayload={state:clone(state),featureState:window.NexusGetFeatureState?window.NexusGetFeatureState():{}};
    queue.commitWorkspace(localStorage,[{key:window.NexusStorageKey,value:JSON.stringify(state)}],repairPayload,{baseServerVersion:pending?pending.baseServerVersion:(priorStamp||null),returnOperationPayload:false});
    pending=queue.getPending(localStorage,uploadUserId);
    renderAll();
   }
  }
  const payload=pending?pending.payload:snapshot();syncDiag('upload-payload-selected',payload,{fromPending:!!pending,hasPending:!!pending});attemptedPayload=payload;attemptedOperationId=pending?pending.operationId:null;attemptedBase=pending?pending.baseServerVersion:(priorStamp||null);
  if(pending){
   const before=await fetchRemote(uploadUserId);
   await assertUploadOwner();
   if(before&&before.payload&&(await sameWorkspace(before.payload,payload))){
     syncDiag('upload-skipped-cloud-already-matches',before.payload,{matchesAttempted:true});
    lastRemoteStamp=before.updated_at||null;
    queue.rememberBase(localStorage,uploadUserId,before.payload,lastRemoteStamp);
    queue.acknowledge(localStorage,uploadUserId,pending.operationId,pending.baseServerVersion,lastRemoteStamp);
    await flushDurableLocalWrites();status('Synced');uploaded=true;return true;
   }
   const actualStamp=before&&before.updated_at?before.updated_at:null;
   if(actualStamp!==(pending.baseServerVersion||null)){const conflict=new Error('The cloud revision changed since this offline snapshot was queued.');conflict.code='NEXUS_CLOUD_CONFLICT';throw conflict;}
   const stamp=nextCloudStamp(pending.baseServerVersion);
   await assertUploadOwner();
   const writeResult=await writeRemoteSnapshot(uploadUserId,payload,pending.baseServerVersion,stamp);
   const verify=await fetchRemote(uploadUserId,writeResult);
   await assertUploadOwner();
   const verificationMatches=!!(verify&&verify.payload&&await sameWorkspace(verify.payload,payload));syncDiag('upload-verification-readback',verify&&verify.payload,{readbackHasPayload:!!(verify&&verify.payload),matchesAttempted:verificationMatches});if(!verificationMatches){const conflict=new Error('The remote cloud snapshot changed during write verification.');conflict.code='NEXUS_CLOUD_CONFLICT';throw conflict;}
   lastRemoteStamp=verify.updated_at||stamp;
   queue.rememberBase(localStorage,uploadUserId,verify.payload,lastRemoteStamp);
   queue.acknowledge(localStorage,uploadUserId,pending.operationId,pending.baseServerVersion,lastRemoteStamp);
   const laterPending=queue.getPending(localStorage,uploadUserId);if(laterPending&&laterPending.operationId!==pending.operationId&&(laterPending.baseServerVersion||null)===(pending.baseServerVersion||null))queue.rebase(localStorage,uploadUserId,snapshot(),lastRemoteStamp,'local-change-during-upload');
  }else{
   const stamp=nextCloudStamp(priorStamp);
   const writeResult=await writeRemoteSnapshot(uploadUserId,payload,priorStamp,stamp);
   const verify=await fetchRemote(uploadUserId,writeResult);
   await assertUploadOwner();
   if(!verify||!verify.payload||!(await sameWorkspace(verify.payload,payload))){const conflict=new Error('The remote cloud snapshot changed during write verification.');conflict.code='NEXUS_CLOUD_CONFLICT';throw conflict;}
   lastRemoteStamp=verify.updated_at||stamp;
   if(queue){
    queue.rememberBase(localStorage,uploadUserId,verify.payload,lastRemoteStamp);
    queue.rememberStamp(localStorage,uploadUserId,lastRemoteStamp);
    const later=queue.getPending(localStorage,uploadUserId);
    if(later&&later.baseServerVersion===(priorStamp||null))queue.rebase(localStorage,uploadUserId,snapshot(),lastRemoteStamp,'local-change-during-upload');
   }
  }
  await flushDurableLocalWrites();status('Synced');uploaded=true;
 }catch(e){
  syncDiag('upload-error',attemptedPayload,{errorCode:String(e&&e.code||'unknown'),errorMessage:String(e&&e.message||'unknown').slice(0,120)});
  if(e&&e.code==='NEXUS_CLOUD_CONFLICT'){
   let alreadyCommitted=false;
   try{
    if(attemptedPayload){
     await assertUploadOwner();
     const latest=await fetchRemote(uploadUserId);
     await assertUploadOwner();
     if(latest&&latest.payload&&(await sameWorkspace(latest.payload,attemptedPayload))){
      lastRemoteStamp=latest.updated_at||null;
      // A matching read-back proves this exact snapshot is the new cloud baseline,
      // even when the conditional write returned an ambiguous conflict response.
      // Advance the merge base before acknowledging the queue so later offline
      // edits cannot compare against an obsolete baseline and resurrect deletions.
      if(queue)queue.rememberBase(localStorage,uploadUserId,latest.payload,lastRemoteStamp);
      if(queue&&attemptedOperationId)queue.acknowledge(localStorage,uploadUserId,attemptedOperationId,attemptedBase,lastRemoteStamp);
      else if(queue){queue.rememberStamp(localStorage,uploadUserId,lastRemoteStamp);const later=queue.getPending(localStorage,uploadUserId);if(later&&later.baseServerVersion===(attemptedPriorStamp||null))queue.rebase(localStorage,uploadUserId,snapshot(),lastRemoteStamp,'local-change-during-upload');}
      await flushDurableLocalWrites();status('Synced');say('Verified: the cloud already contains this exact snapshot, so the interrupted write was safely acknowledged.');uploaded=true;alreadyCommitted=true;
     }else if(latest&&latest.payload&&localStorage.getItem(OWNER_KEY)===uploadUserId&&session&&session.user.id===uploadUserId){
      // The write raced with a real cloud edit. Preserve the queued snapshot and
      // reconnect once this upload/init turn has settled so normal initialization
      // performs the three-way merge without requiring a page refresh.
      retryReconcileAfterConflict=true;
     }
    }
   }catch(recoveryError){
    console.warn('Nexus ambiguous cloud-write recovery could not verify the snapshot',recoveryError);
    if(localStorage.getItem(OWNER_KEY)===uploadUserId&&session&&session.user.id===uploadUserId)retryReconcileAfterConflict=true;
   }
   if(!alreadyCommitted){ready=false;status('Cloud conflict');say(retryReconcileAfterConflict?'Another device changed this account’s cloud backup at the same time. Your local snapshot is preserved. Nexus is reopening the latest revision to merge both workspaces automatically.':'The cloud conflict could not be verified automatically. Your local data and pending snapshot are preserved. Reconnect before retrying.');}
  }
  else{ready=false;status('Sync error');say('Cloud upload failed or could not be verified. Local data and the pending snapshot are preserved. Nexus will retry automatically when the connection is available.');scheduleRetry();}
  console.error('Nexus cloud sync failed',e);
 }finally{syncing=false;if(retryReconcileAfterConflict){retryReconcileAfterConflict=false;setTimeout(()=>{const activeConnect=connectPromise;if(activeConnect)activeConnect.then(()=>connect());else connect();},0);}if(pendingSync){pendingSync=false;if(ready)schedule();else scheduleRetry();}}
 return uploaded;
}
let localQueueHealthy=true,localMutationRevision=0;
function recordWorkspaceSave(payload,reason){
 if(deletingAccount)return;
 localMutationRevision++;
 if(!payload||!payload.state)return;
 const ownerId=session&&session.user?session.user.id:null;
 if(!ownerId||!ready||localStorage.getItem(OWNER_KEY)!==ownerId)return;
 const queue=window.NexusOfflineSyncQueue;
 if(!queue||!window.NexusStorageKey||!window.NexusFeatureStorageKey){
  localQueueHealthy=false;status('Sync queue unavailable');
  say('Your changes are saved on this device, but the cloud queue is unavailable. Local data is preserved. Do not clear browser data.');
  syncDiag('local-save-queue-error',payload,{reason:reason||'local-save',errorMessage:'Safe offline queue unavailable'});
  return;
 }
 const nextPayload={app:'Nexus Spaced Repetition Tracker',schema:4,exportedAt:new Date().toISOString(),state:clone(payload.state),featureState:clone(payload.featureState||{})};
 const trackerJson=JSON.stringify(nextPayload.state),featureJson=JSON.stringify(nextPayload.featureState);
 try{
  let pending=null;
  try{pending=queue.getPending(localStorage,ownerId);}
  catch(error){
   if(error&&error.code!=='NEXUS_OFFLINE_QUEUE_TOO_LARGE')throw error;
   pending=rebuildOversizedOfflineQueue(queue,ownerId,nextPayload,lastRemoteStamp,'local-save');
   localQueueHealthy=true;
   syncDiag('local-save-queued',nextPayload,{reason:reason||'local-save',hadPending:false,payloadCharacters:trackerJson.length+featureJson.length,queueRebuilt:true});
   schedule();
   return;
  }
  queue.commitWorkspace(localStorage,[
   {key:window.NexusStorageKey,value:trackerJson},
   {key:window.NexusFeatureStorageKey,value:featureJson}
  ],nextPayload,{baseServerVersion:pending?pending.baseServerVersion:(lastRemoteStamp||null)});
  localQueueHealthy=true;
  syncDiag('local-save-queued',nextPayload,{reason:reason||'local-save',hadPending:!!pending,payloadCharacters:trackerJson.length+featureJson.length});
 }catch(e){
  localQueueHealthy=false;
  status('Sync queue error');
  say('Your changes are saved on this device, but the cloud queue could not be updated safely. Sync is paused to prevent an older snapshot overwriting your work. Export a JSON backup before clearing storage, then retry after checking available device storage.');
  syncDiag('local-save-queue-error',payload,{reason:reason||'local-save',errorCode:String(e&&e.code||'unknown'),errorMessage:String(e&&e.message||'unknown').slice(0,120)});
  console.error('Nexus could not queue the latest local workspace safely',e);
 }
}
function schedule(){if(deletingAccount||!localQueueHealthy||!client||!session||!ready||(typeof navigator!=='undefined'&&!navigator.onLine))return;clearTimeout(timer);timer=setTimeout(()=>{if(syncing){pendingSync=true;return;}upload();},650);}
function createSafeAuthStorage(storage){
  // A literal "undefined" or other invalid value in Supabase's persisted
  // session key can make auth initialization throw before account sync starts.
  // Repair only the session-token key; never touch Nexus workspace data.
  const isSessionKey=key=>/^sb-.+-auth-token$/.test(String(key||''));
  return {
   getItem(key){
    const raw=storage.getItem(key);
    if(raw===null||!isSessionKey(key))return raw;
    try{const parsed=JSON.parse(raw);if(parsed&&typeof parsed==='object'&&!Array.isArray(parsed))return raw;}catch(_){}
    try{storage.removeItem(key);}catch(error){console.warn('Could not clear malformed Supabase session storage.',error);}
    console.warn('Discarded malformed Supabase session token; Nexus study data was left untouched.');
    return null;
   },
   setItem(key,value){return storage.setItem(key,value);},
   removeItem(key){return storage.removeItem(key);}
  };
}
async function ensureClient(){if(isUnsafeCloudOrigin())throw new Error('Cloud sync is disabled on this preview/local copy to protect real cloud data.');if(client)return client;const c=config();if(!window.supabase||!window.supabase.createClient)await loadSupabaseLibrary();if(!client){client=window.supabase.createClient(c.url,c.key,{auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:true,storage:createSafeAuthStorage(localStorage)}});client.auth.onAuthStateChange((event,newSession)=>{session=newSession||null;syncDiag('auth-event',diagnosticWorkspace(),{event,hasSession:!!(newSession&&newSession.user),ownerPresent:!!localStorage.getItem(OWNER_KEY)});if(event==='TOKEN_REFRESHED'||event==='USER_UPDATED'){session=newSession;setControls();return;}if(event==='SIGNED_OUT'){session=null;ready=false;deletionServiceCheckedUser=null;deletionServiceAvailable=false;clearTimeout(timer);clearRetry();if(initializing&&initializingUserId){queuedSession=null;hasQueuedSession=true;}status('Not signed in · offline ready');say('You can continue using your local data offline. Signing out does not erase it.');setControls();return;}if(event==='SIGNED_IN'||event==='INITIAL_SESSION'){const uid=newSession&&newSession.user?newSession.user.id:null;if(uid!==lastUserId||!ready)setTimeout(()=>initializeSession(newSession),0);else{session=newSession;setControls();}}});}return client;}
let connectPromise=null;function connect(){if(isUnsafeCloudOrigin()){previewCloudBlockedMessage();setControls();return Promise.resolve();}if(connectPromise)return connectPromise;connectPromise=(async()=>{try{await ensureClient();const {data:{session:s},error}=await client.auth.getSession();if(error)throw error;await initializeSession(s);}catch(e){status('Connection error');say('Connection error: '+((e&&e.message)||'unknown error')+'. You can still use Nexus offline; reconnect to sign in and sync.');console.error('Nexus connection failed',e);scheduleRetry();}finally{connectPromise=null;}})();return connectPromise;}
async function googleSignIn(){try{if(isUnsafeCloudOrigin()){previewCloudBlockedMessage();setControls();return;}if(session){say('You are already signed in. Sign out before connecting a different account.');return;}status('Opening Google sign-in…');await ensureClient();const {data,error}=await client.auth.signInWithOAuth({provider:'google',options:{redirectTo:authRedirectUrl(),queryParams:{prompt:'select_account'}}});if(error)throw error;if(data&&data.url)location.assign(data.url);}catch(e){status('Google sign-in failed');say((e&&e.message)||'Could not start Google sign-in. Check your connection and try again.');console.error('Nexus Google sign-in failed',e);}}
async function emailSignIn(){try{if(isUnsafeCloudOrigin()){previewCloudBlockedMessage();setControls();return;}if(session){say('You are already signed in. Sign out before connecting a different account.');return;}status('Preparing email sign-in…');await ensureClient();const email=prompt('Enter your email address to receive a sign-in link:');if(!email){status(session&&ready?'Synced':'Not signed in · offline ready');return;}const {error}=await client.auth.signInWithOtp({email,options:{emailRedirectTo:authRedirectUrl()}});if(error)throw error;say('Check your email for the sign-in link.');status('Email sign-in link sent');}catch(e){status('Email sign-in failed');say((e&&e.message)||'Could not send the sign-in link. Check your connection and try again.');console.error('Nexus email sign-in failed',e);}}
async function checkAccountDeletionService(){
 const userId=session&&session.user&&session.user.id;
 if(!userId||!ready||deletingAccount||!client)return false;
 if(deletionServiceCheckedUser===userId)return deletionServiceAvailable;
 deletionServiceCheckedUser=userId;deletionServiceAvailable=false;
 try{const {data,error}=await client.functions.invoke('delete-account',{method:'GET'});deletionServiceAvailable=!error&&!!(data&&data.ready===true);}
 catch(error){console.info('Nexus account deletion service is not enabled on this Supabase environment.',error&&error.message||error);}
 finally{if(session&&session.user&&session.user.id===userId)setControls();}
 return deletionServiceAvailable;
 }
function getAccountState(){return {signedIn:!!(session&&session.user&&session.user.id),ready:!!ready,email:session&&session.user&&session.user.email||'',deleting:deletingAccount,previewBlocked:isUnsafeCloudOrigin(),deletionServiceAvailable};}
async function clearDeletedAccountLocalData(userId){
 const queue=window.NexusOfflineSyncQueue;
 if(!queue||typeof queue.forgetAccount!=='function')throw new Error('Account-specific local cleanup is unavailable. Update Nexus and retry.');
 const keep=new Set([CFG_KEY,OWNER_KEY,queue.KEY,queue.STAMP,queue.BASE,queue.CONFLICTS,queue.QUARANTINE]);
 const entries=[],seen=new Set();
 for(let i=0;i<localStorage.length;i++){
  const key=localStorage.key(i);
  if(!key||keep.has(key)||key.startsWith('nexus.storage.internal.'))continue;
  if(key.startsWith('recall.')||key.startsWith('nexus.')||key==='alSrsTrackerV2'||key==='alTrackerData'||key==='alHistoryLog'){
   entries.push({key,value:null});seen.add(key);
  }
 }
 for(const key of ['recall.study.tracker.v1','recall.study.features.v1'])if(!seen.has(key))entries.push({key,value:null});
 const cleanup=queue.forgetAccount(localStorage,userId,entries);
 const storage=window.NexusStorage;
 if(storage&&typeof storage.flush==='function')await storage.flush();
 // Remove the owner marker only after the same-owner IndexedDB workspace projection was deleted.
 localStorage.removeItem(OWNER_KEY);
 if(storage&&typeof storage.flush==='function')await storage.flush();
 return cleanup;
}
async function deleteCurrentAccount(){
 if(isUnsafeCloudOrigin())throw new Error('Account deletion is disabled on an unsafe preview or local origin.');
 if(!client||!session||!session.user||!session.user.id)throw new Error('Sign in to the account you want to delete first.');
 if(!ready||lastUserId!==session.user.id||localStorage.getItem(OWNER_KEY)!==session.user.id)throw new Error('Nexus has not finished verifying this account and its workspace. Wait for the account status to show Synced, then retry.');
 if(!deletionServiceAvailable||deletionServiceCheckedUser!==session.user.id)throw new Error('The account-deletion service is not deployed on this Supabase project yet. Your data has not been deleted.');
 if(syncing||initializing)throw new Error('Nexus is currently syncing or loading this account. Wait until it finishes, then retry.');
 if(typeof navigator!=='undefined'&&!navigator.onLine)throw new Error('An internet connection is required to delete a cloud account.');
 const userId=session.user.id;
 const {data:authData,error:authError}=await client.auth.getUser();
 if(authError||!authData||!authData.user||authData.user.id!==userId)throw new Error('Supabase could not verify the currently signed-in account. Sign in again before deleting it.');
 deletingAccount=true;clearTimeout(timer);clearRetry();pendingSync=false;
 try{
  const {error}=await client.functions.invoke('delete-account',{method:'POST',body:{}});
  if(error){
   let code='',serverMessage='';
   try{const response=error.context;if(response&&typeof response.clone==='function'){const body=await response.clone().json();code=String(body&&body.code||'');serverMessage=String(body&&body.error||'');}}catch(_){}
   if(code==='reauthentication_required')throw new Error('For security, sign in again immediately before deleting your account, then reopen the Danger Zone and retry.');
   throw new Error(serverMessage||error.message||'The account-deletion service could not complete the request. Your local workspace has been kept.');
  }
  let localCleanup={quarantineRetained:false},localCleanupError=null;
  try{localCleanup=await clearDeletedAccountLocalData(userId);}catch(error){localCleanupError=error;console.error('Nexus cloud account was deleted, but this device could not complete all local cleanup.',error);}
  try{const {error:signOutError}=await client.auth.signOut({scope:'local'});if(signOutError)throw signOutError;}catch(error){
   console.warn('Supabase local sign-out did not complete after account deletion; removing the persisted auth session locally.',error);
   for(let i=localStorage.length-1;i>=0;i--){const key=localStorage.key(i);if(key&&/^sb-.+-auth-token(?:-code-verifier)?$/.test(key)){try{localStorage.removeItem(key);}catch(_){}}}
  }
  session=null;ready=false;lastUserId=null;deletionServiceCheckedUser=null;deletionServiceAvailable=false;localQueueHealthy=true;clearTimeout(timer);clearRetry();status('Account deleted · signed out');
  say(localCleanupError||localCleanup.quarantineRetained?'Your cloud account has been deleted. Some local recovery data could not be safely cleared; clear Nexus site data on this device and on any other devices you used.':'Your cloud account and this device’s Nexus workspace have been deleted. Clear Nexus site data on any other devices and delete any downloaded backups separately.');
  setControls();
  return {success:true,localCleanupComplete:!localCleanupError&&!localCleanup.quarantineRetained,quarantineRetained:!!localCleanup.quarantineRetained};
 }catch(error){
  deletingAccount=false;
  if(session&&ready)schedule();
  throw error;
 }finally{
  if(!session)deletingAccount=false;
 }
}
async function signOut(){if(client)await client.auth.signOut();session=null;ready=false;clearTimeout(timer);clearRetry();status('Not signed in · offline ready');say('You are signed out. Continue using this device offline; data remains local.');setControls();}
window.NexusCloudSync={schedule,upload,reconnect:connect,getAccountState,deleteAccount:deleteCurrentAccount,recordLocalSave:(payload)=>{const p=payload&&payload.state?payload:snapshot();syncDiag('workspace-saved-locally',p);recordWorkspaceSave(p,'local-save');},recordInstall:(payload)=>{const p=payload&&payload.state?payload:{state:payload||state,featureState:window.NexusGetFeatureState?window.NexusGetFeatureState():{}};syncDiag('curriculum-install-save-requested',p);recordWorkspaceSave(p,'curriculum-install');}};window.addEventListener('online',resumeAfterConnectivity);window.addEventListener('offline',()=>{if(session){status('Offline · changes saved locally');say('You can continue studying. Local changes are queued for this account and will sync when the connection returns.');}});document.addEventListener('visibilitychange',()=>{if(!document.hidden)resumeAfterConnectivity();});window.addEventListener('pageshow',resumeAfterConnectivity);function startCloudSyncUi(){installSyncDiagnosticsButton();if(SYNC_DIAG_ENABLED&&document.body&&typeof MutationObserver!=='undefined'){const diagObserver=new MutationObserver(()=>{if(!el('nexusSyncDiagnosticsDownload'))installSyncDiagnosticsButton();});diagObserver.observe(document.body,{childList:true,subtree:true});}el('cloudGoogleSignInBtn')?.addEventListener('click',googleSignIn);el('cloudEmailSignInBtn')?.addEventListener('click',emailSignIn);el('cloudSignOutBtn')?.addEventListener('click',signOut);connect();}if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',startCloudSyncUi,{once:true});else startCloudSyncUi();
})();