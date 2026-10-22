(function(){'use strict';
const CFG_KEY='nexus.cloud.config.v1',OWNER_KEY='nexus.cloud.last-user-id',DETACHED_OWNER_KEY='nexus.cloud.detached-workspace-owner.v1',DEFAULT_CONFIG={url:'https://txugbdavblpettcnhcxl.supabase.co',key:'sb_publishable_sQkKOf-CfHlG7mvA2sFjIg_qcezI2Fa'};
const LIVE_SUPABASE_URL='https://txugbdavblpettcnhcxl.supabase.co';
function isUnsafeCloudOrigin(){const host=location.hostname.toLowerCase(),url=String(config().url||'').trim();let cloudHost='';try{cloudHost=new URL(url).hostname.toLowerCase();}catch(_){}return cloudHost===new URL(LIVE_SUPABASE_URL).hostname&&host!=='spaced-repetition-tracker-delta.vercel.app'&&host!=='kkmalithmalshan2000-png.github.io';}
function previewCloudBlockedMessage(){status('Preview · cloud sync disabled');say('Cloud sync is disabled on this preview/local copy to protect real cloud data. Nexus still works offline. To test cloud sync, configure a separate Supabase test project on this device.');}
let client=null,session=null,syncing=false,ready=false,timer=null,retryTimer=null,retryAttempt=0,lastRemoteStamp=null,supabaseLoadPromise=null,pendingSync=false,lastUserId=null,initializing=false,initializingUserId=null,queuedSession=null,hasQueuedSession=false;
const el=id=>document.getElementById(id),status=m=>{if(el('cloudStatus'))el('cloudStatus').textContent=m;if(m==='Synced')clearRetry();},say=m=>{if(el('cloudHelpText'))el('cloudHelpText').textContent=m;updateConflictRecoveryButton();},config=()=>{try{return {...DEFAULT_CONFIG,...JSON.parse(localStorage.getItem(CFG_KEY)||'{}')}}catch(_){return {...DEFAULT_CONFIG}}};
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
  button.title='Download saved alternatives from overlapping offline/cloud edits. This archive is stored only in this browser/device for the signed-in account; it is not uploaded or synced to other devices. Download it before clearing this browser’s site data.';
 }catch(error){button.hidden=true;console.warn('Nexus conflict recovery archive could not be read.',error);}
}
function downloadConflictRecovery(){
 const queue=window.NexusOfflineSyncQueue,owner=conflictRecoveryOwner();
 if(!queue||!owner)return;
 try{
  const history=queue.getConflictHistory(localStorage,owner);
  if(!history.length){updateConflictRecoveryButton();return;}
  const data={app:'Nexus Spaced Repetition Tracker',type:'sync-conflict-recovery',schema:1,exportedAt:new Date().toISOString(),note:'This file records alternatives from same-account offline/cloud conflicts. The current workspace kept the deterministic merge result; the archived values are provided for manual inspection and recovery. This archive is stored only in the browser/device that detected the conflict and is not uploaded or synced to other devices.',conflictRecovery:history};
  const blob=new Blob([JSON.stringify(data,null,2)],{type:'application/json'});
  const url=URL.createObjectURL(blob),link=document.createElement('a');
  link.href=url;link.download='nexus-sync-conflict-recovery-'+new Date().toISOString().replace(/[:.]/g,'-')+'.json';
  document.body.appendChild(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
 }catch(error){status('Conflict recovery download failed');say('The conflict archive remains in this browser but could not be downloaded. Make a normal JSON backup and try again.');console.error('Nexus conflict recovery download failed',error);}
}
function clearRetry(){if(retryTimer){clearTimeout(retryTimer);retryTimer=null;}retryAttempt=0;}
function scheduleRetry(){if(retryTimer||isUnsafeCloudOrigin()||(typeof navigator!=='undefined'&&!navigator.onLine))return;const text=el('cloudStatus')?el('cloudStatus').textContent:'';const policy=window.NexusCloudSyncRecovery;if(policy&&!policy.shouldRetry(text))return;if(!policy&&/(cloud conflict|data choice required|account queue paused|not signed in)/i.test(text))return;const delay=policy?policy.retryDelay(retryAttempt):Math.min(300000,1500*Math.pow(2,Math.min(retryAttempt,8)));retryAttempt=Math.min(retryAttempt+1,8);retryTimer=setTimeout(()=>{retryTimer=null;if(typeof navigator!=='undefined'&&!navigator.onLine)return;if(syncing||initializing){scheduleRetry();return;}connect();},delay);}
function resumeAfterConnectivity(){if(isUnsafeCloudOrigin()||(typeof navigator!=='undefined'&&!navigator.onLine))return;const text=el('cloudStatus')?el('cloudStatus').textContent:'';const policy=window.NexusCloudSyncRecovery;if(policy&&!policy.shouldRetry(text))return;if(syncing){pendingSync=true;return;}if(initializing)return;if(session&&ready){let pending=false;try{pending=!!(window.NexusOfflineSyncQueue&&window.NexusOfflineSyncQueue.hasPending(localStorage,session.user.id));}catch(e){status('Sync error');say('The local sync queue could not be read. Local data is preserved; Nexus will retry safely.');scheduleRetry();return;}if(pending)schedule();else status('Synced');}else connect();}
function loadSupabaseLibrary(){if(window.supabase&&window.supabase.createClient)return Promise.resolve();if(supabaseLoadPromise)return supabaseLoadPromise;supabaseLoadPromise=new Promise((resolve,reject)=>{const script=document.createElement('script');script.src='https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.3';script.async=true;script.onload=()=>window.supabase&&window.supabase.createClient?resolve():reject(new Error('Supabase client did not initialize.'));script.onerror=()=>reject(new Error('Could not load Supabase client. Check internet access.'));document.head.appendChild(script);});return supabaseLoadPromise;}
function setControls(){const previewBlocked=isUnsafeCloudOrigin(),logged=!!session,connected=logged&&ready&&!initializing,busy=logged&&!connected;const google=el('cloudGoogleSignInBtn'),email=el('cloudEmailSignInBtn'),out=el('cloudSignOutBtn');if(out){out.disabled=!logged;out.setAttribute('aria-disabled',String(!logged));}if(google){google.hidden=false;google.disabled=logged||previewBlocked;google.classList.toggle('auth-signin-busy',logged);google.setAttribute('aria-disabled',String(logged||previewBlocked));google.setAttribute('aria-label','Sign in with Google');const label=google.querySelector('span');if(label)label.textContent='Sign in with Google';}if(email){email.hidden=false;email.disabled=logged||previewBlocked;email.classList.toggle('auth-signin-busy',logged);email.setAttribute('aria-disabled',String(logged||previewBlocked));email.setAttribute('aria-label','Sign in with email');const label=email.querySelector('span');if(label)label.textContent='Sign in with email';}if(el('cloudAccount'))el('cloudAccount').textContent=previewBlocked?'Preview/local copy — cloud sync disabled':logged?(session.user.email||'Signed-in account'):'Not signed in — offline mode is available';if(el('cloudAccount'))el('cloudAccount').title=previewBlocked?'Use a separate Supabase test project to test cloud sync here.':logged?'Account ID: '+session.user.id:'Your data stays on this device while signed out.';if(previewBlocked)previewCloudBlockedMessage();updateConflictRecoveryButton();}
function clearDetachedOwnerAfterSuccessfulReconciliation(ownerId,wasDetached){if(!wasDetached||!ownerId||!ready||localStorage.getItem(OWNER_KEY)!==ownerId)return false;const queue=window.NexusOfflineSyncQueue;if(!queue||typeof queue.getDetachedOwner!=='function'||!queue.getDetachedOwner(localStorage))return false;localStorage.setItem(DETACHED_OWNER_KEY,'');return true;}
function snapshot(){return {app:'Nexus Spaced Repetition Tracker',schema:4,exportedAt:new Date().toISOString(),state:clone(state),featureState:window.NexusGetFeatureState?window.NexusGetFeatureState():{}};}
function assertStableRecordIds(payload){
 const validate=(section,fields,label)=>{
  if(!section||typeof section!=='object')return;
  for(const field of fields){
   if(section[field]===undefined)continue;
   if(!Array.isArray(section[field]))throw new Error('Cannot safely sync malformed '+label+'.'+field+' records.');
   for(const row of section[field]){
    if(!row||typeof row!=='object'||Array.isArray(row)||row.id===undefined||row.id===null||String(row.id)==='')throw new Error('Cannot safely sync a '+label+'.'+field+' record without a stable ID. Local data is preserved; export a backup and repair the record before syncing.');
   }
  }
 };
 validate(payload.state,['streams','subjects','topics','history','exams'],'tracker');
 validate(payload.featureState,['journal','papers','goals','studyLogs'],'Study Hub');
}
function normalizeWorkspacePayload(payload){
 if(!payload||!payload.state||!Array.isArray(payload.state.streams))throw new Error('A valid workspace snapshot is required for automatic reconciliation.');
 assertStableRecordIds(payload);
 return {...payload,state:(window.NexusNormalizeState?window.NexusNormalizeState(payload.state):normalizeState(payload.state)),featureState:window.NexusNormalizeFeatureState(Object.prototype.hasOwnProperty.call(payload,'featureState')?payload.featureState:undefined)};
}
function nextCloudStamp(previous){
 const policy=window.NexusCloudSyncRecovery;
 if(policy&&typeof policy.nextRevisionStamp==='function')return policy.nextRevisionStamp(previous);
 const now=Date.now(),prior=Date.parse(previous||'');
 return new Date(Number.isFinite(prior)?Math.max(now,prior+1):now).toISOString();
}
async function assertActiveUser(userId){const {data,error}=await client.auth.getSession();if(error)throw error;const activeId=data&&data.session&&data.session.user?data.session.user.id:null;if(activeId!==userId||!session||session.user.id!==userId)throw new Error('The active account changed during sync. No cloud data was applied or written. Retry the account connection.');}
async function fetchRemote(userId){const uid=userId||(session&&session.user&&session.user.id);if(!client||!uid)throw new Error('No active account is available for cloud sync.');const {data,error}=await client.from('nexus_user_data').select('payload,updated_at').eq('user_id',uid).maybeSingle();if(error)throw error;return data;}
function emptyState(){return {schema:3,streams:[{id:'stream-general',name:'General'}],subjects:[{id:'subject-general',name:'General',streamId:'stream-general',order:0}],topics:[],exams:[],history:[],settings:{theme:'system',intervalCap:120}};}
function mergeState(local,remote){const l=normalizeState(local),r=normalizeState(remote),union=(a,b)=>{const m=new Map();for(const x of b||[])m.set(String(x.id),clone(x));for(const x of a||[])m.set(String(x.id),clone(x));return Array.from(m.values());};const streams=union(l.streams,r.streams),subjects=union(l.subjects,r.subjects),topics=union(l.topics,r.topics),exams=union(l.exams,r.exams),history=union(l.history,r.history);if(!streams.length)streams.push({id:'stream-general',name:'General'});const streamIds=new Set(streams.map(x=>x.id));for(const sub of subjects)if(!streamIds.has(sub.streamId))sub.streamId=streams[0].id;const subjectIds=new Set(subjects.map(x=>x.id));for(const t of topics)if(!subjectIds.has(t.subjectId)){const fallback=subjects[0]||{id:'subject-general',name:'General',streamId:streams[0].id,order:0};if(!subjectIds.has(fallback.id))subjects.push(fallback);t.subjectId=fallback.id;}return normalizeState({...r,streams,subjects,topics,exams,history,settings:{...r.settings,...l.settings}});}
function hasLocalWork(s){if(!s)return false;const core=s.state||s||{},f=s.featureState||{};const coreWork=!!(core.topics?.length||core.history?.length||core.exams?.length||core.streams?.length>1||core.subjects?.length>1);const featureWork=['journal','papers','goals','studyLogs','selectedTopicIds'].some(k=>Array.isArray(f[k])&&f[k].length>0)||Object.keys(f.syllabusTargets||{}).length>0||Object.keys(f.taskChecks||{}).length>0||!!(f.lastBackupAt||f.lastReminderAt||f.focusStartedAt||f.focusPausedAt||f.focusTopicId||f.focusSubjectId);const defaults={dailyMinutes:90,sessionMinutes:25,scheduler:'classic',weeklyReviewGoal:100,backlogDays:7,reminders:false,reminderTime:'08:00',maxInterval:120,finalRevision:false,workloadDays:7};const settings=f.settings||{};const settingsWork=Object.keys(defaults).some(k=>settings[k]!==undefined&&settings[k]!==defaults[k]);return coreWork||featureWork||settingsWork;}
function chooseLocalData(){return new Promise(resolve=>{const dlg=el('accountChoiceDialog');if(!dlg){resolve('cancel');return;}let done=false;const onCancel=e=>e.preventDefault();const finish=v=>{if(done)return;done=true;dlg.removeEventListener('cancel',onCancel);if(dlg.open)dlg.close();resolve(v);};dlg.addEventListener('cancel',onCancel);dlg.querySelectorAll('[data-account-choice]').forEach(b=>b.onclick=()=>finish(b.dataset.accountChoice));if(!dlg.open)dlg.showModal();});}
function applyWorkspaceSnapshot(nextState,rawFeatures,ownerId){
  if(!window.NexusBackupRestoreUtils||!window.NexusStorageKey||!window.NexusFeatureStorageKey||!window.NexusNormalizeFeatureState||!window.NexusSetFeatureState)throw new Error('Safe local workspace storage is unavailable. Cloud data was not applied.');
  // Every snapshot entry point (cloud restore, account reconciliation, and merge) must
  // pass through the same curriculum integrity guard before it is persisted locally.
  const safeState=window.NexusRepairInstalledCurricula?window.NexusRepairInstalledCurricula(nextState):nextState;
  const nextFeatures=window.NexusNormalizeFeatureState(rawFeatures);
  const entries=[
    {key:window.NexusStorageKey,value:JSON.stringify(safeState)},
    {key:window.NexusFeatureStorageKey,value:JSON.stringify(nextFeatures)}
  ];
  if(ownerId)entries.push({key:OWNER_KEY,value:String(ownerId)});
  // Free redundant snapshot space before applying a cloud workspace to this browser.
  if(window.NexusOfflineSyncQueue&&typeof window.NexusOfflineSyncQueue.compactMetadata==='function')window.NexusOfflineSyncQueue.compactMetadata(localStorage);
  window.NexusBackupRestoreUtils.commitLocalStorageAtomically(localStorage,entries);
  state=safeState;
  window.NexusSetFeatureState(nextFeatures,{persist:false,render:false});
  renderAll();
  if(window.NexusRenderHub)window.NexusRenderHub();
  return true;
}
function applyRemote(payload,ownerId,serverVersion){
  if(!payload||!payload.state||!Array.isArray(payload.state.streams))throw new Error('Cloud backup format is invalid.');
  const rawNormalize=window.NexusNormalizeStateWithoutCurriculumRepair;
  const incomingState=rawNormalize?rawNormalize(payload.state):normalizeState(payload.state);
  const nextState=window.NexusRepairInstalledCurricula?window.NexusRepairInstalledCurricula(clone(incomingState)):normalizeState(payload.state);
  const hasFeatures=Object.prototype.hasOwnProperty.call(payload,'featureState'),nextFeatures=window.NexusNormalizeFeatureState(hasFeatures?payload.featureState:undefined),repaired=stableJson(incomingState)!==stableJson(nextState);
  ready=false;applyWorkspaceSnapshot(nextState,nextFeatures,ownerId);
  if(ownerId&&window.NexusOfflineSyncQueue){window.NexusOfflineSyncQueue.rememberBase(localStorage,ownerId,{state:incomingState,featureState:nextFeatures},serverVersion||null);if(repaired){const repairPayload={app:'Nexus Spaced Repetition Tracker',schema:4,exportedAt:new Date().toISOString(),state:clone(nextState),featureState:clone(nextFeatures)};window.NexusOfflineSyncQueue.rebase(localStorage,ownerId,repairPayload,serverVersion||null,'repair-incomplete-installed-curriculum');window.NexusOfflineSyncQueue.rememberStamp(localStorage,ownerId,serverVersion||null);}}
  ready=true;if(repaired&&ownerId)schedule();
}
function applyLocalMerged(localPayload,remotePayload){
  const nextState=mergeState(localPayload.state,remotePayload?.state||emptyState());
  const remoteFeatures=remotePayload?.featureState||{},localFeatures=localPayload.featureState||{};
  // Keep local settings and same-ID records, while preserving non-conflicting Study Hub records from cloud.
  const nextFeatures=window.NexusMergeFeatureState(localFeatures,remoteFeatures,{});
  ready=false;
  applyWorkspaceSnapshot(nextState,nextFeatures);
  ready=true;
}
function resetToEmpty(ownerId){
  ready=false;
  applyWorkspaceSnapshot(emptyState(),{},ownerId);
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
  if(remote&&remote.payload&&sameWorkspace(remote.payload,pending.payload)){
   queue.rememberBase(localStorage,userId,remote.payload,remote.updated_at||null);
   queue.acknowledge(localStorage,userId,pending.operationId,pending.baseServerVersion,remote.updated_at||null);
   lastRemoteStamp=remote.updated_at||null;
   return {ok:true,conflicts:totalConflicts};
  }
  const remoteStamp=remote&&remote.updated_at?remote.updated_at:null;
  if((pending.baseServerVersion||null)===(remoteStamp||null)){
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
  const normalizedRemote=normalizeWorkspacePayload(remote.payload);
  const result=merger.merge(normalizedBase,normalizedLocal,normalizedRemote);
  const nextState=normalizeState(result.payload.state);
  const nextFeatures=window.NexusNormalizeFeatureState(result.payload.featureState||{});
  if(!window.NexusBackupRestoreUtils||!window.NexusStorageKey||!window.NexusFeatureStorageKey||!window.NexusSetFeatureState)throw new Error('Atomic workspace reconciliation is unavailable; local changes were preserved.');
  const mergedSnapshot={app:'Nexus Spaced Repetition Tracker',schema:4,exportedAt:new Date().toISOString(),state:clone(nextState),featureState:clone(nextFeatures)};
  const rebased=queue.rebaseWithBase(localStorage,userId,mergedSnapshot,remoteStamp,'automatic-three-way-merge',
   {state:normalizedRemote.state,featureState:normalizedRemote.featureState},
   {workspaceEntries:[
     {key:window.NexusStorageKey,value:JSON.stringify(nextState)},
     {key:window.NexusFeatureStorageKey,value:JSON.stringify(nextFeatures)},
     {key:OWNER_KEY,value:String(userId)}
    ],
    conflicts:result.conflicts,
    conflictMetadata:{baseServerVersion:pending.baseServerVersion,remoteServerVersion:remoteStamp}
   });
  // Storage, outbox, new base, and losing conflict alternatives now commit together.
  // Do not switch the in-memory workspace until the durable transaction succeeds.
  state=nextState;
  window.NexusSetFeatureState(nextFeatures,{persist:false,render:false});
  renderAll();
  if(window.NexusRenderHub)window.NexusRenderHub();
  if(rebased.archivedConflicts){totalConflicts+=rebased.archivedConflicts;updateConflictRecoveryButton();}
  lastRemoteStamp=remoteStamp;ready=true;
  const uploaded=await upload();
  if(uploaded)return {ok:true,conflicts:totalConflicts};
  if((el('cloudStatus')?.textContent||'')!=='Cloud conflict')return {ok:false,conflicts:totalConflicts,reason:'The merge is saved locally, but cloud verification did not finish.'};
  remote=await fetchRemote(userId);
 }
 return {ok:false,conflicts:totalConflicts,reason:'The cloud changed repeatedly during merge. Local edits remain queued and are preserved.'};
}
function alignPendingToCurrentWorkspace(userId,localPayload,pending){
 const queue=window.NexusOfflineSyncQueue;
 if(!queue||!pending||!localPayload||sameWorkspace(localPayload,pending.payload))return {localPayload,pending};
 const base=queue.getBase(localStorage,userId);
 const basePayload=base&&base.state&&base.featureState?{state:base.state,featureState:base.featureState}:null;
 let mergedPayload,conflicts=[];
 if(basePayload&&window.NexusWorkspaceSyncMerge&&typeof window.NexusWorkspaceSyncMerge.merge==='function'){
  // Reconcile the saved workspace and queued snapshot against the same verified baseline.
  // This preserves live installs/edits that occurred after an older queue operation was created.
  const result=window.NexusWorkspaceSyncMerge.merge(
   normalizeWorkspacePayload(basePayload),
   normalizeWorkspacePayload(localPayload),
   normalizeWorkspacePayload(pending.payload)
  );
  mergedPayload=normalizeWorkspacePayload(result.payload);
  conflicts=Array.isArray(result.conflicts)?result.conflicts:[];
 }else{
  // Without a known baseline, preserve content from both same-account snapshots rather than guessing which is disposable.
  mergedPayload={
   state:mergeState(localPayload.state,pending.payload.state),
   featureState:window.NexusMergeFeatureState(localPayload.featureState||{},pending.payload.featureState||{}, {})
  };
 }
 const nextState=normalizeState(mergedPayload.state);
 const nextFeatures=window.NexusNormalizeFeatureState(mergedPayload.featureState||{});
 const alignedSnapshot={app:'Nexus Spaced Repetition Tracker',schema:4,exportedAt:new Date().toISOString(),state:clone(nextState),featureState:clone(nextFeatures)};
 const workspaceEntries=[
  {key:window.NexusStorageKey,value:JSON.stringify(nextState)},
  {key:window.NexusFeatureStorageKey,value:JSON.stringify(nextFeatures)},
  {key:OWNER_KEY,value:String(userId)}
 ];
 const baseVersion=base&&typeof base.serverVersion==='string'&&base.serverVersion?base.serverVersion:(pending.baseServerVersion||null);
 if(basePayload&&typeof queue.rebaseWithBase==='function'){
  // Queue, local workspace, and recovery alternatives commit atomically.
  queue.rebaseWithBase(localStorage,userId,alignedSnapshot,baseVersion,'align-live-workspace-with-pending',basePayload,{
   workspaceEntries,conflicts,
   conflictMetadata:{baseServerVersion:pending.baseServerVersion||null,remoteServerVersion:baseVersion}
  });
 }else{
  queue.commitWorkspace(localStorage,workspaceEntries,alignedSnapshot,{baseServerVersion:baseVersion});
 }
 state=nextState;
 window.NexusSetFeatureState(nextFeatures,{persist:false,render:false});
 renderAll();
 if(window.NexusRenderHub)window.NexusRenderHub();
 const alignedPending=queue.getPending(localStorage,userId);
 if(!alignedPending)throw new Error('The local workspace and offline queue could not be aligned safely. Local data is preserved.');
 return {localPayload:snapshot(),pending:alignedPending};
}
function cloudRevisionGuardMessage(userId,remote){
 const queue=window.NexusOfflineSyncQueue;
 if(!queue||!userId||!remote||!remote.payload||typeof remote.updated_at!=='string')return '';
 const base=queue.getBase(localStorage,userId);
 if(!base||typeof base.serverVersion!=='string'||!base.serverVersion)return '';
 const baseTime=Date.parse(base.serverVersion),remoteTime=Date.parse(remote.updated_at);
 if(!Number.isFinite(baseTime)||!Number.isFinite(remoteTime))return '';
 if(remoteTime<baseTime)return 'The cloud returned a revision older than this device’s last verified baseline.';
 if(remoteTime===baseTime&&!sameWorkspace(remote.payload,base))return 'The cloud payload differs from the last verified baseline without a newer revision.';
 return '';
}
async function reconcileOwnedWorkspace(userId,localPayload,remote){
 const queue=window.NexusOfflineSyncQueue;
 if(!queue||!userId||!localPayload||!remote)return {ok:false,conflicts:0,reason:'Safe same-account reconciliation is unavailable.'};
 const base=queue.getBase(localStorage,userId);
 if(base&&sameWorkspace(localPayload,base)){
  const baseVersion=typeof base.serverVersion==='string'?base.serverVersion:'';
  const remoteVersion=typeof remote.updated_at==='string'?remote.updated_at:'';
  if(baseVersion&&remoteVersion){
   const baseTime=Date.parse(baseVersion),remoteTime=Date.parse(remoteVersion);
   if(Number.isFinite(baseTime)&&Number.isFinite(remoteTime)&&remoteTime>baseTime){
    applyRemote(remote.payload,userId,remoteVersion);
    queue.rememberStamp(localStorage,userId,remoteVersion);
    lastRemoteStamp=remoteVersion;
    return {ok:true,conflicts:0,cloudLoaded:true};
   }
   if(Number.isFinite(baseTime)&&Number.isFinite(remoteTime)){
    return {ok:false,conflicts:0,reason:remoteTime<baseTime
     ?'The cloud returned a revision older than this device’s last verified baseline. No local data was replaced.'
     :'The cloud revision is not newer than the last verified baseline but contains different data. No local data was replaced.'};
   }
  }
 }
 const baseVersion=base&&typeof base.serverVersion==='string'?base.serverVersion:null;
 queue.rebase(localStorage,userId,localPayload,baseVersion,'automatic-recovery-of-local-edits');
 return reconcileConcurrentSnapshot(userId,remote);
}
async function initializeSession(s){const requestedSession=s||null,requestedUserId=requestedSession&&requestedSession.user?requestedSession.user.id:null;if(initializing){if(requestedUserId!==initializingUserId){queuedSession=requestedSession;hasQueuedSession=true;}return;}initializing=true;initializingUserId=requestedUserId;try{const newSession=requestedSession,newUserId=requestedUserId;session=newSession;ready=false;lastRemoteStamp=null;clearTimeout(timer);setControls();if(!session){status(client?'Not signed in · offline ready':'Offline ready');say('You can continue studying offline. Your local data remains on this device when you sign out.');return;}status('Loading account…');await assertActiveUser(newUserId);const remote=await fetchRemote(newUserId);await assertActiveUser(newUserId);const staleRevisionMessage=cloudRevisionGuardMessage(newUserId,remote);if(staleRevisionMessage){status('Automatic merge not verified');say(staleRevisionMessage+' Local data was not replaced and the last verified sync baseline was kept. Verify or restore the cloud backup before reconnecting.');lastUserId=newUserId;return;}if(window.NexusOfflineSyncQueue)window.NexusOfflineSyncQueue.rememberStamp(localStorage,newUserId,remote&&remote.updated_at||null);let owner=localStorage.getItem(OWNER_KEY)||'',localPayload=snapshot();const detachedWorkspace=!owner&&!!(window.NexusOfflineSyncQueue&&window.NexusOfflineSyncQueue.getDetachedOwner(localStorage));let pendingForUser=window.NexusOfflineSyncQueue?window.NexusOfflineSyncQueue.getPending(localStorage,newUserId):null;if(pendingForUser&&owner===newUserId&&!detachedWorkspace&&!sameWorkspace(localPayload,pendingForUser.payload)){const aligned=alignPendingToCurrentWorkspace(newUserId,localPayload,pendingForUser);localPayload=aligned.localPayload;pendingForUser=aligned.pending;}if(pendingForUser&&owner!==newUserId&&!detachedWorkspace){applyWorkspaceSnapshot(normalizeState(pendingForUser.payload.state),window.NexusNormalizeFeatureState(pendingForUser.payload.featureState||{}),newUserId);owner=newUserId;localPayload=snapshot();}if(pendingForUser&&remote&&remote.payload&&sameWorkspace(remote.payload,pendingForUser.payload)){window.NexusOfflineSyncQueue.rememberBase(localStorage,newUserId,remote.payload,remote.updated_at||null);window.NexusOfflineSyncQueue.acknowledge(localStorage,newUserId,pendingForUser.operationId,pendingForUser.baseServerVersion,remote.updated_at);pendingForUser=null;}if(detachedWorkspace&&pendingForUser){if(window.NexusOfflineSyncQueue)window.NexusOfflineSyncQueue.archive(localStorage,newUserId,'signed-out-workspace-detached');pendingForUser=null;say('A previous queued snapshot for this account was preserved in local recovery history instead of replacing your signed-out workspace. Choose how to reconcile local and cloud data below.');}if(owner&&owner!==newUserId){if(remote&&remote.payload){applyRemote(remote.payload,newUserId,remote.updated_at||null);lastRemoteStamp=remote.updated_at;say('Loaded this account’s own cloud data. Offline data from the previous account was not merged or uploaded.');}else{resetToEmpty(newUserId);ready=true;enqueueInitialSnapshot(newUserId);const uploaded=await upload();if(!uploaded){ready=false;throw new Error('A clean workspace was created for this account, but its initial cloud state could not be verified. Previous-account data was not uploaded.');}say('A clean workspace was created for this account. Previous-account data was not merged or uploaded.');}localStorage.setItem(OWNER_KEY,newUserId);if(detachedWorkspace)localStorage.setItem(DETACHED_OWNER_KEY,'');lastUserId=newUserId;if(ready){status('Synced');}return;}const localData={state:localPayload.state,featureState:localPayload.featureState||{}},remoteData=remote&&remote.payload?{state:remote.payload.state,featureState:remote.payload.featureState||{}}:null;let localHasWork=pendingForUser?(!remoteData||stableJson(localData)!==stableJson(remoteData)):(remoteData?stableJson(localData)!==stableJson(remoteData):hasLocalWork(localPayload));let pendingAutomaticallySynced=false,cloudWorkspaceAutoLoaded=false;if(!pendingForUser&&owner===newUserId&&remoteData&&!sameWorkspace(localData,remoteData)){const reconciliation=await reconcileOwnedWorkspace(newUserId,localPayload,remote);if(!reconciliation.ok){ready=false;status('Automatic merge not verified');say((reconciliation.reason||'The same-account workspace could not be reconciled safely.')+' Local data is preserved; do not clear this browser’s data.');if(/cloud changed repeatedly|upload could not be verified|verification did not finish/i.test(reconciliation.reason||''))scheduleRetry();localStorage.setItem(OWNER_KEY,newUserId);lastUserId=newUserId;return;}localHasWork=false;pendingAutomaticallySynced=!reconciliation.cloudLoaded;cloudWorkspaceAutoLoaded=!!reconciliation.cloudLoaded;if(reconciliation.conflicts){say('This account’s offline and cloud changes were automatically merged. '+reconciliation.conflicts+' overlapping edit(s) were archived for recovery.');}else if(reconciliation.cloudLoaded){say('Loaded this account’s newer cloud workspace automatically. This device had no unsynced local changes.');}else{say('This account’s local and cloud changes were automatically merged and verified.');}}if(pendingForUser&&owner===newUserId&&remoteData&&(pendingForUser.baseServerVersion||null)!==(remote.updated_at||null)&&!sameWorkspace(remoteData,pendingForUser.payload)){const reconciliation=await reconcileConcurrentSnapshot(newUserId,remote);if(!reconciliation.ok){ready=false;status('Automatic merge not verified');say((reconciliation.reason||'The local changes are preserved, but the merged cloud state is not verified.')+' Your offline work remains queued; do not clear this browser’s data.');if(/cloud changed repeatedly|upload could not be verified|verification did not finish/i.test(reconciliation.reason||''))scheduleRetry();localStorage.setItem(OWNER_KEY,newUserId);lastUserId=newUserId;return;}pendingForUser=null;localHasWork=false;pendingAutomaticallySynced=true;if(reconciliation.conflicts){say('Offline and cloud changes were automatically merged. '+reconciliation.conflicts+' overlapping field edit(s) used local-device precedence; alternate values were saved in this device’s conflict recovery archive.');}else{say('Offline and cloud changes were automatically merged and verified. Independent edits were combined without a workspace-choice dialog.');}}if(pendingForUser&&!detachedWorkspace&&window.NexusCloudSyncRecovery&&window.NexusCloudSyncRecovery.canAutoResumePending(pendingForUser,remote&&remote.updated_at||null)){lastRemoteStamp=remote&&remote.updated_at||null;ready=true;const autoUploaded=await upload();if(!autoUploaded){ready=false;return;}pendingForUser=null;localHasWork=false;pendingAutomaticallySynced=true;say('Offline changes were automatically uploaded and verified for this account.');}if(localHasWork){let choice=await chooseLocalData();if(choice==='cancel'){ready=false;status('Data choice required');say('Your offline data is preserved. Choose one of the available data options before cloud sync can continue.');return;}while(choice==='replace-cloud'||choice==='replace'){const confirmed=choice==='replace-cloud'?confirm('FINAL CONFIRMATION: overwrite this account’s entire cloud backup with the offline data on this device? Download a backup first if needed.'):remote&&remote.payload?confirm('FINAL CONFIRMATION: replace this device’s offline workspace with this account’s cloud backup? Unsynced local changes that are not in the cloud will be lost. Download a backup first if needed.'):confirm('FINAL CONFIRMATION: start this account with a clean workspace? This will replace the offline data on this device, and no cloud backup is available to restore it. Download a backup first if needed.');if(confirmed)break;ready=false;status('Data choice required');say('Cancelled. Your offline data has not been changed. Choose an option below to continue.');choice=await chooseLocalData();if(choice==='cancel'){ready=false;status('Data choice required');say('Your offline data is preserved. Choose one of the available data options before cloud sync can continue.');return;}}applyWorkspaceSnapshot(normalizeState(localPayload.state),window.NexusNormalizeFeatureState(localPayload.featureState||{}),newUserId);owner=newUserId;localPayload=snapshot();if(choice==='merge'){lastRemoteStamp=remote&&remote.payload?remote.updated_at:null;applyLocalMerged(localPayload,remote&&remote.payload?remote.payload:null);if(window.NexusOfflineSyncQueue)window.NexusOfflineSyncQueue.rebase(localStorage,newUserId,snapshot(),lastRemoteStamp,'user-merge');ready=true;const uploaded=await upload();if(uploaded){say(remote&&remote.payload?'Offline work was merged with this account’s cloud data.':'Offline work was kept and uploaded as this account’s first backup.');}else{ready=false;status('Sync not verified');say('The merge is saved locally, but cloud sync was not verified. Your local data is preserved; reconnect and retry before assuming the cloud has it.');}}else if(choice==='replace-cloud'){lastRemoteStamp=remote&&remote.payload?remote.updated_at:null;if(window.NexusOfflineSyncQueue)window.NexusOfflineSyncQueue.rebase(localStorage,newUserId,snapshot(),lastRemoteStamp,'user-confirmed-cloud-replace');ready=true;const uploaded=await upload();if(uploaded){say('Verified: the cloud backup now matches this device’s offline data.');}else{ready=false;status('Cloud replacement not verified');say('The cloud replacement was NOT confirmed. Your offline data remains on this device. Reconnect and retry the data choice; do not assume the cloud was updated.');}}else{if(pendingForUser&&window.NexusOfflineSyncQueue)window.NexusOfflineSyncQueue.archive(localStorage,newUserId,'user-selected-cloud-restore');if(remote&&remote.payload){applyRemote(remote.payload,newUserId,remote.updated_at||null);lastRemoteStamp=remote.updated_at;if(window.NexusOfflineSyncQueue)window.NexusOfflineSyncQueue.rememberStamp(localStorage,newUserId,lastRemoteStamp);ready=true;say('This device now contains the verified cloud workspace. The cloud backup was not rewritten.');}else{resetToEmpty(newUserId);if(window.NexusOfflineSyncQueue)window.NexusOfflineSyncQueue.rememberStamp(localStorage,newUserId,null);ready=true;enqueueInitialSnapshot(newUserId);const uploaded=await upload();if(!uploaded)say('A clean workspace was saved locally, but its cloud state is not yet verified. Nexus will retry automatically.');else say('Started this account with a clean workspace; offline work was not uploaded.');}}}else if(cloudWorkspaceAutoLoaded){say('Loaded this account’s newer cloud workspace automatically.');}else if(pendingAutomaticallySynced){say('Offline work was uploaded and verified for this account.');}else if(remote&&remote.payload){applyRemote(remote.payload,newUserId,remote.updated_at||null);lastRemoteStamp=remote.updated_at;if(window.NexusOfflineSyncQueue)window.NexusOfflineSyncQueue.rememberStamp(localStorage,newUserId,lastRemoteStamp);say('Loaded this account’s cloud data. Future changes sync automatically.');}else{resetToEmpty(newUserId);ready=true;enqueueInitialSnapshot(newUserId);const uploaded=await upload();if(!uploaded)say('A clean workspace was saved locally, but its cloud state is not yet verified. Nexus will retry automatically.');else say('A clean workspace was created for this account.');}localStorage.setItem(OWNER_KEY,newUserId);lastUserId=newUserId;if(ready){clearDetachedOwnerAfterSuccessfulReconciliation(newUserId,detachedWorkspace);status('Synced');}}catch(e){ready=false;status('Sync unavailable');say('Cloud sync error: '+((e&&e.message)||'unknown error')+'. Local changes are preserved and sync is paused. Reconnect to sync again.');console.error('Nexus account initialization failed',e);scheduleRetry();}finally{initializing=false;initializingUserId=null;setControls();if(hasQueuedSession){const nextSession=queuedSession;queuedSession=null;hasQueuedSession=false;setTimeout(()=>initializeSession(nextSession),0);}}}
function stableJson(v){if(Array.isArray(v))return '['+v.map(stableJson).join(',')+']';if(v&&typeof v==='object')return '{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+stableJson(v[k])).join(',')+'}';return JSON.stringify(v);}
function sameWorkspace(a,b){return !!a&&!!b&&stableJson({state:a.state||{},featureState:a.featureState||{}})===stableJson({state:b.state||{},featureState:b.featureState||{}});}
async function upload(){
 if(!client||!session||!ready)return false;
 if(syncing){pendingSync=true;return false;}
 const uploadUserId=session.user.id;
 async function assertUploadOwner(){await assertActiveUser(uploadUserId);if(localStorage.getItem(OWNER_KEY)!==uploadUserId)throw new Error('The local workspace owner changed during sync. The pending snapshot was not applied to another account.');}
 if(localStorage.getItem(OWNER_KEY)!==uploadUserId){ready=false;status('Account queue paused');say('The active account does not own this local workspace. No cloud write was attempted; reconnect to the correct account.');return false;}
 syncing=true;status('Syncing…');let uploaded=false,retryReconcileAfterConflict=false,attemptedPayload=null,attemptedOperationId=null,attemptedBase=null,attemptedPriorStamp=null;
 const queue=window.NexusOfflineSyncQueue;
 try{
  const {data:authData,error:authError}=await client.auth.getUser();
  if(authError)throw new Error('Supabase could not verify the active login before cloud write: '+authError.message);
  if(!authData.user||authData.user.id!==uploadUserId||!session||session.user.id!==uploadUserId)throw new Error('The active Google/account session changed or could not be verified. Cloud write paused to protect the other account. Sign in again and retry.');
  const pending=queue?queue.getPending(localStorage,uploadUserId):null;
  const priorStamp=lastRemoteStamp;attemptedPriorStamp=priorStamp;
  const payload=pending?pending.payload:snapshot();attemptedPayload=payload;attemptedOperationId=pending?pending.operationId:null;attemptedBase=pending?pending.baseServerVersion:(priorStamp||null);
  if(pending){
   const before=await fetchRemote(uploadUserId);
   await assertUploadOwner();
   if(before&&before.payload&&sameWorkspace(before.payload,payload)){
    lastRemoteStamp=before.updated_at||null;
    queue.rememberBase(localStorage,uploadUserId,before.payload,lastRemoteStamp);
    queue.acknowledge(localStorage,uploadUserId,pending.operationId,pending.baseServerVersion,lastRemoteStamp);
    status('Synced');uploaded=true;return true;
   }
   const actualStamp=before&&before.updated_at?before.updated_at:null;
   if(actualStamp!==(pending.baseServerVersion||null)){const conflict=new Error('The cloud revision changed since this offline snapshot was queued.');conflict.code='NEXUS_CLOUD_CONFLICT';throw conflict;}
   const stamp=nextCloudStamp(pending.baseServerVersion);
   await assertUploadOwner();
   await window.NexusBackupRestoreUtils.writeCloudSnapshot(client,uploadUserId,payload,pending.baseServerVersion,stamp);
   const verify=await fetchRemote(uploadUserId);
   await assertUploadOwner();
   if(!verify||!verify.payload||stableJson(verify.payload)!==stableJson(payload)){const conflict=new Error('The remote cloud snapshot changed during write verification.');conflict.code='NEXUS_CLOUD_CONFLICT';throw conflict;}
   lastRemoteStamp=verify.updated_at||stamp;
   queue.rememberBase(localStorage,uploadUserId,verify.payload,lastRemoteStamp);
   queue.acknowledge(localStorage,uploadUserId,pending.operationId,pending.baseServerVersion,lastRemoteStamp);
  }else{
   const stamp=nextCloudStamp(priorStamp);
   await window.NexusBackupRestoreUtils.writeCloudSnapshot(client,uploadUserId,payload,priorStamp,stamp);
   const verify=await fetchRemote(uploadUserId);
   await assertUploadOwner();
   if(!verify||!verify.payload||stableJson(verify.payload)!==stableJson(payload)){const conflict=new Error('The remote cloud snapshot changed during write verification.');conflict.code='NEXUS_CLOUD_CONFLICT';throw conflict;}
   lastRemoteStamp=verify.updated_at||stamp;
   if(queue){
    queue.rememberBase(localStorage,uploadUserId,verify.payload,lastRemoteStamp);
    queue.rememberStamp(localStorage,uploadUserId,lastRemoteStamp);
    const later=queue.getPending(localStorage,uploadUserId);
    if(later&&later.baseServerVersion===(priorStamp||null))queue.rebase(localStorage,uploadUserId,snapshot(),lastRemoteStamp,'local-change-during-upload');
   }
  }
  status('Synced');uploaded=true;
 }catch(e){
  if(e&&e.code==='NEXUS_CLOUD_CONFLICT'){
   let alreadyCommitted=false;
   try{
    if(attemptedPayload){
     await assertUploadOwner();
     const latest=await fetchRemote(uploadUserId);
     await assertUploadOwner();
     if(latest&&latest.payload&&sameWorkspace(latest.payload,attemptedPayload)){
      lastRemoteStamp=latest.updated_at||null;
      // A matching read-back proves this exact snapshot is the new cloud baseline,
      // even when the conditional write returned an ambiguous conflict response.
      // Advance the merge base before acknowledging the queue so later offline
      // edits cannot compare against an obsolete baseline and resurrect deletions.
      if(queue)queue.rememberBase(localStorage,uploadUserId,latest.payload,lastRemoteStamp);
      if(queue&&attemptedOperationId)queue.acknowledge(localStorage,uploadUserId,attemptedOperationId,attemptedBase,lastRemoteStamp);
      else if(queue){queue.rememberStamp(localStorage,uploadUserId,lastRemoteStamp);const later=queue.getPending(localStorage,uploadUserId);if(later&&later.baseServerVersion===(attemptedPriorStamp||null))queue.rebase(localStorage,uploadUserId,snapshot(),lastRemoteStamp,'local-change-during-upload');}
      status('Synced');say('Verified: the cloud already contains this exact snapshot, so the interrupted write was safely acknowledged.');uploaded=true;alreadyCommitted=true;
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
   if(!alreadyCommitted){ready=false;status('Cloud conflict');say(retryReconcileAfterConflict?'Another device changed this account’s cloud backup at the same time. Your local snapshot is preserved; Nexus is reopening the latest revision to merge both workspaces automatically.':'The cloud conflict could not be verified automatically. Your local data and pending snapshot are preserved; reconnect before retrying.');}
  }
  else{ready=false;status('Sync error');say('Cloud upload failed or could not be verified. Local data and the pending snapshot are preserved. Nexus will retry automatically when the connection is available.');scheduleRetry();}
  console.error('Nexus cloud sync failed',e);
 }finally{syncing=false;if(retryReconcileAfterConflict){retryReconcileAfterConflict=false;setTimeout(()=>{const activeConnect=connectPromise;if(activeConnect)activeConnect.then(()=>connect());else connect();},0);}if(pendingSync){pendingSync=false;if(ready)schedule();else scheduleRetry();}}
 return uploaded;
}
function schedule(){if(!client||!session||!ready||(typeof navigator!=='undefined'&&!navigator.onLine))return;clearTimeout(timer);timer=setTimeout(()=>{if(syncing){pendingSync=true;return;}upload();},650);}
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
async function ensureClient(){if(isUnsafeCloudOrigin())throw new Error('Cloud sync is disabled on this preview/local copy to protect real cloud data.');if(client)return client;const c=config();if(!window.supabase||!window.supabase.createClient)await loadSupabaseLibrary();if(!client){client=window.supabase.createClient(c.url,c.key,{auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:true,storage:createSafeAuthStorage(localStorage)}});client.auth.onAuthStateChange((event,newSession)=>{const previousUserId=session&&session.user?session.user.id:(localStorage.getItem(OWNER_KEY)||'');session=newSession||null;if(event==='TOKEN_REFRESHED'||event==='USER_UPDATED'){session=newSession;setControls();return;}if(event==='SIGNED_OUT'){session=null;ready=false;clearTimeout(timer);clearRetry();if(initializing&&initializingUserId){queuedSession=null;hasQueuedSession=true;}let externalDetachFailed=false;if(previousUserId&&(localStorage.getItem(OWNER_KEY)||'')===previousUserId){try{window.NexusOfflineSyncQueue.detachOwner(localStorage,previousUserId);}catch(detachError){externalDetachFailed=true;console.error('Could not detach the workspace after an external sign-out.',detachError);}}status('Not signed in · offline ready');say(externalDetachFailed?'You are signed out, but Nexus could not safely detach this device from the previous account. Do not make further changes until you reconnect and resolve the workspace ownership warning.':'You can continue studying offline. Changes made while signed out stay on this device and are not uploaded to the previous account. On your next sign-in, Nexus will ask you to reconcile local and cloud data if they differ.');setControls();return;}if(event==='SIGNED_IN'||event==='INITIAL_SESSION'){const uid=newSession&&newSession.user?newSession.user.id:null;if(uid!==lastUserId||!ready)setTimeout(()=>initializeSession(newSession),0);else{session=newSession;setControls();}}});}return client;}
let connectPromise=null;function connect(){if(isUnsafeCloudOrigin()){previewCloudBlockedMessage();setControls();return Promise.resolve();}if(connectPromise)return connectPromise;connectPromise=(async()=>{try{await ensureClient();const {data:{session:s},error}=await client.auth.getSession();if(error)throw error;await initializeSession(s);}catch(e){status('Connection error');say('Connection error: '+((e&&e.message)||'unknown error')+'. You can still use Nexus offline; reconnect to sign in and sync.');console.error('Nexus connection failed',e);scheduleRetry();}finally{connectPromise=null;}})();return connectPromise;}
async function googleSignIn(){try{if(isUnsafeCloudOrigin()){previewCloudBlockedMessage();setControls();return;}if(session){say('You are already signed in. Sign out before connecting a different account.');return;}if(!confirm("IMPORTANT: If you sign in with a different account from the one you used last time, your unsynced offline data on this device will be deleted. To preserve it, sign in with your previous account so you can merge it with that account’s cloud data. If you continue with a different account, your unsynced offline data will be discarded. The previous account’s cloud data will remain unchanged. Continue?")){status('Sign-in cancelled');return;}status('Opening Google sign-in…');await ensureClient();const {data,error}=await client.auth.signInWithOAuth({provider:'google',options:{redirectTo:location.origin+location.pathname,queryParams:{prompt:'select_account'}}});if(error)throw error;if(data&&data.url)location.assign(data.url);}catch(e){status('Google sign-in failed');say((e&&e.message)||'Could not start Google sign-in. Check your connection and try again.');console.error('Nexus Google sign-in failed',e);}}
async function emailSignIn(){try{if(isUnsafeCloudOrigin()){previewCloudBlockedMessage();setControls();return;}if(session){say('You are already signed in. Sign out before connecting a different account.');return;}if(!confirm("IMPORTANT: If you sign in with a different account from the one you used last time, your unsynced offline data on this device will be deleted. To preserve it, sign in with your previous account so you can merge it with that account’s cloud data. If you continue with a different account, your unsynced offline data will be discarded. The previous account’s cloud data will remain unchanged. Continue?")){status('Sign-in cancelled');return;}status('Preparing email sign-in…');await ensureClient();const email=prompt('Enter your email address to receive a sign-in link:');if(!email){status(session&&ready?'Synced':'Not signed in · offline ready');return;}const {error}=await client.auth.signInWithOtp({email,options:{emailRedirectTo:location.origin+location.pathname}});if(error)throw error;say('Check your email for the sign-in link.');status('Email sign-in link sent');}catch(e){status('Email sign-in failed');say((e&&e.message)||'Could not send the sign-in link. Check your connection and try again.');console.error('Nexus email sign-in failed',e);}}
async function signOut(){
 const owner=session&&session.user?session.user.id:(localStorage.getItem(OWNER_KEY)||'');
 ready=false;clearTimeout(timer);clearRetry();
 let detached=false;
 try{
  if(owner){if(!window.NexusOfflineSyncQueue||typeof window.NexusOfflineSyncQueue.detachOwner!=='function')throw new Error('Safe workspace detachment is unavailable; sign-out was paused to protect cloud data.');detached=window.NexusOfflineSyncQueue.detachOwner(localStorage,owner);}
  if(client){const result=await client.auth.signOut();if(result&&result.error)throw result.error;}
  session=null;ready=false;clearTimeout(timer);clearRetry();status('Not signed in · offline ready');
  say('You are signed out. Your workspace remains on this device. Changes made while signed out stay local and are not uploaded to the previous account. On your next sign-in, Nexus will ask you to reconcile the local workspace with that account’s cloud backup if they differ.');
  setControls();
 }catch(error){
  if(detached&&owner&&session&&session.user&&session.user.id===owner){
   try{window.NexusOfflineSyncQueue.attachOwner(localStorage,owner);}catch(reattachError){console.error('Could not reattach workspace after sign-out failed.',reattachError);}
  }
  ready=!!(session&&session.user&&session.user.id===owner);
  status('Sign-out not verified');
  say(ready?'Sign-out did not complete; you remain signed in to the current account. Your workspace ownership was restored where possible. '+String(error&&error.message||''):'Sign-out could not be verified. Nexus preserved local data and paused cloud writes; check the active account before continuing. '+String(error&&error.message||''));
  setControls();console.error('Nexus sign-out failed.',error);
 }
}
window.NexusCloudSync={schedule,upload,reconnect:connect};window.addEventListener('online',resumeAfterConnectivity);window.addEventListener('offline',()=>{if(session){status('Offline · changes saved locally');say('You can continue studying. Local changes are queued for this account and will sync when the connection returns.');}});document.addEventListener('visibilitychange',()=>{if(!document.hidden)resumeAfterConnectivity();});window.addEventListener('pageshow',resumeAfterConnectivity);document.addEventListener('DOMContentLoaded',()=>{el('cloudGoogleSignInBtn')?.addEventListener('click',googleSignIn);el('cloudEmailSignInBtn')?.addEventListener('click',emailSignIn);el('cloudSignOutBtn')?.addEventListener('click',signOut);connect();});
})();