  'use strict';
  const STORAGE_KEY = 'recall.study.tracker.v1';
  window.NexusStorageKey = STORAGE_KEY;
  const OLD_KEYS = ['alSrsTrackerV2','alTrackerData','alHistoryLog'];
  const SEED = [
    ['BS','ව්‍යාපාර අධ්‍යයනය','1. ව්‍යාපාර පදනම හා ව්‍යාපාර පරිසරය'],
    ['BS','ව්‍යාපාර අධ්‍යයනය','2. සමාජ වගකීම හා ව්‍යාපාර ආචාරධර්ම'],
    ['BS','ව්‍යාපාර අධ්‍යයනය','3. රජය හා ව්‍යාපාර'],
    ['BS','ව්‍යාපාර අධ්‍යයනය','4. ව්‍යාපාර සංවිධාන'],
    ['BS','ව්‍යාපාර අධ්‍යයනය','5. ව්‍යවසායකත්වය'],
    ['BS','ව්‍යාපාර අධ්‍යයනය','6. කුඩා හා මධ්‍ය පරිමාණ ව්‍යාපාර'],
    ['BS','ව්‍යාපාර අධ්‍යයනය','7. මුදල්, බැංකු හා මූල්‍ය ආයතන'],
    ['BS','ව්‍යාපාර අධ්‍යයනය','8. රක්ෂණය'],
    ['BS','ව්‍යාපාර අධ්‍යයනය','9. සන්නිවේදනය'],
    ['BS','ව්‍යාපාර අධ්‍යයනය','10. ප්‍රවාහනය හා සැපයුම් සේවා'],
    ['BS','ව්‍යාපාර අධ්‍යයනය','11. දේශීය හා විදේශීය වෙළඳාම'],
    ['BS','ව්‍යාපාර අධ්‍යයනය','12. ව්‍යාපාර කළමනාකරණය'],
    ['BS','ව්‍යාපාර අධ්‍යයනය','13. මෙහෙයුම් කළමනාකරණය'],
    ['BS','ව්‍යාපාර අධ්‍යයනය','14. අලෙවි කළමනාකරණය'],
    ['BS','ව්‍යාපාර අධ්‍යයනය','15. මූල්‍ය කළමනාකරණය'],
    ['BS','ව්‍යාපාර අධ්‍යයනය','16. මානව සම්පත් කළමනාකරණය'],
    ['BS','ව්‍යාපාර අධ්‍යයනය','17. තොරතුරු පද්ධති'],
    ['BS','ව්‍යාපාර අධ්‍යයනය','18. ව්‍යාපාර සැලැස්ම'],
    ['ACC','ගිණුම්කරණය','1. ගිණුම්කරණය හා එහි අවශ්‍යතාවය'],
    ['ACC','ගිණුම්කරණය','2. ගිණුම්කරණ සමීකරණ'],
    ['ACC','ගිණුම්කරණය','3. ද්විත්ව සටහන්'],
    ['ACC','ගිණුම්කරණය','4. මූලික පොත්'],
    ['ACC','ගිණුම්කරණය','5. සංකල්ප (ගිණුම්කරණ සංකල්ප)'],
    ['ACC','ගිණුම්කරණය','6. තනි පුද්ගල ව්‍යාපාර'],
    ['ACC','ගිණුම්කරණය','7. නිෂ්පාදන ගිණුම්'],
    ['ACC','ගිණුම්කරණය','8. අසම්පූර්ණ සටහන්'],
    ['ACC','ගිණුම්කරණය','9. ලාභ අරමුණු කර නොගත් සංවිධාන'],
    ['ACC','ගිණුම්කරණය','10. හවුල් ව්‍යාපාර'],
    ['ACC','ගිණුම්කරණය','11. ගිණුම්කරණ ප්‍රමිත (LKAS / SLFRS)'],
    ['ACC','ගිණුම්කරණය','12. සමාගම් ගිණුම්'],
    ['ACC','ගිණුම්කරණය','13. ගිණුම්කරණ අනුපාත'],
    ['ACC','ගිණුම්කරණය','14. කළමනාකරණ ගිණුම්කරණය'],
    ['ACC','ගිණුම්කරණය','15. පිරිවැය පරිමා ලාභ විශ්ලේෂණය'],
    ['ACC','ගිණුම්කරණය','16. ප්‍රාග්ධන ආයෝජන තීරණ'],
    ['ECON','ආර්ථික විද්‍යාව','1. ආර්ථික විද්‍යාව හැඳින්වීම'],
    ['ECON','ආර්ථික විද්‍යාව','2. ඉල්ලුම හා සැපයුම'],
    ['ECON','ආර්ථික විද්‍යාව','3. වෙළඳපොළට රජය මැදිහත්වීම'],
    ['ECON','ආර්ථික විද්‍යාව','4. වෙළඳපොළ තුළ නිෂ්පාදන ආයතන'],
    ['ECON','ආර්ථික විද්‍යාව','5. ජාතික ගිණුම්'],
    ['ECON','ආර්ථික විද්‍යාව','6. සාර්ව ආර්ථික සමතුලිතය'],
    ['ECON','ආර්ථික විද්‍යාව','7. මුදල් හා මිල මට්ටම්වල හැසිරීම'],
    ['ECON','ආර්ථික විද්‍යාව','8. සාර්ව ආර්ථික අරමුණු සහ රජයේ මැදිහත්වීම'],
    ['ECON','ආර්ථික විද්‍යාව','9. විදේශ වෙළඳාම'],
    ['ECON','ආර්ථික විද්‍යාව','10. විදේශ මූල්‍ය ශ්‍රී ලංකා ආර්ථිකයට බලපෑම'],
    ['ECON','ආර්ථික විද්‍යාව','11. සංවර්ධනයේ විවිධත්වය විග්‍රහ කිරීම'],
    ['ECON','ආර්ථික විද්‍යාව','12. ලංකාවේ ආර්ථික ව්‍යුහය සහ ප්‍රතිපත්ති']
  ];
  function buildFallbackCurriculumPacks(){
    const groups=new Map();
    const meta={BS:{workspaceId:'sub-bs',legacyIdPrefix:'curr-bs'},ACC:{workspaceId:'sub-acc',legacyIdPrefix:'curr-acc'},ECON:{workspaceId:'sub-econ',legacyIdPrefix:'curr-econ'}};
    for(const row of SEED){const code=row[0],name=row[1],topic=row[2];if(!groups.has(code))groups.set(code,{id:code,name,workspaceId:meta[code].workspaceId,legacyIdPrefix:meta[code].legacyIdPrefix,topics:[]});groups.get(code).topics.push(topic);}
    return [{id:'sl-al-commerce-si',title:'වාණිජ (Commerce)',country:'Sri Lanka',exam:'GCE Advanced Level',language:'Sinhala',streamName:'වාණිජ (Commerce)',streamId:'stream-commerce',description:'Commerce starter curriculum in Sinhala, organised by subject.',keywords:['commerce','වාණිජ','A/L','GCE Advanced Level','Sri Lanka','Sinhala'],subjects:[...groups.values()]}];
  }
  let CURRICULUM_PACKS=buildFallbackCurriculumPacks();window.NexusCurriculumPacks=CURRICULUM_PACKS;
  const LEGACY_SUBJECT_MAP = {
    'Business Studies':'ව්‍යාපාර අධ්‍යයනය','Business Studies (BS)':'ව්‍යාපාර අධ්‍යයනය','BS':'ව්‍යාපාර අධ්‍යය���ය',
    'Accounting':'ගිණුම්කරණය','ACC':'ගිණුම්කරණය',
    'Economics':'ආර්ථික විද්‍යාව','ECON':'ආර්ථික විද්‍යාව'
  };
  const RATING_LABELS = {1:'Again',2:'Hard',3:'Good',4:'Very good',5:'Easy'};
  let state, undoState=null, undoTimer=null, toastTimer=null, editTopicId=null, reviewTopicId=null, selectedReviewRating=null, editStreamId=null, editSubjectId=null, editExamId=null, installPrompt=window.NexusInstallPrompt||null, topicVisibleLimit=100, historyVisibleLimit=100, historyInsightsDirty=true, historyMetricsCache=null;
  const $ = id => document.getElementById(id);
  const clone = obj => JSON.parse(JSON.stringify(obj));
  const makeId = prefix => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2,8)}`;
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  function createTopKCollector(limit,compare){
    const capacity=Math.max(0,Math.floor(Number(limit)||0)),heap=[];
    let count=0;
    function siftDown(index){
      while(true){
        const left=index*2+1,right=left+1;
        let worst=index;
        if(left<heap.length&&compare(heap[left],heap[worst])>0)worst=left;
        if(right<heap.length&&compare(heap[right],heap[worst])>0)worst=right;
        if(worst===index)return;
        [heap[index],heap[worst]]=[heap[worst],heap[index]];
        index=worst;
      }
    }
    function siftUp(index){
      while(index>0){
        const parent=(index-1)>>1;
        if(compare(heap[parent],heap[index])>=0)return;
        [heap[index],heap[parent]]=[heap[parent],heap[index]];
        index=parent;
      }
    }
    return {
      add(item){
        if(item===null||item===undefined)return;
        count++;
        if(!capacity)return;
        if(heap.length<capacity){heap.push(item);siftUp(heap.length-1);}
        else if(compare(item,heap[0])<0){heap[0]=item;siftDown(0);}
      },
      finish(){heap.sort(compare);return {items:heap,count};}
    };
  }
  function selectTopK(items,limit,compare,project=value=>value){
    const collector=createTopKCollector(limit,compare);
    for(const source of items)collector.add(project(source));
    return collector.finish();
  }
  window.NexusCreateTopKCollector=createTopKCollector;
  window.NexusSelectTopK=selectTopK;
  function today(){const d=new Date();return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;}
  function validDate(s){if(!/^\d{4}-\d{2}-\d{2}$/.test(String(s||'')))return false;const [y,m,d]=s.split('-').map(Number);const x=new Date(y,m-1,d);return x.getFullYear()===y&&x.getMonth()===m-1&&x.getDate()===d;}
  function plusDays(date,days){if(!validDate(date))return '';const d=new Date(date+'T12:00:00');d.setDate(d.getDate()+Number(days));return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;}
  function dayDiff(from,to){if(!validDate(from)||!validDate(to))return 0;return Math.round((new Date(to+'T12:00:00')-new Date(from+'T12:00:00'))/86400000);}
  function fmtDate(s){if(!validDate(s))return '—';return new Date(s+'T12:00:00').toLocaleDateString(undefined,{day:'numeric',month:'short',year:'numeric'});}
  function baseState(){
    // New workspaces start empty. Starter curricula are installed explicitly from Explore.
    return {schema:3,streams:[],subjects:[],topics:[],exams:[],history:[],settings:{theme:'system',intervalCap:120,installedCurricula:[],curriculumTombstones:[]}};
  }
  function safeRead(key){try{const val=localStorage.getItem(key);return val?JSON.parse(val):null;}catch(e){console.warn('Could not read saved data',e);return null;}}
  function normalizeTopic(t, fallbackSub){return {id:String(t.id||makeId('topic')),subjectId:String(t.subjectId||fallbackSub),name:String(t.name||t.topic||'Untitled topic').slice(0,240),notes:String(t.notes||'').slice(0,1000),custom:t.custom!==false,createdAt:validDate(t.createdAt)?t.createdAt:today(),lastReviewed:validDate(t.lastReviewed)?t.lastReviewed:(validDate(t.lastDate)?t.lastDate:''),lastRating:Number(t.lastRating??t.score)>=1&&Number(t.lastRating??t.score)<=5?Number(t.lastRating??t.score):null,dueDate:validDate(t.dueDate)?t.dueDate:(validDate(t.nextDate)?t.nextDate:''),intervalDays:Math.max(0,Math.min(120,Number(t.intervalDays)||0)),reviewCount:Math.max(0,Math.min(100000,Number(t.reviewCount)||0)),streak:Math.max(0,Number(t.streak)||0),lapses:Math.max(0,Number(t.lapses??t.lapseCount)||0),archived:Boolean(t.archived),fsrs:window.NexusBackupRestoreUtils.sanitizeFsrsCard(t.fsrs)};}
  function migrateOld(raw){
    const fresh=baseState(); if(!raw||typeof raw!=='object')return fresh;
    const oldTopics=Array.isArray(raw.topics)?raw.topics:[]; const oldHistory=Array.isArray(raw.history)?raw.history:[];
    const oldNameToCurrent = name => LEGACY_SUBJECT_MAP[name]||name;
    const findSubject = name => fresh.subjects.find(s=>s.name===oldNameToCurrent(name));
    const ensureSubject = name => {
      const mapped=oldNameToCurrent(String(name||'Imported subject'));
      let subj=findSubject(mapped);if(subj)return subj;
      const commerceNames=['ව්‍යාපාර අධ්‍යයනය','ගිණුම්කරණය','ආර්ථික විද්‍යාව'];
      let stream;
      if(commerceNames.includes(mapped)){
        stream=fresh.streams.find(s=>s.id==='stream-commerce');
        if(!stream){stream={id:'stream-commerce',name:'වාණිජ (Commerce)'};fresh.streams.push(stream);}
      }else{
        stream=fresh.streams.find(s=>s.name==='Imported / Other');
        if(!stream){stream={id:makeId('stream'),name:'Imported / Other'};fresh.streams.push(stream);}
      }
      subj={id:({'ව්‍යාපාර අධ්‍යයනය':'sub-bs','ගිණුම්කරණය':'sub-acc','ආර්ථික විද්‍යාව':'sub-econ'})[mapped]||makeId('subject'),name:mapped,streamId:stream.id,order:fresh.subjects.filter(x=>x.streamId===stream.id).length};
      fresh.subjects.push(subj);return subj;
    };
    for(const old of oldTopics){
      const subj=ensureSubject(old.subject);
      let name=old.topic||old.name||'Untitled topic'; let existing=fresh.topics.find(t=>t.subjectId===subj.id&&t.name===name);
      const mapped=normalizeTopic({...old,name,subjectId:subj.id,custom:old.custom===false?false:true, lastReviewed:old.lastReviewed||old.lastDate, lastRating:old.lastRating??old.score,dueDate:old.dueDate||old.nextDate,intervalDays:old.intervalDays||((validDate(old.lastReviewed||old.lastDate)&&validDate(old.dueDate||old.nextDate))?Math.max(1,dayDiff(old.lastReviewed||old.lastDate,old.dueDate||old.nextDate)):0)},subj.id);
      if(existing)Object.assign(existing,mapped,{id:existing.id,subjectId:subj.id,name,custom:false});else fresh.topics.push(mapped);
    }
    fresh.history=oldHistory.map((h,i)=>{
      const s=findSubject(h.subject)||ensureSubject(h.subject);const targetSub=s.id;const top=fresh.topics.find(t=>t.subjectId===targetSub&&t.name===(h.topic||h.topicName));const rating=Math.min(5,Math.max(1,Number(h.rating??h.score)||3));const reviewed=validDate(h.reviewedAt||h.reviewedDate)?(h.reviewedAt||h.reviewedDate):today();const due=validDate(h.dueDate||h.nextDate)?(h.dueDate||h.nextDate):plusDays(reviewed,({1:1,2:2,3:4,4:7,5:12})[rating]);
      return {id:String(h.id||makeId('history')+i),topicId:top?.id||'',streamId:s?.streamId||'',subjectId:s?.id||'',streamName:s?fresh.streams.find(x=>x.id===s.streamId)?.name:'',subjectName:s?.name||String(h.subject||'Imported'),topicName:String(h.topic||h.topicName||'Untitled topic'),reviewedAt:reviewed,rating,intervalDays:Math.max(1,Math.min(120,Number(h.intervalDays)||dayDiff(reviewed,due)||1)),dueDate:due,note:String(h.note||'')};
    });
    const settings=raw.settings||{}; fresh.settings.theme=['system','light','dark'].includes(settings.theme)?settings.theme:'system'; fresh.settings.installedCurricula=Array.isArray(settings.installedCurricula)?Array.from(new Set(settings.installedCurricula.filter(x=>typeof x==='string'&&x.length>0))).slice(-5000):[]; fresh.settings.curriculumTombstones=Array.isArray(settings.curriculumTombstones)?Array.from(new Set(settings.curriculumTombstones.filter(x=>typeof x==='string'&&x.length>0))).slice(-5000):[];
    if(validDate(settings.examDate)){fresh.exams.push({id:'exam-legacy-migrated',name:'GCE Advanced Level',date:settings.examDate,type:'Academic exam',notes:''});}
    if(Array.isArray(settings.exams))fresh.exams=settings.exams.map(ex=>sanitizeExam(ex));
    return fresh;
  }
  function sanitizeExam(ex){return {id:String(ex.id||makeId('exam')),name:String(ex.name||'Exam').slice(0,150),date:validDate(ex.date)?ex.date:'',type:String(ex.type||'Other').slice(0,60),notes:String(ex.notes||'').slice(0,500)};}
  function normalizeState(raw){
    if(!raw||typeof raw!=='object')throw new Error('Invalid backup format.');
    if(!Array.isArray(raw.streams)||!Array.isArray(raw.subjects)||!Array.isArray(raw.topics))return migrateOld(raw);
    const streams=raw.streams.filter(s=>s&&s.id&&s.name).map(s=>({id:String(s.id),name:String(s.name).slice(0,100)}));
    const subjects=raw.subjects.filter(s=>s&&s.id&&s.name).map((s,i)=>({id:String(s.id),name:String(s.name).slice(0,100),streamId:String(s.streamId||''),order:Number(s.order)||i}));
    const topics=raw.topics.filter(t=>t&&t.name).map(t=>normalizeTopic(t,String(t.subjectId||'')));
    // Empty workspaces are valid; only create a fallback parent when actual topics need one.
    if(topics.length&&!streams.length)streams.push({id:'stream-general',name:'General'});
    if(topics.length&&!subjects.length)subjects.push({id:'subject-general',name:'General',streamId:streams[0].id,order:0});
    const streamIds=new Set(streams.map(s=>s.id));
    for(const sub of subjects){if(!streamIds.has(sub.streamId)){if(!streams.length)streams.push({id:'stream-general',name:'General'});sub.streamId=streams[0].id;streamIds.add(sub.streamId);}}
    const subjectIds=new Set(subjects.map(s=>s.id));
    for(const t of topics){if(!subjectIds.has(t.subjectId)){let sub=subjects[0];if(!sub){sub={id:'subject-general',name:'General',streamId:streams[0].id,order:0};subjects.push(sub);subjectIds.add(sub.id);}t.subjectId=sub.id;}}
    const cleanHistory=Array.isArray(raw.history)?raw.history.slice(0,200000).map((h,i)=>{const rating=Number(h.rating??h.score);const reviewed=validDate(h.reviewedAt||h.reviewedDate)?(h.reviewedAt||h.reviewedDate):today();return {id:String(h.id||`history-${i}-${Date.now()}`),topicId:String(h.topicId||''),streamId:String(h.streamId||''),subjectId:String(h.subjectId||''),streamName:String(h.streamName||''),subjectName:String(h.subjectName||h.subject||'Unknown subject').slice(0,100),topicName:String(h.topicName||h.topic||'Untitled topic').slice(0,240),reviewedAt:reviewed,rating:rating>=1&&rating<=5?rating:3,intervalDays:Math.min(120,Math.max(1,Number(h.intervalDays)||1)),dueDate:validDate(h.dueDate||h.nextDate)?(h.dueDate||h.nextDate):'',note:String(h.note||'').slice(0,1000)};}):[];
    const exams=Array.isArray(raw.exams)?raw.exams.filter(e=>e&&e.name).map(sanitizeExam):[];
    const theme=['system','light','dark'].includes(raw.settings?.theme)?raw.settings.theme:'system';
    const installedCurricula=Array.isArray(raw.settings?.installedCurricula)?Array.from(new Set(raw.settings.installedCurricula.filter(x=>typeof x==='string'&&x.length>0))).slice(-5000):[];
    const curriculumTombstones=Array.isArray(raw.settings?.curriculumTombstones)?Array.from(new Set(raw.settings.curriculumTombstones.filter(x=>typeof x==='string'&&x.length>0))).slice(-5000):[];
    return {schema:3,streams,subjects,topics,history:cleanHistory,exams,settings:{theme,intervalCap:Math.min(120,Math.max(1,Number(raw.settings?.intervalCap)||120)),installedCurricula,curriculumTombstones}};
  }
  // Curriculum rows are owned by explicit install intent, not by whether a topic has
  // review progress. The previous cleanup inferred ownership from seed IDs and deleted
  // untouched Commerce-pack rows on every reload.
  function repairCurriculumStateResult(data){
    const api=window.NexusCurriculumIntegrity;
    if(!api||typeof api.repair!=='function')return {state:data,changed:false,restoredStreams:0,restoredSubjects:0,restoredTopics:0};
    return api.repair(data,CURRICULUM_PACKS,{today,makeId});
  }
  function repairCurriculumState(data){return repairCurriculumStateResult(data).state;}
  window.NexusRepairNormalizedCurriculumState=repairCurriculumState;
  window.NexusRepairNormalizedCurriculumStateWithResult=repairCurriculumStateResult;
  window.NexusRepairCurriculumState=function(data){return repairCurriculumState(normalizeState(data));};
  function persistLoadedRepair(data){
    const queue=window.NexusOfflineSyncQueue;
    if(!queue||typeof queue.commitWorkspace!=='function')throw new Error('Safe offline sync queue is unavailable.');
    const rawFeatures=localStorage.getItem('recall.study.features.v1');
    const featureState=rawFeatures===null?{}:JSON.parse(rawFeatures);
    if(!featureState||typeof featureState!=='object'||Array.isArray(featureState))throw new Error('Saved Study Hub data is invalid.');
    queue.commitWorkspace(localStorage,[{key:STORAGE_KEY,value:JSON.stringify(data)}],{state:data,featureState},{returnOperationPayload:false});
  }
  function loadAndRepair(data){
    const normalized=normalizeState(data);
    const result=repairCurriculumStateResult(normalized);
    const repaired=result.state;
    if(result.changed){
      try{persistLoadedRepair(repaired);}catch(e){console.warn('Curriculum repair is available in memory but could not be persisted safely; original saved data was left intact.',e);}
    }
    return repaired;
  }
  function loadState(){const current=safeRead(STORAGE_KEY);if(current){try{return loadAndRepair(current);}catch(e){console.warn('Saved data was invalid; existing saved bytes were not overwritten.',e);}}const old=safeRead('alSrsTrackerV2');if(old){try{return loadAndRepair(migrateOld(old.state||old));}catch(e){console.warn(e);}}const legacyT=safeRead('alTrackerData'),legacyH=safeRead('alHistoryLog');if(Array.isArray(legacyT)||Array.isArray(legacyH))return loadAndRepair(migrateOld({topics:legacyT||[],history:legacyH||[]}));return baseState();}
  let storageSaveRevision=0;
  function save(){
    try{
      // Curriculum repair runs at hydration, import/restore, cloud-merge, and catalogue
      // boundaries. Repeating a full catalogue scan on every ordinary review/save would
      // make a large workspace pay for repair work even when no catalogue state changed.
      const featureState=window.NexusGetFeatureState?window.NexusGetFeatureState():(()=>{
        try{const x=JSON.parse(localStorage.getItem('recall.study.features.v1')||'{}');return x&&typeof x==='object'&&!Array.isArray(x)?x:{}}catch(_){return {}}
      })();
      if(!window.NexusOfflineSyncQueue)throw new Error('Safe offline sync queue is unavailable.');
      window.NexusOfflineSyncQueue.commitWorkspace(localStorage,[{key:STORAGE_KEY,value:JSON.stringify(state)}],{state,featureState},{returnOperationPayload:false});
      const storage=window.NexusStorage;
      if(storage&&typeof storage.isEnabled==='function'&&storage.isEnabled()&&typeof storage.flush==='function'){
        const saveRevision=++storageSaveRevision;
        $('saveStatus').textContent='Saving to this device…';
        $('saveStatus').style.color='';
        storage.flush().then(()=>{
          if(saveRevision!==storageSaveRevision)return;
          $('saveStatus').textContent='Saved on this device';
          $('saveStatus').style.color='';
        }).catch(error=>{
          if(saveRevision!==storageSaveRevision)return;
          $('saveStatus').textContent='Save failed — export backup';
          $('saveStatus').style.color='var(--red)';
          notify('Could not finish saving to durable device storage. Keep Nexus open and export a backup before continuing.');
          console.error('Nexus durable save failed',error);
        });
      }else{
        $('saveStatus').textContent='Saved on this device';
        $('saveStatus').style.color='';
      }
      if(window.NexusCloudSync&&window.NexusCloudSync.recordLocalSave)window.NexusCloudSync.recordLocalSave({state,featureState});
      if(window.NexusCloudSync)window.NexusCloudSync.schedule();
      return true;
    }catch(e){
      $('saveStatus').textContent='Save failed — export backup';
      $('saveStatus').style.color='var(--red)';
      notify('Could not save data. Export a backup and check browser storage.');
      return false;
    }
  }
  function notify(text,undoable=false){$('toastText').textContent=text;$('undoBtn').style.display=undoable?'':'none';$('toast').classList.toggle('undoable',undoable);$('toast').classList.add('show');clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').classList.remove('show'),6500);}
  function armUndo(text){
    clearTimeout(undoTimer);notify(text,true);
    undoTimer=setTimeout(()=>{undoState=null;$('undoBtn').style.display='none';},6500);
  }
  function startUndoBulkDelete(text){
    if(window.NexusClearCascadeUndo)window.NexusClearCascadeUndo();
    // Bulk deletes replace top-level arrays and only mutate the small settings
    // tombstone object. Keep the original large topic/history arrays by reference.
    undoState={kind:'state-reference',value:state,streams:state.streams,subjects:state.subjects,topics:state.topics,history:state.history,settings:clone(state.settings)};
    armUndo(text);
  }
  function startUndoTopicEdit(text,topic){
    if(window.NexusClearCascadeUndo)window.NexusClearCascadeUndo();
    undoState={kind:'topic-edit',value:state,topic,before:{name:topic.name,subjectId:topic.subjectId,notes:topic.notes,dueDate:topic.dueDate}};
    armUndo(text);
  }
  function startUndoTopicAdd(text,topicId){
    if(window.NexusClearCascadeUndo)window.NexusClearCascadeUndo();
    undoState={kind:'topic-add',value:state,topicId};
    armUndo(text);
  }
  function startUndoHistoryChange(text){
    if(window.NexusClearCascadeUndo)window.NexusClearCascadeUndo();
    undoState={kind:'history-reference',value:state,history:state.history};
    armUndo(text);
  }
  function startUndoWorkspaceReplace(text){
    if(window.NexusClearCascadeUndo)window.NexusClearCascadeUndo();
    undoState={kind:'workspace-reference',value:state};
    armUndo(text);
  }
  function startUndoEntityEdit(text,collection,item,fields){
    if(window.NexusClearCascadeUndo)window.NexusClearCascadeUndo();
    const before={};for(const field of fields)before[field]=item[field];
    undoState={kind:'entity-edit',value:state,item,before};
    armUndo(text);
  }
  function startUndoEntityAdd(text,collection,itemId){
    if(window.NexusClearCascadeUndo)window.NexusClearCascadeUndo();
    undoState={kind:'entity-add',value:state,collection,itemId};
    armUndo(text);
  }
  function startUndoArrayReplacement(text,collection){
    if(window.NexusClearCascadeUndo)window.NexusClearCascadeUndo();
    undoState={kind:'array-reference',value:state,collection,previous:state[collection]};
    armUndo(text);
  }
  function startUndoArrayItemReplacement(text,collection,index){
    if(window.NexusClearCascadeUndo)window.NexusClearCascadeUndo();
    undoState={kind:'array-item-reference',value:state,collection,index,previous:state[collection][index]};
    armUndo(text);
  }
  function startUndoTopicBatch(text,topics,fields){
    if(window.NexusClearCascadeUndo)window.NexusClearCascadeUndo();
    const changes=[];
    const uniqueTopics=new Set();
    for(const topic of topics||[]){
      if(!topic||uniqueTopics.has(topic))continue;
      uniqueTopics.add(topic);
      const before={};for(const field of fields||[])before[field]=topic[field];
      changes.push({topic,before});
    }
    undoState={kind:'topic-batch-edit',value:state,changes};
    armUndo(text);
  }
  window.NexusStartUndoBulkDelete=startUndoBulkDelete;
  window.NexusStartUndoTopicBatch=startUndoTopicBatch;
  function startUndoReview(text,topic,reviewId){
    if(window.NexusClearCascadeUndo)window.NexusClearCascadeUndo();
    // A review mutates one topic and prepends one history row. Capture only the
    // previous topic fields and history length instead of cloning 20+ MiB of data.
    undoState={kind:'review',value:state,topic,reviewId,historyLength:state.history.length,
      topicBefore:{lapses:topic.lapses,streak:topic.streak,lastReviewed:topic.lastReviewed,lastRating:topic.lastRating,
        intervalDays:topic.intervalDays,dueDate:topic.dueDate,reviewCount:topic.reviewCount}};
    armUndo(text);
  }
  function undo(){
    if(!undoState)return;
    const pending=undoState;undoState=null;clearTimeout(undoTimer);
    if(pending.kind==='review'){
      state=pending.value;Object.assign(pending.topic,pending.topicBefore);
      if(state.history.length===pending.historyLength+1&&state.history[0]?.id===pending.reviewId)state.history.shift();
      else state.history=state.history.filter(entry=>String(entry&&entry.id||'')!==String(pending.reviewId));
    }else if(pending.kind==='state-reference'){
      state=pending.value;state.streams=pending.streams;state.subjects=pending.subjects;state.topics=pending.topics;state.history=pending.history;state.settings=pending.settings;
    }else if(pending.kind==='topic-edit'){
      state=pending.value;Object.assign(pending.topic,pending.before);
    }else if(pending.kind==='topic-add'){
      state=pending.value;state.topics=state.topics.filter(topic=>String(topic.id)!==String(pending.topicId));
    }else if(pending.kind==='history-reference'){
      state=pending.value;state.history=pending.history;
    }else if(pending.kind==='entity-edit'){
      state=pending.value;Object.assign(pending.item,pending.before);
    }else if(pending.kind==='entity-add'){
      state=pending.value;state[pending.collection]=state[pending.collection].filter(item=>String(item.id)!==String(pending.itemId));
    }else if(pending.kind==='array-reference'){
      state=pending.value;state[pending.collection]=pending.previous;
    }else if(pending.kind==='array-item-reference'){
      state=pending.value;state[pending.collection][pending.index]=pending.previous;
    }else if(pending.kind==='topic-batch-edit'){
      state=pending.value;for(const change of pending.changes)Object.assign(change.topic,change.before);
    }else state=pending.value;
    if(window.NexusUndoCascadeDelete)window.NexusUndoCascadeDelete();
    save();renderAll();$('toast').classList.remove('show');
  }
  function subjectFor(topic){return state.subjects.find(s=>s.id===topic.subjectId)||null;}
  function streamFor(subject){return state.streams.find(s=>s.id===subject?.streamId)||null;}
  function getTopic(id){return state.topics.find(t=>t.id===String(id));}
  function activeTopics(){return state.topics.filter(t=>!t.archived);}
  function status(topic){if(!topic.lastReviewed||!topic.dueDate)return 'new';if(topic.dueDate<today())return 'overdue';if(topic.dueDate===today())return 'due';return 'upcoming';}
  function statusText(s){return ({overdue:'Overdue',due:'Due today',new:'Not reviewed',upcoming:'Upcoming'})[s]||s;}
  function dueRank(s){return ({overdue:0,due:1,new:2,upcoming:3})[s]??4;}
  function interval(rating,previous){const prev=Math.max(0,Number(previous)||0);let d;if(rating===1)d=1;else if(rating===2)d=prev?Math.max(prev+1,Math.round(prev*1.25)):2;else if(rating===3)d=prev?Math.round(prev*2):4;else if(rating===4)d=prev?Math.round(prev*2.5):7;else d=prev?Math.round(prev*3):12;return Math.min(120,Math.max(1,d));}
  function subjectDisplay(t){const s=subjectFor(t),st=streamFor(s);return {subject:s?.name||'Unknown subject',stream:st?.name||'Unknown stream'};}
  function nearestExam(){return state.exams.filter(e=>validDate(e.date)).slice().sort((a,b)=>{const ad=a.date>=today()?0:1,bd=b.date>=today()?0:1;return ad-bd|| (ad===0?a.date.localeCompare(b.date):b.date.localeCompare(a.date));})[0]||null;}
  function switchView(name){
    document.querySelectorAll('.tab').forEach(b=>b.setAttribute('aria-selected',String(b.dataset.view===name)));
    document.querySelectorAll('.view').forEach(v=>v.classList.toggle('active',v.id===`view-${name}`));
    if(name==='overview'){renderOverview();if(window.NexusRefreshHomeConsistencySummary)window.NexusRefreshHomeConsistencySummary();}
    if(name==='topics'){refreshFilterOptions();renderTopics();}
    if(name==='explore')renderExplore();
    if(name==='history'){refreshFilterOptions();renderHistory();}
    if(name==='setup')renderSetup();
    window.scrollTo({top:0,behavior:'smooth'});
  }
  function statCard(label,value,foot){return `<div class="stat"><div class="stat-label">${esc(label)}</div><div class="stat-value">${esc(value)}</div><div class="stat-foot">${esc(foot)}</div></div>`;}
  function insertSortedLimit(items,item,limit,compare){
    let low=0,high=items.length;
    while(low<high){const middle=(low+high)>>1;if(compare(items[middle],item)<=0)low=middle+1;else high=middle;}
    if(low>=limit)return;
    items.splice(low,0,item);
    if(items.length>limit)items.pop();
  }
  function renderOverview(){
    const topics=state.topics,todayKey=today(),progressBySubject=new Map(),queue=[];
    let activeCount=0,dueCount=0,overdueCount=0,newCount=0,reviewedCount=0;
    const queueCompare=(a,b)=>dueRank(a.status)-dueRank(b.status)||
      (a.topic.dueDate||'9999').localeCompare(b.topic.dueDate||'9999')||
      naturalCompare(a.topic.name,b.topic.name);
    // Compute all topic totals in one pass. Only the seven visible queue
    // entries are retained and sorted; the full collection is never sorted
    // merely to render a seven-row summary.
    for(const topic of topics){
      if(topic.archived)continue;activeCount++;
      const topicStatus=status(topic);
      if(topicStatus==='overdue'||topicStatus==='due'){dueCount++;if(topicStatus==='overdue')overdueCount++;}
      if(topicStatus==='new')newCount++;
      if(topic.reviewCount>0)reviewedCount++;
      let entry=progressBySubject.get(topic.subjectId);
      if(!entry){entry={total:0,done:0};progressBySubject.set(topic.subjectId,entry);}
      entry.total++;if(topic.reviewCount>0)entry.done++;
      if(topicStatus==='overdue'||topicStatus==='due'||topicStatus==='new')insertSortedLimit(queue,{topic,status:topicStatus},7,queueCompare);
    }
    const reviewedToday=getHistoryMetrics().byDate.get(todayKey)||0;
    $('statsGrid').innerHTML=statCard('Due now',dueCount,overdueCount+' overdue')+statCard('Not reviewed',newCount,'Active topics with no review')+statCard('Reviewed topics',reviewedCount,'of '+activeCount+' active topics')+statCard('Reviews today',reviewedToday,'Review records dated today');
    const ex=nearestExam();if(ex){const remaining=dayDiff(todayKey,ex.date);$('examBanner').innerHTML='<div><h3>'+esc(ex.name)+'</h3><p>'+esc(ex.type)+' · '+fmtDate(ex.date)+(ex.notes?' · '+esc(ex.notes):'')+'</p></div><div class="countdown"><strong>'+(remaining>=0?remaining:Math.abs(remaining))+'</strong><span>'+(remaining>0?'days remaining':remaining===0?'today':'days since')+'</span></div>';}else{$('examBanner').innerHTML='<div><h3>No exam dates added</h3><p>Add an exam or deadline to display a countdown here.</p></div><button class="btn btn-sm" id="bannerAddExam">＋ Add exam</button>';$('bannerAddExam').addEventListener('click',()=>openExam());}
    $('dueQueue').innerHTML=queue.length?queue.map(({topic,status:st})=>{const d=subjectDisplay(topic);return '<div class="due-item"><div style="min-width:0"><div class="due-title">'+esc(topic.name)+'</div><div class="due-meta"><span>'+esc(d.subject)+'</span><span>·</span><span>'+esc(d.stream)+'</span><span class="pill '+st+'">'+statusText(st)+'</span></div></div><button type="button" class="btn btn-sm btn-primary" data-action="review" data-id="'+esc(topic.id)+'">Review</button></div>';}).join(''):'<div class="empty"><strong>You\'re all caught up</strong>No overdue or due topics at the moment. New topics are available under Topics.</div>';
    const subjectGroups=state.subjects.map(sub=>{const stats=progressBySubject.get(sub.id)||{total:0,done:0};return {s:sub,total:stats.total,done:stats.done,stream:streamFor(sub)?.name||''};}).filter(x=>x.total||state.subjects.length<8);
    $('progressList').innerHTML=subjectGroups.length?subjectGroups.map(g=>{const p=g.total?Math.round(g.done/g.total*100):0;return '<div class="progress-row"><div class="progress-label"><strong>'+esc(g.s.name)+'</strong><span>'+g.done+'/'+g.total+' · '+p+'%</span></div><div class="progress-track"><div class="progress-fill" style="width:'+p+'%"></div></div><div class="muted small" style="margin-top:4px">'+esc(g.stream)+'</div></div>';}).join(''):'<div class="empty">Add a subject to see progress.</div>';
    renderUpcomingQueue();renderOverviewAnalytics();
  }
  function addHistoryMetricRecord(metrics,record){
    if(!record)return;
    const date=record.reviewedAt;
    if(validDate(date)){metrics.byDate.set(date,(metrics.byDate.get(date)||0)+1);metrics.dates.add(date);}
    metrics.ratingSum+=Number(record.rating)||0;
    const ratingIndex=Number(record.rating)-1;
    if(Number.isInteger(ratingIndex)&&ratingIndex>=0&&ratingIndex<5)metrics.ratingCounts[ratingIndex]++;
  }
  function buildHistoryMetrics(entries){
    const metrics={source:entries,length:entries.length,firstRecord:entries[0],byDate:new Map(),dates:new Set(),ratingSum:0,ratingCounts:[0,0,0,0,0]};
    for(const record of entries)addHistoryMetricRecord(metrics,record);
    return metrics;
  }
  function getHistoryMetrics(){
    const entries=state.history,cache=historyMetricsCache;
    if(cache&&cache.source===entries){
      if(cache.length===entries.length)return cache;
      if(entries.length===cache.length+1&&entries[1]===cache.firstRecord){
        addHistoryMetricRecord(cache,entries[0]);cache.length=entries.length;cache.firstRecord=entries[0];return cache;
      }
    }
    historyMetricsCache=buildHistoryMetrics(entries);return historyMetricsCache;
  }
  function recentHistoryCount(days,metrics=getHistoryMetrics()){
    const end=today();let count=0;
    for(let i=0;i<days;i++)count+=metrics.byDate.get(plusDays(end,-i))||0;
    return count;
  }
  function dailyReviewSeries(days, entries=state.history){
    const base=today(),counts=new Map();
    if(entries===state.history){
      const indexed=getHistoryMetrics().byDate;
      for(const [date,count] of indexed)if(date<=base&&date>=plusDays(base,-(days-1)))counts.set(date,count);
    }else{
      const first=plusDays(base,-(days-1));
      for(const h of entries){if(validDate(h.reviewedAt)&&h.reviewedAt>=first&&h.reviewedAt<=base)counts.set(h.reviewedAt,(counts.get(h.reviewedAt)||0)+1);}
    }
    return Array.from({length:days},(_,i)=>{const date=plusDays(base,i-(days-1)),d=new Date(date+'T12:00:00');return {date,count:counts.get(date)||0,label:days>7?String(d.getDate()):d.toLocaleDateString(undefined,{weekday:'short'}).replace('.',''),short:d.toLocaleDateString(undefined,{day:'numeric',month:'short'})};});
  }
  function currentStudyStreak(){
    const dates=getHistoryMetrics().dates;let start=dates.has(today())?0:1,streak=0;
    for(let i=start;i<3660;i++){if(dates.has(plusDays(today(),-i)))streak++;else break;}return streak;
  }
  function averageRating(entries=state.history){
    if(entries===state.history){const metrics=getHistoryMetrics();return entries.length?metrics.ratingSum/entries.length:0;}
    return entries.length?entries.reduce((sum,h)=>sum+(Number(h.rating)||0),0)/entries.length:0;
  }
  function metricMarkup(value,label){return `<div class="insight-metric"><strong>${esc(value)}</strong><span>${esc(label)}</span></div>`;}
  let chartGradientCounter=0;
  function nextChartGradientId(prefix){return String(prefix||'nexus-chart')+'-'+(++chartGradientCounter);}
  function smoothCurvePath(points){
    if(!points||!points.length)return '';
    if(points.length===1)return 'M '+points[0].x.toFixed(2)+' '+points[0].y.toFixed(2);
    let d='M '+points[0].x.toFixed(2)+' '+points[0].y.toFixed(2);
    for(let i=0;i<points.length-1;i++){
      const p0=points[i-1]||points[i],p1=points[i],p2=points[i+1],p3=points[i+2]||p2,low=Math.min(p1.y,p2.y),high=Math.max(p1.y,p2.y);
      const c1x=p1.x+(p2.x-p0.x)/6,c1y=Math.min(high,Math.max(low,p1.y+(p2.y-p0.y)/6)),c2x=p2.x-(p3.x-p1.x)/6,c2y=Math.min(high,Math.max(low,p2.y-(p3.y-p1.y)/6));
      d+=' C '+c1x.toFixed(2)+' '+c1y.toFixed(2)+', '+c2x.toFixed(2)+' '+c2y.toFixed(2)+', '+p2.x.toFixed(2)+' '+p2.y.toFixed(2);
    }
    return d;
  }
  function barsMarkup(series){const max=Math.max(1,...series.map(x=>x.count));return `<div class="chart-bars" style="grid-template-columns:repeat(${series.length},minmax(0,1fr))" role="img" aria-label="Daily review counts for the past ${series.length} days">${series.map((x,i)=>`<div class="chart-column" title="${esc(x.short)}: ${x.count} review${x.count===1?'':'s'}"><span class="chart-value">${x.count||'·'}</span><div class="chart-bar-track"><span class="chart-bar" style="height:${x.count?Math.max(6,Math.round(x.count/max*100)):3}%;animation-delay:${i*24}ms"></span></div><span class="chart-day">${esc(x.label)}</span></div>`).join('')}</div>`;}
  function overviewLineChartMarkup(series){
    const width=720,height=188,left=39,right=15,top=18,bottom=37,plotWidth=width-left-right,plotHeight=height-top-bottom,baseline=top+plotHeight;
    const values=(Array.isArray(series)?series:[]).map(item=>Math.max(0,Number(item&&item.count)||0));
    const rawMax=Math.max(1,...values),tickStep=rawMax<=4?1:Math.ceil(rawMax/4),maxValue=Math.max(1,Math.ceil(rawMax/tickStep)*tickStep);
    const xAt=i=>left+(values.length>1?i/(values.length-1):.5)*plotWidth,yAt=value=>top+plotHeight-(value/maxValue)*plotHeight;
    const points=values.map((value,i)=>({x:xAt(i),y:yAt(value),value,item:series[i]}));
    const path=smoothCurvePath(points),area=points.length>1?path+' L '+points[points.length-1].x.toFixed(2)+' '+baseline.toFixed(2)+' L '+points[0].x.toFixed(2)+' '+baseline.toFixed(2)+' Z':'';
    const gradientId=nextChartGradientId('overview-momentum');
    let svg='<svg class="overview-line-svg" viewBox="0 0 '+width+' '+height+'" role="img" aria-label="Smooth line chart of daily review activity over the last '+values.length+' days"><defs><linearGradient id="'+gradientId+'" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="var(--accent)" stop-opacity=".25"/><stop offset="100%" stop-color="var(--accent)" stop-opacity="0"/></linearGradient></defs>';
    [...new Set([0,Math.round(maxValue/2),maxValue])].forEach(value=>{const y=yAt(value);svg+='<line x1="'+left+'" y1="'+y.toFixed(2)+'" x2="'+(width-right)+'" y2="'+y.toFixed(2)+'" stroke="var(--border)" stroke-dasharray="3 4"/><text x="'+(left-8)+'" y="'+(y+4).toFixed(2)+'" fill="var(--muted)" font-size="11" text-anchor="end">'+value+'</text>';});
    svg+='<line x1="'+left+'" y1="'+baseline.toFixed(2)+'" x2="'+(width-right)+'" y2="'+baseline.toFixed(2)+'" stroke="var(--border)"/>';
    if(points.length>1)svg+='<path d="'+area+'" fill="url(#'+gradientId+')"/>';
    if(points.length)svg+='<path d="'+path+'" fill="none" stroke="var(--accent)" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>';
    const labelEvery=Math.max(1,Math.ceil(points.length/7));
    points.forEach((point,i)=>{const item=point.item||{},date=String(item.short||item.date||''),count=point.value;svg+='<circle cx="'+point.x.toFixed(2)+'" cy="'+point.y.toFixed(2)+'" r="3.5" fill="var(--accent)"><title>'+esc(date)+': '+count+' review'+(count===1?'':'s')+'</title></circle>';if(i%labelEvery===0||i===points.length-1)svg+='<text x="'+point.x.toFixed(2)+'" y="'+(height-17)+'" fill="var(--muted)" font-size="10" text-anchor="middle">'+esc(String(item.label||''))+'</text>';});
    svg+='<text x="'+(left+plotWidth/2)+'" y="'+(height-2)+'" fill="var(--muted)" font-size="10" font-weight="600" text-anchor="middle">Day</text></svg>';
    return '<div class="overview-line-wrap">'+svg+'</div>';
  }
  function renderOverviewAnalytics(){
    const recent=recentHistoryCount(7);
    const average=averageRating();
    const series=dailyReviewSeries(7);
    $('overviewAnalytics').innerHTML=`<div class="insight-metrics">${metricMarkup(recent.length,'Reviews this week')}${metricMarkup(average?average.toFixed(1)+'/5':'—','Average recall rating')}${metricMarkup(currentStudyStreak()+'d','Current study streak')}</div><div class="chart-heading"><span>Daily reviews</span><small>7-day activity</small></div>${state.history.length?overviewLineChartMarkup(series):'<div class="chart-empty">Your chart will fill in after your first review.</div>'}`;
  }
  function renderUpcomingQueue(){
    const todayKey=today(),limit=plusDays(todayKey,7),items=[];
    const compare=(a,b)=>a.dueDate.localeCompare(b.dueDate)||naturalCompare(a.name,b.name);
    for(const topic of state.topics){
      if(topic.archived||!validDate(topic.dueDate)||topic.dueDate<=todayKey||topic.dueDate>limit)continue;
      insertSortedLimit(items,topic,7,compare);
    }
    $('upcomingCount').textContent=items.length+' scheduled';
    $('upcomingQueue').innerHTML=items.length?items.map(t=>{const d=subjectDisplay(t),days=dayDiff(todayKey,t.dueDate);return '<div class="due-item upcoming-row"><div style="min-width:0"><div class="due-title">'+esc(t.name)+'</div><div class="due-meta"><span>'+esc(d.subject)+'</span><span class="pill upcoming">In '+days+' day'+(days===1?'':'s')+'</span></div></div><div class="upcoming-date"><strong>'+esc(fmtDate(t.dueDate))+'</strong><button type="button" class="btn btn-sm" data-action="review" data-id="'+esc(t.id)+'">Review</button></div></div>';}).join(''):'<div class="empty"><strong>No reviews scheduled this week</strong>Upcoming topics will appear here when their next review date falls within seven days.</div>';
  }
  function renderHistoryInsights(){
    const series=dailyReviewSeries(14),recent=recentHistoryCount(7),average=averageRating();
    const ratingCounts=getHistoryMetrics().ratingCounts;
    const maxRating=Math.max(1,...ratingCounts);
    $('historyInsights').innerHTML=`<div class="insight-metrics">${metricMarkup(state.history.length,'Total saved reviews')}${metricMarkup(recent.length,'Reviews in last 7 days')}${metricMarkup(average?average.toFixed(1)+'/5':'—','Average recall rating')}</div><div class="chart-heading"><span>Review activity</span><small>Last 14 days</small></div>${state.history.length?barsMarkup(series):'<div class="chart-empty">No review history yet. Complete your first review to start tracking activity.</div>'}<div class="divider"></div><div class="chart-heading"><span>Recall rating distribution</span><small>All saved reviews</small></div><div class="rating-distribution">${ratingCounts.map((count,i)=>`<div class="rating-distribution-row"><span>${i+1} · ${esc(RATING_LABELS[i+1])}</span><div class="progress-track"><div class="progress-fill" style="width:${count?Math.max(2,Math.round(count/maxRating*100)):0}%"></div></div><strong>${count}</strong></div>`).join('')}</div><p class="analytics-subtitle">A higher average rating can indicate stronger recall, but use your actual exam-question performance as the main measure of mastery.</p>`;
  }
  function fillSelect(el,items,selected,allLabel){const prior=selected??el.value;el.innerHTML=(allLabel?`<option value="ALL">${esc(allLabel)}</option>`:'')+items.map(i=>`<option value="${esc(i.value)}">${esc(i.label)}</option>`).join('');if([...el.options].some(o=>o.value===prior))el.value=prior;}
  function refreshFilterOptions(){const streams=state.streams.map(s=>({value:s.id,label:s.name}));const subs=state.subjects.map(s=>({value:s.id,label:s.name}));fillSelect($('topicStreamFilter'),streams,$('topicStreamFilter').value,'All streams');fillSelect($('historyStreamFilter'),streams,$('historyStreamFilter').value,'All streams');fillSelect($('topicSubjectFilter'),subs,$('topicSubjectFilter').value,'All subjects');fillSelect($('historySubjectFilter'),subs,$('historySubjectFilter').value,'All subjects');fillSelect($('topicStreamInput'),streams,$('topicStreamInput').value,null);refreshTopicSubjectInput();fillSelect($('subjectStreamInput'),streams,$('subjectStreamInput').value,null);}
  function refreshTopicSubjectInput(){const streamId=$('topicStreamInput').value||state.streams[0]?.id;const list=state.subjects.filter(s=>s.streamId===streamId);fillSelect($('topicSubjectInput'),list.map(s=>({value:s.id,label:s.name})),$('topicSubjectInput').value,null);}

  // Natural sort helper for lesson ordering 1,2,10 etc.
  const naturalCollator = new Intl.Collator(undefined, {numeric:true, sensitivity:'base'});
  function naturalCompare(a,b){ return naturalCollator.compare(a,b); }

  let exploreCurriculumController=null;
  function initExploreCurriculum(){
    if(exploreCurriculumController)return exploreCurriculumController;
    const api=window.NexusExploreCurriculum;
    if(!api||typeof api.create!=='function')return null;
    exploreCurriculumController=api.create({
      document,
      fetch:(...args)=>fetch(...args),
      getState:()=>state,
      setState:next=>{state=next;},
      getPacks:()=>CURRICULUM_PACKS,
      setPacks:packs=>{CURRICULUM_PACKS=packs;window.NexusCurriculumPacks=CURRICULUM_PACKS;},
      esc,makeId,today,save,renderAll,notify,
      getIntegrity:()=>window.NexusCurriculumIntegrity,
      onCatalogLoaded:()=>{
        const result=repairCurriculumStateResult(state);
        state=result.state;
        if(result.changed)save();
        renderAll();
      },
      onCatalogError:error=>console.warn('Nexus curriculum catalogue could not be refreshed; using the built-in Commerce fallback.',error)
    });
    return exploreCurriculumController;
  }
  async function loadCurriculumCatalog(){
    const controller=initExploreCurriculum();
    if(!controller){console.warn('Nexus Explore Curriculum module is unavailable.');return;}
    await controller.loadCatalog();
  }
  function renderExplore(){
    const controller=initExploreCurriculum();
    if(controller)controller.render();
  }
  function installCurriculum(packId,subjectId=null,topicName=null){
    const controller=initExploreCurriculum();
    if(controller)return controller.install(packId,subjectId,topicName);
    return false;
  }
  function renderTopics(){
    // Keep both intermediate memory and the DOM bounded. The tracker can contain
    // tens of thousands of topics; retain only the current page while scanning it.
    renderStructureList();
    const q=$('topicSearch').value.trim().toLocaleLowerCase(),streamId=$('topicStreamFilter').value,subjectId=$('topicSubjectFilter').value,stat=$('topicStatusFilter').value,sort=$('topicSort').value;
    const subjectById=new Map(state.subjects.map(subject=>[String(subject.id),subject]));
    const streamById=new Map(state.streams.map(stream=>[String(stream.id),stream]));
    const compare=(a,b)=>{
      if(sort==='name')return naturalCompare(a.topic.name,b.topic.name)||a.order-b.order;
      if(sort==='stream')return naturalCompare(a.stream,b.stream)||naturalCompare(a.subject,b.subject)||naturalCompare(a.topic.name,b.topic.name)||a.order-b.order;
      if(sort==='least')return a.topic.reviewCount-b.topic.reviewCount||naturalCompare(a.topic.name,b.topic.name)||a.order-b.order;
      return dueRank(a.status)-dueRank(b.status)||(a.topic.dueDate||'9999').localeCompare(b.topic.dueDate||'9999')||naturalCompare(a.topic.name,b.topic.name)||a.order-b.order;
    };
    let activeCount=0,topicOrder=0;
    const selection=selectTopK(state.topics,topicVisibleLimit,compare,topic=>{
      const order=topicOrder++;
      if(topic.archived)return null;
      activeCount++;
      const subject=subjectById.get(String(topic.subjectId)),stream=subject?streamById.get(String(subject.streamId)):null;
      const topicStatus=status(topic);
      if(q&&![topic.name,topic.notes,subject?.name,stream?.name].some(value=>String(value||'').toLocaleLowerCase().includes(q)))return null;
      if(streamId!=='ALL'&&stream?.id!==streamId)return null;
      if(subjectId!=='ALL'&&topic.subjectId!==subjectId)return null;
      if(stat!=='ALL'&&(stat==='due-now'?!['overdue','due'].includes(topicStatus):topicStatus!==stat))return null;
      return {topic,status:topicStatus,subject:subject?.name||'Unknown subject',stream:stream?.name||'Unknown stream',order};
    });
    const visible=selection.items,remaining=selection.count-visible.length;
    $('topicCountLabel').textContent=`Showing ${visible.length} of ${selection.count} matching topics (${activeCount} active)`;
    const cards=visible.map(({topic:t,status:s,subject,stream})=>`<article class="topic-card"><div class="topic-card-top"><div style="min-width:0"><div class="topic-name">${esc(t.name)}</div><div class="topic-sub">${esc(stream)} · ${esc(subject)}</div></div><span class="pill ${s}">${statusText(s)}</span></div>${t.notes?`<div class="topic-note">${esc(t.notes)}</div>`:''}<div class="topic-details"><span>Last: ${fmtDate(t.lastReviewed)}</span><span>Next: ${fmtDate(t.dueDate)}</span><span>Interval: ${t.intervalDays||'—'}d</span><span>Reviews: ${t.reviewCount}</span></div><div class="topic-actions"><button class="btn btn-sm btn-primary" data-action="review" data-id="${esc(t.id)}">Review</button><button class="btn btn-sm" data-action="edit-topic" data-id="${esc(t.id)}">Edit</button><span class="spacer"></span><button class="btn btn-sm btn-danger" data-action="delete-topic" data-id="${esc(t.id)}">Delete</button></div></article>`).join('');
    const more=remaining?`<div style="grid-column:1/-1;display:flex;justify-content:center;padding:12px"><button type="button" class="btn btn-sm" data-action="show-more-topics">Show 100 more topics (${remaining} remaining)</button></div>`:'';
    $('topicGrid').innerHTML=cards||`<div class="panel" style="grid-column:1/-1"><div class="empty"><strong>No matching topics</strong>Change the filters or add a topic.</div></div>`;
    if(more)$('topicGrid').insertAdjacentHTML('beforeend',more);
  }
  function compareHistoryRows(a,b){return b.reviewedAt.localeCompare(a.reviewedAt)||String(b.id).localeCompare(String(a.id));}
  function renderHistory(){
    const q=$('historySearch').value.trim().toLocaleLowerCase(),streamId=$('historyStreamFilter').value,subjectId=$('historySubjectFilter').value;
    const subjectById=new Map(state.subjects.map(x=>[String(x.id),x])),subjectByName=new Map(state.subjects.map(x=>[String(x.name),x]));
    const streamById=new Map(state.streams.map(x=>[String(x.id),x])),streamByName=new Map(state.streams.map(x=>[String(x.name),x]));
    const compare=(a,b)=>compareHistoryRows(a.record,b.record)||a.order-b.order;
    let historyOrder=0;
    const selection=selectTopK(state.history,historyVisibleLimit,compare,h=>{
      const order=historyOrder++;
      const subject=subjectById.get(String(h.subjectId||''))||subjectByName.get(String(h.subjectName||''));
      const stream=streamById.get(String(h.streamId||''))||streamByName.get(String(h.streamName||''))||streamById.get(String(subject?.streamId||''));
      const matches=(!q||[h.topicName,h.subjectName,h.streamName,h.note].some(x=>String(x||'').toLocaleLowerCase().includes(q)))&&
        (streamId==='ALL'||stream?.id===streamId)&&(subjectId==='ALL'||subject?.id===subjectId);
      return matches?{record:h,order}:null;
    });
    const visible=selection.items.map(item=>item.record);
    $('historyList').innerHTML=visible.length?visible.map(h=>`<article class="history-entry"><div><h3>${esc(h.topicName)}</h3><p>${esc(h.streamName)} · ${esc(h.subjectName)} · ${fmtDate(h.reviewedAt)}</p><p>Next: ${fmtDate(h.dueDate)} · ${h.intervalDays} day interval</p>${h.note?`<div class="history-note">${esc(h.note)}</div>`:''}<div class="history-actions"><button class="btn btn-sm btn-danger" data-action="delete-history" data-id="${esc(h.id)}">Delete entry</button></div></div><div class="history-score">${h.rating}/5<br><span class="muted small">${esc(RATING_LABELS[h.rating])}</span></div></article>`).join(''):`<div class="panel"><div class="empty"><strong>No review records found</strong>Completed reviews will appear here.</div></div>`;
    $('historyCountLabel').textContent=`Showing ${visible.length} of ${selection.count} matching records (${state.history.length} total). Deleting an entry also removes that review from Analytics and future exports; topic schedules remain unchanged.`;
    $('historyPagination').hidden=visible.length>=selection.count;
    if(historyInsightsDirty){renderHistoryInsights();historyInsightsDirty=false;}
  }
  function renderStructureList(){
    const topicCounts=new Map(),subjectsByStream=new Map();
    for(const topic of state.topics)if(!topic.archived)topicCounts.set(topic.subjectId,(topicCounts.get(topic.subjectId)||0)+1);
    for(const subject of state.subjects){
      if(!subjectsByStream.has(subject.streamId))subjectsByStream.set(subject.streamId,[]);
      subjectsByStream.get(subject.streamId).push(subject);
    }
    const streamsMarkup=state.streams.map(st=>{
      const subjects=subjectsByStream.get(st.id)||[];
      return `<div class="entity"><div><strong>${esc(st.name)}</strong><small>${subjects.length} subject${subjects.length===1?'':'s'}</small>${subjects.map(s=>`<div class="entity" style="padding:8px 0 0 10px"><div><strong style="font-size:12px">${esc(s.name)}</strong><small>${topicCounts.get(s.id)||0} active topics</small></div><div class="inline-actions"><button class="btn btn-sm" data-action="edit-subject" data-id="${esc(s.id)}">Edit</button><button class="btn btn-sm btn-danger" data-action="delete-subject" data-id="${esc(s.id)}">Delete</button></div></div>`).join('')}</div><div class="inline-actions"><button class="btn btn-sm" data-action="add-subject-to-stream" data-id="${esc(st.id)}">＋ Subject</button><button class="btn btn-sm" data-action="edit-stream" data-id="${esc(st.id)}">Edit</button><button class="btn btn-sm btn-danger" data-action="delete-stream" data-id="${esc(st.id)}">Delete</button></div></div>`;
    }).join('');
    $('structureList').innerHTML=streamsMarkup||'<div class="empty">No streams created.</div>';
  }
  function renderSetup(){refreshFilterOptions();$('themeSelect').value=state.settings.theme;renderStructureList();
    const exams=state.exams.slice().sort((a,b)=>a.date.localeCompare(b.date));$('examList').innerHTML=exams.length?exams.map(ex=>`<div class="entity"><div><strong>${esc(ex.name)}</strong><small>${fmtDate(ex.date)} · ${esc(ex.type)}${validDate(ex.date)&&ex.date>=today()?` · ${dayDiff(today(),ex.date)} day(s) left`:''}</small>${ex.notes?`<small>${esc(ex.notes)}</small>`:''}</div><div class="inline-actions"><button class="btn btn-sm" data-action="edit-exam" data-id="${esc(ex.id)}">Edit</button><button class="btn btn-sm btn-danger" data-action="delete-exam" data-id="${esc(ex.id)}">Delete</button></div></div>`).join(''):'<div class="empty"><strong>No exams scheduled</strong>Add an exam or deadline.</div>';
  }
  function renderAll(){
    historyInsightsDirty=true;
    const activeView=document.querySelector('.view.active')?.id||'view-overview';
    if(activeView==='view-overview'){renderOverview();if(window.NexusRefreshHomeConsistencySummary)window.NexusRefreshHomeConsistencySummary();}
    else if(activeView==='view-topics'){refreshFilterOptions();renderTopics();}
    else if(activeView==='view-history'){refreshFilterOptions();renderHistory();}
    else if(activeView==='view-setup'){renderSetup();}
    else if(activeView==='view-explore'){renderExplore();}
    applyTheme();
  }
  function openReview(id){
    const t=getTopic(id);if(!t)return;
    reviewTopicId=t.id;selectedReviewRating=null;
    const d=subjectDisplay(t);
    $('reviewTitle').textContent=t.name;
    $('reviewMeta').textContent=`${d.stream} · ${d.subject} · ${t.reviewCount} previous review(s)`;
    $('reviewNote').value='';$('reviewCustomDue').value='';
    $('saveReviewBtn').disabled=true;
    document.querySelectorAll('[data-rating]').forEach(b=>{
      const r=Number(b.dataset.rating),days=interval(r,t.intervalDays);
      b.querySelector('.rating-days').textContent=`${days} day${days===1?'':'s'}`;
      b.setAttribute('aria-pressed','false');
    });
    renderReviewPreview();$('reviewDialog').showModal();
  }
  function renderReviewPreview(){
    const preview=$('reviewPreview'),custom=$('reviewCustomDue').value;
    preview.classList.remove('is-warning');
    if(!selectedReviewRating){
      preview.textContent='Choose a recall rating. The suggested date will appear here before you save.';
      $('saveReviewBtn').disabled=true;return;
    }
    if(custom&&!validDate(custom)){
      preview.textContent='That date is invalid. Choose a valid date or clear the custom date field.';
      preview.classList.add('is-warning');$('saveReviewBtn').disabled=true;return;
    }
    const days=interval(selectedReviewRating,getTopic(reviewTopicId)?.intervalDays||0);
    const autoDue=plusDays(today(),days),due=custom||autoDue;
    const ratingName=RATING_LABELS[selectedReviewRating];
    preview.textContent=custom?`${ratingName} selected. Your custom next review is ${fmtDate(due)}${due<=today()?' — this topic will still show as due or overdue after saving.':''}.`:`${ratingName} selected. Next review: ${fmtDate(due)} (${days} day${days===1?'':'s'}).`;
    if(custom&&due<=today())preview.classList.add('is-warning');
    $('saveReviewBtn').disabled=false;
  }
  function saveReview(rating=selectedReviewRating){
    const t=getTopic(reviewTopicId);
    if(!t||!Number.isInteger(Number(rating))||Number(rating)<1||Number(rating)>5)return;
    rating=Number(rating);
    const customDueInput=$('reviewCustomDue').value||'';
    if(customDueInput&&!validDate(customDueInput)){
      $('reviewPreview').textContent='Please choose a valid custom date, or clear the date field before saving.';
      $('reviewPreview').classList.add('is-warning');return;
    }
    const d=subjectDisplay(t),subject=subjectFor(t),stream=streamFor(subject);
    const reviewed=today(),days=interval(rating,t.intervalDays),autoDue=plusDays(reviewed,days);
    const due=customDueInput||autoDue;
    const note=$('reviewNote').value.trim();
    const finalNote=[note,customDueInput?`[Custom next: ${customDueInput}]`:'' ].filter(Boolean).join(' ');
    const reviewEntry={id:makeId('history'),topicId:t.id,streamId:stream?.id||'',subjectId:subject?.id||'',streamName:d.stream,subjectName:d.subject,topicName:t.name,reviewedAt:reviewed,rating,intervalDays:days,dueDate:due,note:finalNote};
    startUndoReview('Review recorded.',t,reviewEntry.id);
    if(rating===1)t.lapses=(t.lapses||0)+1;
    t.streak=rating>=3?(t.streak||0)+1:0;
    t.lastReviewed=reviewed;t.lastRating=rating;t.intervalDays=days;t.dueDate=due;t.reviewCount=(t.reviewCount||0)+1;
    state.history.unshift(reviewEntry);
    const persisted=save();
    $('reviewDialog').close();
    selectedReviewRating=null;$('reviewCustomDue').value='';
    renderAll();
    if(persisted)notify(`Review recorded. Next review: ${fmtDate(due)}.${customDueInput?' Custom date saved.':''}`,true);
    else notify('Review updated in this session, but browser storage failed. Export a backup before closing.',true);
  }
  function selectReviewRating(rating){
    selectedReviewRating=Number(rating);
    document.querySelectorAll('[data-rating]').forEach(b=>b.setAttribute('aria-pressed',String(Number(b.dataset.rating)===selectedReviewRating)));
    renderReviewPreview();
  }
  function openTopic(id=null){editTopicId=id;const t=id?getTopic(id):null;$('topicDialogTitle').textContent=t?'Edit topic':'Add topic';$('topicNameInput').value=t?.name||'';$('topicNotesInput').value=t?.notes||'';if($('topicDueInput'))$('topicDueInput').value=t?.dueDate||'';refreshFilterOptions();const sub=subjectFor(t||{});$('topicStreamInput').value=sub?.streamId||state.streams[0]?.id||'';refreshTopicSubjectInput();$('topicSubjectInput').value=t?.subjectId||state.subjects.find(s=>s.streamId===$('topicStreamInput').value)?.id||'';$('topicDialog').showModal();}
  function saveTopic(e){
    e.preventDefault();
    const name=$('topicNameInput').value.trim(),subjectId=$('topicSubjectInput').value,notes=$('topicNotesInput').value.trim(),customDue=$('topicDueInput')?.value||'';
    if(!name||!state.subjects.some(subject=>subject.id===subjectId)){notify('Choose a valid subject.');return;}
    const duplicate=activeTopics().find(topic=>topic.id!==editTopicId&&topic.subjectId===subjectId&&topic.name.toLocaleLowerCase()===name.toLocaleLowerCase());
    if(duplicate&&!confirm('A topic with that name already exists in this subject. Save a duplicate anyway?'))return;
    if(editTopicId){
      const topic=getTopic(editTopicId);if(!topic)return;
      startUndoTopicEdit('Topic updated.',topic);
      topic.name=name;topic.subjectId=subjectId;topic.notes=notes;
      if(customDue&&validDate(customDue))topic.dueDate=customDue;
    }else{
      const newTopic={id:makeId('topic'),subjectId,name,notes,custom:true,createdAt:today(),lastReviewed:'',lastRating:null,dueDate:customDue&&validDate(customDue)?customDue:'',intervalDays:0,reviewCount:0,streak:0,lapses:0,archived:false};
      startUndoTopicAdd('Topic added.',newTopic.id);
      state.topics.push(newTopic);
    }
    save();$('topicDialog').close();renderAll();switchView('topics');notify('Topic saved.'+(customDue?' Custom date set.':''),true);
  }
  function deleteTopic(id){const t=getTopic(id);if(!t)return;if(!confirm(`Delete “${t.name}” from the topic tracker? Existing history entries will be retained.`))return;startUndoBulkDelete('Topic deleted.');if(window.NexusCurriculumIntegrity)window.NexusCurriculumIntegrity.markDeletedTopic(state,CURRICULUM_PACKS,t);state.topics=state.topics.filter(x=>x.id!==id);save();renderAll();notify('Topic deleted. Review history is retained.',true);}
  function openStream(id=null){editStreamId=id;const st=id?state.streams.find(s=>s.id===id):null;$('streamDialogTitle').textContent=st?'Edit stream / course':'Add stream / course';$('streamNameInput').value=st?.name||'';$('streamDialog').showModal();}
  function saveStream(e){
    e.preventDefault();const name=$('streamNameInput').value.trim();if(!name)return;
    const duplicate=state.streams.find(item=>item.id!==editStreamId&&item.name.toLocaleLowerCase()===name.toLocaleLowerCase());
    if(duplicate){notify('A stream with that name already exists.');return;}
    if(editStreamId){const stream=state.streams.find(item=>item.id===editStreamId);if(!stream)return;startUndoEntityEdit('Stream saved.','streams',stream,['name']);stream.name=name;}
    else{const stream={id:makeId('stream'),name};startUndoEntityAdd('Stream saved.','streams',stream.id);state.streams.push(stream);}
    save();$('streamDialog').close();renderAll();notify('Stream saved.',true);
  }
  function openSubject(id=null,preselectedStream=null){editSubjectId=id;const sub=id?state.subjects.find(s=>s.id===id):null;$('subjectDialogTitle').textContent=sub?'Edit subject':'Add subject';refreshFilterOptions();$('subjectStreamInput').value=sub?.streamId||preselectedStream||state.streams[0]?.id||'';$('subjectNameInput').value=sub?.name||'';$('subjectDialog').showModal();}
  function saveSubject(e){
    e.preventDefault();const name=$('subjectNameInput').value.trim(),streamId=$('subjectStreamInput').value;
    if(!name||!state.streams.some(stream=>stream.id===streamId))return;
    const duplicate=state.subjects.find(subject=>subject.id!==editSubjectId&&subject.streamId===streamId&&subject.name.toLocaleLowerCase()===name.toLocaleLowerCase());
    if(duplicate){notify('That subject already exists in this stream.');return;}
    if(editSubjectId){const subject=state.subjects.find(item=>item.id===editSubjectId);if(!subject)return;startUndoEntityEdit('Subject saved.','subjects',subject,['name','streamId']);subject.name=name;subject.streamId=streamId;}
    else{const subject={id:makeId('subject'),name,streamId,order:state.subjects.length};startUndoEntityAdd('Subject saved.','subjects',subject.id);state.subjects.push(subject);}
    save();$('subjectDialog').close();renderAll();notify('Subject saved.',true);
  }
  function deleteSubject(id){const sub=state.subjects.find(s=>s.id===id);if(!sub)return;const topicIds=state.topics.filter(t=>t.subjectId===id).map(t=>t.id),topicIdSet=new Set(topicIds),historyCount=state.history.filter(h=>h.subjectId===id||topicIdSet.has(h.topicId)).length;if(!confirm(`Delete subject “${sub.name}” and all its data?\n\nThis permanently removes ${topicIds.length} topic(s), ${historyCount} review-history record(s), and linked Study Hub journal/paper records. This cannot be undone after you leave this page. Export a full JSON backup first if unsure.`))return;startUndoBulkDelete('Subject and its data deleted.');if(window.NexusCurriculumIntegrity)window.NexusCurriculumIntegrity.markDeletedSubject(state,CURRICULUM_PACKS,sub);if(window.NexusCascadeDeleteSubject)window.NexusCascadeDeleteSubject(id,topicIds);state.topics=state.topics.filter(t=>t.subjectId!==id);state.history=state.history.filter(h=>h.subjectId!==id&&!topicIdSet.has(h.topicId));state.subjects=state.subjects.filter(s=>s.id!==id);save();renderAll();notify('Subject and nested data deleted.',true);}
  function deleteStream(id){const st=state.streams.find(s=>s.id===id);if(!st)return;const subjectIds=state.subjects.filter(s=>s.streamId===id).map(s=>s.id),subjectIdSet=new Set(subjectIds),topicIds=state.topics.filter(t=>subjectIdSet.has(t.subjectId)).map(t=>t.id),topicIdSet=new Set(topicIds),historyCount=state.history.filter(h=>subjectIdSet.has(h.subjectId)||topicIdSet.has(h.topicId)||h.streamId===id).length;if(!confirm(`Delete stream “${st.name}” and all nested data?\n\nThis permanently removes ${subjectIds.length} subject(s), ${topicIds.length} topic(s), ${historyCount} review-history record(s), and linked Study Hub journal/paper records. This cannot be undone after you leave this page. Export a full JSON backup first if unsure.`))return;startUndoBulkDelete('Stream and its data deleted.');if(window.NexusCurriculumIntegrity)window.NexusCurriculumIntegrity.markDeletedStream(state,CURRICULUM_PACKS,st);if(window.NexusCascadeDeleteStream)window.NexusCascadeDeleteStream(id,subjectIds,topicIds);state.topics=state.topics.filter(t=>!subjectIdSet.has(t.subjectId));state.history=state.history.filter(h=>!subjectIdSet.has(h.subjectId)&&!topicIdSet.has(h.topicId)&&h.streamId!==id);state.subjects=state.subjects.filter(s=>s.streamId!==id);state.streams=state.streams.filter(s=>s.id!==id);save();renderAll();notify('Stream and nested data deleted.',true);}
  function openExam(id=null){editExamId=id;const ex=id?state.exams.find(e=>e.id===id):null;$('examDialogTitle').textContent=ex?'Edit exam or deadline':'Add exam or deadline';$('examNameInput').value=ex?.name||'';$('examDateInput').value=ex?.date||'';$('examTypeInput').value=ex?.type||'Academic exam';$('examNotesInput').value=ex?.notes||'';$('examDialog').showModal();}
  function saveExam(e){
    e.preventDefault();const name=$('examNameInput').value.trim(),date=$('examDateInput').value;
    if(!name||!validDate(date)){notify('Enter an exam name and a valid date.');return;}
    const item={id:editExamId||makeId('exam'),name,date,type:$('examTypeInput').value,notes:$('examNotesInput').value.trim()};
    if(editExamId){const index=state.exams.findIndex(exam=>exam.id===editExamId);if(index<0)return;startUndoArrayItemReplacement('Exam saved.','exams',index);state.exams[index]=item;}
    else{startUndoEntityAdd('Exam saved.','exams',item.id);state.exams.push(item);}
    save();$('examDialog').close();renderAll();notify('Exam saved.',true);
  }
  function deleteExam(id){const exam=state.exams.find(item=>item.id===id);if(!exam||!confirm(`Delete “${exam.name}”?`))return;startUndoArrayReplacement('Exam deleted.','exams');state.exams=state.exams.filter(item=>item.id!==id);save();renderAll();notify('Exam deleted.',true);}
  function downloadFile(filename,content,type){const blob=new Blob([content],{type}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=filename;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1500);}
  function exportBackup(){if(typeof window.NexusExportFullBackup==='function'){window.NexusExportFullBackup();return;}const packet={app:'Nexus Spaced Repetition Tracker',schema:4,exportedAt:new Date().toISOString(),state,featureState:window.NexusGetFeatureState?window.NexusGetFeatureState():{}};downloadFile(`nexus-backup-${today()}.json`,JSON.stringify(packet,null,2),'application/json;charset=utf-8');notify('Full backup downloaded. Keep it somewhere safe.');}
  const csvCell=v=>window.NexusBackupRestoreUtils.csvCell(v);
  function exportHistory(){const rows=[['Review date','Stream','Subject','Topic','Rating','Rating meaning','Interval days','Next due','Note'],...state.history.map(h=>[h.reviewedAt,h.streamName,h.subjectName,h.topicName,h.rating,RATING_LABELS[h.rating],h.intervalDays,h.dueDate,h.note])];downloadFile(`nexus-history-${today()}.csv`,'\uFEFF'+rows.map(r=>r.map(csvCell).join(',')).join('\r\n'),'text/csv;charset=utf-8');notify('History CSV exported.');}
  function exportTopics(){const rows=[['Stream','Subject','Topic','Notes','Last reviewed','Last rating','Next due','Interval days','Review count','Streak','Lapses','Status'],...state.topics.map(t=>{const d=subjectDisplay(t);return[d.stream,d.subject,t.name,t.notes,t.lastReviewed,t.lastRating,t.dueDate,t.intervalDays,t.reviewCount,t.streak,t.lapses,status(t)];})];downloadFile(`nexus-topics-${today()}.csv`,'\uFEFF'+rows.map(r=>r.map(csvCell).join(',')).join('\r\n'),'text/csv;charset=utf-8');notify('Topics CSV exported.');}
  async function importBackup(file){if(!file)return;try{const parsed=JSON.parse(await file.text()),raw=parsed?.state||parsed;const restored=normalizeState(raw);if(!restored.topics||!restored.history||!restored.subjects)throw new Error('Required backup sections are missing.');if(!confirm(`Import ${restored.topics.length} topics, ${restored.history.length} history records, and ${restored.exams.length} exams? This replaces current local data.`))return;startUndoWorkspaceReplace('Backup imported.');state=restored;save();renderAll();switchView('overview');notify('Backup restored.',true);}catch(err){alert(`Could not import this backup. ${err.message||'Check the file format.'}`);}finally{$('importFile').value='';}}
  function clearHistory(){if(!state.history.length){notify('History is already empty.');return;}if(!confirm('DANGER ZONE — Clear every saved review-history entry?\n\nAll rating analytics, review-history exports and historical counts based on these records will be lost. Topic schedules may remain unchanged. Use Undo immediately or restore a backup if this was accidental. Continue?'))return;startUndoHistoryChange('History cleared.');state.history=[];save();renderAll();notify('History cleared; schedules remain unchanged.',true);}
  function resetAll(){if(!confirm('Reset all local data, including topics, custom streams, subjects, exams, settings and history? Download a backup first if you may need it.'))return;startUndoWorkspaceReplace('Tracker reset.');state=baseState();save();renderAll();switchView('overview');notify('Tracker reset.',true);}
  function applyTheme(){document.documentElement.dataset.theme=state.settings.theme;const themeColor=document.querySelector('meta[name="theme-color"]');if(themeColor){const appBackground=getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();if(appBackground)themeColor.setAttribute('content',appBackground);}$('themeSelect').value=state.settings.theme;$('themeBtn').textContent=state.settings.theme==='light'?'☀':state.settings.theme==='dark'?'☾':'◐';$('themeBtn').title=`Theme: ${state.settings.theme}. Click to cycle.`;}
  function cycleTheme(){const seq=['system','light','dark'];state.settings.theme=seq[(seq.indexOf(state.settings.theme)+1)%seq.length];save();applyTheme();notify(`Theme: ${state.settings.theme}.`);}
  function openHelp(){$('helpDialog').showModal();}
  function install(){$('pwaInstallOption').hidden=false;$('installNote').textContent=installPrompt?'Use the button below to install Nexus through your browser.':'If the button cannot open an install prompt, use your browser menu: in Chrome, tap ⋮ and choose “Install app”. If it is not listed, refresh Nexus and check again. On other browsers, use “Add to Home screen” if available.';$('installDialog').showModal();}
  async function installPwa(){
    // Prefer Chromium's established beforeinstallprompt flow whenever it is available.
    // Keep the experimental Web Install API as a secondary path for browsers that expose it.
    if(installPrompt){
      const promptEvent=installPrompt;
      installPrompt=null;
      window.NexusInstallPrompt=null;
      $('installDialog').close();
      try{
        await promptEvent.prompt();
      }catch(error){
        console.warn('Browser install prompt failed.',error);
        notify('Open your browser menu and choose Install app or Add to Home screen.');
      }finally{
        $('pwaInstallOption').hidden=false;
      }
      return;
    }

    // The experimental Web Install API must run directly from this user-initiated click.
    if(typeof navigator.install==='function'){
      $('installDialog').close();
      try{
        await navigator.install();
        return;
      }catch(error){
        // A dismissed browser prompt is a normal user choice, not a failure.
        if(error?.name==='AbortError')return;
        console.warn('Modern Web Install API failed; falling back to browser instructions.',error);
      }
    }

    $('installNote').textContent='This browser does not provide an in-page installation prompt. In Chrome, open the ⋮ menu and choose “Install app”. If that option is missing, refresh Nexus and try again. Other browsers may offer “Add to Home screen” instead.';
  }
  // Events are attached once; dynamic content uses delegated handlers.
  document.querySelectorAll('.tab').forEach(b=>b.addEventListener('click',()=>switchView(b.dataset.view)));
  
  $('viewDueBtn').addEventListener('click',()=>{switchView('topics');topicVisibleLimit=100;$('topicStatusFilter').value='due-now';renderTopics();});
  // Delegate review actions once so dynamically rendered due and upcoming queues work consistently.
  document.addEventListener('click',e=>{const b=e.target.closest('button[data-action="review"]');if(!b)return;openReview(b.dataset.id);});
  $('topicGrid').addEventListener('click',e=>{const b=e.target.closest('button[data-action]');if(!b)return;const {action,id}=b.dataset;if(action==='edit-topic')openTopic(id);if(action==='delete-topic')deleteTopic(id);if(action==='show-more-topics'){topicVisibleLimit+=100;renderTopics();}});
  $('historyList').addEventListener('click',e=>{const b=e.target.closest('button[data-action="delete-history"]');if(!b)return;const id=b.dataset.id;const entry=state.history.find(h=>h.id===id);if(!entry||!confirm('DANGER ZONE — Delete this review record?\n\nThis review will disappear from rating analytics and future history exports. The topic schedule will not change. Use Undo immediately or restore a backup if needed. Continue?'))return;startUndoHistoryChange('History entry deleted.');state.history=state.history.filter(h=>h.id!==id);historyInsightsDirty=true;save();renderHistory();notify('History entry deleted.',true);});
  $('structureList').addEventListener('click',e=>{const b=e.target.closest('button[data-action]');if(!b)return;const {action,id}=b.dataset;if(action==='edit-stream')openStream(id);if(action==='delete-stream')deleteStream(id);if(action==='add-subject-to-stream')openSubject(null,id);if(action==='edit-subject')openSubject(id);if(action==='delete-subject')deleteSubject(id);});
  $('examList').addEventListener('click',e=>{const b=e.target.closest('button[data-action]');if(!b)return;if(b.dataset.action==='edit-exam')openExam(b.dataset.id);if(b.dataset.action==='delete-exam')deleteExam(b.dataset.id);});
  let topicSearchTimer=0,historySearchTimer=0,exploreSearchTimer=0;
  $('topicSearch').addEventListener('input',()=>{topicVisibleLimit=100;clearTimeout(topicSearchTimer);topicSearchTimer=setTimeout(renderTopics,110);});
  ['topicStreamFilter','topicSubjectFilter','topicStatusFilter','topicSort'].forEach(id=>$(id).addEventListener('change',()=>{topicVisibleLimit=100;renderTopics();}));
  $('historySearch').addEventListener('input',()=>{clearTimeout(historySearchTimer);historyVisibleLimit=100;historySearchTimer=setTimeout(renderHistory,110);});
  ['historyStreamFilter','historySubjectFilter'].forEach(id=>$(id).addEventListener('change',()=>{historyVisibleLimit=100;renderHistory();}));
  $('historyShowMoreBtn').addEventListener('click',()=>{historyVisibleLimit+=100;renderHistory();});
  $('exploreSearch').addEventListener('input',()=>{clearTimeout(exploreSearchTimer);exploreSearchTimer=setTimeout(renderExplore,100);});
  $('exploreGrid').addEventListener('click',e=>{const b=e.target.closest('[data-explore-action]');if(!b)return;const action=b.dataset.exploreAction,packId=b.dataset.packId,subjectId=b.dataset.subjectId||null;if(action==='install-pack')installCurriculum(packId);if(action==='install-subject')installCurriculum(packId,subjectId);if(action==='install-topic')installCurriculum(packId,subjectId,b.dataset.topicName);});
  $('topicStreamInput').addEventListener('change',refreshTopicSubjectInput);
  $('topicForm').addEventListener('submit',saveTopic);$('streamForm').addEventListener('submit',saveStream);$('subjectForm').addEventListener('submit',saveSubject);$('examForm').addEventListener('submit',saveExam);
  $('addTopicBtn').addEventListener('click',()=>openTopic());$('addStreamBtn').addEventListener('click',()=>openStream());$('addSubjectBtn').addEventListener('click',()=>openSubject());$('addExamBtn').addEventListener('click',()=>openExam());
  document.querySelectorAll('[data-rating]').forEach(b=>b.addEventListener('click',()=>selectReviewRating(Number(b.dataset.rating))));
  $('saveReviewBtn').addEventListener('click',()=>saveReview());
  $('reviewCustomDue').addEventListener('input',renderReviewPreview);
  $('reviewCustomDue').addEventListener('change',renderReviewPreview);
  document.querySelectorAll('[data-close]').forEach(b=>b.addEventListener('click',()=>$(b.dataset.close).close()));
  $('reviewNote').addEventListener('input',()=>{});
  $('themeBtn').addEventListener('click',cycleTheme);$('themeSelect').addEventListener('change',()=>{state.settings.theme=$('themeSelect').value;save();applyTheme();notify('Theme preference saved.');});$('helpBtn').addEventListener('click',openHelp);$('installBtn').addEventListener('click',install);$('supportNexusBtn').addEventListener('click',()=>$('supportNexusDialog').showModal());$('pwaInstallOption').addEventListener('click',installPwa);
  $('backupBtn').addEventListener('click',exportBackup);$('menuBackup').addEventListener('click',()=>{$('moreMenu').open=false;exportBackup();});$('restoreBtn').addEventListener('click',()=>$('importFile').click());$('menuRestore').addEventListener('click',()=>{$('moreMenu').open=false;$('importFile').click();});$('importFile').addEventListener('change',e=>importBackup(e.target.files?.[0]));
  $('historyCsvBtn').addEventListener('click',exportHistory);$('setupHistoryCsvBtn').addEventListener('click',exportHistory);$('menuHistoryCsv').addEventListener('click',()=>{exportHistory();$('moreMenu').open=false;});$('setupTopicsCsvBtn').addEventListener('click',exportTopics);$('menuTopicsCsv').addEventListener('click',()=>{exportTopics();$('moreMenu').open=false;});$('clearHistoryBtn').addEventListener('click',clearHistory);
  function refreshDeletionChoiceUi(){
    const account=window.NexusCloudSync&&typeof window.NexusCloudSync.getAccountState==='function'?window.NexusCloudSync.getAccountState():{signedIn:false,ready:false};
    const choice=$('accountDeletionChoice'),hint=$('accountDeletionSignInHint'),email=$('deletionSignedInAccount'),status=$('accountDeletionStatusText'),button=$('accountDeleteChoiceBtn');
    if(choice)choice.hidden=!account.signedIn;
    if(hint)hint.hidden=!!account.signedIn;
    if(email)email.textContent=account.email?'Signed in as '+account.email:'Signed-in Nexus account';
    if(button)button.disabled=!account.signedIn||!account.ready||!!account.deleting||!!account.previewBlocked||!account.deletionServiceAvailable;
    if(status)status.textContent=!account.signedIn?'Sign in to the account you want to delete.':account.previewBlocked?'Account deletion is disabled on this preview or local copy.':account.deleting?'Account deletion is in progress…':!account.ready?'Wait until Nexus has finished loading this account and the cloud status is Synced.':!account.deletionServiceAvailable?'The secure deletion service is not deployed on this Supabase project yet. Use the manual deletion instructions in the Account & Data Deletion page.': 'Account verified and deletion service available. A recent sign-in is still required before permanent deletion.';
  }
  window.NexusRefreshDeletionOptions=refreshDeletionChoiceUi;
  $('resetBtn').addEventListener('click',()=>{refreshDeletionChoiceUi();$('workspaceDeletionDialog').showModal();});
  $('workspaceResetOnlyBtn').addEventListener('click',()=>{$('workspaceDeletionDialog').close();resetAll();});
  $('cancelWorkspaceDeletionBtn').addEventListener('click',()=>$('workspaceDeletionDialog').close());
  $('accountDeleteChoiceBtn').addEventListener('click',async()=>{
    refreshDeletionChoiceUi();
    const account=window.NexusCloudSync&&typeof window.NexusCloudSync.getAccountState==='function'?window.NexusCloudSync.getAccountState():null;
    if(!account||!account.signedIn||!account.ready||account.previewBlocked||!account.deletionServiceAvailable){alert('Sign in, wait until the account workspace is verified, and confirm that the secure deletion service is available before requesting account deletion.');return;}
    const warning='Permanently delete this signed-in Nexus account and its cloud data?\n\nThis removes the Supabase account and cloud workspace. Nexus will also clear this device’s local workspace and account-specific sync recovery data after the server confirms deletion. Other devices may still contain offline copies, and downloaded JSON/CSV backups are not erased.\n\nDownload a full JSON backup first if you may need your study records.';
    if(!confirm(warning))return;
    const typed=prompt('Type DELETE ACCOUNT to permanently delete this account:');
    if(typed!=='DELETE ACCOUNT'){notify('Account deletion cancelled.');return;}
    const button=$('accountDeleteChoiceBtn');button.disabled=true;button.textContent='Deleting account…';
    try{
      if(!window.NexusCloudSync||typeof window.NexusCloudSync.deleteAccount!=='function')throw new Error('The account-deletion service is unavailable in this app build.');
      const result=await window.NexusCloudSync.deleteAccount();
      if(result&&result.localCleanupComplete){
        alert('Your Nexus cloud account and this device’s workspace have been deleted. Clear Nexus site data on every other device you used, and delete any downloaded backups separately.');
        window.location.reload();
      }else{
        alert('Your cloud account has been deleted, but this device could not safely clear all local recovery data. Close this tab, then clear the browser site data for the Nexus app on this device. Also clear Nexus site data on your other devices and delete downloaded backups separately.');
        window.location.assign('./delete-account.html#local-cleanup');
      }
    }catch(error){
      alert(error&&error.message?error.message:'Account deletion failed. Your local workspace has been kept.');
      button.textContent='Permanently delete account';
      refreshDeletionChoiceUi();
    }
  });
  refreshDeletionChoiceUi();
  $('undoBtn').addEventListener('click',undo);$('menuSettings').addEventListener('click',()=>{switchView('setup');$('moreMenu').open=false;});
  $('topicDialog').addEventListener('close',()=>{editTopicId=null;});$('streamDialog').addEventListener('close',()=>{editStreamId=null;});$('subjectDialog').addEventListener('close',()=>{editSubjectId=null;});$('examDialog').addEventListener('close',()=>{editExamId=null;});$('reviewDialog').addEventListener('close',()=>{reviewTopicId=null;});
  document.querySelectorAll('[data-rating]').forEach(b=>b.addEventListener('focus',()=>{}));
  window.addEventListener('beforeinstallprompt',e=>{e.preventDefault();installPrompt=e;window.NexusInstallPrompt=e;$('installBtn').classList.remove('is-installed');$('installBtnLabel').textContent='Install';});
  window.addEventListener('appinstalled',()=>{installPrompt=null;window.NexusInstallPrompt=null;$('installBtn').classList.add('is-installed');$('installBtnLabel').textContent='Installed';notify('Nexus installed on this device.');});
  // Service-worker registration is handled once by nexus-app-bootstrap.js before app modules load.

  // --- Persistent Undo toast: one source of truth for message, visibility, and timers. ---
  (function(){
    const toastEl = document.getElementById('toast');
    const toastTextEl = document.getElementById('toastText');
    const undoBtnEl = document.getElementById('undoBtn');
    const closeUndoBtnEl = document.getElementById('closeUndoBtn');
    let transientToastTimer = null;
    let clearUndoAfterCloseTimer = null;

    function clearToastTimers(){
      clearTimeout(toastTimer);
      toastTimer = null;
      clearTimeout(transientToastTimer);
      transientToastTimer = null;
    }
    function showUndoAction(){
      undoBtnEl.style.display = 'inline-flex';
      toastEl.classList.add('undoable','show');
    }
    function clearUndoAction(){
      undoBtnEl.style.display = 'none';
      toastEl.classList.remove('undoable');
    }

    window.notify = function(msg, isPersistent){
      clearToastTimers();
      if(undoState){
        // Theme changes and unrelated notifications must not hide an active Undo action.
        if(isPersistent) toastTextEl.textContent = msg;
        showUndoAction();
        return;
      }

      toastTextEl.textContent = msg;
      clearUndoAction();
      toastEl.classList.add('show');
      transientToastTimer = setTimeout(()=>{
        if(!undoState) toastEl.classList.remove('show');
      },2600);
    };

    window.hideUndo = function(){
      toastEl.classList.remove('show');
    };

    undoBtnEl.addEventListener('click',()=>{
      clearToastTimers();
      clearTimeout(clearUndoAfterCloseTimer);
      undoState = null;
      clearUndoAction();
      toastEl.classList.remove('show');
    });

    if(closeUndoBtnEl){
      closeUndoBtnEl.addEventListener('click',()=>{
        clearTimeout(clearUndoAfterCloseTimer);
        toastEl.classList.remove('show');
        clearUndoAfterCloseTimer = setTimeout(()=>{
          // A new undoable action may have started while the close animation was running.
          if(!toastEl.classList.contains('show')){
            undoState = null;
            clearUndoAction();
          }
          clearUndoAfterCloseTimer = null;
        },300);
      });
    }

    // Enhanced confirm for data protection
    const origConfirm = window.confirm;
    window.confirmAction = function({title, desc}){
      // Use native confirm but with detailed message for now, wrapped in custom later
      return origConfirm(title + "\n\n" + desc);
    };
    
    // Route legacy/global entry points through the primary handlers. Older wrappers
    // deep-cloned the entire workspace and removed review history when a topic was
    // deleted, bypassing the bounded Undo and history-retention behavior above.
    window.deleteTopic = id => deleteTopic(id);
    window.deleteSubject = id => deleteSubject(id);
    window.deleteStream = id => deleteStream(id);
    window.deleteExam = id => deleteExam(id);

    const historyList = document.getElementById('historyList');
    if(historyList){
      historyList.addEventListener('click',function(e){
        const button=e.target.closest('button[data-action="delete-history"]');
        if(!button)return;
        e.stopImmediatePropagation();e.preventDefault();
        const id=button.dataset.id,entry=state.history.find(item=>item.id===id);
        if(!entry)return;
        if(!confirm('DANGER ZONE — Delete this review record?\\n\\nThis review will disappear from rating analytics and future history exports. The topic schedule will not change. Use Undo immediately or restore a backup if needed. Continue?'))return;
        startUndoHistoryChange('History entry deleted.');
        state.history=state.history.filter(item=>item.id!==id);
        historyInsightsDirty=true;save();renderHistory();
      },true);
    }

    window.clearHistory = function(){
      if(!confirm('Clear ALL history?\\n\\nThis will delete '+state.history.length+' records. Schedules stay but past reviews are retained.\\n\\nExport a backup first!'))return;
      if(!confirm('Are you absolutely sure?'))return;
      startUndoHistoryChange('All history cleared.');
      state.history=[];save();renderAll();
    };

    window.resetAll = function(){
      if(!confirm('Reset ALL data?\\n\\nThis deletes topics, subjects, streams, exams, history and settings. Export a backup first.'))return;
      const typed=prompt('To confirm, type RESET in capital letters:');
      if(typed!=='RESET'){alert('Cancelled');return;}
      startUndoWorkspaceReplace('All data reset.');
      localStorage.removeItem(STORAGE_KEY);OLD_KEYS.forEach(key=>localStorage.removeItem(key));
      state=baseState();save();renderAll();
    };

    // Dropdown filters toggle
    document.getElementById('toggleTopicFilters')?.addEventListener('click', ()=>{
      const bar = document.getElementById('topicFiltersBar');
      if(!bar) return;
      bar.style.display = bar.style.display==='none' ? 'flex' : 'none';
      if(bar.style.display!=='none'){ bar.style.animation='slideDown .35s ease'; }
    });
    document.getElementById('toggleHistoryFilters')?.addEventListener('click', ()=>{
      const bar = document.getElementById('historyFiltersBar');
      if(!bar) return;
      bar.style.display = bar.style.display==='none' ? 'flex' : 'none';
      if(bar.style.display!=='none'){ bar.style.animation='slideDown .35s ease'; }
    });
    
    // Overview collapse/expand is handled by explicit labelled buttons in the markup.
    // Do not re-add legacy arrow-only controls or click handlers to panel headers.

  })();

  state=loadState();save();renderAll();
  loadCurriculumCatalog();
