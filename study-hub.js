/* Nexus Study Hub: additive, migration-safe features. Existing v3 state remains compatible. */
(function(){
  'use strict';
  const FEATURE_KEY='recall.study.features.v1';
  const hubEl=id=>document.getElementById(id);
  const freshFeatureState=()=>({version:1,fsrsSettings:window.NexusFSRS&&typeof window.NexusFSRS.settings==='function'?window.NexusFSRS.settings():{request_retention:0.9,maximum_interval:120,enable_fuzz:false,w:null},settings:{dailyMinutes:90,sessionMinutes:25,scheduler:'classic',weeklyReviewGoal:100,backlogDays:7,reminders:false,reminderTime:'08:00',maxInterval:120,finalRevision:false,workloadDays:7},syllabusTargets:{},taskChecks:{},journal:[],papers:[],goals:[],studyLogs:[],selectedTopicIds:[],lastBackupAt:'',lastReminderAt:'',focusStartedAt:null,focusActualStartedAt:null,focusPausedAt:null,focusTopicId:'',focusSubjectId:''});
  function loadFeatureState(){try{const x=JSON.parse(localStorage.getItem(FEATURE_KEY)||'null');if(!x||typeof x!=='object'||Array.isArray(x))return freshFeatureState();const d=freshFeatureState(),focus=window.NexusBackupRestoreUtils.sanitizeFocusState(x);return {...d,...x,settings:{...d.settings,...(x.settings&&typeof x.settings==='object'&&!Array.isArray(x.settings)?x.settings:{})},syllabusTargets:x.syllabusTargets&&typeof x.syllabusTargets==='object'&&!Array.isArray(x.syllabusTargets)?x.syllabusTargets:{},taskChecks:x.taskChecks&&typeof x.taskChecks==='object'&&!Array.isArray(x.taskChecks)?x.taskChecks:{},journal:Array.isArray(x.journal)?x.journal:[],papers:Array.isArray(x.papers)?x.papers:[],goals:Array.isArray(x.goals)?x.goals:[],studyLogs:Array.isArray(x.studyLogs)?x.studyLogs:[],selectedTopicIds:Array.isArray(x.selectedTopicIds)?x.selectedTopicIds:[],...focus};}catch(e){console.warn('Study Hub data could not be read',e);return freshFeatureState();}}
  let fsState=loadFeatureState();if(window.NexusFSRS&&typeof window.NexusFSRS.setSettings==='function'&&fsState.fsrsSettings)window.NexusFSRS.setSettings(fsState.fsrsSettings,{syncFeature:false,persist:true});let hubTab='planner';let focusTimer=null,studyLogHistoryLimit=100;let focusStart=fsState.focusStartedAt?new Date(fsState.focusStartedAt).getTime():null;let focusPausedAt=fsState.focusPausedAt?new Date(fsState.focusPausedAt).getTime():null;let focusTopicId=fsState.focusTopicId||'';let focusSubjectId=fsState.focusSubjectId||'';
  const fid=()=>`hub-${Date.now().toString(36)}-${Math.random().toString(36).slice(2,9)}`;
  const dateShift=(d,n)=>{const x=new Date((d||today())+'T12:00:00');x.setDate(x.getDate()+n);return `${x.getFullYear()}-${String(x.getMonth()+1).padStart(2,'0')}-${String(x.getDate()).padStart(2,'0')}`;};
  const safeDate=d=>{if(!/^\d{4}-\d{2}-\d{2}$/.test(String(d||'')))return false;const [y,m,day]=String(d).split('-').map(Number);const x=new Date(y,m-1,day);return x.getFullYear()===y&&x.getMonth()===m-1&&x.getDate()===day;};
  const localEsc=x=>esc(String(x??''));
  const fNum=x=>Number.isFinite(Number(x))?Number(x):0;
  // Cache daily focus-goal totals between minute boundaries; the visible clock still ticks every second.
  let focusGoalCacheKey='',focusGoalLoggedMinutes=0;
  function saveFs(){focusGoalCacheKey='';try{if(!window.NexusOfflineSyncQueue)throw new Error('Safe offline sync queue is unavailable.');window.NexusOfflineSyncQueue.commitWorkspace(localStorage,[{key:FEATURE_KEY,value:JSON.stringify(fsState)}],{state,featureState:fsState},{returnOperationPayload:false});if(window.NexusCloudSync)window.NexusCloudSync.schedule();return true;}catch(e){console.error(e);try{notify('Study Hub data could not be saved. Export a backup now.');}catch(_){}return false;}}
  window.NexusFeatureStorageKey=FEATURE_KEY;window.NexusNormalizeFeatureState=value=>window.NexusBackupRestoreUtils.normalizeFeatureState(value,freshFeatureState());window.NexusMergeFeatureState=(current,imported,rawImported)=>window.NexusBackupRestoreUtils.mergeFeatureState(current,imported,freshFeatureState(),rawImported);window.NexusGetFeatureState=()=>clone(fsState);window.NexusSetFeatureState=(value,options={})=>{focusGoalCacheKey='';fsState=window.NexusNormalizeFeatureState(value);if(options.applyFsrs!==false&&window.NexusFSRS&&typeof window.NexusFSRS.setSettings==='function')window.NexusFSRS.setSettings(fsState.fsrsSettings,{syncFeature:false,persist:options.persist!==false});focusStart=fsState.focusStartedAt?new Date(fsState.focusStartedAt).getTime():null;focusPausedAt=fsState.focusPausedAt?new Date(fsState.focusPausedAt).getTime():null;focusTopicId=fsState.focusTopicId||'';focusSubjectId=fsState.focusSubjectId||'';if(focusTimer){clearInterval(focusTimer);focusTimer=null;}if(focusStart)focusTimer=setInterval(refreshLiveFocusUi,1000);if(options.persist!==false)saveFs();if(options.render!==false)renderHub();if(focusStart&&options.render!==false)refreshLiveFocusUi();return true;};
  let cascadeUndoState=null;window.NexusCascadeDeleteSubject=(subjectId,topicIds)=>{cascadeUndoState=clone(fsState);fsState.journal=fsState.journal.filter(x=>x.subjectId!==subjectId&&!topicIds.includes(x.topicId));fsState.papers=fsState.papers.filter(x=>x.subjectId!==subjectId);delete fsState.syllabusTargets[subjectId];fsState.selectedTopicIds=fsState.selectedTopicIds.filter(id=>!topicIds.includes(id));saveFs();renderHub();};window.NexusCascadeDeleteStream=(streamId,subjectIds,topicIds)=>{cascadeUndoState=clone(fsState);fsState.journal=fsState.journal.filter(x=>!subjectIds.includes(x.subjectId)&&!topicIds.includes(x.topicId));fsState.papers=fsState.papers.filter(x=>!subjectIds.includes(x.subjectId));subjectIds.forEach(id=>delete fsState.syllabusTargets[id]);fsState.selectedTopicIds=fsState.selectedTopicIds.filter(id=>!topicIds.includes(id));saveFs();renderHub();};window.NexusUndoCascadeDelete=()=>{if(cascadeUndoState){fsState=clone(cascadeUndoState);cascadeUndoState=null;saveFs();renderHub();}};window.NexusClearCascadeUndo=()=>{cascadeUndoState=null;};window.NexusRenderHub=()=>renderHub();
  let topicHistoryStatsCache={source:null,length:-1,byTopic:new Map()};
  function getTopicHistoryStats(){
    const history=state.history,cache=topicHistoryStatsCache;
    if(cache.source===history&&cache.length===history.length)return cache.byTopic;
    const byTopic=new Map();
    for(const record of history){
      const id=String(record&&record.topicId||'');if(!id)continue;
      let item=byTopic.get(id);if(!item){item={recent:[],count:0,sum:0};byTopic.set(id,item);}
      item.count++;item.sum+=fNum(record.rating);
      const date=record.reviewedAt||'',recent=item.recent;
      let index=0;
      while(index<recent.length&&(recent[index].reviewedAt||'')>=date)index++;
      if(index<5){recent.splice(index,0,record);if(recent.length>5)recent.pop();}
    }
    for(const item of byTopic.values()){
      item.avg=item.recent.length?item.recent.reduce((sum,record)=>sum+fNum(record.rating),0)/item.recent.length:0;
      item.allAvg=item.count?item.sum/item.count:0;
    }
    topicHistoryStatsCache={source:history,length:history.length,byTopic};return byTopic;
  }
  function featureMeta(t){
    const stats=getTopicHistoryStats().get(String(t.id)),hs=stats?.recent||[],avg=hs.length?stats.avg:(t.lastRating||0),allAvg=hs.length?stats.allAvg:(t.lastRating||0);
    const weak=Boolean(t.lapses||avg&&avg<3||status(t)==='overdue'&&dayDiff(t.dueDate,today())>5);let score=0;
    if(t.reviewCount>0){score=Math.round(Math.max(0,Math.min(100,(avg/5)*65+Math.min(t.reviewCount,6)/6*20+Math.min(t.intervalDays,30)/30*15)));if(t.lastRating===1)score=Math.max(5,score-15);}
    return {hs,avg,allAvg,score,weak};
  }
  function estimateMinutes(t){const m=featureMeta(t);return Math.max(6,Math.min(30,Math.round(10+(m.weak?7:0)+(m.avg&&m.avg<3?5:0)+(status(t)==='overdue'?Math.min(5,Math.ceil(Math.max(0,dayDiff(t.dueDate,today()))/5)):0))));}
  function weeklyReviewCount(){const start=dateShift(today(),-6);return state.history.filter(h=>h.reviewedAt>=start&&h.reviewedAt<=today()).length;}
  function isMastered(t){const m=featureMeta(t);return t.reviewCount>=2&&m.avg>=3.5&&t.intervalDays>=4&&status(t)!=='overdue';}
  function streakCount(){return currentStudyStreak();}
  function studyLogMinutes(entry){const seconds=entry&&entry.durationSeconds;if(seconds!==undefined&&seconds!==null&&Number.isFinite(Number(seconds)))return Math.max(0,Number(seconds))/60;return Math.max(0,fNum(entry&&entry.minutes));}function formatStudyDuration(seconds){const total=Math.max(0,Math.round(Number(seconds)||0)),minutes=Math.floor(total/60),remainder=total%60;return minutes?`${minutes} min${remainder?' '+remainder+' sec':''}`:`${remainder} sec`;}function totalStudyMinutes(){return fsState.studyLogs.reduce((n,x)=>n+studyLogMinutes(x),0);}
  function reviewActivity(days){
    const end=today(),start=dateShift(end,-(days-1)),counts=new Map();
    for(const record of state.history){const date=record&&record.reviewedAt;if(typeof date==='string'&&date.length===10&&date>=start&&date<=end)counts.set(date,(counts.get(date)||0)+1);}
    const out=[];for(let i=days-1;i>=0;i--){const date=dateShift(end,-i);out.push({date,count:counts.get(date)||0});}
    return out;
  }
  function nearestFutureExam(){return state.exams.filter(e=>safeDate(e.date)&&e.date>=today()).sort((a,b)=>a.date.localeCompare(b.date))[0]||null;}
  function updateKpis(){
    let activeCount=0,due=0,weak=0,mastered=0;
    for(const topic of state.topics){
      if(topic.archived)continue;activeCount++;
      const st=status(topic),meta=featureMeta(topic);
      if(st==='overdue'||st==='due')due++;
      if(meta.weak)weak++;
      if(topic.reviewCount>=2&&meta.avg>=3.5&&topic.intervalDays>=4&&st!=='overdue')mastered++;
    }
    const todayDone=loggedMinutesToday()+liveFocusMinutesToday();
    hubEl('hubKpis').innerHTML='<div class="hub-kpi"><strong>'+due+'</strong><span>Due or overdue</span></div><div class="hub-kpi"><strong>'+weak+'</strong><span>Topics needing attention</span></div><div class="hub-kpi"><strong>'+mastered+'/'+activeCount+'</strong><span>Mastered topics</span></div><div class="hub-kpi"><strong>'+formatStudyDuration(todayDone*60)+'</strong><span>Study time today</span></div>';
  }
  function topicPriority(t,meta=featureMeta(t)){
    const st=status(t),mastered=t.reviewCount>=2&&meta.avg>=3.5&&t.intervalDays>=4&&st!=='overdue';
    const revisionBoost=fsState.settings.finalRevision&&!mastered?45:0;
    return revisionBoost+(st==='overdue'?100+Math.min(30,Math.max(0,dayDiff(t.dueDate,today()))):st==='due'?80:st==='new'?60:st==='upcoming'?10:0)+(meta.weak?30:0)+(meta.avg&&meta.avg<2.5?20:0)+(t.lapses||0)*3-(meta.score/20);
  }
  function buildPlan(limitBudget=true){
    const ts=state.topics,daily=Math.max(10,Math.min(720,fNum(fsState.settings.dailyMinutes)||90));
    const backlog=fsState.settings.backlogDays||7,cap=limitBudget?daily:Math.max(720,ts.length*30);
    const buckets=new Map(),selected=[];let sum=0;
    // Grouping by the exact priority preserves source order within equal-priority
    // buckets and avoids sorting the full catalogue.
    for(const topic of ts){
      if(topic.archived)continue;
      const st=status(topic);
      if(!['overdue','due','new'].includes(st)||(st==='overdue'&&backlog===0))continue;
      const key=topicPriority(topic);
      let bucket=buckets.get(key);if(!bucket){bucket=[];buckets.set(key,bucket);}
      bucket.push(topic);
    }
    const priorityKeys=Array.from(buckets.keys()).sort((a,b)=>b-a);
    for(const key of priorityKeys){
      for(const topic of buckets.get(key)){
        const st=status(topic),minutes=estimateMinutes(topic);
        if(sum+minutes>cap&&selected.length>0)continue;
        if(sum+minutes>cap&&selected.length===0&&limitBudget)continue;
        selected.push({topic,minutes,priority:key,status:st});sum+=minutes;
        if(sum>=cap)break;
      }
      if(sum>=cap)break;
    }
    return selected;
  }
  function hubCard(title,desc,body,wide=false){
    const inAnalytics=hubTab==='analytics',collapsible=inAnalytics&&!/(summary|trend|graph|chart|heatmap|consistency|daily review|daily study|review difficulty)/i.test(String(title||''));
    if(!inAnalytics)return `<section class="hub-card${wide?' wide':''}"><div class="hub-card-head"><div><h3>${title}</h3>${desc?`<p>${desc}</p>`:''}</div></div>${body}</section>`;
    const toggle=collapsible?'<button type="button" class="analytics-card-toggle" data-hub-action="analytics-card-toggle" aria-expanded="true">Collapse</button>':'';
    const inner=collapsible?'<div class="analytics-card-content">'+body+'</div>':body;
    return `<section class="hub-card${wide?' wide':''}${collapsible?' analytics-collapsible-card':''}"${collapsible?' data-analytics-collapsible="true"':''}><div class="hub-card-head"><div><h3>${title}</h3>${desc?`<p>${desc}</p>`:''}</div>${toggle}</div>${inner}</section>`;
  }
  function inputField(label,id,value,type='text',extra=''){return `<div class="hub-field"><label for="${id}">${label}</label><input id="${id}" type="${type}" value="${localEsc(value)}" ${extra}></div>`;}
  function selectOptions(items,current){return items.map(([v,l])=>`<option value="${localEsc(v)}" ${String(v)===String(current)?'selected':''}>${localEsc(l)}</option>`).join('');}
  function subjectOptions(current, includeAll=false){let s=state.subjects.map(x=>[x.id,x.name]);if(includeAll)s=[['','All subjects'],...s];return selectOptions(s,current||'');}
  function studyTopicOptionsMarkup(query='',current='',limit=150){
    const q=String(query||'').trim().toLocaleLowerCase(),items=[],subjectById=new Map(state.subjects.map(subject=>[String(subject.id),subject]));
    let total=0;
    for(const topic of state.topics){
      if(topic.archived)continue;
      const subject=subjectById.get(String(topic.subjectId));
      if(q&&![topic.name,topic.notes,subject?.name].some(value=>String(value||'').toLocaleLowerCase().includes(q)))continue;
      total++;
      if(items.length<limit)items.push([topic.id,(subject?.name?subject.name+' · ':'')+topic.name]);
    }
    if(current&&!items.some(item=>String(item[0])===String(current))){
      const selected=state.topics.find(topic=>String(topic.id)===String(current)&&!topic.archived);
      if(selected){const subject=subjectById.get(String(selected.subjectId));items.unshift([selected.id,(subject?.name?subject.name+' · ':'')+selected.name+' (selected)']);if(items.length>limit)items.pop();}
    }
    const html=selectOptions(items,current||'');
    return html+(total>limit?'<option disabled>Showing '+limit+' matches. Refine the search to see more.</option>':'');
  }
  function topicOptions(current, includeNone=true){
    const items=[];
    if(includeNone)items.push(['','No linked topic']);
    return selectOptions(items,current||'')+studyTopicOptionsMarkup('',current,200);
  }
  function liveFocusMinutesToday(){if(!focusStart)return 0;const now=focusPausedAt?focusPausedAt:Date.now();const dayStart=new Date();dayStart.setHours(0,0,0,0);return Math.max(0,(now-Math.max(focusStart,dayStart.getTime()))/60000);}
  function loggedMinutesToday(){let total=0;const date=today();for(const entry of fsState.studyLogs)if(entry&&entry.date===date)total+=studyLogMinutes(entry);return total;}
  function ensureStudyLogIds(){const ids=new Set();let changed=false;for(const entry of fsState.studyLogs){if(!entry||typeof entry!=='object')continue;let id=String(entry.id||'');if(!id||ids.has(id)){do{entry.id=fid();id=String(entry.id);}while(ids.has(id));changed=true;}ids.add(id);}if(changed)saveFs();}
  function studyLogTimeInfo(entry){const match=String(entry&&entry.note||'').match(/Started (.*?) · ended (.*?) · Duration:/);const parse=value=>{const ms=Date.parse(value||'');return Number.isFinite(ms)?new Date(ms):null;};const start=parse(entry&&entry.startedAt)||parse(match&&match[1]),end=parse(entry&&entry.endedAt)||parse(match&&match[2]),fallback=parse((entry&&entry.date||'')+'T12:00:00');const time=date=>date.toLocaleTimeString([],{hour:'numeric',minute:'2-digit'}),full=date=>date.toLocaleString([],{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'});const label=start&&end?(start.toDateString()===end.toDateString()?time(start)+'–'+time(end):full(start)+' – '+full(end)):start?'Started '+full(start):'';return {start,end,label,sortStamp:(end||start||fallback||new Date(0)).getTime()};}
  function renderStudyLogHistory(){
    ensureStudyLogIds();
    const subjectById=new Map(state.subjects.map(subject=>[String(subject.id),subject]));
    const topicById=new Map(state.topics.map(topic=>[String(topic.id),topic]));
    const compare=(a,b)=>b.timing.sortStamp-a.timing.sortStamp||a.index-b.index;
    const collector=window.NexusCreateTopKCollector(studyLogHistoryLimit,compare);
    let count=0,totalSeconds=0,index=0;
    // Only the newest page is kept for rendering; all records still contribute to totals.
    for(const entry of fsState.studyLogs){
      if(entry&&typeof entry==='object'){
        const timing=studyLogTimeInfo(entry);
        count++;
        totalSeconds+=Math.max(0,Math.round(studyLogMinutes(entry)*60));
        collector.add({entry,index,timing});
      }
      index++;
    }
    const visible=collector.finish().items;
    const rows=visible.map(({entry,timing})=>{
      const subject=subjectById.get(String(entry.subjectId||''))?.name||entry.subjectName||'Unassigned subject';
      const topic=topicById.get(String(entry.topicId||''))?.name||entry.topicName||'';
      const title=topic?subject+' · '+topic:subject,type=String(entry.type||'Study session');
      const date=safeDate(entry.date)?fmtDate(entry.date):String(entry.date||'Date unavailable');
      const note=entry.note&&type.toLowerCase()!=='focus session'?String(entry.note).slice(0,240):'';
      return `<article class="nexus-study-log-row"><div class="nexus-study-log-main"><div class="nexus-study-log-title">${localEsc(title)}</div><div class="nexus-study-log-meta">${localEsc(date)}${timing.label?' · '+localEsc(timing.label):''} · ${localEsc(type)}</div>${note?`<div class="nexus-study-log-note">${localEsc(note)}</div>`:''}</div><div class="nexus-study-log-actions"><strong class="nexus-study-log-duration">${formatStudyDuration(studyLogMinutes(entry)*60)}</strong><button type="button" class="btn btn-sm btn-danger" data-hub-action="delete-study-log" data-id="${localEsc(entry.id)}" aria-label="Delete this study-time entry">Delete</button></div></article>`;
    }).join('');
    const more=count>visible.length?`<div class="hub-actions"><button type="button" class="btn btn-sm btn-soft" data-hub-action="study-history-more">Show 100 older entries (${count-visible.length} remaining)</button></div>`:'';
    return `<div class="nexus-study-log-history-toolbar"><div><strong>${count} entr${count===1?'y':'ies'}</strong><span class="nexus-study-log-total">${formatStudyDuration(totalSeconds)} total recorded</span></div><button type="button" class="btn btn-sm btn-soft" data-hub-action="study-history-toggle" data-target="hubStudyLogHistory" aria-controls="hubStudyLogHistory" aria-expanded="true">Collapse</button></div><div id="hubStudyLogHistory" role="region" aria-label="Study-time history" tabindex="0">${rows||'<div class="nexus-study-log-empty">No study-time entries yet. Completed focus sessions will appear here.</div>'}</div>${more}`;
  }
  function deleteStudyLog(id){const entry=fsState.studyLogs.find(item=>item&&String(item.id)===String(id));if(!entry){notify('That study-time entry could not be found. Refresh the history and try again.');return;}const subject=state.subjects.find(s=>s.id===entry.subjectId)?.name||entry.subjectName||'Unassigned subject',topic=getTopic(entry.topicId)?.name||entry.topicName||'',time=studyLogTimeInfo(entry).label,duration=formatStudyDuration(studyLogMinutes(entry)*60),description=(topic?subject+' · '+topic:subject)+'\n'+(safeDate(entry.date)?fmtDate(entry.date):String(entry.date||'Date unavailable'))+(time?' · '+time:'')+'\n'+String(entry.type||'Study session')+' · '+duration;if(!confirm(`Delete this study-time entry?\n\n${description}\n\nIt will be removed from study-time history, totals, charts, and future exports. Related review, journal, and paper records will be kept. This cannot be undone.`))return;fsState.studyLogs=fsState.studyLogs.filter(item=>!item||String(item.id)!==String(id));saveFs();renderHub();notify('Study-time entry deleted. Study-time totals and exports updated.');}
  function renderPlanner(){const plan=buildPlan(true),done=new Set(fsState.taskChecks[today()]||[]),allPlan=plan.length?plan.reduce((n,x)=>n+x.minutes,0):0,doneMins=loggedMinutesToday()+liveFocusMinutesToday();const daily=fNum(fsState.settings.dailyMinutes)||90,session=fNum(fsState.settings.sessionMinutes)||25,week=weeklyReviewCount(),goal=fNum(fsState.settings.weeklyReviewGoal)||100;const nearest=nearestFutureExam();const left=nearest?Math.max(0,dayDiff(today(),nearest.date)):null;let remainingMins=0;for(const topic of state.topics){if(topic.archived)continue;const st=status(topic),meta=featureMeta(topic),mastered=topic.reviewCount>=2&&meta.avg>=3.5&&topic.intervalDays>=4&&st!=='overdue';if(!mastered)remainingMins+=Math.max(6,Math.min(30,Math.round(10+(meta.weak?7:0)+(meta.avg&&meta.avg<3?5:0)+(st==='overdue'?Math.min(5,Math.ceil(Math.max(0,dayDiff(topic.dueDate,today()))/5)):0))));}const perDay=left!==null&&left>0?Math.ceil(remainingMins/left):remainingMins;
    const tasks=plan.length?plan.map(x=>`<div class="hub-task"><div><div class="hub-task-name">${localEsc(x.topic.name)}</div><div class="hub-task-meta">${localEsc(subjectFor(x.topic)?.name||'')} · estimated ${x.minutes} min · ${localEsc(statusText(x.status))}</div></div><button class="btn btn-sm btn-primary" data-hub-action="review-topic" data-id="${localEsc(x.topic.id)}">Review</button></div>`).join(''):`<div class="hub-empty">No due or new topics fit the current budget. You can still choose any topic for a longer focus session.</div>`;
    const calWindow=Number(fsState.calendarWindow)||14,calendarStart=today(),scheduledByDate=new Map();for(const topic of state.topics){if(topic.archived)continue;const date=topic.dueDate||topic.createdAt||'';if(date){const dayOffset=dayDiff(calendarStart,date);if(dayOffset>=0&&dayOffset<calWindow)scheduledByDate.set(date,(scheduledByDate.get(date)||0)+1);}}const nextDays=Array.from({length:calWindow},(_,i)=>{const d=dateShift(calendarStart,i),count=scheduledByDate.get(d)||0,exams=state.exams.filter(e=>e.date===d);return {d,count,exams};});
    const cal=nextDays.map(x=>`<div class="hub-row"><div class="hub-row-main"><div class="hub-row-title">${localEsc(new Date(x.d+'T12:00:00').toLocaleDateString(undefined,{weekday:'short',month:'short',day:'numeric'}))}${x.d===today()?' · Today':''}</div><div class="hub-row-meta">${x.count} scheduled topic(s)${x.exams.length?' · '+x.exams.map(e=>localEsc(e.name)).join(', '):''}</div></div><span class="hub-badge ${x.count?'warn':''}">${x.count}</span></div>`).join('');
    const focus=focusStart?`<div class="hub-note">⏱ Focus session running · <strong id="hubFocusClock">${formatElapsed(Date.now()-focusStart)}</strong><br>Timer is saved locally and calculates elapsed time from its start timestamp when you return, even after closing the tab. It cannot verify that you were studying while away. <button class="btn btn-sm btn-primary" data-hub-action="focus-stop" style="margin-top:8px">Stop & log session</button> <button class="btn btn-sm btn-danger" data-hub-action="focus-discard" style="margin-top:8px">Discard without logging</button></div>`:'';
    const planBody=`<div class="hub-inline" style="justify-content:space-between;margin-bottom:10px"><div><div class="hub-score"><span id="hubDoneMinutes">${formatStudyDuration(doneMins*60)}</span>/${daily} min</div><div class="hub-muted">Completed planned time today · Daily budget ${daily} min · Weekly reviews ${week}/${goal}</div></div><span id="hubGoalBadge" class="hub-badge ${doneMins>=daily?'good':'warn'}">${Math.round(doneMins/Math.max(1,daily)*100)}% of daily goal</span></div><div class="hub-meter"><span id="hubGoalMeter" style="width:${Math.min(100,doneMins/Math.max(1,daily)*100)}%"></span></div><div class="hub-workload-summary"><div><strong>${plan.length} suggested topics</strong><span>${allPlan} estimated minutes · not a fixed 10-minute allocation</span></div><button class="btn btn-sm" data-hub-action="refresh-plan">Refresh estimates</button><button class="btn btn-sm btn-soft" data-hub-action="backlog-plan">Spread overdue backlog</button></div><div class="hub-list" style="margin-top:12px">${tasks}</div><div class="hub-note">The daily budget is a planning target, not a per-topic limit. Choose a topic and set a session length that matches the work.</div>`;
    const setupBody=`<div class="hub-form">${inputField('Available study time per day (minutes)','hubDailyMinutes',daily,'number','min="10" max="720" step="5"')}${inputField('Focus session length (minutes)','hubSessionMinutes',session,'number','min="5" max="180" step="5"')}${inputField('Weekly review target','hubWeeklyGoal',goal,'number','min="1" max="2000" step="5"')}<div class="hub-field"><label for="hubScheduler">Scheduling algorithm</label><select id="hubScheduler">${selectOptions([['classic','Classic intervals (existing)'],['fsrs-lite','FSRS-inspired adaptive heuristic']],fsState.settings.scheduler)}</select></div></div><div class="hub-actions"><button class="btn btn-primary" data-hub-action="save-planner-settings">Save planning settings</button><button class="btn" data-hub-action="focus-start">Start focus session (${session} min)</button><button class="btn" data-hub-action="focus-stop">Stop & log focus time</button></div>${focus}<div class="hub-note">The adaptive option is a transparent FSRS-inspired heuristic, not the official FSRS algorithm. Existing saved schedules are preserved. The selected method influences future review intervals only.</div>`;
    const examBody=nearest?`<div class="hub-score">${left===0?'Exam day':left+' days left'}</div><div class="hub-row-meta">${localEsc(nearest.name)} · ${localEsc(fmtDate(nearest.date))}</div><div class="hub-meter"><span style="width:${Math.min(100,left===0?100:Math.max(2,100/(left+1)))}%"></span></div><div class="hub-row-meta" style="margin-top:10px">Estimated non-mastered topic workload: ${remainingMins} min. To cover it before this exam, aim for about ${perDay} min/day across ${Math.max(1,left)} day(s). This estimate excludes past-paper time.</div>`:`<div class="hub-empty">Add an exam or deadline in Setup & data to calculate a countdown-based workload plan.</div>`;
    return `<div class="hub-grid">${hubCard('Topic study timer','Search and choose any topic, whether it is due today or not. The timer logs time against the selected topic and subject.',`<div class="hub-form"><div class="hub-field full"><label for="hubStudySearch">Search any topic</label><input class="hub-input" id="hubStudySearch" type="search" ${focusStart?'disabled':''} placeholder="Topic, subject, or notes…" value="${localEsc(fsState.studyTopicQuery||'')}"></div><div class="hub-field full"><label for="hubStudyTopic">Selected topic</label><select class="hub-input" id="hubStudyTopic" ${focusStart?'disabled':''}>${studyTopicOptionsMarkup(fsState.studyTopicQuery,focusTopicId,150)}</select></div><div class="hub-field"><label for="hubStudySubject">Subject if no topic is selected</label><select class="hub-input" id="hubStudySubject">${subjectOptions(focusSubjectId,true)}</select></div><div class="hub-field"><label for="hubTimerMinutes">Target minutes</label><input class="hub-input" id="hubTimerMinutes" type="number" min="5" max="240" step="5" value="${localEsc(fsState.settings.sessionMinutes||25)}"></div><div class="hub-actions full"><button class="btn btn-primary" data-hub-action="focus-start" ${focusStart?'disabled':''}>Start focus session</button>${focusStart?'<button class="btn btn-danger" data-hub-action="focus-stop">Stop & log session</button><button class="btn btn-danger" data-hub-action="focus-discard">Discard without logging</button>':''}</div><div class="hub-note">Daily budget: ${daily} min · logged today: ${doneMins} min. Active focus time is included in the daily budget.</div></div>`,true)}${hubCard('Study-time history','Review sessions recorded by the focus timer and other Study Hub tools. Delete mistaken entries to correct totals and exports.',renderStudyLogHistory())}${hubCard('Today’s study plan','A practical workload based on due dates, recent recall, and difficulty.',planBody,true)}${hubCard('Planning controls','Set the daily budget, focus block, weekly review target, and scheduler.',setupBody)}${hubCard('Exam countdown planner','Estimated study workload against your nearest upcoming exam.',examBody)}${hubCard('Final-revision mode & workload balancing','Temporarily prioritise non-mastered topics, then spread revision workload over a chosen window. Dates change. Review history is never fabricated.',`<div class="hub-inline"><span class="hub-badge ${fsState.settings.finalRevision?'good':'warn'}">${fsState.settings.finalRevision?'Final revision ON':'Final revision OFF'}</span><span class="hub-muted">${fsState.settings.finalRevision?'Non-mastered topics receive higher priority.':'Normal due-date and weakness priority.'}</span></div><div class="hub-actions"><button class="btn btn-sm ${fsState.settings.finalRevision?'':'btn-primary'}" data-hub-action="toggle-final-revision">${fsState.settings.finalRevision?'Turn final revision off':'Turn final revision on'}</button></div><div class="hub-form" style="margin-top:12px">${inputField('Balance topics across how many days','hubWorkloadDays',fsState.settings.workloadDays||7,'number','min="1" max="90" step="1"')}</div><div class="hub-actions"><button class="btn btn-sm btn-primary" data-hub-action="balance-workload">Balance active topics</button></div><div class="hub-note">Workload balancing distributes due, overdue, and new topics across the selected number of days using estimated effort and priority. It changes due dates only. Export a backup first if you want a rollback outside the app.</div>`,true)}${hubCard('Subject-neutral theory recall log','Use your own syllabus and method: blank-page recall, verbal explanation, written outline, formula derivation, or timed response. This is a practice log, not a quiz or flashcard system.',`<form id="hubRecallForm" class="hub-form"><div class="hub-field"><label for="hubRecallSubject">Subject</label><select id="hubRecallSubject">${subjectOptions('',true)}</select></div><div class="hub-field"><label for="hubRecallTopic">Topic (optional)</label><select id="hubRecallTopic">${topicOptions('',true)}</select></div><div class="hub-field"><label for="hubRecallMethod">Recall method</label><select id="hubRecallMethod">${selectOptions([['Blank-page recall','Blank-page recall'],['Verbal explanation','Verbal explanation'],['Written outline','Written outline'],['Formula / calculation derivation','Formula / calculation derivation'],['Timed exam response','Timed exam response'],['Diagram / process reconstruction','Diagram / process reconstruction'],['Other','Other']],'Blank-page recall')}</select></div><div class="hub-field"><label for="hubRecallConfidence">Recall quality</label><select id="hubRecallConfidence">${selectOptions([['1','1 · Could not recall'],['2','2 · Major gaps'],['3','3 · Partial'],['4','4 · Mostly complete'],['5','5 · Accurate and complete']],'3')}</select></div><div class="hub-field full"><label for="hubRecallRecalled">What did you reconstruct from memory?</label><textarea id="hubRecallRecalled" maxlength="3000" placeholder="Briefly record the key points, steps, formulas, or structure you recalled."></textarea></div><div class="hub-field full"><label for="hubRecallGaps">Gaps to fix next</label><textarea id="hubRecallGaps" maxlength="2000" placeholder="What was missing or inaccurate? What will you review?"></textarea></div><div class="hub-actions full"><button class="btn btn-primary" type="submit">Save recall session</button></div></form>`,true)}</div>`;}
  function renderMastery(){
    const subjectStats=new Map(state.subjects.map(sub=>[String(sub.id),{
      sub,total:0,reviewed:0,mastered:0,weak:0,averageSum:0,target:fNum(fsState.syllabusTargets[sub.id])||0
    }]));
    const compareDetailed=(a,b)=>a.meta.score-b.meta.score||b.priority-a.priority||a.order-b.order;
    const detailedCollector=window.NexusCreateTopKCollector(40,compareDetailed);
    // Aggregate all subject metrics and mastery candidates in a single topic pass.
    // Only the best 40 detail rows are retained; the complete topic array is not copied or sorted.
    let topicOrder=0;
    for(const topic of state.topics){
      const order=topicOrder++;
      if(topic.archived)continue;
      const row=subjectStats.get(String(topic.subjectId));
      if(!row)continue;
      const meta=featureMeta(topic),topicStatus=status(topic);
      row.total++;
      if(topic.reviewCount>0){row.reviewed++;row.averageSum+=meta.avg;}
      if(topic.reviewCount>=2&&meta.avg>=3.5&&topic.intervalDays>=4&&topicStatus!=='overdue')row.mastered++;
      if(meta.weak)row.weak++;
      detailedCollector.add({topic,meta,priority:topicPriority(topic,meta),status:topicStatus,order});
    }
    const rows=Array.from(subjectStats.values()).map(row=>{
      const coverage=row.target>0?Math.min(100,Math.round(row.total/row.target*100)):row.total?Math.round(row.reviewed/row.total*100):0;
      return {...row,avg:row.reviewed?row.averageSum/row.reviewed:0,coverage};
    });
    const subjectRows=rows.length?rows.map(r=>`<tr><td>${localEsc(r.sub.name)}<div class="hub-row-meta">${localEsc(streamFor(r.sub)?.name||'')}</div></td><td>${r.total}${r.target?` / ${r.target}`:''}</td><td>${r.total?Math.round(r.reviewed/r.total*100):0}%</td><td>${r.total?Math.round(r.mastered/r.total*100):0}%</td><td>${r.avg?r.avg.toFixed(1)+'/5':'—'}</td><td>${r.weak}</td><td><div class="hub-meter"><span style="width:${r.coverage}%"></span></div><div class="hub-row-meta">${r.target?`${r.coverage}% of expected count`:'reviewed-topic coverage'}</div></td></tr>`).join(''):`<tr><td colspan="7">Create a subject to start tracking coverage.</td></tr>`;
    const targetInputs=rows.map(r=>`<div class="hub-row"><div class="hub-row-main"><div class="hub-row-title">${localEsc(r.sub.name)}</div><div class="hub-row-meta">${r.total} topics in the tracker · ${r.reviewed} reviewed · ${r.mastered} mastered</div></div><div style="width:120px"><input class="hub-input" type="number" min="0" max="10000" step="1" data-target-subject="${localEsc(r.sub.id)}" value="${r.target||''}" placeholder="Expected count" aria-label="Expected lesson count for ${localEsc(r.sub.name)}"></div></div>`).join('');
    const detailed=detailedCollector.finish().items.map(({topic:t,meta:m,status:st})=>{
      const pct=m.score,mastered=t.reviewCount>=2&&m.avg>=3.5&&t.intervalDays>=4&&st!=='overdue';
      return `<div class="hub-row"><div class="hub-row-main"><div class="hub-row-title">${localEsc(t.name)}</div><div class="hub-row-meta">${localEsc(subjectFor(t)?.name||'')} · ${t.reviewCount} reviews · Avg ${m.avg?m.avg.toFixed(1)+'/5':'not rated'} · ${localEsc(statusText(st))}</div><div class="hub-meter"><span style="width:${pct}%;background:${m.weak?'var(--amber)':'var(--accent)'}"></span></div></div><div class="hub-row-actions"><span class="hub-badge ${m.weak?'warn':mastered?'good':''}">${m.weak?'Needs work':mastered?'Mastered':pct+'%'}</span><button class="btn btn-sm" data-hub-action="edit-topic" data-id="${localEsc(t.id)}">Edit</button></div></div>`;
    }).join('');
    return `<div class="hub-grid">${hubCard('Syllabus coverage map','Metrics are based on topics represented in this tracker. Set an expected topic count to estimate coverage against a full syllabus.',`<div class="hub-table-wrap"><table class="hub-table"><thead><tr><th>Subject</th><th>Topics</th><th>Reviewed</th><th>Mastered</th><th>Avg rating</th><th>Weak</th><th>Coverage</th></tr></thead><tbody>${subjectRows}</tbody></table></div>`,true)}${hubCard('Expected syllabus size','Optional estimated denominator by subject; leave blank to show progress only among currently entered topics.',`${targetInputs}<div class="hub-actions"><button class="btn btn-primary" data-hub-action="save-targets">Save syllabus targets</button></div>`)}${hubCard('Weakness detector & topic mastery','Top 40 topics ordered by estimated mastery, with repeated lapses, low recent ratings and overdue status flagged.',`<div class="hub-list">${detailed||'<div class="hub-empty">No topics yet.</div>'}</div>`,true)}</div>`;
  }
  function renderPapers(){const n=fsState.papers.length,scored=fsState.papers.filter(p=>p.score!==null&&p.score!==undefined&&p.maxScore>0),avg=scored.length?Math.round(scored.reduce((s,p)=>s+p.score/p.maxScore*100,0)/scored.length):0,minutes=fsState.papers.reduce((s,p)=>s+fNum(p.duration),0),err=fsState.papers.reduce((s,p)=>s+fNum(p.errorCount),0);const exam=nearestFutureExam();const form=`<form id="hubPaperForm" class="hub-form">${inputField('Paper / practice name','hubPaperName','','text','required maxlength="160" placeholder="e.g. Economics 2022 Paper II"')}<div class="hub-field"><label for="hubPaperSubject">Subject</label><select id="hubPaperSubject">${subjectOptions('',true)}</select></div><div class="hub-field"><label for="hubPaperKind">Practice type</label><select id="hubPaperKind">${selectOptions([['Past paper','Past paper'],['Timed section','Timed section'],['Calculation drill','Calculation drill'],['Theory recall','Theory recall'],['Mock exam','Mock exam'],['Other','Other']],'Past paper')}</select></div>${inputField('Date','hubPaperDate',today(),'date','required')}${inputField('Score achieved','hubPaperScore','','number','min="0" step="any" placeholder="Optional"')}${inputField('Maximum score','hubPaperMax','','number','min="0.01" step="any" placeholder="Optional"')}${inputField('Duration (minutes)','hubPaperDuration','','number','min="0" max="10000" step="1"')}${inputField('Errors / questions missed','hubPaperErrors','0','number','min="0" max="10000" step="1"')}<div class="hub-field full"><label for="hubPaperWeak">Weak areas / missed concepts</label><input id="hubPaperWeak" maxlength="1000" placeholder="e.g. elasticity calculations, company accounts"></div><div class="hub-field full"><label for="hubPaperNotes">Notes and next actions</label><textarea id="hubPaperNotes" maxlength="2000" placeholder="Why marks were lost, what to practise next"></textarea></div><div class="hub-actions full"><button class="btn btn-primary" type="submit">Save paper / practice log</button></div></form>`;
    const stats=`<div class="hub-kpis" style="margin-bottom:0"><div class="hub-kpi"><strong>${n}</strong><span>Practices logged</span></div><div class="hub-kpi"><strong>${avg}%</strong><span>Average scored result</span></div><div class="hub-kpi"><strong>${minutes}</strong><span>Paper minutes logged</span></div><div class="hub-kpi"><strong>${err}</strong><span>Missed items recorded</span></div></div>`;
    const examCard=exam?`<div class="hub-note"><strong>${localEsc(exam.name)}</strong>: ${dayDiff(today(),exam.date)} day(s) left. Plan subject-specific paper attempts alongside spaced reviews; this tracker does not assume that a completed review equals exam readiness.</div>`:`<div class="hub-note">Add your exam date in Setup & data to enable countdown planning.</div>`;
    return `<div class="hub-grid">${hubCard('Paper and calculation practice log','Record full past papers, timed sections, theory recall, calculation drills and mock exams.',form)}${hubCard('Exam readiness snapshot','Compare practice results, errors, and logged paper time over time.',`${stats}${examCard}<div class="hub-actions"><button class="btn" data-hub-action="export-papers">Export practice CSV</button></div>`)}${hubCard('Paper history','Scores and weak areas are stored locally and included in full backups.',`<div class="hub-list">${paperRows()||'<div class="hub-empty">No papers logged yet. Add your first timed section, calculation drill, or past paper above.</div>'}</div>`,true)}</div>`;}
  function renderJournal(){const form=`<form id="hubJournalForm" class="hub-form"><div class="hub-field"><label for="hubJournalCategory">Entry type</label><select id="hubJournalCategory">${selectOptions([['Mistake','Mistake / lost marks'],['Concept gap','Concept gap'],['Calculation','Calculation error'],['Theory recall','Theory recall'],['Repeated error','Repeated error'],['Next action','Next action'],['Study note','Study note']],'Mistake')}</select></div><div class="hub-field"><label for="hubJournalSubject">Subject</label><select id="hubJournalSubject">${subjectOptions('',true)}</select></div><div class="hub-field"><label for="hubJournalTopic">Related topic (optional)</label><select id="hubJournalTopic">${topicOptions('',true)}</select></div><div class="hub-field"><label for="hubJournalSeverity">Severity</label><select id="hubJournalSeverity">${selectOptions([['1','Low'],['2','Moderate'],['3','High'],['4','Repeated / critical']], '2')}</select></div><div class="hub-field full"><label for="hubJournalIssue">What went wrong / what should be remembered?</label><textarea id="hubJournalIssue" maxlength="3000" required placeholder="Describe the exact mistake, missed step, or unclear idea."></textarea></div><div class="hub-field full"><label for="hubJournalFix">Correction / next action</label><textarea id="hubJournalFix" maxlength="3000" placeholder="Write the correct reasoning or the practice task needed."></textarea></div><div class="hub-actions full"><button class="btn btn-primary" type="submit">Save journal entry</button></div></form>`;
    const items=fsState.journal.slice().sort((a,b)=>(b.date||'').localeCompare(a.date||'')).map(j=>`<div class="hub-row"><div class="hub-row-main"><div class="hub-row-title">${localEsc(j.category)} <span class="hub-badge ${j.solved?'good':Number(j.severity)>=3?'warn':''}">${j.solved?'Resolved':'Open'} · Severity ${localEsc(j.severity)}</span></div><div class="hub-row-meta">${localEsc(fmtDate(j.date))} · ${localEsc(state.subjects.find(s=>s.id===j.subjectId)?.name||'General')}${j.topicId?` · ${localEsc(getTopic(j.topicId)?.name||'Deleted topic')}`:''}</div><div style="margin-top:7px;white-space:pre-wrap;overflow-wrap:anywhere">${localEsc(j.issue)}</div>${j.fix?`<div class="hub-note"><strong>Correction / action:</strong><br>${localEsc(j.fix)}</div>`:''}</div><div class="hub-row-actions"><button class="btn btn-sm" data-hub-action="toggle-journal" data-id="${localEsc(j.id)}">${j.solved?'Reopen':'Resolve'}</button><button class="btn btn-sm btn-danger" data-hub-action="delete-journal" data-id="${localEsc(j.id)}">Delete</button></div></div>`).join('');
    return `<div class="hub-grid">${hubCard('Mistake journal and lesson notes','Subject-neutral entries work across Accounting, Economics, Business Studies, languages, science, and any other course.',form)}${hubCard('How to use the journal','Keep each entry specific: identify the error, write the correct method, and define a follow-up action.',`<div class="hub-note">Recommended after every paper: record repeated errors and calculation mistakes, then tag the related topic. Use the mastery page to find low-rated topics and revisit the error log before another attempt.</div><div class="hub-row"><div class="hub-row-main"><div class="hub-row-title">Open entries</div><div class="hub-row-meta">Entries not yet marked resolved</div></div><strong class="hub-score">${fsState.journal.filter(j=>!j.solved).length}</strong></div><div class="hub-row"><div class="hub-row-main"><div class="hub-row-title">High severity</div><div class="hub-row-meta">Severity 3–4 entries still open</div></div><strong class="hub-score">${fsState.journal.filter(j=>!j.solved&&Number(j.severity)>=3).length}</strong></div>`)}${hubCard('Journal history',`Saved entries: ${fsState.journal.length}`,`<div class="hub-list">${items||'<div class="hub-empty">No journal entries yet. Add a mistake or lesson note after your next practice session.</div>'}</div>`,true)}</div>`;}
  function analyticsAccessPolicy(){return {tier:'free',maxRangeDays:730,unlimitedRange:false};}

  const RATING_ANALYTICS_COLORS={1:'#ef4444',2:'#f97316',3:'#eab308',4:'#84cc16',5:'#059669'};

  function getRatingAnalyticsSelection(){
    const allowed=['week','month','year','custom'],period=allowed.includes(String(fsState.analyticsPeriod||'week'))?String(fsState.analyticsPeriod||'week'):'week',now=today();let from=now,to=now;
    if(period==='week'){const offset=(new Date(now+'T12:00:00').getDay()+6)%7;from=dateShift(now,-offset);to=dateShift(from,6);}
    else if(period==='month'){from=now.slice(0,7)+'-01';const p=now.split('-'),last=new Date(Number(p[0]),Number(p[1]),0).getDate();to=now.slice(0,7)+'-'+String(last).padStart(2,'0');}
    else if(period==='year'){from=now.slice(0,4)+'-01-01';to=now.slice(0,4)+'-12-31';}
    else{from=safeDate(fsState.analyticsCustomStart)?fsState.analyticsCustomStart:dateShift(now,-29);to=safeDate(fsState.analyticsCustomEnd)?fsState.analyticsCustomEnd:now;}
    const valid=safeDate(from)&&safeDate(to)&&from<=to,records=valid?state.history.filter(h=>safeDate(h.reviewedAt)&&h.reviewedAt>=from&&h.reviewedAt<=to):[];
    return {range:period,from,to,records,label:({week:'This week',month:'This month',year:'This year',custom:'Custom date range'})[period],valid};
  }
  function getRatingAnalyticsEntityOptions(level){
    const map=new Map();
    if(level==='topic'){
      state.topics.forEach(t=>{const sub=subjectFor(t);map.set(String(t.id),{value:String(t.id),label:String(t.name||'Untitled topic'),subtitle:String(sub?.name||'Unassigned subject')});});
      state.history.forEach(h=>{const name=String(h.topicName||getTopic(h.topicId)?.name||'Untitled topic'),sub=String(h.subjectName||'Unassigned subject'),value=h.topicId?String(h.topicId):'legacy-topic:'+sub+'::'+name;if(!map.has(value))map.set(value,{value,label:name,subtitle:sub});});
    }else if(level==='subject'){
      state.subjects.forEach(sub=>{const st=streamFor(sub);map.set(String(sub.id),{value:String(sub.id),label:String(sub.name||'Untitled subject'),subtitle:String(st?.name||'Unassigned syllabus')});});
      state.history.forEach(h=>{const name=String(h.subjectName||'Unassigned subject'),subtitle=String(h.streamName||'Unassigned syllabus'),value=h.subjectId?String(h.subjectId):'legacy-subject:'+name;if(!map.has(value))map.set(value,{value,label:name,subtitle});});
    }else{
      state.streams.forEach(st=>map.set(String(st.id),{value:String(st.id),label:String(st.name||'Untitled syllabus'),subtitle:'Syllabus / stream'}));
      state.history.forEach(h=>{const name=String(h.streamName||'Unassigned syllabus'),value=h.streamId?String(h.streamId):'legacy-syllabus:'+name;if(!map.has(value))map.set(value,{value,label:name,subtitle:'Syllabus / stream'});});
    }
    const allLabel=level==='topic'?'All topics':level==='subject'?'All subjects':'All syllabuses';
    map.set('ALL',{value:'ALL',label:allLabel,subtitle:'Combined rating history for this timeframe'});
    return Array.from(map.values()).sort((a,b)=>a.label.localeCompare(b.label)||a.subtitle.localeCompare(b.subtitle));
  }
  function getRatingAnalyticsEntityId(level,options){const choices=Array.isArray(options)?options:getRatingAnalyticsEntityOptions(level),prior=String(fsState.analyticsRatingEntity||'');return choices.some(x=>x.value===prior)?prior:(choices[0]?.value||'');}
  function getRatingAnalyticsEntityLabel(level,entityId,options){const choices=Array.isArray(options)?options:getRatingAnalyticsEntityOptions(level),o=choices.find(x=>x.value===String(entityId));return o?.label||'No '+(level==='topic'?'topic':level==='subject'?'subject':'syllabus')+' selected';}
  function getRatingAnalyticsScopedRecords(records,level,entityId){
    if(!entityId)return [];if(String(entityId)==='ALL')return records||[];
    return records.filter(h=>{
      const name=String(h.topicName||getTopic(h.topicId)?.name||'Untitled topic'),subject=String(h.subjectName||'Unassigned subject'),stream=String(h.streamName||'Unassigned syllabus');
      if(level==='topic'){if(String(entityId).startsWith('legacy-topic:'))return !h.topicId&&String(entityId)==='legacy-topic:'+subject+'::'+name;const t=getTopic(entityId);return String(h.topicId||'')===String(entityId)||(!h.topicId&&t&&name===t.name&&subject===(subjectFor(t)?.name||'Unassigned subject'));}
      if(level==='subject'){if(String(entityId).startsWith('legacy-subject:'))return !h.subjectId&&String(entityId)==='legacy-subject:'+subject;const sub=state.subjects.find(x=>String(x.id)===String(entityId));return String(h.subjectId||'')===String(entityId)||(!h.subjectId&&sub&&subject===sub.name);}
      if(String(entityId).startsWith('legacy-syllabus:'))return !h.streamId&&String(entityId)==='legacy-syllabus:'+stream;
      const st=state.streams.find(x=>String(x.id)===String(entityId));return String(h.streamId||'')===String(entityId)||(!h.streamId&&st&&stream===st.name);
    });
  }
  function getRatingAnalyticsGroups(records,level){
    const map=new Map();
    records.forEach(h=>{
      const topicName=String(h.topicName||getTopic(h.topicId)?.name||'Untitled topic');
      const subjectName=String(h.subjectName||state.subjects.find(s=>s.id===h.subjectId)?.name||'Unassigned subject');
      const streamName=String(h.streamName||state.streams.find(s=>s.id===h.streamId)?.name||'Unassigned syllabus');
      let key,label,subtitle;
      if(level==='subject'){key=String(h.subjectId||('subject:'+subjectName));label=subjectName;subtitle=streamName;}
      else if(level==='syllabus'){key=String(h.streamId||('syllabus:'+streamName));label=streamName;subtitle='Syllabus / stream';}
      else{key=String(h.topicId||('topic:'+subjectName+'::'+topicName));label=topicName;subtitle=subjectName+' · '+streamName;}
      if(!map.has(key))map.set(key,{key,label,subtitle,counts:[0,0,0,0,0],total:0});
      const item=map.get(key),rating=Number(h.rating);
      if(rating>=1&&rating<=5&&Number.isInteger(rating)){item.counts[rating-1]++;item.total++;}
    });
    return Array.from(map.values()).filter(x=>x.total>0).sort((a,b)=>b.total-a.total||a.label.localeCompare(b.label));
  }

  function getRatingAnalyticsTimeline(selection,level,entityId){
    const period=selection.range,from=selection.from,to=selection.to,bins=[],now=today(),empty={bins,records:[],totals:[0,0,0,0,0]};
    if(!safeDate(from)||!safeDate(to)||from>to)return empty;
    const pushDay=date=>bins.push({start:date,end:date,label:period==='week'?new Date(date+'T12:00:00').toLocaleDateString(undefined,{weekday:'short'}):date.slice(8),title:fmtDate(date)});
    if(period==='week'){for(let i=0;i<7;i++)pushDay(dateShift(from,i));}
    else if(period==='month'){const n=dayDiff(from,to)+1;for(let i=0;i<n;i++)pushDay(dateShift(from,i));bins.forEach(b=>{b.label=String(Number(b.start.slice(8)));b.title=fmtDate(b.start);});}
    else if(period==='year'){
      let cursor=from;
      while(cursor<=to){const d=new Date(cursor+'T12:00:00'),year=d.getFullYear(),month=d.getMonth()+1,last=year+'-'+String(month).padStart(2,'0')+'-'+String(new Date(year,month,0).getDate()).padStart(2,'0'),end=last<to?last:to;bins.push({start:cursor,end,label:new Date(year,month-1,1).toLocaleDateString(undefined,{month:'short'}),title:new Date(year,month-1,1).toLocaleDateString(undefined,{month:'long',year:'numeric'})});cursor=dateShift(end,1);}
    }else{
      const n=dayDiff(from,to)+1;
      if(n<=31){for(let i=0;i<n;i++)pushDay(dateShift(from,i));bins.forEach(b=>{b.label=new Date(b.start+'T12:00:00').toLocaleDateString(undefined,{month:'numeric',day:'numeric'});});}
      else if(n<=186){for(let cursor=from;cursor<=to;){const end=dateShift(cursor,Math.min(6,dayDiff(cursor,to)));bins.push({start:cursor,end,label:new Date(cursor+'T12:00:00').toLocaleDateString(undefined,{month:'numeric',day:'numeric'}),title:fmtDate(cursor)+' – '+fmtDate(end)});cursor=dateShift(end,1);}}
      else{for(let cursor=from;cursor<=to;){const d=new Date(cursor+'T12:00:00'),year=d.getFullYear(),month=d.getMonth()+1,last=year+'-'+String(month).padStart(2,'0')+'-'+String(new Date(year,month,0).getDate()).padStart(2,'0'),end=last<to?last:to;bins.push({start:cursor,end,label:d.toLocaleDateString(undefined,{month:'short',year:'2-digit'}),title:fmtDate(cursor)+' – '+fmtDate(end)});cursor=dateShift(end,1);}}
    }
    const scoped=getRatingAnalyticsScopedRecords(selection.records||[],level,entityId),totals=[0,0,0,0,0],dateToBin=new Map();
    bins.forEach((bin,index)=>{bin.isFuture=bin.start>now;bin.counts=bin.isFuture?[null,null,null,null,null]:[0,0,0,0,0];if(!bin.isFuture)for(let d=bin.start;d<=bin.end&&d<=now;d=dateShift(d,1))dateToBin.set(d,index);});
    scoped.forEach(record=>{const index=dateToBin.get(record.reviewedAt),rating=Number(record.rating);if(index===undefined||!Number.isInteger(rating)||rating<1||rating>5)return;bins[index].counts[rating-1]++;totals[rating-1]++;});
    bins.forEach(bin=>{bin.total=bin.isFuture?null:bin.counts.reduce((sum,count)=>sum+count,0);});
    return {bins,records:scoped,totals};
  }
  function getVisibleAnalyticsRatings(){
    const saved=Array.isArray(fsState.analyticsVisibleRatings)?fsState.analyticsVisibleRatings.map(Number).filter(r=>Number.isInteger(r)&&r>=1&&r<=5):[1,2,3,4,5];
    return saved.length?saved:[1,2,3,4,5];
  }
  function ratingAnalyticsSvgMarkup(selection,level,entityId,timelineResult){
    const result=timelineResult||getRatingAnalyticsTimeline(selection,level,entityId),bins=result.bins,visibleRatings=getVisibleAnalyticsRatings(),dense=bins.length>12,left=50,right=20,top=22,bottom=51,minCellWidth=bins.length>24?28:bins.length>12?35:56,W=Math.max(720,left+right+bins.length*minCellWidth),H=300,plotW=W-left-right,plotH=H-top-bottom,cellW=bins.length?plotW/bins.length:plotW,baseline=top+plotH;
    const maxCount=Math.max(1,...bins.map(bin=>visibleRatings.reduce((max,rating)=>Math.max(max,Number(bin.counts[rating-1])||0),0))),magnitude=Math.pow(10,Math.floor(Math.log10(maxCount)))||1,norm=maxCount/magnitude,mult=norm<=1?1:norm<=2?2:norm<=5?5:10,yMax=maxCount<=5?5:mult*magnitude,yAt=count=>top+plotH-(count/yMax)*plotH,xAt=i=>left+(i+.5)*cellW;
    let svg='<svg class="ra-svg'+(dense?' ra-svg-dense':' ra-svg-single')+'" '+(dense?'style="--ra-chart-width:'+W+'px" ':'')+'viewBox="0 0 '+W+' '+H+'" role="img" aria-label="Line chart of review difficulty ratings over time. Each rating uses the same count scale. Filter difficulty lines with the colored buttons."><defs>';
    visibleRatings.forEach(rating=>{const color=RATING_ANALYTICS_COLORS[rating];svg+='<linearGradient id="rating-'+rating+'" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="'+color+'" stop-opacity=".18"/><stop offset="62%" stop-color="'+color+'" stop-opacity=".06"/><stop offset="100%" stop-color="'+color+'" stop-opacity="0"/></linearGradient>';});
    svg+='</defs>';
    const tickStep=Math.max(1,Math.ceil(yMax/4)),ticks=[0,tickStep,Math.min(yMax,tickStep*2),Math.min(yMax,tickStep*3),yMax].filter((v,i,a)=>a.indexOf(v)===i);
    ticks.forEach(value=>{const yy=yAt(value);svg+='<line class="ra-gridline" x1="'+left+'" y1="'+yy.toFixed(2)+'" x2="'+(W-right)+'" y2="'+yy.toFixed(2)+'"/><text class="ra-tick" x="'+(left-9)+'" y="'+(yy+4).toFixed(2)+'" text-anchor="end">'+value+'</text>';});
    svg+='<line class="ra-axis" x1="'+left+'" y1="'+top+'" x2="'+left+'" y2="'+baseline+'"/><line class="ra-axis" x1="'+left+'" y1="'+baseline+'" x2="'+(W-right)+'" y2="'+baseline+'"/>';
    const labelEvery=bins.length<=12?1:Math.max(1,Math.ceil(bins.length/(selection.range==='month'?12:10)));
    bins.forEach((bin,index)=>{const x=xAt(index);if(index%labelEvery===0||index===bins.length-1)svg+='<line class="ra-gridline" x1="'+x.toFixed(2)+'" y1="'+baseline+'" x2="'+x.toFixed(2)+'" y2="'+(baseline+4)+'"/><text class="ra-tick" x="'+x.toFixed(2)+'" y="'+(H-23)+'" text-anchor="middle">'+esc(bin.label)+'</text>';});
    visibleRatings.forEach(rating=>{
      const color=RATING_ANALYTICS_COLORS[rating],points=bins.map((bin,index)=>bin.isFuture||!Number.isFinite(bin.counts[rating-1])?null:{x:xAt(index),y:yAt(bin.counts[rating-1]),count:bin.counts[rating-1],title:bin.title,index}).filter(Boolean);
      if(result.totals[rating-1]>0&&points.length){
        const path=smoothCurvePath(points),area=path+' L '+points[points.length-1].x.toFixed(2)+' '+baseline.toFixed(2)+' L '+points[0].x.toFixed(2)+' '+baseline.toFixed(2)+' Z';
        svg+='<g class="ra-line-series" data-rating-line="'+rating+'" data-scale-max="'+yMax+'"><path class="ra-series-area" data-rating-area="'+rating+'" fill="url(#rating-'+rating+')" d="'+area+'"/><path class="ra-line" data-rating-line-path="'+rating+'" stroke="'+color+'" d="'+path+'"/>';
        points.forEach(point=>{svg+='<circle class="ra-point" data-rating-point="'+rating+'" data-bin-index="'+point.index+'" cx="'+point.x.toFixed(2)+'" cy="'+point.y.toFixed(2)+'" r="3.1" fill="'+color+'"><title>'+esc(point.title)+' · '+rating+' '+esc(RATING_LABELS[rating])+': '+point.count+' review'+(point.count===1?'':'s')+'</title></circle>';});
        svg+='</g>';
      }
    });
    if(!visibleRatings.some(rating=>result.totals[rating-1]>0))svg+='<text class="ra-no-data" x="'+(left+plotW/2)+'" y="'+(top+plotH/2)+'" text-anchor="middle">No reviews for the selected difficulties in this timeframe</text>';
    svg+='<text class="ra-axis-title" x="'+(left+plotW/2)+'" y="'+(H-5)+'" text-anchor="middle">Selected timeframe</text><text class="ra-axis-title" transform="translate(15 '+(top+plotH/2)+') rotate(-90)" text-anchor="middle">Review difficulty ratings per interval</text></svg>';
    return svg;
  }
  function ratingAnalyticsTimelineTableMarkup(selection,level,entityId,timelineResult){
    const bins=(timelineResult||getRatingAnalyticsTimeline(selection,level,entityId)).bins;
    const rows=bins.map(bin=>'<tr'+(bin.isFuture?' class="ra-future-row"':'')+'><td>'+esc(bin.title)+(bin.isFuture?' · Future':'')+'</td>'+bin.counts.map((count,i)=>'<td class="num">'+(count===null?'—':'<span class="ra-table-rating" data-rating="'+(i+1)+'">'+count+'</span>')+'</td>').join('')+'<td class="num"><strong>'+(bin.total===null?'—':bin.total)+'</strong></td></tr>').join('');
    return '<div class="ra-count-table-wrap"><table class="ra-count-table"><thead><tr><th>Date / interval</th><th class="num">1 Again</th><th class="num">2 Hard</th><th class="num">3 Good</th><th class="num">4 Very good</th><th class="num">5 Easy</th><th class="num">Total</th></tr></thead><tbody>'+rows+'</tbody></table></div>';
  }
  function ratingAnalyticsLegendMarkup(){
    return '<div class="ra-legend">'+[1,2,3,4,5].map(r=>'<span class="ra-legend-item"><i class="ra-swatch" data-rating="'+r+'"></i>'+r+' · '+esc(RATING_LABELS[r])+'</span>').join('')+'</div>';
  }

  function ratingAnalyticsChartMarkup(selection,level,entityId,entityOptions){
    const options=Array.isArray(entityOptions)?entityOptions:getRatingAnalyticsEntityOptions(level),selected=options.find(x=>x.value===entityId),timeline=getRatingAnalyticsTimeline(selection,level,entityId),scopeLabel=selected?.label||'No '+level+' selected',subtitle=selected?.subtitle||'',visibleRatings=getVisibleAnalyticsRatings();
    const legend=[1,2,3,4,5].map(rating=>'<button type="button" class="ra-legend-item" data-hub-action="analytics-toggle-rating" data-rating-toggle="'+rating+'" aria-pressed="'+visibleRatings.includes(rating)+'" title="'+(visibleRatings.includes(rating)?'Hide ':'Show ')+esc(RATING_LABELS[rating])+' difficulty in the graph"><i class="ra-swatch" data-rating="'+rating+'"></i>'+rating+' · '+esc(RATING_LABELS[rating])+' <strong>'+timeline.totals[rating-1]+'</strong></button>').join('');
    const selectedCount=visibleRatings.reduce((sum,rating)=>sum+timeline.totals[rating-1],0);
    const summary='<div class="ra-chart-summary"><div><strong>'+esc(scopeLabel)+'</strong><small>'+esc(subtitle)+' · '+esc(selection.label)+' · '+esc(fmtDate(selection.from))+' – '+esc(fmtDate(selection.to))+'</small></div><div><strong>'+selectedCount+' selected review ratings</strong><small>Toggle difficulty labels to show or hide each curve. All difficulties use the same count scale.</small></div></div>';
    return summary+'<div class="ra-legend">'+legend+'</div><div class="ra-svg-wrap">'+ratingAnalyticsSvgMarkup(selection,level,entityId,timeline)+'</div><details class="ra-count-details"><summary>View exact counts by date / interval</summary>'+ratingAnalyticsTimelineTableMarkup(selection,level,entityId,timeline)+'</details><div class="ra-foot">Each colored curve tracks one review-button difficulty on a shared count scale. The shaded area fades toward the baseline. Tap a difficulty label to filter its curve. Hover or tap a point for the exact count. Future intervals remain blank, and the table marks them unavailable rather than treating them as zero.</div>';
  }
  function analyticsReportStackedRows(groups,limit){
    const visible=groups.slice(0,limit||20),max=Math.max(1,...groups.map(g=>g.total));
    if(!visible.length)return '<p class="pdf-empty">No review ratings in this period.</p>';
    return visible.map(g=>'<div class="pdf-stack-row"><div class="pdf-stack-label"><strong>'+esc(g.label)+'</strong><small>'+esc(g.subtitle)+'</small></div><div class="pdf-stack-track">'+g.counts.map((count,i)=>count?'<span class="pdf-rating" data-rating="'+(i+1)+'" style="width:'+((count/max)*100).toFixed(3)+'%" title="'+esc(RATING_LABELS[i+1]+': '+count)+'"></span>':'').join('')+'</div><b>'+g.total+'</b></div>').join('');
  }
  function exportAnalyticsCsv(){
    try{
      const selection=getRatingAnalyticsSelection(),from=selection.from,to=selection.to;
      if(!selection||selection.valid===false||!safeDate(from)||!safeDate(to)){notify('Choose a valid analytics timeframe before exporting.');return;}
      const rows=[['Section','Date / interval start','Interval end','Subject / stream','Topic / paper / record','Metric','Value','Unit','Notes']];
      const add=(section,date,end,subject,record,metric,value,unit,notes='')=>rows.push([section,date||'',end||'',subject||'',record||'',metric||'',value??'',unit||'',notes||'']);
      add('Report',from,to,'','Selected timeframe','Coverage',selection.label,'','The export uses the current shared Analytics timeframe.');
      const inRange=d=>safeDate(d)&&d>=from&&d<=to;
      const reviewRecords=state.history.filter(h=>inRange(h.reviewedAt)).slice().sort((a,b)=>String(a.reviewedAt||'').localeCompare(String(b.reviewedAt||'')));
      const reviewByDate=new Map();reviewRecords.forEach(h=>reviewByDate.set(h.reviewedAt,(reviewByDate.get(h.reviewedAt)||0)+1));
      const studyLogs=fsState.studyLogs.filter(l=>inRange(l.date)).slice().sort((a,b)=>String(a.date||'').localeCompare(String(b.date||'')));
      const studyByDate=new Map();studyLogs.forEach(l=>studyByDate.set(l.date,(studyByDate.get(l.date)||0)+studyLogMinutes(l)));
      const activityEnd=to>today()?today():to;
      for(let d=from;safeDate(d)&&d<=activityEnd;d=dateShift(d,1)){
        add('Daily activity',d,d,'','All subjects','Review count',reviewByDate.get(d)||0,'reviews');
        add('Daily activity',d,d,'','All subjects','Study time',studyByDate.get(d)||0,'minutes');
      }
      const ratingCounts=[1,2,3,4,5].map(rating=>reviewRecords.filter(h=>Number(h.rating)===rating).length);
      add('Summary',from,to,'','Review history','Total reviews',reviewRecords.length,'reviews');
      add('Summary',from,to,'','Review history','Mean recall rating',reviewRecords.length?(reviewRecords.reduce((sum,h)=>sum+fNum(h.rating),0)/reviewRecords.length).toFixed(2):'N/A','out of 5');
      [1,2,3,4,5].forEach((rating,i)=>add('Review distribution',from,to,'',RATING_LABELS[rating],'Saved reviews',ratingCounts[i],'reviews'));
      add('Summary',from,to,'','Study logs','Total study time',studyLogs.reduce((sum,l)=>sum+studyLogMinutes(l),0),'minutes');
      reviewRecords.forEach(h=>add('Review record',h.reviewedAt,'',h.streamName||'',h.topicName||'',RATING_LABELS[Number(h.rating)]||'Rating',h.rating,'out of 5',[h.subjectName,h.note].filter(Boolean).join(' · ')));
      fsState.papers.filter(p=>inRange(p.date)).slice().sort((a,b)=>String(a.date||'').localeCompare(String(b.date||''))).forEach(p=>{
        const subject=state.subjects.find(x=>x.id===p.subjectId)?.name||'Unassigned subject',validScore=p.score!==null&&p.score!==undefined&&Number.isFinite(Number(p.score))&&Number(p.maxScore)>0;
        const pct=validScore?Math.round(Number(p.score)/Number(p.maxScore)*100):'';
        add('Paper / practice record',p.date,'',subject,p.name||'Untitled record','Score',validScore?p.score:'','points',p.notes||p.weakAreas||'');
        add('Paper / practice record',p.date,'',subject,p.name||'Untitled record','Maximum score',validScore?p.maxScore:'','points');
        if(validScore)add('Paper / practice record',p.date,'',subject,p.name||'Untitled record','Percentage',pct,'%');
        if(p.duration!==undefined&&p.duration!==null)add('Paper / practice record',p.date,'',subject,p.name||'Untitled record','Duration',p.duration,'minutes');
        if(p.errorCount!==undefined&&p.errorCount!==null)add('Paper / practice record',p.date,'',subject,p.name||'Untitled record','Errors',p.errorCount,'');
      });
      studyLogs.forEach(l=>{
        const subject=state.subjects.find(x=>x.id===l.subjectId)?.name||l.subjectName||'Unassigned subject',topic=getTopic(l.topicId);
        add('Study session',l.date,'',subject,topic?.name||l.topicName||'Unlinked session','Study time',studyLogMinutes(l),'minutes',[l.type,'Duration: '+formatStudyDuration(studyLogMinutes(l)*60),l.note].filter(Boolean).join(' · '));
      });
      fsState.journal.filter(j=>inRange(j.date)).slice().sort((a,b)=>String(a.date||'').localeCompare(String(b.date||''))).forEach(j=>{
        const subject=state.subjects.find(x=>x.id===j.subjectId)?.name||'General',topic=getTopic(j.topicId);
        add('Mistake journal record',j.date,'',subject,topic?.name||j.category||'Other',j.solved?'Status: resolved':'Status: open',j.severity??'','severity',[j.issue,j.fix].filter(Boolean).join(' · '));
      });
      const csv='\uFEFF'+rows.map(row=>row.map(value=>window.NexusBackupRestoreUtils.csvCell(value)).join(',')).join('\r\n');
      downloadBlob('nexus-analytics-'+from+'-to-'+to+'.csv',csv,'text/csv;charset=utf-8');
      notify('Analytics CSV exported for '+from+' to '+to+'.');
    }catch(error){console.error('Nexus analytics CSV export failed',error);notify('Could not export analytics CSV. Please try again.');}
  }

  const PDF_EXPORT_GRAPH_OPTIONS = [
    ['ratingDistribution','Review difficulty distribution'],
    ['ratingTimeline','Review ratings over time'],
    ['reviewActivity','Review activity over time'],
    ['studyTime','Study time over time'],
    ['subjectTime','Study time by subject'],
    ['paperTrends','Paper score trends']
  ];
  function pdfExportLimits(){
    const native=Boolean(window.NexusAndroidBridge&&window.NexusAndroidBridge.isNativeApp);
    const memory=Number(navigator.deviceMemory)||0;
    if(native)return {maxPages:80,maxChars:1500000,warnPages:30,warnChars:600000,label:'Android app'};
    if(memory>0&&memory<=2)return {maxPages:80,maxChars:1500000,warnPages:30,warnChars:600000,label:'low-memory browser'};
    if(memory>0&&memory<=4)return {maxPages:120,maxChars:2500000,warnPages:40,warnChars:800000,label:'mobile browser'};
    if(memory>=8)return {maxPages:240,maxChars:5000000,warnPages:70,warnChars:1300000,label:'higher-memory browser'};
    return {maxPages:120,maxChars:2500000,warnPages:40,warnChars:800000,label:'browser'};
  }
  function pdfTableConfigMarkup(key,label,defaultLimit){
    return '<div class="nexus-pdf-table-option"><label class="nexus-pdf-check"><input type="checkbox" data-pdf-table="'+key+'" checked><span>'+label+'</span></label><div><select class="field" data-pdf-limit="'+key+'" aria-label="'+label+' record limit"><option value="50">Last 50</option><option value="100" '+(defaultLimit==='100'?'selected':'')+'>Last 100</option><option value="300">Last 300</option><option value="all">All records</option><option value="custom">Custom count</option></select><input class="field nexus-pdf-custom-count" type="number" min="1" max="100000" step="1" value="500" data-pdf-custom="'+key+'" aria-label="'+label+' custom record count" hidden></div><small data-pdf-count="'+key+'">Checking records…</small></div>';
  }
  function pdfScopeOptionsMarkup(){
    const streams=Array.isArray(state.streams)?state.streams:[],subjects=Array.isArray(state.subjects)?state.subjects:[];
    const streamRows=streams.map(stream=>'<label class="nexus-pdf-check nexus-pdf-scope-stream"><input type="checkbox" data-pdf-stream="'+esc(stream.id)+'" checked><span>'+esc(stream.name||'Untitled stream')+'</span></label>').join('');
    const subjectRows=subjects.map(subject=>{
      const stream=streams.find(item=>String(item.id)===String(subject.streamId));
      return '<label class="nexus-pdf-check nexus-pdf-scope-subject" data-pdf-subject-row="'+esc(subject.id)+'" data-pdf-subject-stream="'+esc(subject.streamId||'')+'"><input type="checkbox" data-pdf-subject="'+esc(subject.id)+'" checked><span>'+esc(subject.name||'Untitled subject')+' <small>· '+esc(stream?.name||'Unassigned stream')+'</small></span></label>';
    }).join('');
    return '<fieldset class="nexus-pdf-fieldset"><legend>Streams</legend><p class="nexus-pdf-hint">Choose which streams belong in this report. All are selected by default.</p>'+
      (streamRows||'<p class="nexus-pdf-hint">No streams are configured.</p>')+
      '</fieldset><fieldset class="nexus-pdf-fieldset"><legend>Subjects</legend><p class="nexus-pdf-hint">Choose subjects from the selected streams. Unmatched or unassigned records are excluded when using a restricted scope.</p>'+
      (subjectRows||'<p class="nexus-pdf-hint">No subjects are configured.</p>')+'</fieldset>';
  }
  function pdfExportDialogMarkup(){
    return '<dialog id="nexusPdfExportDialog" class="nexus-pdf-export-dialog" aria-labelledby="nexusPdfExportTitle">'+
      '<div class="nexus-pdf-export-shell"><div class="nexus-pdf-export-head"><div><span class="eyebrow">REPORT CONFIGURATION</span><h2 id="nexusPdfExportTitle">Export analytics PDF</h2><p>Choose one timeframe for the report, then decide which graphs and detailed records to include.</p></div><button type="button" class="btn btn-icon" data-pdf-action="close" aria-label="Close export settings">×</button></div>'+
      '<div class="nexus-pdf-export-body">'+
      '<label class="nexus-pdf-field"><span>Common timeframe</span><select id="nexusPdfTimeframe" class="field"><option value="selected">Current Analytics timeframe</option><option value="all">All time</option><option value="last30">Last 30 days</option><option value="last90">Last 90 days</option><option value="year">This year</option><option value="custom">Custom date range</option></select></label>'+
      '<div class="nexus-pdf-date-range" id="nexusPdfCustomDates" hidden><label class="nexus-pdf-field"><span>From</span><input id="nexusPdfDateFrom" class="field" type="date"></label><label class="nexus-pdf-field"><span>To</span><input id="nexusPdfDateTo" class="field" type="date"></label></div>'+
      pdfScopeOptionsMarkup()+
      '<fieldset class="nexus-pdf-fieldset"><legend>Analytics graphs</legend><p class="nexus-pdf-hint">All graphs are included by default. Deselect only the ones you do not need.</p>'+
      PDF_EXPORT_GRAPH_OPTIONS.map(([key,label])=>'<label class="nexus-pdf-check"><input type="checkbox" data-pdf-graph="'+key+'" checked><span>'+label+'</span></label>').join('')+
      '</fieldset>'+
      '<fieldset class="nexus-pdf-fieldset"><legend>Detailed tables</legend><p class="nexus-pdf-hint">Limits apply to the newest records inside the common timeframe. Summary statistics and graphs still use all matching records.</p>'+
      pdfTableConfigMarkup('reviews','Review history','100')+
      pdfTableConfigMarkup('sessions','Study sessions','100')+
      pdfTableConfigMarkup('papers','Paper / practice records','100')+
      pdfTableConfigMarkup('journal','Mistakes journal','50')+
      '</fieldset>'+
      '<div class="nexus-pdf-estimate" id="nexusPdfEstimate" aria-live="polite"><strong>Estimating report size…</strong></div>'+
      '<label class="nexus-pdf-confirm" id="nexusPdfLargeConfirm" hidden><input id="nexusPdfConfirmLarge" type="checkbox"><span>I understand this report is large and may take longer to prepare and print.</span></label>'+
      '<p class="nexus-pdf-progress" id="nexusPdfBuildStatus" role="status" hidden></p>'+
      '</div><div class="nexus-pdf-export-actions"><button type="button" class="btn btn-soft" data-pdf-action="close">Cancel</button><button type="button" class="btn btn-primary" id="nexusPdfGenerate" data-pdf-action="generate">Generate PDF</button></div></div></dialog>';
  }
  function ensurePdfExportDialog(){
    let dialog=document.getElementById('nexusPdfExportDialog');
    if(dialog)return dialog;
    if(!document.getElementById('nexus-pdf-export-style')){
      const style=document.createElement('style');
      style.id='nexus-pdf-export-style';
      style.textContent='.nexus-pdf-export-dialog{width:min(680px,calc(100vw - 24px));max-height:calc(100dvh - 28px);padding:0;border:1px solid var(--border);border-radius:20px;background:var(--surface);color:var(--text);box-shadow:0 24px 80px #0004}.nexus-pdf-export-shell{display:flex;flex-direction:column;max-height:calc(100dvh - 30px)}.nexus-pdf-export-head{display:flex;justify-content:space-between;gap:14px;padding:20px 20px 12px;border-bottom:1px solid var(--border)}.nexus-pdf-export-head h2{margin:5px 0;font-size:22px}.nexus-pdf-export-head p,.nexus-pdf-hint{margin:4px 0;color:var(--muted);font-size:13px}.nexus-pdf-export-body{padding:15px 20px;overflow:auto;overscroll-behavior:contain}.nexus-pdf-field{display:grid;gap:6px;font-weight:700;font-size:13px}.nexus-pdf-field .field,.nexus-pdf-table-option .field{width:100%;min-width:0}.nexus-pdf-date-range{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:10px}.nexus-pdf-fieldset{border:1px solid var(--border);border-radius:13px;padding:12px;margin:16px 0 0;min-width:0}.nexus-pdf-fieldset legend{font-size:14px;font-weight:800;padding:0 5px}.nexus-pdf-check{display:flex;align-items:center;gap:9px;font-size:13px;font-weight:600;min-width:0}.nexus-pdf-check input,.nexus-pdf-confirm input{width:17px;height:17px;flex:0 0 17px;accent-color:var(--accent)}.nexus-pdf-fieldset>.nexus-pdf-check{padding:6px 0}.nexus-pdf-table-option{display:grid;grid-template-columns:minmax(0,1fr) minmax(130px,180px);gap:4px 12px;align-items:center;padding:9px 0;border-top:1px solid var(--border)}.nexus-pdf-table-option:first-of-type{border-top:0}.nexus-pdf-table-option>div{display:grid;gap:5px}.nexus-pdf-table-option small{grid-column:1/-1;color:var(--muted);font-size:11px}.nexus-pdf-custom-count{max-width:180px}.nexus-pdf-estimate{border:1px solid var(--border);border-radius:13px;padding:13px;margin-top:15px;font-size:13px}.nexus-pdf-estimate strong{display:block;font-size:17px;margin-bottom:5px}.nexus-pdf-estimate p{margin:4px 0;color:var(--muted)}.nexus-pdf-estimate .is-warning{color:#a16207}.nexus-pdf-estimate .is-blocked{color:#b42318}.nexus-pdf-confirm{display:flex;gap:9px;align-items:flex-start;margin-top:12px;font-size:12px}.nexus-pdf-progress{margin:10px 0 0;color:var(--muted);font-size:12px}.nexus-pdf-export-actions{display:flex;justify-content:flex-end;gap:9px;padding:12px 20px 18px;border-top:1px solid var(--border)}.nexus-pdf-export-actions button{min-width:110px}@media(max-width:520px){.nexus-pdf-export-head,.nexus-pdf-export-body{padding-left:14px;padding-right:14px}.nexus-pdf-table-option{grid-template-columns:minmax(0,1fr) minmax(118px,145px);gap:4px 8px}.nexus-pdf-export-actions{padding-left:14px;padding-right:14px}.nexus-pdf-export-actions button{min-width:0;flex:1}}';
      document.head.appendChild(style);
    }
    const holder=document.createElement('div');
    holder.innerHTML=pdfExportDialogMarkup();
    document.body.appendChild(holder.firstElementChild);
    dialog=document.getElementById('nexusPdfExportDialog');
    dialog.addEventListener('change',event=>{if(event.target?.id!=='nexusPdfConfirmLarge')dialog.querySelector('#nexusPdfConfirmLarge').checked=false;updatePdfExportEstimate(dialog);});
    dialog.addEventListener('click',async event=>{
      const action=event.target.closest('[data-pdf-action]')?.dataset.pdfAction;
      if(action==='close'){dialog.close();return;}
      if(action!=='generate')return;
      const model=dialog._pdfExportModel;
      if(!model||model.estimate.blocked){updatePdfExportEstimate(dialog);return;}
      if(model.estimate.large&&!dialog.querySelector('#nexusPdfConfirmLarge')?.checked){
        dialog.querySelector('#nexusPdfLargeConfirm').hidden=false;
        dialog.querySelector('#nexusPdfConfirmLarge').focus();
        return;
      }
      const button=dialog.querySelector('#nexusPdfGenerate');
      button.disabled=true;
      button.textContent='Preparing report…';
      dialog.querySelector('#nexusPdfBuildStatus').hidden=false;
      try{await exportAnalyticsPdf(model.options);}
      catch(error){
        console.error('Nexus PDF export failed.',error);
        notify(error&&error.message?error.message:'Could not prepare the PDF report. Reduce the selected detail or try again.');
        button.disabled=false;button.textContent='Try again';dialog.querySelector('#nexusPdfBuildStatus').hidden=true;
      }
    });
    return dialog;
  }
  function resolvePdfExportSelection(dialog){
    const preset=dialog.querySelector('#nexusPdfTimeframe').value,current=dialog._pdfInitialSelection||getRatingAnalyticsSelection();
    let from=current.from,to=current.to,label=current.label,range=current.range;
    if(preset==='all'){
      let allRange=dialog._pdfAllTimeRange;
      if(!allRange){
        let firstDate='',lastDate='';
        const includeDate=value=>{if(!safeDate(value))return;if(!firstDate||value<firstDate)firstDate=value;if(!lastDate||value>lastDate)lastDate=value;};
        state.history.forEach(x=>includeDate(x.reviewedAt));
        fsState.studyLogs.forEach(x=>includeDate(x.date));
        fsState.papers.forEach(x=>includeDate(x.date));
        fsState.journal.forEach(x=>includeDate(x.date));
        allRange={from:firstDate||dateShift(today(),-29),to:lastDate&&lastDate>today()?lastDate:today()};
        dialog._pdfAllTimeRange=allRange;
      }
      from=allRange.from;to=allRange.to;label='All time';range='custom';
    }else if(preset==='last30'){from=dateShift(today(),-29);to=today();label='Last 30 days';range='custom';}
    else if(preset==='last90'){from=dateShift(today(),-89);to=today();label='Last 90 days';range='custom';}
    else if(preset==='year'){from=today().slice(0,4)+'-01-01';to=today().slice(0,4)+'-12-31';label='This year';range='year';}
    else if(preset==='custom'){from=dialog.querySelector('#nexusPdfDateFrom').value||'';to=dialog.querySelector('#nexusPdfDateTo').value||'';label='Custom date range';range='custom';}
    const valid=safeDate(from)&&safeDate(to)&&from<=to;
    const cache=dialog._pdfRangeSelectionCache||(dialog._pdfRangeSelectionCache=new Map()),key=from+'|'+to;
    let records=[];
    if(valid){
      if(cache.has(key))records=cache.get(key);
      else{records=state.history.filter(h=>safeDate(h.reviewedAt)&&h.reviewedAt>=from&&h.reviewedAt<=to);cache.set(key,records);}
    }
    return {range,from,to,records,label,valid};
  }
  function getPdfExportScope(dialog){
    const streamIds=Array.from(dialog.querySelectorAll('[data-pdf-stream]:checked')).map(input=>String(input.dataset.pdfStream));
    const subjectIds=Array.from(dialog.querySelectorAll('[data-pdf-subject]:checked')).map(input=>String(input.dataset.pdfSubject));
    const allStreams=streamIds.length===(state.streams||[]).length,allSubjects=subjectIds.length===(state.subjects||[]).length;
    return {streamIds,subjectIds,all:allStreams&&allSubjects};
  }
  function pdfRecordMatchesScope(record,scope){
    if(!scope||scope.all)return true;
    const subjectId=String(record?.subjectId||'');
    let subject=subjectId?state.subjects.find(item=>String(item.id)===subjectId):null;
    if(!subject&&record?.topicId){const topic=getTopic(record.topicId);if(topic)subject=state.subjects.find(item=>String(item.id)===String(topic.subjectId))||null;}
    if(!subject&&record?.subjectName){
      const name=String(record.subjectName),streamName=String(record.streamName||'');
      const matches=state.subjects.filter(item=>String(item.name||'')===name&&(!streamName||String(streamFor(item)?.name||'')===streamName));
      if(matches.length===1)subject=matches[0];
    }
    if(!subject)return false;
    return scope.streamIds.includes(String(subject.streamId||''))&&scope.subjectIds.includes(String(subject.id));
  }
  function collectPdfExportOptions(dialog,selection){
    const scope=getPdfExportScope(dialog),scopedSelection={...selection,records:selection.records.filter(record=>pdfRecordMatchesScope(record,scope))};
    const graphs={};
    PDF_EXPORT_GRAPH_OPTIONS.forEach(([key])=>{graphs[key]=Boolean(dialog.querySelector('[data-pdf-graph="'+key+'"]')?.checked);});
    const tables={};
    ['reviews','sessions','papers','journal'].forEach(key=>{tables[key]={include:Boolean(dialog.querySelector('[data-pdf-table="'+key+'"]')?.checked),limit:dialog.querySelector('[data-pdf-limit="'+key+'"]')?.value||'100',custom:Math.max(1,Math.min(100000,Math.floor(Number(dialog.querySelector('[data-pdf-custom="'+key+'"]')?.value)||500)))};});
    return {selection:scopedSelection,graphs,tables,scope};
  }
  function getPdfExportDatasets(selection,scope){
    const inRange=date=>safeDate(date)&&date>=selection.from&&date<=selection.to,sort=(a,b)=>String(b.date||b.reviewedAt||'').localeCompare(String(a.date||a.reviewedAt||''));
    return {
      reviews:selection.records.filter(x=>pdfRecordMatchesScope(x,scope)).slice().sort((a,b)=>String(b.reviewedAt||'').localeCompare(String(a.reviewedAt||''))),
      sessions:fsState.studyLogs.filter(x=>inRange(x.date)&&pdfRecordMatchesScope(x,scope)).slice().sort(sort),
      papers:fsState.papers.filter(x=>inRange(x.date)&&pdfRecordMatchesScope(x,scope)).slice().sort(sort),
      journal:fsState.journal.filter(x=>inRange(x.date)&&pdfRecordMatchesScope(x,scope)).slice().sort(sort)
    };
  }
  function pdfLimitedRecords(records,config){
    if(!config.include)return [];
    const limit=config.limit==='all'?records.length:config.limit==='custom'?config.custom:Math.max(1,Number(config.limit)||100);
    return records.slice(0,limit);
  }
  function pdfRecordText(record,kind){
    if(kind==='reviews')return [record.reviewedAt,record.streamName,record.subjectName,record.topicName,record.rating,record.intervalDays,record.dueDate,record.note].map(x=>String(x??'')).join(' ');
    if(kind==='sessions')return [record.date,record.subjectName,record.topicName,record.type,record.note,record.durationSeconds,record.minutes].map(x=>String(x??'')).join(' ');
    if(kind==='papers')return [record.date,record.name,record.subjectId,record.score,record.maxScore,record.notes,record.weakAreas].map(x=>String(x??'')).join(' ');
    return [record.date,record.category,record.subjectId,record.topicId,record.issue,record.fix,record.solved].map(x=>String(x??'')).join(' ');
  }
  function estimatePdfExport(options,dialog){
    const scopeKey=options.scope?options.scope.streamIds.join(',')+'|'+options.scope.subjectIds.join(','):'all';
    const cacheKey=options.selection.from+'|'+options.selection.to+'|'+scopeKey;
    let datasets,groupCount;
    if(dialog&&dialog._pdfDatasetCache&&dialog._pdfDatasetCache.key===cacheKey){
      datasets=dialog._pdfDatasetCache.datasets;groupCount=dialog._pdfDatasetCache.groupCount;
    }else{
      datasets=getPdfExportDatasets(options.selection,options.scope);
      groupCount=getRatingAnalyticsGroups(datasets.reviews,fsState.analyticsRatingGrouping||'topic').length;
      if(dialog)dialog._pdfDatasetCache={key:cacheKey,datasets,groupCount};
    }
    const selected={
      reviews:pdfLimitedRecords(datasets.reviews,options.tables.reviews),
      sessions:pdfLimitedRecords(datasets.sessions,options.tables.sessions),
      papers:pdfLimitedRecords(datasets.papers,options.tables.papers),
      journal:pdfLimitedRecords(datasets.journal,options.tables.journal)
    };
    let estimatedChars=52000,tablePages=0;
    const density={reviews:29,sessions:32,papers:31,journal:25};
    for(const kind of Object.keys(selected)){
      let rowUnits=0;
      for(const row of selected[kind]){
        const text=pdfRecordText(row,kind);
        rowUnits+=Math.max(1,Math.ceil(text.length/180));
        estimatedChars+=360+Math.ceil(text.length*6);
      }
      if(selected[kind].length)tablePages+=Math.ceil(rowUnits/density[kind]);
    }
    const graphCount=Object.values(options.graphs).filter(Boolean).length;
    const graphPages=graphCount+(options.graphs.ratingTimeline?1:0)+Math.ceil(groupCount/24);
    estimatedChars+=groupCount*400;
    const estimatedPages=Math.ceil((2+graphPages+tablePages)*1.12),limits=pdfExportLimits();
    const blocked=estimatedPages>limits.maxPages||estimatedChars>limits.maxChars;
    const large=!blocked&&(estimatedPages>limits.warnPages||estimatedChars>limits.warnChars);
    return {datasets,selected,estimatedPages,estimatedChars,limits,blocked,large};
  }
  function updatePdfExportEstimate(dialog){
    const preset=dialog.querySelector('#nexusPdfTimeframe').value;
    dialog.querySelector('#nexusPdfCustomDates').hidden=preset!=='custom';
    const selectedStreams=new Set(Array.from(dialog.querySelectorAll('[data-pdf-stream]:checked')).map(input=>String(input.dataset.pdfStream)));
    dialog.querySelectorAll('[data-pdf-subject-row]').forEach(row=>{row.hidden=!selectedStreams.has(String(row.dataset.pdfSubjectStream||''));});
    ['reviews','sessions','papers','journal'].forEach(key=>{
      const limit=dialog.querySelector('[data-pdf-limit="'+key+'"]'),custom=dialog.querySelector('[data-pdf-custom="'+key+'"]'),included=dialog.querySelector('[data-pdf-table="'+key+'"]').checked;
      custom.hidden=limit.value!=='custom';limit.disabled=!included;custom.disabled=!included||limit.value!=='custom';
    });
    const selection=resolvePdfExportSelection(dialog),estimateBox=dialog.querySelector('#nexusPdfEstimate'),button=dialog.querySelector('#nexusPdfGenerate');
    if(!selection.valid){estimateBox.innerHTML='<strong class="is-block">Choose a valid date range</strong><p>The start date must be on or before the end date.</p>';button.disabled=true;dialog._pdfExportModel=null;return;}
    const options=collectPdfExportOptions(dialog,selection),estimate=estimatePdfExport(options,dialog),fmt=n=>Number(n).toLocaleString(),mb=(estimate.estimatedChars/1048576).toFixed(2);
    Object.keys(estimate.datasets).forEach(key=>{
      const label=dialog.querySelector('[data-pdf-count="'+key+'"]'),total=estimate.datasets[key].length,chosen=estimate.selected[key].length;
      label.textContent=options.tables[key].include?('Including '+fmt(chosen)+' of '+fmt(total)+' records'):('Excluded · '+fmt(total)+' available');
    });
    if(estimate.blocked){
      estimateBox.innerHTML='<strong class="is-block">This report exceeds the safe export limit</strong><p>Estimated '+fmt(estimate.estimatedPages)+' pages and '+mb+' MiB of report data. This '+estimate.limits.label+' is limited to about '+fmt(estimate.limits.maxPages)+' pages or '+(estimate.limits.maxChars/1048576).toFixed(1)+' MiB. Reduce table limits, narrow the timeframe, or export complete raw data as CSV / JSON.</p>';
      dialog.querySelector('#nexusPdfLargeConfirm').hidden=true;button.disabled=true;
    }else{
      estimateBox.innerHTML='<strong>Approximately '+fmt(estimate.estimatedPages)+' pages</strong><p>Estimated report data: '+mb+' MiB · '+fmt(selection.records.length)+' reviews, '+fmt(estimate.datasets.sessions.length)+' study sessions, '+fmt(estimate.datasets.papers.length)+' papers and '+fmt(estimate.datasets.journal.length)+' journal entries in this timeframe.</p>'+
        (estimate.large?'<p class="is-warning">Large report: preparation or printing may take longer on this device. Confirm below before continuing.</p>':'<p>Within the estimated safe range for this device.</p>');
      dialog.querySelector('#nexusPdfLargeConfirm').hidden=!estimate.large;
      if(!estimate.large)dialog.querySelector('#nexusPdfConfirmLarge').checked=false;
      button.disabled=false;
    }
    dialog._pdfExportModel={options,estimate};
  }
  function openAnalyticsPdfDialog(){
    const dialog=ensurePdfExportDialog(),selection=getRatingAnalyticsSelection();
    dialog._pdfInitialSelection=selection;
    dialog._pdfRangeSelectionCache=new Map([[selection.from+'|'+selection.to,selection.records]]);
    dialog.querySelectorAll('[data-pdf-stream],[data-pdf-subject]').forEach(input=>{input.checked=true;});
    dialog.querySelectorAll('[data-pdf-subject-row]').forEach(row=>{row.hidden=false;});
    dialog._pdfDatasetCache=null;dialog._pdfAllTimeRange=null;
    dialog.querySelector('#nexusPdfTimeframe').value='selected';
    dialog.querySelector('#nexusPdfDateFrom').value=selection.from;
    dialog.querySelector('#nexusPdfDateTo').value=selection.to;
    dialog.querySelectorAll('[data-pdf-graph]').forEach(input=>{input.checked=true;});
    const defaults={reviews:'100',sessions:'100',papers:'100',journal:'50'};
    Object.keys(defaults).forEach(key=>{
      dialog.querySelector('[data-pdf-table="'+key+'"]').checked=true;
      dialog.querySelector('[data-pdf-limit="'+key+'"]').value=defaults[key];
      dialog.querySelector('[data-pdf-custom="'+key+'"]').value='500';
    });
    dialog.querySelector('#nexusPdfConfirmLarge').checked=false;
    dialog.querySelector('#nexusPdfBuildStatus').hidden=true;
    dialog.querySelector('#nexusPdfGenerate').disabled=false;
    dialog.querySelector('#nexusPdfGenerate').textContent='Generate PDF';
    updatePdfExportEstimate(dialog);
    if(!dialog.open)dialog.showModal();
  }
  function setPdfExportProgress(message,reportWindow,dialog){
    const line=dialog?.querySelector('#nexusPdfBuildStatus');
    if(line){line.hidden=false;line.textContent=message;}
    try{const target=reportWindow?.document?.getElementById('nexusPdfBuildProgress');if(target)target.textContent=message;}catch(_){}
  }
  async function buildPdfTableRows(items,renderRow,emptyRow,label,reportWindow,dialog){
    if(!items.length)return emptyRow;
    let html='';
    for(let index=0;index<items.length;index++){
      html+=renderRow(items[index]);
      if((index+1)%200===0){
        setPdfExportProgress('Preparing '+label+': '+(index+1).toLocaleString()+' of '+items.length.toLocaleString()+' records…',reportWindow,dialog);
        await new Promise(resolve=>setTimeout(resolve,0));
      }
    }
    return html||emptyRow;
  }

  async function exportAnalyticsPdf(options={}){
    const isNative=Boolean(window.NexusAndroidBridge&&window.NexusAndroidBridge.isNativeApp);
    const reportWindow=isNative?null:window.open('','_blank');
    if(!isNative&&!reportWindow){notify('Allow pop-ups for Nexus to open the print-ready report, then try again.');return;}
    const dialog=document.getElementById('nexusPdfExportDialog');
    if(reportWindow){reportWindow.document.open();reportWindow.document.write('<!doctype html><html><head><title>Preparing Nexus PDF</title></head><body style="font:15px Arial;padding:28px;color:#273047"><h2>Preparing your Nexus report…</h2><p id="nexusPdfBuildProgress">Preparing report data…</p></body></html>');reportWindow.document.close();}
    setPdfExportProgress('Preparing report data…',reportWindow,dialog);
    try{
    const logoUrl=new URL('icon-192.png',window.location.href).href;
    const initialSelection=options.selection||getRatingAnalyticsSelection();
    const graphs=options.graphs||Object.fromEntries(PDF_EXPORT_GRAPH_OPTIONS.map(([key])=>[key,true]));
    const tables=options.tables||{reviews:{include:true,limit:'100'},sessions:{include:true,limit:'100'},papers:{include:true,limit:'100'},journal:{include:true,limit:'50'}};
    const scope=options.scope||{streamIds:(state.streams||[]).map(item=>String(item.id)),subjectIds:(state.subjects||[]).map(item=>String(item.id)),all:true};
    const selection={...initialSelection,records:(initialSelection.records||[]).filter(record=>pdfRecordMatchesScope(record,scope))};
    const preflight=estimatePdfExport({selection,graphs,tables,scope});
    if(preflight.blocked)throw new Error('This report now exceeds the safe PDF export limit for this device. Reduce the selected table limits or narrow the timeframe. Complete raw data remains available through JSON / CSV backup exports.');
    const datasets=preflight.datasets,records=datasets.reviews;
    const level=['topic','subject','syllabus'].includes(fsState.analyticsRatingGrouping)?fsState.analyticsRatingGrouping:'topic';
    const entityOptions=getRatingAnalyticsEntityOptions(level),entityId='ALL';
    const timeline=graphs.ratingTimeline?getRatingAnalyticsTimeline(selection,level,entityId):{bins:[],records:[],totals:[0,0,0,0,0]};
    const scopeStreams=(options.scope?.streamIds||[]).map(id=>state.streams.find(item=>String(item.id)===String(id))?.name).filter(Boolean);
    const scopeSubjects=(options.scope?.subjectIds||[]).map(id=>state.subjects.find(item=>String(item.id)===String(id))).filter(item=>item&&options.scope?.streamIds.includes(String(item.streamId||''))).map(item=>item.name).filter(Boolean);
    const scopeText='Streams: '+(options.scope?.all?'All':scopeStreams.join(', ')||'None')+' · Subjects: '+(options.scope?.all?'All':scopeSubjects.join(', ')||'None');
    const rangeText=selection.label+' · '+fmtDate(selection.from)+' – '+fmtDate(selection.to)+' · '+scopeText;
    const timelineSvg=graphs.ratingTimeline?ratingAnalyticsSvgMarkup(selection,level,entityId,timeline):'';
    const timelineTable=graphs.ratingTimeline?ratingAnalyticsTimelineTableMarkup(selection,level,entityId,timeline):'';
    const entityLabel=getRatingAnalyticsEntityLabel(level,entityId,entityOptions);
    const inRange=d=>safeDate(d)&&d>=selection.from&&d<=selection.to;
    const average=records.length?records.reduce((n,h)=>n+fNum(h.rating),0)/records.length:0;
    const successful=records.length?Math.round(records.filter(h=>Number(h.rating)>=3).length/records.length*100):0;
    const studyLogs=datasets.sessions;
    const studyMinutes=studyLogs.reduce((n,l)=>n+studyLogMinutes(l),0);
    const subjectTimeMap=new Map();
    studyLogs.forEach(l=>{const subject=state.subjects.find(s=>s.id===l.subjectId),name=String(subject?.name||l.subjectName||'Unassigned subject');subjectTimeMap.set(name,(subjectTimeMap.get(name)||0)+studyLogMinutes(l));});
    const subjectTime=Array.from(subjectTimeMap.entries()).sort((a,b)=>b[1]-a[1]);
    const subjectTimeChart=graphs.subjectTime?(subjectTime.length?subjectTime.map(x=>'<div class="pdf-time-row"><span>'+esc(x[0])+'</span><div class="pdf-time-track"><i style="width:'+(x[1]/Math.max(1,...subjectTime.map(y=>y[1]))*100)+'%"></i></div><b>'+formatStudyDuration(x[1]*60)+'</b></div>').join(''):'<p class="pdf-empty">No logged focus sessions in this period.</p>'):'';
    const paperList=datasets.papers;
    const scoredPapers=paperList.filter(p=>p.score!==null&&p.score!==undefined&&Number.isFinite(Number(p.score))&&Number(p.maxScore)>0);
    const paperTrendChart=graphs.paperTrends?paperScoreTrendsMarkup(scoredPapers):'';
    const journals=datasets.journal;
    const groups=getRatingAnalyticsGroups(records,level);
    const groupTable=groups.length?groups.map(g=>'<tr><td>'+esc(g.label)+'</td>'+g.counts.map(n=>'<td class="num">'+n+'</td>').join('')+'<td class="num"><b>'+g.total+'</b></td></tr>').join(''):'<tr><td colspan="7">No rating groups in this period.</td></tr>';
    const ratingCounts=[1,2,3,4,5].map(r=>records.filter(h=>Number(h.rating)===r).length),maxRating=Math.max(1,...ratingCounts);
    const ratingDistribution=graphs.ratingDistribution?ratingCounts.map((count,i)=>'<div class="pdf-dist-row"><span class="pdf-dist-label"><b>'+(i+1)+' · '+esc(RATING_LABELS[i+1])+'</b></span><div class="pdf-dist-track"><span data-rating="'+(i+1)+'" style="width:'+(count/maxRating*100)+'%"></span></div><strong>'+count+'</strong></div>').join(''):'';
    const activityMarkupForPdf=(graphs.reviewActivity||graphs.studyTime)?renderActivityAnalytics({...selection,pdfScope:scope,pdfDatasets:datasets}):'';
    const activityGraphsForPdf=String(activityMarkupForPdf||'').match(/<div class="nexus-activity-graph-wrap">[\s\S]*?<\/div>/g)||[];
    const activityChart=graphs.reviewActivity?(activityGraphsForPdf[0]||'<p class="pdf-empty">No saved review activity in this timeframe.</p>'):'';
    const studyTimeChart=graphs.studyTime?(activityGraphsForPdf[1]||'<p class="pdf-empty">No saved study time in this timeframe.</p>'):'';
    const tableRecords={
      reviews:pdfLimitedRecords(records,tables.reviews),
      sessions:pdfLimitedRecords(studyLogs,tables.sessions),
      papers:pdfLimitedRecords(paperList,tables.papers),
      journal:pdfLimitedRecords(journals,tables.journal)
    };
    const tableEmpty=(cols,message)=>'<tr><td colspan="'+cols+'">'+message+'</td></tr>';
    const studyRows=tables.sessions.include?await buildPdfTableRows(tableRecords.sessions,l=>{
      const subject=state.subjects.find(s=>s.id===l.subjectId),topic=getTopic(l.topicId);
      return '<tr><td>'+esc(fmtDate(l.date))+'</td><td>'+esc(subject?.name||l.subjectName||'—')+'</td><td>'+esc(topic?.name||l.topicName||'—')+'</td><td class="num">'+formatStudyDuration(studyLogMinutes(l)*60)+'</td><td>'+esc(l.type||'Focus session')+'</td><td>'+esc(l.note||'')+'</td></tr>';
    },tableEmpty(6,'No logged focus sessions in this period.'),'study sessions',reportWindow,dialog):'';
    const paperRows=tables.papers.include?await buildPdfTableRows(tableRecords.papers,p=>{
      return '<tr><td>'+esc(fmtDate(p.date))+'</td><td>'+esc(p.name||'Untitled paper')+'</td><td>'+esc(state.subjects.find(s=>s.id===p.subjectId)?.name||'—')+'</td><td class="num">'+(p.score===null||p.maxScore===null?'—':esc(p.score)+' / '+esc(p.maxScore))+'</td><td class="num">'+(p.maxScore>0?Math.round(p.score/p.maxScore*100)+'%':'—')+'</td><td>'+esc(p.notes||p.weakAreas||'')+'</td></tr>';
    },tableEmpty(6,'No saved paper results in this period.'),'paper records',reportWindow,dialog):'';
    const journalRows=tables.journal.include?await buildPdfTableRows(tableRecords.journal,j=>{
      return '<tr><td>'+esc(fmtDate(j.date))+'</td><td>'+esc(j.category||'Other')+'</td><td>'+esc(state.subjects.find(s=>s.id===j.subjectId)?.name||'—')+'</td><td>'+esc(getTopic(j.topicId)?.name||'—')+'</td><td>'+esc(j.issue||'')+'</td><td>'+esc(j.fix||'')+'</td><td>'+(j.solved?'Resolved':'Open')+'</td></tr>';
    },tableEmpty(7,'No journal entries in this period.'),'mistakes journal',reportWindow,dialog):'';
    const historyRows=tables.reviews.include?await buildPdfTableRows(tableRecords.reviews,h=>{
      return '<tr><td>'+esc(fmtDate(h.reviewedAt))+'</td><td>'+esc(h.streamName||'—')+'</td><td>'+esc(h.subjectName||'—')+'</td><td>'+esc(h.topicName||'—')+'</td><td><span class="pdf-grade" data-rating="'+Number(h.rating)+'">'+Number(h.rating)+' · '+esc(RATING_LABELS[Number(h.rating)]||'Unknown')+'</span></td><td class="num">'+fNum(h.intervalDays)+'</td><td>'+esc(fmtDate(h.dueDate))+'</td><td class="note-cell">'+esc(h.note||'')+'</td></tr>';
    },tableEmpty(8,'No saved review history in this period.'),'review history',reportWindow,dialog):'';
    setPdfExportProgress('Finalising report layout…',reportWindow,dialog);
    const titleGroup=level==='syllabus'?'Syllabus / stream':level==='subject'?'Subject':'Topic';
    const reportSections=[];
    const addPdfSection=(id,title,body)=>reportSections.push({id,title,body});
    if(graphs.ratingDistribution)addPdfSection('report-rating-distribution','Review Difficulty distribution','<p class="section-note">Each record contributes once to its saved Review Difficulty rating. This graph includes all reviews in the selected timeframe.</p><div class="panel"><div class="legend">'+[1,2,3,4,5].map(r=>'<span><i class="dot" data-rating="'+r+'"></i>'+r+' · '+esc(RATING_LABELS[r])+'</span>').join('')+'</div>'+ratingDistribution+'</div>');
    if(graphs.ratingTimeline)addPdfSection('report-rating-timeline','Review Difficulty Record over time · '+entityLabel,'<p class="section-note">Saved review counts by Review Difficulty rating across the selected timeframe.</p><div class="panel pdf-time-series">'+timelineSvg+'</div>'+timelineTable+'<div class="section-note">Table: exact count for each plotted day, week or month.</div>');
    addPdfSection('report-rating-groups','Review Difficulty counts by '+titleGroup.toLowerCase(),'<p class="section-note">Exact Review Difficulty counts for each topic, subject or syllabus in the selected date range. This summary includes all matching records.</p><div class="table-wrap"><table><thead><tr><th>'+esc(titleGroup)+'</th><th class="num">1 Again</th><th class="num">2 Hard</th><th class="num">3 Good</th><th class="num">4 Very good</th><th class="num">5 Easy</th><th class="num">Total</th></tr></thead><tbody>'+groupTable+'</tbody></table></div>');
    if(graphs.reviewActivity)addPdfSection('report-total-reviews','Total review activity','<p class="section-note">Total saved review count across the selected timeframe, grouped by day or aggregated intervals. All matching records are included.</p><div class="panel pdf-line-panel">'+activityChart+'</div>');
    if(graphs.studyTime)addPdfSection('report-total-study-time','Total study time over time','<p class="section-note">Total logged focus-session minutes across the selected timeframe. All matching sessions are included.</p><div class="panel pdf-line-panel">'+studyTimeChart+'</div>');
    if(graphs.subjectTime)addPdfSection('report-study-by-subject','Study time by subject','<p class="section-note">Subject totals from all saved focus sessions in the selected timeframe.</p><div class="panel">'+subjectTimeChart+'</div>');
    if(graphs.paperTrends)addPdfSection('report-paper-trends','Paper marks and score trends','<p class="section-note">Subject-wise percentage trends for scored papers and practice attempts, using the same 0–100% scale and trend points as Paper analytics.</p><div class="panel pdf-paper-trends">'+(paperTrendChart||'<p class="pdf-empty">No scored papers or practice attempts in this timeframe.</p>')+'</div>');
    const tableDescription=(key,allCount)=>'Newest records first. Showing '+tableRecords[key].length+' of '+allCount+' records that match this timeframe; all summary calculations remain based on the full matching dataset.';
    if(tables.reviews.include)addPdfSection('report-review-records','Detailed Review Difficulty Record ('+tableRecords.reviews.length+' of '+records.length+')','<p class="section-note">'+tableDescription('reviews',records.length)+'</p><div class="table-wrap"><table><thead><tr><th>Date</th><th>Syllabus</th><th>Subject</th><th>Topic</th><th>Review difficulty</th><th class="num">Interval d</th><th>Next due</th><th>Review note</th></tr></thead><tbody>'+historyRows+'</tbody></table></div>');
    if(tables.sessions.include)addPdfSection('report-study-sessions','Logged focus sessions ('+tableRecords.sessions.length+' of '+studyLogs.length+')','<p class="section-note">'+tableDescription('sessions',studyLogs.length)+'</p><div class="table-wrap"><table><thead><tr><th>Date</th><th>Subject</th><th>Topic</th><th class="num">Duration</th><th>Session type</th><th>Note</th></tr></thead><tbody>'+studyRows+'</tbody></table></div>');
    if(tables.papers.include)addPdfSection('report-paper-records','Paper / practice results ('+tableRecords.papers.length+' of '+paperList.length+')','<p class="section-note">'+tableDescription('papers',paperList.length)+'</p><div class="table-wrap"><table><thead><tr><th>Date</th><th>Paper / practice</th><th>Subject</th><th class="num">Score</th><th class="num">Percent</th><th>Notes / weak areas</th></tr></thead><tbody>'+paperRows+'</tbody></table></div>');
    if(tables.journal.include)addPdfSection('report-journal','Mistakes and lesson journal ('+tableRecords.journal.length+' of '+journals.length+')','<p class="section-note">'+tableDescription('journal',journals.length)+'</p><div class="table-wrap"><table><thead><tr><th>Date</th><th>Category</th><th>Subject</th><th>Topic</th><th>Issue</th><th>Correction / fix</th><th>Status</th></tr></thead><tbody>'+journalRows+'</tbody></table></div>');
    const tocHtml=reportSections.map((section,index)=>'<a href="#'+section.id+'">'+(index+1)+'. '+esc(section.title)+'</a>').join('');
    const sectionsHtml=reportSections.map((section,index)=>'<section class="pdf-report-section"><h2 id="'+section.id+'">'+(index+1)+'. '+esc(section.title)+'</h2>'+section.body+'</section>').join('');
    const report='<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Nexus · Study &amp; Review Difficulty Report</title><style>'+
      '@page{size:A4;margin:13mm}:root{--accent:#7769e8}*{box-sizing:border-box}body{font-family:Arial,Helvetica,sans-serif;color:#18212e;font-size:10px;line-height:1.45;margin:0;background:#fff;-webkit-print-color-adjust:exact;print-color-adjust:exact}h1{font-size:27px;letter-spacing:-.7px;line-height:1.1;margin:6px 0 8px;color:#121a2a}h2{font-size:16px;letter-spacing:-.25px;margin:24px 0 5px;padding-bottom:7px;border-bottom:1px solid #dfe5ef;color:#19243b;break-after:avoid}h3{font-size:11px;margin:14px 0 6px}p{margin:5px 0}.cover{padding:24px 24px 20px;border-radius:16px;background:linear-gradient(135deg,#17172d,#292354 62%,#14525a);color:white;margin:0 0 17px}.cover-brand{display:flex;align-items:center;gap:12px;margin:0 0 20px;padding:0 0 15px;border-bottom:1px solid #ffffff32}.cover-logo{display:block;width:48px;height:48px;object-fit:cover;flex:0 0 48px;border-radius:13px;border:1px solid #ffffff33;box-shadow:0 5px 18px #0003}.cover-brand-copy{display:flex;flex-direction:column;gap:3px;min-width:0}.cover-brand-copy strong{font-size:19px;line-height:1;font-weight:900;letter-spacing:3px;color:#fff}.cover-brand-copy span{font-size:7px;line-height:1.4;font-weight:800;letter-spacing:1.5px;color:#a5f3ed}.cover-brand-tag{margin-left:auto;padding:6px 9px;border:1px solid #a5f3ed66;border-radius:999px;color:#a5f3ed;font-size:7px;letter-spacing:1px;font-weight:800;white-space:nowrap}.kicker{font-size:9px;font-weight:800;letter-spacing:2px;color:#8af1e7}.cover h1{color:#fff}.cover p{color:#e6e9fb}.cover-meta{margin-top:18px;padding-top:12px;border-top:1px solid #ffffff35;display:flex;justify-content:space-between;gap:12px;font-size:9px}.report-toc{border:1px solid #dedaf8;border-radius:12px;padding:12px 14px;margin:14px 0 18px;background:#faf9ff;break-inside:avoid}.report-toc h2{font-size:14px;margin:0 0 8px;padding:0;border:0;color:#292553}.report-toc-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:3px 14px}.report-toc a{display:block;padding:4px 0;font-size:9px;line-height:1.35;color:#5147b8;text-decoration:none;overflow-wrap:anywhere}.report-toc a:hover{text-decoration:underline}.report-toc a:focus{outline:2px solid #7769e8;outline-offset:2px}@media(max-width:600px){.report-toc-grid{grid-template-columns:1fr}}.metrics{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin:14px 0}.metric{border:1px solid #e0e5ed;border-radius:9px;padding:11px;background:#f8faff}.metric b{display:block;font-size:20px;color:#28295c;line-height:1.2}.metric span{display:block;color:#68728a;font-size:8px;margin-top:4px}.panel{border:1px solid #e0e5ed;border-radius:12px;padding:12px;margin:12px 0;break-inside:avoid}.muted{color:#657188}.legend{display:flex;flex-wrap:wrap;gap:6px 12px;margin:8px 0 12px}.legend span{display:inline-flex;align-items:center;gap:5px;font-size:8px}.dot{width:8px;height:8px;border-radius:3px;display:inline-block}.pdf-rating,.pdf-dist-track span,.dot{background:#aaa}.pdf-rating[data-rating="1"],.pdf-dist-track span[data-rating="1"],.dot[data-rating="1"],.pdf-grade[data-rating="1"]{background:#ef4444}.pdf-rating[data-rating="2"],.pdf-dist-track span[data-rating="2"],.dot[data-rating="2"],.pdf-grade[data-rating="2"]{background:#f97316}.pdf-rating[data-rating="3"],.pdf-dist-track span[data-rating="3"],.dot[data-rating="3"],.pdf-grade[data-rating="3"]{background:#eab308}.pdf-rating[data-rating="4"],.pdf-dist-track span[data-rating="4"],.dot[data-rating="4"],.pdf-grade[data-rating="4"]{background:#22c55e}.pdf-rating[data-rating="5"],.pdf-dist-track span[data-rating="5"],.dot[data-rating="5"],.pdf-grade[data-rating="5"]{background:#10b981}.pdf-stack-row{display:grid;grid-template-columns:150px 1fr 25px;gap:8px;align-items:center;margin:10px 0}.pdf-stack-label{min-width:0;overflow-wrap:anywhere}.pdf-stack-label strong{display:block;font-size:9px}.pdf-stack-label small{display:block;color:#69738a;font-size:7px}.pdf-stack-track{height:12px;border-radius:7px;background:#edf1f7;display:flex;overflow:hidden}.pdf-rating{height:100%;display:block;min-width:0}.pdf-stack-row>b{font-size:9px;text-align:right}.pdf-dist-row{display:grid;grid-template-columns:100px 1fr 30px;gap:9px;align-items:center;margin:9px 0}.pdf-dist-label{font-size:9px}.pdf-dist-track,.pdf-time-track{height:10px;border-radius:6px;overflow:hidden;background:#edf1f7}.pdf-dist-track span{display:block;height:100%;border-radius:6px}.pdf-dist-row>strong{text-align:right}.pdf-columns{height:145px;display:flex;gap:3px;align-items:stretch;border-bottom:1px solid #d8deea;padding-top:6px}.pdf-col{flex:1;min-width:0;display:flex;flex-direction:column;align-items:center;justify-content:flex-end;gap:3px;font-size:7px;color:#6c778d}.pdf-col-value{font-size:7px;height:9px}.pdf-col-track{height:112px;width:100%;display:flex;align-items:flex-end;justify-content:center}.pdf-col-track i{display:block;width:75%;background:linear-gradient(180deg,#51d9d0,#7169de);border-radius:3px 3px 0 0;min-height:2px}.pdf-time-row{display:grid;grid-template-columns:125px 1fr 48px;gap:8px;align-items:center;margin:8px 0;font-size:9px}.pdf-time-track i{display:block;background:linear-gradient(90deg,#6c63df,#31c7c3);height:100%;border-radius:6px}.pdf-time-row>b{text-align:right}.ra-svg{display:block;width:100%;height:auto;min-height:210px;overflow:visible}.ra-svg-dense{min-width:820px;max-width:none}@media print{.ra-svg-dense{min-width:0;max-width:100%;width:100%}.ra-count-table-wrap{overflow:visible;max-height:none}}.ra-svg-dense .ra-tick{font-size:10px}.ra-svg .ra-gridline{stroke:#dbe2ee;stroke-width:1}.ra-svg .ra-axis{stroke:#7b8495;stroke-width:1.3}.ra-svg .ra-tick{fill:#647084;font-size:12px}.ra-svg .ra-axis-title{fill:#20293a;font-size:13px;font-weight:700}.ra-svg .ra-line{fill:none;stroke-width:3.1;stroke-linecap:round;stroke-linejoin:round}.ra-svg .ra-point{stroke:#fff;stroke-width:1.8}.pdf-time-series{padding:12px}.pdf-line-panel{padding:10px 12px;break-inside:avoid}.pdf-line-chart-wrap{width:100%;overflow:hidden}.pdf-line-svg{display:block;width:100%;height:auto;max-width:100%}.nexus-activity-graph-wrap{width:100%;min-width:0;overflow:hidden;margin-top:0}.nexus-activity-svg{display:block;width:100%;min-width:0!important;max-width:100%;height:auto;overflow:visible}.nexus-activity-grid{stroke:#dbe2ee;stroke-width:1;stroke-dasharray:3 4}.nexus-activity-axis{stroke:#7b8495;stroke-width:1}.nexus-activity-line{fill:none;stroke-width:2.5;stroke-linecap:round;stroke-linejoin:round}.nexus-activity-area{stroke:none;pointer-events:none}.nexus-activity-point{stroke:#fff;stroke-width:1.8}.nexus-activity-tick{fill:#647084;font-size:11px;font-variant-numeric:tabular-nums}.nexus-activity-axis-title{fill:#20293a;font-size:11px;font-weight:650}.nexus-activity-empty-label{fill:#647084;font-size:13px}.pdf-paper-trends{padding:9px}.paper-trend-panel{padding:8px;margin:8px 0;border:1px solid #e0e5ed;border-radius:9px;break-inside:avoid}.paper-trend-head{display:flex;justify-content:space-between;align-items:flex-start;gap:10px;margin-bottom:7px}.paper-trend-head strong{font-size:9px;overflow-wrap:anywhere}.paper-trend-head span{font-size:8px;color:#657188;text-align:right}.paper-trend-chart{width:100%;overflow:visible}.paper-trend-svg{display:block;width:100%!important;min-width:0!important;max-width:100%!important;height:auto}.paper-trend-grid{stroke:#dbe2ee;stroke-width:1}.paper-trend-axis{stroke:#7b8495;stroke-width:1.3}.paper-trend-tick{fill:#647084;font-size:12px}.paper-trend-axis-title{fill:#20293a;font-size:13px;font-weight:700}.paper-trend-line{fill:none;stroke:var(--accent);stroke-width:3.1;stroke-linecap:round;stroke-linejoin:round}.paper-trend-point{fill:var(--accent);stroke:#fff;stroke-width:1.8}@media print{.paper-trend-svg{width:100%!important;min-width:0!important;max-width:100%!important}.pdf-line-panel,.paper-trend-panel{break-inside:avoid}}.ra-count-table-wrap{overflow-x:auto;max-height:none;margin:8px 0 14px}.ra-count-table{width:100%;border-collapse:collapse;font-size:8px}.ra-count-table th,.ra-count-table td{padding:5px 4px;border-bottom:1px solid #e5e9f0}.ra-count-table th{background:#eef1fb;color:#303b57;text-align:left}.ra-table-rating[data-rating="1"]{color:#ef4444}.ra-table-rating[data-rating="2"]{color:#f97316}.ra-table-rating[data-rating="3"]{color:#b78a00}.ra-table-rating[data-rating="4"]{color:#22c55e}.ra-table-rating[data-rating="5"]{color:#10b981}.pdf-empty{color:#66718a;padding:9px 0}.section-note{font-size:8px;color:#66718a;margin:4px 0 10px}.table-wrap{width:100%;break-inside:auto;page-break-inside:auto}.pdf-report-section{break-inside:auto;page-break-inside:auto}table{width:100%;border-collapse:collapse;font-size:8px;table-layout:auto}thead{display:table-header-group}tbody{display:table-row-group}tr{break-inside:avoid;page-break-inside:avoid}th{background:#eef1fb;color:#303b57;text-align:left;font-size:7.5px;text-transform:uppercase;letter-spacing:.3px;padding:6px 5px}td{padding:6px 5px;border-bottom:1px solid #e5e9f0;vertical-align:top;overflow-wrap:anywhere}tbody tr:nth-child(even){background:#fafbfe}.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}.note-cell{white-space:pre-wrap;min-width:80px}.pdf-grade{display:inline-block;border-radius:5px;color:#fff;padding:3px 5px;white-space:nowrap;font-weight:700;font-size:7px}.footer{margin-top:24px;padding-top:8px;border-top:1px solid #e0e5ed;color:#788197;font-size:8px;display:flex;justify-content:space-between;gap:10px}.page-break{break-before:page}.no-break{break-inside:avoid}@media screen{body{max-width:920px;margin:24px auto;padding:0 18px;background:#f6f8fc}.cover{box-shadow:0 14px 35px #25265726}}@media(max-width:600px){.metrics{grid-template-columns:repeat(2,1fr)}.pdf-stack-row{grid-template-columns:110px 1fr 22px}.cover-meta{display:block}.cover-meta span{display:block;margin:3px 0}}'+
      '</style></head><body><header class="cover"><div class="cover-brand"><img class="cover-logo" src="'+esc(logoUrl)+'" alt="Nexus logo"><div class="cover-brand-copy"><strong>NEXUS</strong><span>SPACED REPETITION TRACKER</span></div><span class="cover-brand-tag">LEARNING INTELLIGENCE</span></div><h1>Study &amp; Review Difficulty Report</h1><p>A detailed record of your recall ratings, review schedule, focus sessions and study progress.</p><div class="cover-meta"><span><b>Coverage:</b> '+esc(rangeText)+'</span><span><b>Generated:</b> '+esc(fmtDate(today()))+'</span><span><b>Chart grouping:</b> '+esc(titleGroup)+'</span></div></header>'+
      '<nav class="report-toc" aria-label="Report contents"><h2>Report contents</h2><div class="report-toc-grid">'+tocHtml+'</div></nav>'+
      '<div class="metrics"><div class="metric"><b>'+records.length+'</b><span>Review Difficulty Records</span></div><div class="metric"><b>'+(average?average.toFixed(2):'—')+' / 5</b><span>Mean review difficulty rating</span></div><div class="metric"><b>'+successful+'%</b><span>Ratings 3–5</span></div><div class="metric"><b>'+studyMinutes+'</b><span>Focus minutes logged</span></div></div>'+
      sectionsHtml+
      '<div class="footer"><span>Nexus · Spaced Repetition Tracker</span><span>Private report generated locally in your browser</span></div></body></html>';
    const activeLimits=pdfExportLimits();
    if(report.length>activeLimits.maxChars)throw new Error('The finished report is larger than this device can safely send to its print service. Reduce the table limits or export complete raw data as CSV / JSON.');
    if(isNative){
      let nativeReport=report;
      const escapedLogoUrl=esc(logoUrl);
      try{
        const imageResponse=await fetch(logoUrl);
        if(!imageResponse.ok)throw new Error('The Nexus report logo could not be loaded.');
        const imageBlob=await imageResponse.blob();
        const logoDataUrl=await new Promise((resolve,reject)=>{
          const reader=new FileReader();
          reader.onload=()=>resolve(String(reader.result||''));
          reader.onerror=()=>reject(reader.error||new Error('The Nexus report logo could not be embedded.'));
          reader.readAsDataURL(imageBlob);
        });
        if(!logoDataUrl.startsWith('data:image/'))throw new Error('The Nexus report logo has an unsupported image format.');
        nativeReport=nativeReport.replace('src="'+escapedLogoUrl+'"','src="'+logoDataUrl+'"');
      }catch(error){
        console.warn('Nexus could not embed the report logo for native printing; continuing without it.',error);
        nativeReport=nativeReport.replace('<img class="cover-logo" src="'+escapedLogoUrl+'" alt="Nexus logo">','<span class="cover-logo" aria-hidden="true"></span>');
      }
      if(dialog?.open)dialog.close();
      await window.NexusAndroidBridge.printHtml('Nexus Study and Review Difficulty Report',nativeReport);
      notify('Android print dialog opened. Select Save as PDF to save your report.');
      return;
    }
    reportWindow.document.open();reportWindow.document.write(report);reportWindow.document.close();
    if(dialog?.open)dialog.close();
    setTimeout(function(){try{reportWindow.focus();reportWindow.print();}catch(e){notify('The report opened, but printing was blocked. Use the browser menu to Print / Save as PDF.');}},450);
    }catch(error){
      try{if(reportWindow&&!reportWindow.closed)reportWindow.close();}catch(_){}
      throw error;
    }

  }

  function paperScoreTrendsMarkup(papers){
    // Keep the chart algorithm inside this renderer: the PDF exporter and Paper analytics
    // both invoke it, and it must not rely on helpers from the main app's separate script.
    const chartIdPrefix='nexus-paper-trend-'+Date.now().toString(36)+'-'+Math.random().toString(36).slice(2,8);
    const paperSmoothCurvePath=points=>{
      if(!Array.isArray(points)||!points.length)return '';
      if(points.length===1)return 'M '+points[0].x.toFixed(2)+' '+points[0].y.toFixed(2);
      let d='M '+points[0].x.toFixed(2)+' '+points[0].y.toFixed(2);
      for(let i=0;i<points.length-1;i++){
        const p0=points[i-1]||points[i],p1=points[i],p2=points[i+1],p3=points[i+2]||p2,low=Math.min(p1.y,p2.y),high=Math.max(p1.y,p2.y);
        const c1x=p1.x+(p2.x-p0.x)/6,c1y=Math.min(high,Math.max(low,p1.y+(p2.y-p0.y)/6)),c2x=p2.x-(p3.x-p1.x)/6,c2y=Math.min(high,Math.max(low,p2.y-(p3.y-p1.y)/6));
        d+=' C '+c1x.toFixed(2)+' '+c1y.toFixed(2)+', '+c2x.toFixed(2)+' '+c2y.toFixed(2)+', '+p2.x.toFixed(2)+' '+p2.y.toFixed(2);
      }
      return d;
    };
    const groups=new Map();
    (papers||[]).filter(p=>p&&safeDate(p.date)&&p.score!==null&&p.score!==undefined&&Number.isFinite(Number(p.score))&&Number(p.maxScore)>0).forEach(p=>{const subject=state.subjects.find(s=>s.id===p.subjectId),key=String(p.subjectId||'unassigned');if(!groups.has(key))groups.set(key,{name:subject?subject.name:'Unassigned subject',items:[]});groups.get(key).items.push(p);});
    return Array.from(groups.values()).map((group,groupIndex)=>{
      const items=group.items.slice().sort((a,b)=>a.date.localeCompare(b.date)||String(a.name||'').localeCompare(String(b.name||'')));
      let graphItems=items;
      if(items.length>180){
        const bucketSize=Math.ceil(items.length/90),picked=new Map();picked.set(0,items[0]);picked.set(items.length-1,items[items.length-1]);
        for(let start=0;start<items.length;start+=bucketSize){const end=Math.min(items.length,start+bucketSize);let minIndex=start,maxIndex=start,minValue=Infinity,maxValue=-Infinity;for(let i=start;i<end;i++){const value=Number(items[i].score)/Number(items[i].maxScore)*100;if(value<minValue){minValue=value;minIndex=i;}if(value>maxValue){maxValue=value;maxIndex=i;}}picked.set(minIndex,items[minIndex]);picked.set(maxIndex,items[maxIndex]);}
        graphItems=Array.from(picked.entries()).sort((a,b)=>a[0]-b[0]).map(x=>x[1]);
      }
      const left=46,right=18,height=214,top=18,bottom=42,plotH=height-top-bottom,width=Math.max(720,left+right+graphItems.length*30),plotW=width-left-right,baseline=top+plotH,values=graphItems.map(p=>Math.max(0,Math.min(100,Number(p.score)/Number(p.maxScore)*100))),xAt=i=>left+(graphItems.length>1?i/(graphItems.length-1):.5)*plotW,yAt=value=>top+plotH-(value/100)*plotH,gradientId=chartIdPrefix+'-'+groupIndex;
      const points=values.map((value,i)=>({x:xAt(i),y:yAt(value),value,p:graphItems[i]})),path=paperSmoothCurvePath(points),areaPath=points.length?path+' L '+points[points.length-1].x.toFixed(2)+' '+baseline.toFixed(2)+' L '+points[0].x.toFixed(2)+' '+baseline.toFixed(2)+' Z':'';
      let svg='<svg class="paper-trend-svg" style="width:'+width+'px" viewBox="0 0 '+width+' '+height+'" role="img" aria-label="'+localEsc(group.name)+' paper score percentages over time"><defs><linearGradient id="'+gradientId+'" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="var(--accent)" stop-opacity=".28"/><stop offset="62%" stop-color="var(--accent)" stop-opacity=".10"/><stop offset="100%" stop-color="var(--accent)" stop-opacity="0"/></linearGradient></defs>';
      [0,50,100].forEach(value=>{const yy=yAt(value);svg+='<line class="paper-trend-grid" x1="'+left+'" y1="'+yy.toFixed(2)+'" x2="'+(width-right)+'" y2="'+yy.toFixed(2)+'"/><text class="paper-trend-tick" x="'+(left-8)+'" y="'+(yy+4).toFixed(2)+'" text-anchor="end">'+value+'%</text>';});
      svg+='<line class="paper-trend-axis" x1="'+left+'" y1="'+baseline+'" x2="'+(width-right)+'" y2="'+baseline+'"/>';
      if(points.length>1)svg+='<path class="paper-trend-area" fill="url(#'+gradientId+')" d="'+areaPath+'"/><path class="paper-trend-line" d="'+path+'"/>';
      const labelEvery=Math.max(1,Math.ceil(graphItems.length/Math.min(12,Math.floor(plotW/56)||1)));
      points.forEach((point,i)=>{svg+='<circle class="paper-trend-point" cx="'+point.x.toFixed(2)+'" cy="'+point.y.toFixed(2)+'" r="3.2"><title>'+localEsc(point.p.date)+' · '+localEsc(point.p.name||'Paper')+' · '+point.value.toFixed(1)+'%</title></circle>';if(i%labelEvery===0||i===points.length-1)svg+='<text class="paper-trend-tick" x="'+point.x.toFixed(2)+'" y="'+(height-19)+'" text-anchor="middle">'+localEsc(point.p.date.slice(5))+'</text>';});
      svg+='<text class="paper-trend-axis-title" x="'+(left+plotW/2)+'" y="'+(height-3)+'" text-anchor="middle">Attempt date</text></svg>';
      const first=Math.round(values[0]||0),last=Math.round(values[values.length-1]||0),change=last-first,changeText=items.length>1?' · '+(change>0?'+':'')+change+' pp from first attempt':'',sampleNote=graphItems.length<items.length?' · showing '+graphItems.length+' trend points for '+items.length+' attempts. All records remain below':'';
      return '<div class="paper-trend-panel"><div class="paper-trend-head"><strong>'+localEsc(group.name)+'</strong><span>'+items.length+' scored attempt'+(items.length===1?'':'s')+' · latest '+last+'%'+changeText+sampleNote+'</span></div><div class="paper-trend-chart" tabindex="0" role="region" aria-label="Scrollable '+localEsc(group.name)+' score chart">'+svg+'</div></div>';
    }).join('');
  }
    function renderHomeConsistencySummary(){
    const target=hubEl('homeConsistencySummary');if(!target||!fsState||!state||!hubEl('view-overview')?.classList.contains('active'))return;
    const selection=getRatingAnalyticsSelection(),from=selection.from,to=selection.to,valid=selection.valid!==false,recent=selection.records||[],rangeDays=valid?Math.max(1,dayDiff(from,to)+1):30;
    let activeCount=0,mastered=0,overdue=0,dueSoon=0;const homeToday=today(),homeWeekEnd=dateShift(homeToday,6);for(const topic of state.topics){if(topic.archived)continue;activeCount++;const topicStatus=status(topic),meta=featureMeta(topic);if(topicStatus==='overdue')overdue++;if(safeDate(topic.dueDate)&&topic.dueDate>=homeToday&&topic.dueDate<=homeWeekEnd)dueSoon++;if(topic.reviewCount>=2&&meta.avg>=3.5&&topic.intervalDays>=4&&topicStatus!=='overdue')mastered++;}const masteryPct=activeCount?Math.round(mastered/activeCount*100):0;
    const now=today(),weekStart=dateShift(now,-6),weeklyMinutes=fsState.studyLogs.filter(l=>safeDate(l.date)&&l.date>=weekStart&&l.date<=now).reduce((sum,l)=>sum+studyLogMinutes(l),0),weeklyTarget=Math.max(1,fNum(fsState.settings.dailyMinutes)||90)*7,weeklyPct=Math.min(100,Math.round(weeklyMinutes/weeklyTarget*100));
    const priorStart=valid?dateShift(from,-rangeDays):dateShift(now,-29),prior=state.history.filter(h=>safeDate(h.reviewedAt)&&h.reviewedAt>=priorStart&&h.reviewedAt<from),momentum=prior.length?Math.round((recent.length-prior.length)/prior.length*100):null;
    const heatDays=({7:7,30:30,84:84,180:180,365:365})[Number(fsState.heatmapPeriod)]||84,heat=reviewActivity(heatDays).map(x=>'<div class="hub-heat" data-count="'+Math.min(4,x.count)+'" title="'+localEsc(x.date)+' · '+x.count+' review(s)" aria-label="'+localEsc(x.date)+': '+x.count+' review(s)"></div>').join(''),streak=currentStudyStreak();
    const intelligence='<div class="insight-grid"><div class="insight-metric"><span class="insight-label">Review momentum</span><strong>'+(momentum===null?'New baseline':(momentum>0?'+':'')+momentum+'%')+'</strong><small>'+(momentum===null?'No prior-period data':'vs. previous '+rangeDays+' days')+'</small></div><div class="insight-metric"><span class="insight-label">Mastery coverage</span><strong>'+masteryPct+'%</strong><small>'+mastered+' of '+active.length+' active topics</small><div class="insight-track"><span style="width:'+masteryPct+'%"></span></div></div><div class="insight-metric"><span class="insight-label">Next 7-day load</span><strong>'+dueSoon+'</strong><small>'+overdue+' overdue now</small></div><div class="insight-metric"><span class="insight-label">Weekly study goal</span><strong>'+weeklyPct+'%</strong><small>'+weeklyMinutes+' / '+weeklyTarget+' min logged</small><div class="insight-track"><span style="width:'+weeklyPct+'%"></span></div></div><div class="insight-metric"><span class="insight-label">Current review streak</span><strong>'+streak+' days</strong><small>Consecutive days with at least one saved review</small></div></div>';
    target.innerHTML=intelligence+'<div class="home-heatmap-head"><div><strong>Review activity heatmap</strong><small>Each square represents a day. Darker squares indicate more saved reviews.</small></div><div class="ra-field"><label for="homeHeatmapPeriod">Heatmap period</label><select class="hub-input" id="homeHeatmapPeriod">'+selectOptions([['7','7 days'],['30','30 days'],['84','12 weeks'],['180','6 months'],['365','12 months']],String(heatDays))+'</select></div></div><div class="hub-heatmap analytics-heatmap home-activity-heatmap">'+heat+'</div>';
  }
  window.NexusRefreshHomeConsistencySummary=renderHomeConsistencySummary;
  function renderActivityAnalytics(selection){
    const pdfScope=selection?.pdfScope||null;
     const studyLogMinutes=record=>{const seconds=record&&record.durationSeconds;if(seconds!==undefined&&seconds!==null&&Number.isFinite(Number(seconds)))return Math.max(0,Number(seconds))/60;return Math.max(0,Number(record&&record.minutes)||0);};
     const formatStudyDuration=seconds=>{const total=Math.max(0,Math.round(Number(seconds)||0)),minutes=Math.floor(total/60),remainder=total%60;return minutes?`${minutes} min${remainder?' '+remainder+' sec':''}`:`${remainder} sec`;};
    // This renderer owns every date, aggregation, and SVG helper it needs.
    // It must not depend on private helpers from the main application's separate IIFE.
    const escapeActivityHtml=value=>String(value??'').replace(/[&<>]/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[ch])).replaceAll('"','&quot;').replaceAll(String.fromCharCode(39),'&#39;');
    const activityDate=value=>{
      const date=String(value??'').slice(0,10);
      if(!/^\d{4}-\d{2}-\d{2}$/.test(date))return '';
      const parts=date.split('-').map(Number),check=new Date(Date.UTC(parts[0],parts[1]-1,parts[2]));
      return check.getUTCFullYear()===parts[0]&&check.getUTCMonth()===parts[1]-1&&check.getUTCDate()===parts[2]?date:'';
    };
    const activityToday=()=>{
      const d=new Date();
      return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
    };
    const activityShift=(date,days)=>{
      const d=new Date(date+'T12:00:00Z');
      d.setUTCDate(d.getUTCDate()+days);
      return d.getUTCFullYear()+'-'+String(d.getUTCMonth()+1).padStart(2,'0')+'-'+String(d.getUTCDate()).padStart(2,'0');
    };
    const activityDayDiff=(from,to)=>Math.round((Date.parse(to+'T12:00:00Z')-Date.parse(from+'T12:00:00Z'))/86400000);
    const from=activityDate(selection&&selection.from),selectedTo=activityDate(selection&&selection.to),todayDate=activityToday();
    const valid=!!(selection&&selection.valid!==false&&from&&selectedTo&&from<=selectedTo);
    const to=valid&&selectedTo>todayDate?todayDate:selectedTo;
    const rangeValid=valid&&from<=to;
    if(!rangeValid)return '<div class="hub-empty">Choose a valid timeframe to view saved activity.</div>';

    const history=Array.isArray(selection?.pdfDatasets?.reviews)?selection.pdfDatasets.reviews:(Array.isArray(state&&state.history)?state.history:[]);
    const studyLogs=Array.isArray(selection?.pdfDatasets?.sessions)?selection.pdfDatasets.sessions:(Array.isArray(fsState&&fsState.studyLogs)?fsState.studyLogs:[]);
    const subjects=Array.isArray(state&&state.subjects)?state.subjects:[];
    const subjectNameById=new Map(subjects.map(subject=>[String(subject.id),String(subject.name||'Unnamed subject')]));
    const reviewsByDate=new Map(),minutesByDate=new Map(),reviewsBySubject=new Map(),minutesBySubject=new Map();
    const activeDates=new Set();
    const subjectLabel=record=>{
      const id=String(record&&record.subjectId||'');
      return subjectNameById.get(id)||String(record&&record.subjectName||'Unassigned subject');
    };
    let reviewCount=0,positiveSessionCount=0,totalMinutes=0;
    // Stream through source records once. Building filtered wrapper arrays here used
    // several additional full-size allocations for a 77k-record workspace.
    for(const record of history){
      const date=activityDate(record&&record.reviewedAt);
      if(!record||!date||date<from||date>to||(pdfScope&&!pdfRecordMatchesScope(record,pdfScope)))continue;
      reviewCount++;
      reviewsByDate.set(date,(reviewsByDate.get(date)||0)+1);
      const name=subjectLabel(record);
      reviewsBySubject.set(name,(reviewsBySubject.get(name)||0)+1);
      activeDates.add(date);
    }
    for(const record of studyLogs){
      const date=activityDate(record&&record.date);
      if(!record||!date||date<from||date>to||(pdfScope&&!pdfRecordMatchesScope(record,pdfScope)))continue;
      const minutes=studyLogMinutes(record);
      if(minutes>0)positiveSessionCount++;
      minutesByDate.set(date,(minutesByDate.get(date)||0)+minutes);
      const name=subjectLabel(record);
      minutesBySubject.set(name,(minutesBySubject.get(name)||0)+minutes);
      totalMinutes+=minutes;
      if(minutes>0)activeDates.add(date);
    }

    const span=activityDayDiff(from,to)+1,longRange=span>35;
    const buildActivitySeries=(start,end,values)=>{
      const days=activityDayDiff(start,end)+1;
      if(days<1)return [];
      const step=days>35?Math.max(1,Math.ceil(days/52)):1,result=[];
      for(let offset=0;offset<days;offset+=step){
        const lastOffset=Math.min(days-1,offset+step-1),bucketStart=activityShift(start,offset),bucketEnd=activityShift(start,lastOffset);
        let count=0;
        for(let d=offset;d<=lastOffset;d++)count+=Math.max(0,Number(values.get(activityShift(start,d))||0));
        const label=step===1?(days<=14?bucketStart.slice(8):bucketStart.slice(5)):bucketStart.slice(5);
        result.push({date:bucketStart,endDate:bucketEnd,count,label});
      }
      return result;
    };
    const renderActivityChart=(series,title,unit,color,gradientId,hasData)=>{
      const width=720,height=250,left=48,right=18,top=20,bottom=43,plotWidth=width-left-right,plotHeight=height-top-bottom,baseline=top+plotHeight;
      const values=series.map(item=>Math.max(0,Number(item.count)||0)),rawMax=Math.max(1,...values),tickStep=rawMax<=4?1:Math.ceil(rawMax/4),maxValue=Math.max(1,Math.ceil(rawMax/tickStep)*tickStep);
      const xAt=i=>left+(values.length>1?i/(values.length-1):.5)*plotWidth;
      const yAt=value=>top+plotHeight-(value/maxValue)*plotHeight;
      const points=values.map((value,i)=>({x:xAt(i),y:yAt(value),value,item:series[i]}));
      const smoothPath=()=>{
        if(!points.length)return '';
        if(points.length===1)return 'M '+points[0].x.toFixed(2)+' '+points[0].y.toFixed(2);
        let path='M '+points[0].x.toFixed(2)+' '+points[0].y.toFixed(2);
        for(let i=0;i<points.length-1;i++){
          const p0=points[i-1]||points[i],p1=points[i],p2=points[i+1],p3=points[i+2]||p2;
          const low=Math.min(p1.y,p2.y),high=Math.max(p1.y,p2.y);
          const c1x=p1.x+(p2.x-p0.x)/6,c1y=Math.min(high,Math.max(low,p1.y+(p2.y-p0.y)/6));
          const c2x=p2.x-(p3.x-p1.x)/6,c2y=Math.min(high,Math.max(low,p2.y-(p3.y-p1.y)/6));
          path+=' C '+c1x.toFixed(2)+' '+c1y.toFixed(2)+', '+c2x.toFixed(2)+' '+c2y.toFixed(2)+', '+p2.x.toFixed(2)+' '+p2.y.toFixed(2);
        }
        return path;
      };
      const linePath=smoothPath(),areaPath=points.length?linePath+' L '+points[points.length-1].x.toFixed(2)+' '+baseline.toFixed(2)+' L '+points[0].x.toFixed(2)+' '+baseline.toFixed(2)+' Z':'';
      let svg='<svg class="nexus-activity-svg" viewBox="0 0 '+width+' '+height+'" role="img" aria-label="'+escapeActivityHtml(title)+'">';
      svg+='<defs><linearGradient id="'+gradientId+'" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="'+color+'" stop-opacity=".28"/><stop offset="68%" stop-color="'+color+'" stop-opacity=".08"/><stop offset="100%" stop-color="'+color+'" stop-opacity="0"/></linearGradient></defs>';
      [...new Set([0,Math.round(maxValue/2),maxValue])].forEach(value=>{
        const y=yAt(value);
        svg+='<line class="nexus-activity-grid" x1="'+left+'" y1="'+y.toFixed(2)+'" x2="'+(width-right)+'" y2="'+y.toFixed(2)+'"/><text class="nexus-activity-tick" x="'+(left-9)+'" y="'+(y+4).toFixed(2)+'" text-anchor="end">'+value+'</text>';
      });
      svg+='<line class="nexus-activity-axis" x1="'+left+'" y1="'+baseline.toFixed(2)+'" x2="'+(width-right)+'" y2="'+baseline.toFixed(2)+'"/>';
      if(hasData&&points.length){
        if(points.length>1)svg+='<path class="nexus-activity-area" fill="url(#'+gradientId+')" d="'+areaPath+'"/>';
        svg+='<path class="nexus-activity-line" stroke="'+color+'" d="'+linePath+'"/>';
        const every=Math.max(1,Math.ceil(points.length/8));
        points.forEach((point,i)=>{
          const item=point.item||{},startDate=item.date||'',endDate=item.endDate||'',dateLabel=endDate&&endDate!==startDate?startDate+' – '+endDate:startDate;
          const noun=unit==='Reviews'?(point.value===1?'review':'reviews'):'minutes';
          svg+='<circle class="nexus-activity-point" cx="'+point.x.toFixed(2)+'" cy="'+point.y.toFixed(2)+'" r="3.2" fill="'+color+'"><title>'+escapeActivityHtml(dateLabel)+' · '+(unit==='Reviews'?point.value+' '+noun:formatStudyDuration(point.value*60))+'</title></circle>';
          if(i%every===0||i===points.length-1)svg+='<text class="nexus-activity-tick" x="'+point.x.toFixed(2)+'" y="'+(height-20)+'" text-anchor="middle">'+escapeActivityHtml(item.label||'')+'</text>';
        });
      }else{
        svg+='<text class="nexus-activity-empty-label" x="'+(left+plotWidth/2)+'" y="'+(top+plotHeight/2)+'" text-anchor="middle">No saved '+unit.toLowerCase()+' in this timeframe</text>';
      }
      svg+='<text class="nexus-activity-axis-title" x="'+(left+plotWidth/2)+'" y="'+(height-3)+'" text-anchor="middle">Date</text><text class="nexus-activity-axis-title" transform="translate(13 '+(top+plotHeight/2)+') rotate(-90)" text-anchor="middle">'+escapeActivityHtml(unit)+'</text></svg>';
      return '<div class="nexus-activity-graph-wrap">'+svg+'</div>';
    };
    const reviewSeries=buildActivitySeries(from,to,reviewsByDate),studySeries=buildActivitySeries(from,to,minutesByDate);
    const reviewTitle=longRange?'Total review count':'Daily review count',studyTitle=longRange?'Total study time':'Daily study time';
    const rangeDescription=longRange?'Aggregated totals across the selected timeframe.':'Daily totals across the selected timeframe.';
    const reviewGraph=renderActivityChart(reviewSeries,reviewTitle,'Reviews','#8978f8','nexusActivityReviewsGradient',reviewCount>0);
    const studyGraph=renderActivityChart(studySeries,studyTitle,'Minutes','#32bfc0','nexusActivityStudyGradient',positiveSessionCount>0);
    const sessionCount=positiveSessionCount;
    const kpis='<div class="hub-kpis"><div class="hub-kpi"><strong>'+reviewCount+'</strong><span>Reviews in range</span></div><div class="hub-kpi"><strong>'+formatStudyDuration(totalMinutes*60)+'</strong><span>Logged study time</span></div><div class="hub-kpi"><strong>'+sessionCount+'</strong><span>Study sessions logged</span></div><div class="hub-kpi"><strong>'+activeDates.size+'</strong><span>Days with activity</span></div></div>';
    const charts='<div class="hub-grid analytics-chart-grid">'+
      hubCard(reviewTitle,rangeDescription,reviewGraph,true)+
      hubCard(studyTitle,rangeDescription+' Only completed focus sessions with saved minutes contribute to the graph.',studyGraph,true)+
      '</div>';
    const reviewSubjectRows=[...reviewsBySubject.entries()].sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0]));
    const maxReviews=Math.max(1,...reviewSubjectRows.map(item=>item[1]));
    const reviewSubjectMarkup=reviewSubjectRows.length?reviewSubjectRows.map(([name,count])=>'<div class="nexus-activity-subject"><div class="hub-inline" style="justify-content:space-between"><strong>'+escapeActivityHtml(name)+'</strong><span>'+count+' review'+(count===1?'':'s')+'</span></div><div class="progress-track"><span style="width:'+Math.round(count/maxReviews*100)+'%"></span></div></div>').join(''):'<div class="hub-empty">No saved reviews in this timeframe.</div>';
    const studySubjectRows=[...minutesBySubject.entries()].filter(item=>item[1]>0).sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0]));
    const studySubjectMarkup=studySubjectRows.length?studySubjectRows.map(([name,minutes])=>'<div class="hub-row"><div class="hub-row-main"><div class="hub-row-title">'+escapeActivityHtml(name)+'</div><div class="hub-row-meta">Saved focus-session time</div></div><strong>'+formatStudyDuration(minutes*60)+'</strong></div>').join(''):'<div class="hub-empty">No saved focus-session time in this timeframe.</div>';
    return kpis+charts+'<div class="hub-grid analytics-card-grid">'+
      hubCard('Review activity by subject','Saved review counts in the selected timeframe.','<div class="nexus-activity-subjects">'+reviewSubjectMarkup+'</div>')+
      hubCard('Study time by subject','Minutes from saved focus sessions in the same timeframe.','<div class="hub-scroll-list analytics-log-scroll" role="region" aria-label="Study time by subject" tabindex="0">'+studySubjectMarkup+'</div>')+
      '</div>';
  }

  let analyticsSection='presses';
  function renderAnalytics(){
    const selection=getRatingAnalyticsSelection(),from=selection.from,to=selection.to,valid=selection.valid!==false,recent=selection.records||[],rangeDays=valid?Math.max(1,dayDiff(from,to)+1):30;
    const keys=['presses','papers','activity'];if(!keys.includes(analyticsSection))analyticsSection='presses';
    const icons={
      presses:'<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M2.5 15.5 6.4 10l3.2 2.5 5.9-7 2 1.7M2.5 18V3" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>',
      papers:'<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 2.5h8l4 4V17.5H4zM12 2.5v4h4M7 10h6M7 13h6" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
      activity:'<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M2 10h3l2-5 3.3 10 2.2-6H18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>',

    };
    const tabSpecs=[['presses','Review difficulty'],['papers','Paper analytics'],['activity','Activity analytics']];
    const nav='<nav class="hub-nav analytics-nav" aria-label="Analytics sections">'+tabSpecs.map(([key,label])=>'<button type="button" class="hub-tab analytics-tab '+(analyticsSection===key?'active':'')+'" data-hub-action="analytics-section" data-analytics-section="'+key+'" aria-pressed="'+(analyticsSection===key)+'">'+icons[key]+'<span>'+label+'</span></button>').join('')+'</nav>';

    if(analyticsSection==='activity'){
      const customRange=selection.range==='custom';
      const activityCustomDates='<div class="ra-custom-dates" id="hubRatingCustomDates" '+(customRange?'':'hidden')+'><div class="ra-field"><label for="hubRatingCustomStart">From date</label><input class="hub-input" type="date" id="hubRatingCustomStart" value="'+localEsc(selection.from)+'"></div><div class="ra-field"><label for="hubRatingCustomEnd">To date</label><input class="hub-input" type="date" id="hubRatingCustomEnd" value="'+localEsc(selection.to)+'"></div><button class="btn btn-primary" type="button" data-hub-action="analytics-custom-apply">Apply custom range</button></div>';
      const activityFilter='<div class="analytics-global-filter ra-controls single-filter"><div class="ra-field"><label for="hubRatingPeriod">Timeframe</label><select class="hub-input" id="hubRatingPeriod">'+selectOptions([['week','This week'],['month','This month'],['year','This year'],['custom','Choose date range']],selection.range)+'</select></div></div>'+activityCustomDates;
      const activityHero='<div class="analytics-hero"><div><span class="analytics-eyebrow">LEARNING INTELLIGENCE</span><h3>Your progress, decoded.</h3><p>Review history and saved study sessions for the selected timeframe.</p></div><div class="hub-actions"><button class="btn btn-primary" data-hub-action="analytics-export-pdf"><svg class="nexus-action-icon" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M8 15h8M8 18h5"/></svg> Export detailed PDF</button><button class="btn btn-soft" data-hub-action="analytics-export">Export CSV</button></div></div>';
      return activityHero+nav+activityFilter+'<div class="analytics-section-content" data-analytics-section="activity">'+renderActivityAnalytics(selection)+'</div>';
    }
    const ratingLevel=['topic','subject','syllabus'].includes(fsState.analyticsRatingGrouping)?fsState.analyticsRatingGrouping:'topic',ratingOptions=analyticsSection==='presses'?getRatingAnalyticsEntityOptions(ratingLevel):[],ratingEntityId=analyticsSection==='presses'?getRatingAnalyticsEntityId(ratingLevel,ratingOptions):'',ratingEntityChoices=ratingOptions.length?selectOptions(ratingOptions.map(x=>[x.value,x.label+' — '+x.subtitle]),ratingEntityId):'<option value="">No '+esc(ratingLevel)+' records available</option>',groupingLabel=ratingLevel==='syllabus'?'syllabus / stream':ratingLevel;
    const reviewScopeFields=analyticsSection==='presses'?'<div class="ra-field"><label for="hubRatingGrouping">Analyse by</label><select class="hub-input" id="hubRatingGrouping">'+selectOptions([['topic','Individual topic'],['subject','Subject'],['syllabus','Syllabus / stream']],ratingLevel)+'</select></div><div class="ra-field"><label for="hubRatingEntity">Choose '+esc(groupingLabel)+'</label><select class="hub-input" id="hubRatingEntity">'+ratingEntityChoices+'</select></div>':'';
    const customRange=selection.range==='custom',customDates='<div class="ra-custom-dates" id="hubRatingCustomDates" '+(customRange?'':'hidden')+'><div class="ra-field"><label for="hubRatingCustomStart">From date</label><input class="hub-input" type="date" id="hubRatingCustomStart" value="'+localEsc(selection.from)+'"></div><div class="ra-field"><label for="hubRatingCustomEnd">To date</label><input class="hub-input" type="date" id="hubRatingCustomEnd" value="'+localEsc(selection.to)+'"></div><button class="btn btn-primary" type="button" data-hub-action="analytics-custom-apply">Apply custom range</button></div>';
    const sharedTimeframeFilter='<div class="analytics-global-filter ra-controls '+(analyticsSection==='presses'?'':'single-filter')+'">'+reviewScopeFields+'<div class="ra-field"><label for="hubRatingPeriod">Timeframe</label><select class="hub-input" id="hubRatingPeriod">'+selectOptions([['week','This week'],['month','This month'],['year','This year'],['custom','Choose date range']],selection.range)+'</select></div></div>'+customDates;
    const hero='<div class="analytics-hero"><div><span class="analytics-eyebrow">LEARNING INTELLIGENCE</span><h3>Your progress, decoded.</h3><p>Choose a section to explore review difficulty ratings, paper scores, and study activity for your selected timeframe.</p></div><div class="hub-actions"><button class="btn btn-primary" data-hub-action="analytics-export-pdf"><svg class="nexus-action-icon" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M8 15h8M8 18h5"/></svg> Export detailed PDF</button><button class="btn btn-soft" data-hub-action="analytics-export">Export CSV</button></div></div>';
    let content='';
    if(analyticsSection==='presses'){
      const avg=recent.length?recent.reduce((sum,h)=>sum+fNum(h.rating),0)/recent.length:0,good=recent.length?Math.round(recent.filter(h=>Number(h.rating)>=3).length/recent.length*100):0;
      const kpis='<div class="hub-kpis"><div class="hub-kpi"><strong>'+recent.length+'</strong><span>Reviews in range</span></div><div class="hub-kpi"><strong>'+(avg?avg.toFixed(2)+'/5':'—')+'</strong><span>Mean recall rating</span></div><div class="hub-kpi"><strong>'+good+'%</strong><span>Ratings 3–5</span></div><div class="hub-kpi"><strong>'+currentStudyStreak()+'d</strong><span>Current review streak</span></div></div>';
      const level=['topic','subject','syllabus'].includes(fsState.analyticsRatingGrouping)?fsState.analyticsRatingGrouping:'topic';
      content=hubCard('Review difficulty trends','Compare review difficulty ratings over time. Toggle Again, Hard, Good, Very good, or Easy to isolate the difficulties you want.',ratingAnalyticsChartMarkup(selection,level,ratingEntityId,ratingOptions),true)+hubCard('Selected period summary','These totals use the timeframe chosen in Review difficulty trends.',kpis,true);
    }else if(analyticsSection==='papers'){
      const practices=fsState.papers.filter(p=>safeDate(p.date)&&valid&&p.date>=from&&p.date<=to).slice().sort((a,b)=>String(b.date||'').localeCompare(String(a.date||'')));
      const scored=practices.filter(p=>p.score!==null&&p.score!==undefined&&Number.isFinite(Number(p.score))&&Number(p.maxScore)>0),avgScore=scored.length?Math.round(scored.reduce((sum,p)=>sum+Number(p.score)/Number(p.maxScore)*100,0)/scored.length):0,errors=practices.reduce((sum,p)=>sum+Math.max(0,fNum(p.errorCount)),0);
      const kpis='<div class="hub-kpis"><div class="hub-kpi"><strong>'+practices.length+'</strong><span>Practice attempts</span></div><div class="hub-kpi"><strong>'+scored.length+'</strong><span>Scored attempts</span></div><div class="hub-kpi"><strong>'+avgScore+'%</strong><span>Mean score</span></div><div class="hub-kpi"><strong>'+errors+'</strong><span>Errors recorded</span></div></div>';
      const chart=paperScoreTrendsMarkup(scored);
      const rows=practices.map(p=>{
        const subject=state.subjects.find(s=>s.id===p.subjectId)?.name||'Unassigned subject',validScore=p.score!==null&&p.score!==undefined&&Number.isFinite(Number(p.score))&&Number(p.maxScore)>0,pct=validScore?Math.round(Number(p.score)/Number(p.maxScore)*100):null;
        const meta=[fmtDate(p.date),subject,p.kind||'Practice',validScore?(p.score+' / '+p.maxScore+' · '+pct+'%'):'Score not recorded',fNum(p.duration)>0?fNum(p.duration)+' min':'',fNum(p.errorCount)>0?fNum(p.errorCount)+' error(s)':''].filter(Boolean).map(localEsc).join(' · ');
        const details=[p.weakAreas?'<div><strong>Weak areas:</strong> '+localEsc(p.weakAreas)+'</div>':'',p.notes?'<div><strong>Notes:</strong> '+localEsc(p.notes)+'</div>':''].join('');
        return '<article class="hub-row analytics-log-row"><div class="hub-row-main"><div class="hub-row-title">'+localEsc(p.name||'Untitled practice')+'</div><div class="hub-row-meta">'+meta+'</div>'+(details?'<details class="analytics-log-details"><summary>View notes and weak areas</summary><div>'+details+'</div></details>':'')+'</div></article>';
      }).join('');
      content=hubCard('Paper score trends','Each subject has its own smooth percentage trend with a soft gradient beneath the curve. The scale is always 0–100%.',chart||'<div class="hub-empty">Add scored papers or practice records in this date range to see your trends.</div>',true)+hubCard('Paper performance summary','Only recorded scores are used for the average. Unscored practice logs are still shown in the records below.',kpis,true)+hubCard('Practice & paper records','Scroll through saved papers and practice attempts. All entries remain in your records and full backups.','<div class="hub-scroll-list analytics-log-scroll" role="region" aria-label="Practice and paper log" tabindex="0">'+(rows||'<div class="hub-empty">No practice or paper records in this timeframe.</div>')+'</div>',true);
    }
    return hero+nav+sharedTimeframeFilter+'<div class="analytics-section-content" data-analytics-section="'+analyticsSection+'">'+content+'</div>';
  }
  
  let analyticsReturnParent=null,analyticsReturnNext=null;
  const analyticsDefaultParent=hubEl('hubContent')?.parentElement||null,analyticsDefaultNext=hubEl('hubContent')?.nextSibling||null;
  function ensureAnalyticsEntityForRange(level){
    const options=getRatingAnalyticsEntityOptions(level),prior=String(fsState.analyticsRatingEntity||''),selected=options.find(option=>option.value===prior);
    const range=getRatingAnalyticsSelection();
    if(selected&&getRatingAnalyticsScopedRecords(range.records,level,selected.value).length)return selected.value;
    // A previously selected topic may be inactive during this month while other topics
    // still have ratings. Use the aggregate view rather than leaving Analytics blank.
    const all=options.find(option=>option.value==='ALL');
    const best=options.map(option=>({option,count:getRatingAnalyticsScopedRecords(range.records,level,option.value).length}))
      .filter(item=>item.count>0).sort((a,b)=>b.count-a.count||a.option.label.localeCompare(b.option.label))[0]?.option;
    const next=all?.value||best?.value||options[0]?.value||'';
    if(next!==prior){fsState.analyticsRatingEntity=next;saveFs();}
    return next;
  }
  function openAnalyticsWindow(){
    const panel=hubEl('hubContent'),target=hubEl('analyticsScreenContent'),standalone=hubEl('analyticsStandalone');
    if(!panel||!target||!standalone){notify('Analytics could not open. Reload the app and try again.');return;}
    if(document.body.classList.contains('analytics-mode')&&!standalone.hidden){
      if(panel.parentElement!==target)target.appendChild(panel);
      standalone.hidden=false;return;
    }
    document.body.classList.remove('analytics-mode');standalone.hidden=true;
    if(panel.parentElement===target&&analyticsDefaultParent)analyticsDefaultParent.insertBefore(panel,analyticsDefaultNext&&analyticsDefaultNext.parentElement===analyticsDefaultParent?analyticsDefaultNext:null);
    const parent=panel.parentElement||analyticsDefaultParent,next=panel.nextSibling;
    try{
      const level=['topic','subject','syllabus'].includes(fsState.analyticsRatingGrouping)?fsState.analyticsRatingGrouping:'topic';
      ensureAnalyticsEntityForRange(level);hubTab='analytics';renderHub();
      analyticsReturnParent=parent;analyticsReturnNext=next;
      target.appendChild(panel);standalone.hidden=false;document.body.classList.add('analytics-mode');
      window.scrollTo({top:0,behavior:'auto'});
    }catch(error){
      document.body.classList.remove('analytics-mode');standalone.hidden=true;
      if(parent&&panel.parentElement===target)parent.insertBefore(panel,next&&next.parentElement===parent?next:null);
      analyticsReturnParent=null;analyticsReturnNext=null;hubTab='planner';
      console.error('Nexus Analytics failed to open',error);
      notify('Analytics could not open. Please try again. Reload the app if the problem continues.');
    }
  }
  function closeAnalyticsWindow(){
    const panel=hubEl('hubContent'),standalone=hubEl('analyticsStandalone');
    document.body.classList.remove('analytics-mode');
    const parent=analyticsReturnParent&&analyticsReturnParent.isConnected?analyticsReturnParent:analyticsDefaultParent;
    const next=analyticsReturnParent&&analyticsReturnParent.isConnected?analyticsReturnNext:analyticsDefaultNext;
    if(panel&&parent)parent.insertBefore(panel,next&&next.parentElement===parent?next:null);
    if(standalone)standalone.hidden=true;
    analyticsReturnParent=null;analyticsReturnNext=null;hubTab='planner';
    try{renderHub();}catch(error){console.error('Nexus Study Hub failed to return from Analytics',error);notify('The Study Hub could not refresh. Please reload the app.');}
    window.scrollTo({top:0,behavior:'auto'});
  }
  function openDangerZone(){if(document.body.classList.contains('danger-mode'))return;renderHistory();$('dangerZoneStandalone').hidden=false;document.body.classList.add('danger-mode');window.scrollTo({top:0,behavior:'auto'});}
  function closeDangerZone(){document.body.classList.remove('danger-mode');$('dangerZoneStandalone').hidden=true;window.scrollTo({top:0,behavior:'auto'});}
  function globalSearchMarkup(q){
    const query=String(q||'').trim().toLocaleLowerCase();
    if(!query)return '<div class="hub-empty">Type a topic, note, subject, paper, or mistake to search across the tracker.</div>';
    const ts=[];let topicMatchCount=0;
    const subjectById=new Map(state.subjects.map(subject=>[String(subject.id),subject]));
    for(const topic of state.topics){
      const subject=subjectById.get(String(topic.subjectId)),stream=subject?streamFor(subject):null;
      if(![topic.name,topic.notes,subject?.name,stream?.name].some(value=>String(value||'').toLocaleLowerCase().includes(query)))continue;
      topicMatchCount++;
      if(ts.length<80)ts.push(topic);
    }
    const js=fsState.journal.filter(j=>[j.category,j.issue,j.fix,state.subjects.find(s=>s.id===j.subjectId)?.name].some(v=>String(v||'').toLocaleLowerCase().includes(query))).slice(0,25);
    const ps=fsState.papers.filter(p=>[p.name,p.weakAreas,p.notes,state.subjects.find(s=>s.id===p.subjectId)?.name].some(v=>String(v||'').toLocaleLowerCase().includes(query))).slice(0,25);
    const topicResult=ts.map(t=>`<div class="hub-row"><label class="hub-switch"><input type="checkbox" data-hub-action="select-topic" data-id="${localEsc(t.id)}" ${fsState.selectedTopicIds.includes(t.id)?'checked':''}><span class="hub-row-main"><span class="hub-row-title">${localEsc(t.name)}</span><span class="hub-row-meta">${localEsc(subjectFor(t)?.name||'')} · ${localEsc(statusText(status(t)))}${t.archived?' · Archived':''}</span></span></label><div class="hub-row-actions"><button class="btn btn-sm" data-hub-action="edit-topic" data-id="${localEsc(t.id)}">Edit</button></div></div>`).join('');
    const journalResult=js.map(j=>`<div class="hub-row"><div class="hub-row-main"><div class="hub-row-title">${localEsc(j.category)} · ${localEsc(j.issue.slice(0,180))}</div><div class="hub-row-meta">Journal · ${localEsc(fmtDate(j.date))}</div></div></div>`).join('');
    const paperResult=ps.map(p=>`<div class="hub-row"><div class="hub-row-main"><div class="hub-row-title">${localEsc(p.name)}</div><div class="hub-row-meta">Practice · ${localEsc(fmtDate(p.date))}</div></div></div>`).join('');
    return `<div class="hub-list">${topicResult||''}${journalResult}${paperResult}</div>${topicMatchCount+js.length+ps.length===0?'<div class="hub-empty">No matching topics, journal entries, or papers.</div>':''}<div class="hub-muted" style="margin-top:8px">${topicMatchCount} topic(s), ${js.length} journal item(s), ${ps.length} paper(s) matched. Only the first 80 matching topics are shown; refine the search for a shorter result set. Topic checkboxes select items for bulk actions below.</div>`;
  }
  function renderTools(){const reminderSupported='Notification'in window;const selected=fsState.selectedTopicIds.filter(id=>state.topics.some(t=>t.id===id)).length;const age=fsState.lastBackupAt?dayDiff(fsState.lastBackupAt,today()):null;const searchCard=`<div class="hub-field"><label for="hubGlobalSearch">Search every subject, topic, journal and paper</label><input class="hub-input" id="hubGlobalSearch" type="search" placeholder="Try a lesson name, formula, or error…"></div><div id="hubSearchResults" style="margin-top:10px"></div><div class="hub-row"><div class="hub-row-main"><div class="hub-row-title">${selected} topic(s) selected</div><div class="hub-row-meta">Bulk actions update selected topic schedules or archive state. They do not create fake review history.</div></div></div><div class="hub-actions"><button class="btn btn-sm" data-hub-action="bulk-due-today">Set selected due today</button><div class="hub-field" style="min-width:150px"><label for="hubBulkDueDate">Custom due date</label><input class="hub-input" type="date" id="hubBulkDueDate" min="${today()}"></div><button class="btn btn-sm" data-hub-action="bulk-due-custom">Apply custom date</button><button class="btn btn-sm" data-hub-action="bulk-archive">Archive selected</button><button class="btn btn-sm" data-hub-action="bulk-unarchive">Unarchive selected</button><button class="btn btn-sm" data-hub-action="bulk-export">Export selected CSV</button><button class="btn btn-sm btn-danger" data-hub-action="bulk-delete">Delete selected</button><button class="btn btn-sm btn-danger" data-hub-action="bulk-clear">Clear selection</button></div>`;
    const settings=`<div class="hub-form"><div class="hub-field"><label for="hubBacklogDays">Backlog recovery window (days)</label><input type="number" id="hubBacklogDays" min="1" max="60" value="${localEsc(fsState.settings.backlogDays||7)}"></div><div class="hub-field"><label for="hubReminderTime">Daily reminder time</label><input type="time" id="hubReminderTime" value="${localEsc(fsState.settings.reminderTime||'08:00')}"></div></div><label class="hub-switch" style="margin-top:10px"><input type="checkbox" id="hubRemindersEnabled" ${fsState.settings.reminders?'checked':''}><span>Enable due-study reminder while Nexus is open</span></label><div class="hub-actions"><button class="btn btn-sm btn-primary" data-hub-action="save-tool-settings">Save reminder settings</button><button class="btn btn-sm" data-hub-action="request-notifications">Enable browser notifications</button><button class="btn btn-sm" data-hub-action="check-reminder">Check reminder now</button></div><div class="hub-note">Browser notifications can be checked while the app is running and permission is granted. A fully closed browser cannot reliably send scheduled reminders without push infrastructure and a server.</div>`;
    const data=`<div class="hub-row"><div class="hub-row-main"><div class="hub-row-title">Backup status</div><div class="hub-row-meta">${fsState.lastBackupAt?`Last recorded backup: ${localEsc(fmtDate(fsState.lastBackupAt))} (${age} day(s) ago)`:'No backup recorded yet.'}</div></div><span class="hub-badge ${age===null||age>7?'warn':'good'}">${age===null?'Needed':age>7?'Due':'Recent'}</span></div><div class="hub-actions"><button class="btn btn-sm btn-primary" data-hub-action="full-backup"><svg class="nexus-action-icon" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v11m-4-4 4 4 4-4"/><path d="M5 16v4h14v-4"/></svg> Download full backup</button><button class="btn btn-sm" data-hub-action="full-restore"><svg class="nexus-action-icon" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7.5A2.5 2.5 0 0 1 6.5 5H10l2 2h5.5A2.5 2.5 0 0 1 20 9.5v8a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 17.5z"/><path d="M12 16v-6m-2.5 2.5L12 10l2.5 2.5"/></svg> Restore / merge backup</button><button class="btn btn-sm" data-hub-action="export-papers">Export papers CSV</button><button class="btn btn-sm" data-hub-action="export-journal">Export journal CSV</button><button class="btn btn-sm" data-hub-action="export-study">Export focus log CSV</button><button class="btn btn-sm" data-hub-action="csv-template">Download topic CSV template</button><button class="btn btn-sm" data-hub-action="csv-import">Import topics CSV</button><input id="hubImportFile" type="file" accept=".json,.csv,application/json,text/csv" hidden></div><div class="hub-note">Study data is stored locally by default. Use Cloud sync in Setup & data to connect a private Supabase account, or continue using manual JSON export/import. Keep copies in a separate location.</div>`;
    const goalForm=`<form id="hubGoalForm" class="hub-form"><div class="hub-field"><label for="hubGoalTitle">Milestone</label><input id="hubGoalTitle" required maxlength="160" placeholder="e.g. Finish 5 timed Economics papers"></div><div class="hub-field"><label for="hubGoalUnit">Goal type</label><select id="hubGoalUnit">${selectOptions([['papers','Papers'],['hours','Focus hours'],['reviews','Reviews'],['topics','Topics'],['custom','Manual count']], 'papers')}</select></div><div class="hub-field"><label for="hubGoalTarget">Target</label><input id="hubGoalTarget" type="number" min="1" max="100000" value="5" required></div><div class="hub-field"><label for="hubGoalDate">Target date (optional)</label><input id="hubGoalDate" type="date"></div><div class="hub-actions full"><button class="btn btn-primary" type="submit">Add milestone</button></div></form>`;
    const goals=fsState.goals.map(g=>{const progress=goalProgress(g),pct=Math.min(100,Math.round(progress/Math.max(1,g.target)*100));return `<div class="hub-row"><div class="hub-row-main"><div class="hub-row-title">${localEsc(g.title)}</div><div class="hub-row-meta">${localEsc(g.unit)} · ${progress}/${g.target}${g.dueDate?` · due ${localEsc(fmtDate(g.dueDate))}`:''}</div><div class="hub-meter"><span style="width:${pct}%"></span></div></div><div class="hub-row-actions">${g.unit==='custom'?`<button class="btn btn-sm" data-hub-action="goal-plus" data-id="${localEsc(g.id)}">+1</button>`:''}<button class="btn btn-sm btn-danger" data-hub-action="delete-goal" data-id="${localEsc(g.id)}">Delete</button></div></div>`;}).join('');
    return `<div class="hub-grid">${hubCard('Global search and bulk actions','Find items across the app, select several topics, and apply reversible schedule or archive operations.',searchCard,true)}${hubCard('Reminder & backlog settings','Browser notification capability and backlog controls.',settings)}${hubCard('Backup, restore, import and export','Portable data protection, CSV imports, and feature export.',data)}${hubCard('Goals and milestones','Count reviews, papers, focus hours, topics, or manual progress toward targets.',`${goalForm}<div class="hub-list" style="margin-top:14px">${goals||'<div class="hub-empty">No milestones yet. Add one that is measurable and date-bounded.</div>'}</div>`,true)}</div>`;}
  function goalProgress(g){switch(g.unit){case'reviews':return state.history.filter(h=>!g.dueDate||h.reviewedAt<=g.dueDate).length;case'papers':return fsState.papers.length;case'hours':return Math.floor(totalStudyMinutes()/60);case'topics':return activeTopics().filter(t=>t.reviewCount>0).length;default:return fNum(g.progress);}}
  function renderHub(){
    const content=hubEl('hubContent');if(!content)return;
    try{
      updateKpis();document.querySelectorAll('[data-hub-tab]').forEach(b=>b.classList.toggle('active',b.dataset.hubTab===hubTab));
      const renderers={planner:renderPlanner,mastery:renderMastery,papers:renderPapers,journal:renderJournal,analytics:renderAnalytics,tools:renderTools};
      content.innerHTML=(renderers[hubTab]||renderPlanner)();
      if(hubTab==='tools')renderGlobalResults();
    }catch(error){
      console.error('Nexus Study Hub render failed ('+hubTab+')',error);
      if(hubTab==='analytics')content.innerHTML='<div class="hub-empty analytics-render-error"><strong>This analytics section could not be displayed.</strong><p>Your saved data has not been changed. Retry the section; if the problem repeats, reload the app and report the failure.</p><button type="button" class="btn btn-primary" data-hub-action="analytics-retry">Retry analytics</button></div>';
      else notify('The Study Hub could not refresh. Please try again.');
    }
    try{renderHomeConsistencySummary();}catch(error){console.error('Nexus Overview consistency summary failed',error);}
  }
  function renderGlobalResults(){const inp=hubEl('hubGlobalSearch'),out=hubEl('hubSearchResults');if(!inp||!out)return;inp.value=inp.dataset.q||'';out.innerHTML=globalSearchMarkup(inp.value);}
  function hubSwitch(tab){hubTab=tab;renderHub();try{hubEl('view-studyhub').scrollIntoView({behavior:'smooth',block:'start'});}catch(_){}}
  function persistAndRender(base=false){saveFs();if(base){save();renderAll();}renderHub();}
  function downloadBlob(filename,text,type){const blob=new Blob([text],{type}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=filename;a.rel='noopener';a.style.position='fixed';a.style.left='-10000px';document.body.appendChild(a);try{a.click();}finally{a.remove();setTimeout(()=>URL.revokeObjectURL(url),15000);}}
  function csvCellHub(v){return window.NexusBackupRestoreUtils.csvCell(v);}
  function exportHubCsv(which){let rows=[],filename='nexus-hub-export.csv';if(which==='papers'){filename=`nexus-papers-${today()}.csv`;rows=[['Name','Subject','Kind','Date','Score','Max score','Duration minutes','Error count','Weak areas','Notes'],...fsState.papers.map(p=>[p.name,state.subjects.find(s=>s.id===p.subjectId)?.name||'',p.kind,p.date,p.score,p.maxScore,p.duration,p.errorCount,p.weakAreas,p.notes])];}else if(which==='journal'){filename=`nexus-journal-${today()}.csv`;rows=[['Date','Type','Subject','Topic','Severity','Issue','Correction','Resolved'],...fsState.journal.map(j=>[j.date,j.category,state.subjects.find(s=>s.id===j.subjectId)?.name||'',getTopic(j.topicId)?.name||'',j.severity,j.issue,j.fix,j.solved?'yes':'no'])];}else if(which==='selected'){filename=`nexus-selected-topics-${today()}.csv`;const ts=state.topics.filter(t=>fsState.selectedTopicIds.includes(t.id));rows=[['Stream','Subject','Topic','Notes','Last reviewed','Last rating','Next due','Review count','Status'],...ts.map(t=>{const d=subjectDisplay(t);return[d.stream,d.subject,t.name,t.notes,t.lastReviewed,t.lastRating,t.dueDate,t.reviewCount,status(t)];})];}else{filename=`nexus-study-log-${today()}.csv`;rows=[['Date','Whole Minutes','Total Seconds','Type','Note'],...fsState.studyLogs.map(x=>[x.date,Math.floor(studyLogMinutes(x)),Math.round(studyLogMinutes(x)*60),x.type,x.note||''])];}downloadBlob(filename,'\uFEFF'+rows.map(r=>r.map(csvCellHub).join(',')).join('\r\n'),'text/csv;charset=utf-8');notify('Study Hub CSV exported.');}
  function exportTemplate(){const rows=[['Stream','Subject','Topic','Notes','Last reviewed','Last rating','Next due','Interval days','Review count'],['Commerce','Economics','Demand and supply','','','','','','']];downloadBlob('nexus-topic-import-template.csv','\uFEFF'+rows.map(r=>r.map(csvCellHub).join(',')).join('\r\n'),'text/csv;charset=utf-8');}
  function parseCsvHub(text){
    if(!window.NexusBackupRestoreUtils||typeof window.NexusBackupRestoreUtils.parseCsv!=='function')throw new Error('CSV safety support is unavailable. No data was changed.');
    return window.NexusBackupRestoreUtils.parseCsv(text);
  }
  async function importTopicCsv(file){
    if(!file)return;
    const maxBytes=5*1024*1024;
    if(Number.isFinite(file.size)&&file.size>maxBytes)throw new Error('CSV files must be 5 MiB or smaller.');
    const txt=await file.text();
    if(txt.length>maxBytes)throw new Error('CSV files must be 5 MiB or smaller.');
    const rows=parseCsvHub(txt);
    if(rows.length<2)throw new Error('CSV needs a header and at least one topic row.');
    const heads=rows[0].map(x=>String(x).trim().toLocaleLowerCase());
    const populatedHeads=heads.filter(Boolean);
    if(new Set(populatedHeads).size!==populatedHeads.length)throw new Error('CSV contains duplicate column names. Rename duplicate headers and try again.');
    const idx=(...names)=>heads.findIndex(h=>names.includes(h));
    const iStream=idx('stream','stream name','course'),iSub=idx('subject','subject name'),iName=idx('topic','lesson','topic name','lesson name');
    if(iName<0)throw new Error('CSV requires a Topic or Lesson column.');
    if(!window.NexusBackupRestoreUtils||typeof window.NexusBackupRestoreUtils.commitLocalStorageAtomically!=='function'||!window.NexusStorageKey)throw new Error('Safe local storage support is unavailable. No data was changed.');
    const nextState=clone(state);
    let added=0,dupes=0,invalid=0;
    const streamMap=new Map(nextState.streams.map(x=>[x.name.toLocaleLowerCase(),x]));
    const subjectMap=new Map(nextState.subjects.map(x=>[`${x.streamId}|${x.name.toLocaleLowerCase()}`,x]));
    const known=new Set(nextState.topics.map(x=>`${x.subjectId}|${x.name.trim().toLocaleLowerCase()}`));
    const read=(row,i)=>i<0?'':String(row[i]??'').trim();
    for(const row of rows.slice(1)){
      if(row.length>heads.length){invalid++;continue;}
      const name=read(row,iName);
      if(!name||name.length>240){invalid++;continue;}
      const streamName=read(row,iStream)||'Imported';
      const subName=read(row,iSub)||'Imported subject';
      if(streamName.length>100||subName.length>100){invalid++;continue;}
      let stream=streamMap.get(streamName.toLocaleLowerCase());
      if(!stream){stream={id:fid(),name:streamName};nextState.streams.push(stream);streamMap.set(streamName.toLocaleLowerCase(),stream);}
      const subjectKey=`${stream.id}|${subName.toLocaleLowerCase()}`;
      let subject=subjectMap.get(subjectKey);
      if(!subject){subject={id:fid(),name:subName,streamId:stream.id,order:nextState.subjects.length};nextState.subjects.push(subject);subjectMap.set(subjectKey,subject);}
      const topicKey=`${subject.id}|${name.toLocaleLowerCase()}`;
      if(known.has(topicKey)){dupes++;continue;}
      const lastRatingRaw=Number(read(row,idx('last rating','lastrating')));
      const lastRating=Number.isInteger(lastRatingRaw)&&lastRatingRaw>=1&&lastRatingRaw<=5?lastRatingRaw:null;
      const intervalRaw=Number(read(row,idx('interval days','intervaldays')));
      const reviewCountRaw=Number(read(row,idx('review count','reviewcount')));
      const intervalDays=Number.isFinite(intervalRaw)?Math.max(0,Math.min(365,Math.trunc(intervalRaw))):0;
      const reviewCount=Number.isFinite(reviewCountRaw)?Math.max(0,Math.min(100000,Math.trunc(reviewCountRaw))):0;
      const lastReviewed=read(row,idx('last reviewed','lastreviewed'));
      const dueDate=read(row,idx('next due','due date','next review date'));
      nextState.topics.push({
        id:fid(),subjectId:subject.id,name,notes:read(row,idx('notes','note')).slice(0,1000),
        custom:true,createdAt:today(),lastReviewed:safeDate(lastReviewed)?lastReviewed:'',
        lastRating,dueDate:safeDate(dueDate)?dueDate:'',intervalDays,reviewCount,
        streak:0,lapses:0,archived:false
      });
      known.add(topicKey);
      added++;
    }
    if(!added){notify(`CSV import complete: 0 added, ${dupes} duplicates skipped, ${invalid} invalid rows skipped.`);return;}
    window.NexusOfflineSyncQueue.commitWorkspace(localStorage,[
      {key:window.NexusStorageKey,value:JSON.stringify(nextState)}
    ],{state:nextState,featureState:window.NexusGetFeatureState?window.NexusGetFeatureState():{}},{returnOperationPayload:false});
    state=nextState;
    const saveStatus=$('saveStatus');
    if(saveStatus){saveStatus.textContent='Saved on this device';saveStatus.style.color='';}
    if(window.NexusCloudSync)window.NexusCloudSync.schedule();
    try{
      renderAll();
      notify(`CSV import complete: ${added} added, ${dupes} duplicates skipped, ${invalid} invalid rows skipped.`);
    }catch(e){
      console.error('CSV import saved but rendering failed',e);
      alert('CSV data was saved, but the screen did not refresh cleanly. Reload Nexus to view the imported topics.');
    }
  }
  function backupPayload(){let backupState=state;try{if(window.NexusRepairCurriculumState)backupState=window.NexusRepairCurriculumState(state);}catch(error){console.warn('Could not normalize curriculum metadata for the backup; original workspace data will still be exported.',error);}let syncStatus={schemaVersion:1,accountBoundQueueExcluded:true,queueStatus:'unavailable'};try{if(window.NexusOfflineSyncQueue)syncStatus={...syncStatus,...window.NexusOfflineSyncQueue.summary(localStorage,localStorage.getItem('nexus.cloud.last-user-id')),queueStatus:'local-only-metadata'};}catch(_){}return {app:'Nexus Spaced Repetition Tracker',schema:4,exportedAt:new Date().toISOString(),state:backupState,featureState:fsState,syncMetadata:syncStatus};}
  function fullBackup(){fsState.lastBackupAt=today();saveFs();downloadBlob(`nexus-full-backup-${today()}.json`,JSON.stringify(backupPayload(),null,2),'application/json;charset=utf-8');notify('Full backup downloaded. Keep an extra copy outside the browser.');renderHub();}
  window.NexusCreateBackupPayload=backupPayload;
  window.NexusExportFullBackup=fullBackup;
  async function restoreOrMerge(file){
    if(!file)return;
    let committed=false;
    try{
      if(String(file.name||'').toLowerCase().endsWith('.csv')){await importTopicCsv(file);return;}
      const data=JSON.parse(await file.text());
      if(!data||typeof data!=='object'||Array.isArray(data))throw new Error('Choose a valid Nexus JSON backup.');
      const raw=Object.prototype.hasOwnProperty.call(data,'state')?data.state:data;
      if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new Error('The file does not contain a valid backup state.');
      window.NexusBackupRestoreUtils.validateBackupState(raw);
      const imported=normalizeState(raw);
      const defaults=freshFeatureState();
      const hasFeatureState=Object.prototype.hasOwnProperty.call(data,'featureState');
      const importedFeatures=window.NexusBackupRestoreUtils.normalizeFeatureState(hasFeatureState?data.featureState:undefined,defaults);
      let mode=prompt('Restore mode: type REPLACE to replace app data, or MERGE to keep current data and add imported entries.');
      if(!mode)return;
      mode=mode.trim().toUpperCase();
      if(!['REPLACE','MERGE'].includes(mode)){alert('Import cancelled: enter REPLACE or MERGE.');return;}
      let nextState, nextFeatures;
      if(mode==='REPLACE'){
        nextState=imported;
        nextFeatures=window.NexusBackupRestoreUtils.resolveReplaceFeatureState?window.NexusBackupRestoreUtils.resolveReplaceFeatureState(hasFeatureState,fsState,importedFeatures,defaults):window.NexusBackupRestoreUtils.normalizeFeatureState(hasFeatureState?importedFeatures:fsState,defaults);
      }else{
        const combined={schema:4,streams:[...state.streams],subjects:[...state.subjects],topics:[...state.topics],history:[...state.history],exams:[...state.exams],settings:state.settings};
        const pushUnique=(target,source)=>{const ids=new Set(target.map(x=>x.id));source.forEach(x=>{if(!ids.has(x.id)){target.push(x);ids.add(x.id);}});};
        pushUnique(combined.streams,imported.streams);
        pushUnique(combined.subjects,imported.subjects);
        pushUnique(combined.topics,imported.topics);
        pushUnique(combined.history,imported.history);
        pushUnique(combined.exams,imported.exams);
        nextState=normalizeState(combined);
        nextFeatures=hasFeatureState
          ? window.NexusBackupRestoreUtils.mergeFeatureState(fsState,importedFeatures,defaults,data.featureState)
          : window.NexusBackupRestoreUtils.normalizeFeatureState(fsState,defaults);
      }
      // Full-backup imports can predate durable curriculum markers. Repair before
      // writing the local workspace or queuing the cloud snapshot so the two stay aligned.
      if(typeof window.NexusRepairCurriculumState==='function')nextState=window.NexusRepairCurriculumState(nextState);
      const serializedState=JSON.stringify(nextState);
      const serializedFeatures=JSON.stringify(nextFeatures);
      const serializedCards=JSON.stringify(Object.fromEntries((nextState.topics||[]).filter(topic=>topic&&topic.fsrs).map(topic=>[String(topic.id),topic.fsrs])));
      const serializedFsrsSettings=JSON.stringify(nextFeatures.fsrsSettings);
      if(mode==='REPLACE'&&window.NexusOfflineSyncQueue.hasPending(localStorage,localStorage.getItem('nexus.cloud.last-user-id'))&&!confirm('This account has an unsynced local snapshot. Continue with REPLACE? The pending snapshot will be preserved in local recovery metadata, and only the restored workspace will be queued for upload.'))return;
      window.NexusOfflineSyncQueue.commitWorkspace(localStorage,[
        {key:STORAGE_KEY,value:serializedState},
        {key:FEATURE_KEY,value:serializedFeatures},
        {key:'nexus.fsrs.cards.v1',value:serializedCards},
        {key:'nexus.fsrs.settings.v1',value:serializedFsrsSettings}
      ],{state:nextState,featureState:nextFeatures},{archivePending:mode==='REPLACE',reason:'manual-restore-replace',returnOperationPayload:false});
      committed=true;
      state=nextState;
      fsState=nextFeatures;
      if(window.NexusFSRS&&typeof window.NexusFSRS.setSettings==='function')window.NexusFSRS.setSettings(nextFeatures.fsrsSettings,{syncFeature:false,persist:false});
      focusGoalCacheKey='';
      focusStart=fsState.focusStartedAt?new Date(fsState.focusStartedAt).getTime():null;
      focusPausedAt=fsState.focusPausedAt?new Date(fsState.focusPausedAt).getTime():null;
      focusTopicId=fsState.focusTopicId||'';
      focusSubjectId=fsState.focusSubjectId||'';
      if(focusTimer){clearInterval(focusTimer);focusTimer=null;}
      if(focusStart){focusTimer=setInterval(refreshLiveFocusUi,1000);}
      if(window.NexusCloudSync)window.NexusCloudSync.schedule();
      $('saveStatus').textContent='Saved on this device';
      $('saveStatus').style.color='';
      renderAll();
      renderHub();
      if(focusStart)refreshLiveFocusUi();
      notify(mode==='REPLACE'&&!hasFeatureState?'Tracker data restored. Existing Study Hub data was kept because this backup does not include it.':'Backup '+mode.toLowerCase()+' completed and saved. Review imported topics and dates.');
    }catch(e){
      console.error(e);
      if(committed){
        alert('The backup was saved, but the screen did not refresh cleanly. Reload Nexus to view the restored data.');
      }else if(e&&e.rollbackSucceeded===false){
        alert((e.message||'Backup restore failed.')+' Export or copy any visible unsaved work before closing this tab.');
      }else{
        alert('Could not import this backup. '+(e.message||'Check the file format. The current app data was not changed.'));
      }
    }
  }
  function formatElapsed(ms){const sec=Math.max(0,Math.floor(ms/1000)),h=Math.floor(sec/3600),m=Math.floor((sec%3600)/60),s=sec%60;return h?`${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`:`${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;}
  function refreshLiveFocusUi(){if(!focusStart)return;const elapsed=focusPausedAt?focusPausedAt-focusStart:Date.now()-focusStart;const clock=hubEl('hubFocusClock');if(clock)clock.textContent=formatElapsed(elapsed);const bigClock=document.getElementById('focusModeClock');if(bigClock)bigClock.textContent=formatElapsed(elapsed);const status=document.getElementById('focusModeStatus');if(status)status.textContent=focusPausedAt?'Paused · take your time':'Stay present · one task at a time';const pauseBtn=document.getElementById('focusPauseBtn');if(pauseBtn){pauseBtn.textContent=focusPausedAt?'▶':'Ⅱ';pauseBtn.setAttribute('aria-label',focusPausedAt?'Resume timer':'Pause timer');}const focusDialog=document.getElementById('focusModeDialog');if(focusDialog)focusDialog.classList.toggle('is-paused',!!focusPausedAt);const liveMinutes=liveFocusMinutesToday(),daily=fNum(fsState.settings.dailyMinutes)||90,goalKey=today()+'|'+liveMinutes+'|'+fsState.studyLogs.length+'|'+daily;if(goalKey!==focusGoalCacheKey){focusGoalCacheKey=goalKey;focusGoalLoggedMinutes=loggedMinutesToday();const total=focusGoalLoggedMinutes+liveMinutes,pct=Math.round(total/Math.max(1,daily)*100);const n=hubEl('hubDoneMinutes'),b=hubEl('hubGoalBadge'),m=hubEl('hubGoalMeter');if(n)n.textContent=formatStudyDuration(total*60);if(b){b.textContent=pct+'% of daily goal';b.classList.toggle('good',total>=daily);b.classList.toggle('warn',total<daily);}if(m)m.style.width=Math.min(100,total/Math.max(1,daily)*100)+'%';}}
  if(focusStart&&!focusTimer)focusTimer=setInterval(refreshLiveFocusUi,1000);
  function logFocusStop(){if(!focusStart){notify('No focus session is currently running.');return;}const stoppedAt=Date.now(),start=focusStart,end=focusPausedAt||stoppedAt,elapsedSeconds=Math.max(0,Math.floor((end-start)/1000)),mins=Math.floor(elapsedSeconds/60),actualStart=Date.parse(fsState.focusActualStartedAt||''),wallStart=Number.isFinite(actualStart)?actualStart:start;const note=`Started ${new Date(wallStart).toLocaleString()} · ended ${new Date(stoppedAt).toLocaleString()} · Duration: ${formatStudyDuration(elapsedSeconds)}`;fsState.studyLogs.unshift({id:fid(),date:today(),startedAt:new Date(wallStart).toISOString(),endedAt:new Date(stoppedAt).toISOString(),minutes:mins,durationSeconds:elapsedSeconds,type:'Focus session',subjectId:focusSubjectId||'',topicId:focusTopicId||'',note:(focusTopicId?'Topic: '+(getTopic(focusTopicId)?.name||'Selected topic')+' · ':'')+note});focusStart=null;focusPausedAt=null;fsState.focusStartedAt=null;fsState.focusActualStartedAt=null;fsState.focusPausedAt=null;const focusDialog=document.getElementById('focusModeDialog');if(focusDialog?.open)focusDialog.close();if(focusTimer){clearInterval(focusTimer);focusTimer=null;}saveFs();notify(`Logged ${formatStudyDuration(elapsedSeconds)}.`);renderHub();}
  function discardFocusSession(){if(!focusStart){notify('No focus session is currently running.');return;}if(!confirm('Discard the active focus session without saving any study-time history? This removes the running timer and no session will be logged.'))return;focusStart=null;focusPausedAt=null;fsState.focusStartedAt=null;fsState.focusActualStartedAt=null;fsState.focusPausedAt=null;const focusDialog=document.getElementById('focusModeDialog');if(focusDialog?.open)focusDialog.close();if(focusTimer){clearInterval(focusTimer);focusTimer=null;}saveFs();renderHub();refreshLiveFocusUi();notify('Active focus session discarded. No study time was logged.');}
  function startFocus(){if(focusStart){notify('A focus session is already running.');return;}focusTopicId=hubEl('hubStudyTopic')?.value||'';focusSubjectId=focusTopicId?(subjectFor(getTopic(focusTopicId))?.id||''):(hubEl('hubStudySubject')?.value||'');fsState.focusTopicId=focusTopicId;fsState.focusSubjectId=focusSubjectId;focusStart=Date.now();focusPausedAt=null;fsState.focusStartedAt=new Date(focusStart).toISOString();fsState.focusActualStartedAt=new Date(focusStart).toISOString();fsState.focusPausedAt=null;saveFs();if(focusTimer)clearInterval(focusTimer);focusTimer=setInterval(refreshLiveFocusUi,1000);notify('Focus timer started. Elapsed time is timestamp-based and survives app backgrounding and offline use.');renderHub();refreshLiveFocusUi();openFocusMode();}
  function openFocusMode(){const d=document.getElementById('focusModeDialog');if(!d)return;const t=getTopic(focusTopicId);const sub=state.subjects.find(x=>x.id===focusSubjectId);const title=t?.name||sub?.name||'Independent study session';const target=Number(fsState.settings.sessionMinutes)||25;const label=document.getElementById('focusModeTopic');if(label)label.textContent=title;const goal=document.getElementById('focusModeGoal');if(goal)goal.textContent='Session target · '+target+' min';if(!d.open)d.showModal();refreshLiveFocusUi();}function toggleFocusPause(){if(!focusStart)return;if(focusPausedAt){const pausedFor=Date.now()-focusPausedAt;focusStart+=pausedFor;fsState.focusStartedAt=new Date(focusStart).toISOString();focusPausedAt=null;fsState.focusPausedAt=null;}else{focusPausedAt=Date.now();fsState.focusPausedAt=new Date(focusPausedAt).toISOString();}saveFs();refreshLiveFocusUi();}function markTask(id,checked){const arr=new Set(fsState.taskChecks[today()]||[]);if(checked)arr.add(id);else arr.delete(id);fsState.taskChecks[today()]=Array.from(arr);saveFs();renderHub();}
  function spreadBacklog(){const n=Math.max(1,Math.min(60,fNum(fsState.settings.backlogDays)||7));const over=activeTopics().filter(t=>status(t)==='overdue').sort((a,b)=>(a.dueDate||'').localeCompare(b.dueDate||''));if(!over.length){notify('No overdue topics to redistribute.');return;}if(!confirm(`Spread ${over.length} overdue topic(s) across the next ${n} days?\n\nThis changes due dates but does not add review history. Export a backup first if unsure.`))return;startUndo('Overdue backlog rescheduled');over.forEach((t,i)=>{t.dueDate=dateShift(today(),Math.floor(i*n/over.length));});save();renderAll();renderHub();notify(`Spread ${over.length} overdue topics across ${n} days.`,true);}
  function balanceWorkload(){const days=Math.max(1,Math.min(90,Number(hubEl('hubWorkloadDays')?.value)||7));fsState.settings.workloadDays=days;const candidates=activeTopics().filter(t=>!t.archived&&['overdue','due','new'].includes(status(t))).sort((a,b)=>topicPriority(b)-topicPriority(a));if(!candidates.length){saveFs();renderHub();notify('No active due, overdue, or new topics to balance.');return;}if(!confirm(`Distribute ${candidates.length} due/new topic(s) across ${days} day(s)? This changes due dates only and does not add review history.`)){saveFs();return;}startUndo('Study workload balanced');const loads=Array(days).fill(0);const buckets=Array.from({length:days},()=>[]);for(const t of candidates){const mins=estimateMinutes(t);let best=0;for(let i=1;i<days;i++){if(loads[i]<loads[best])best=i;}buckets[best].push(t);loads[best]+=mins;}buckets.forEach((items,i)=>items.forEach(t=>{t.dueDate=dateShift(today(),i);}));save();saveFs();renderAll();renderHub();notify(`Balanced ${candidates.length} topics over ${days} days. Review history was not changed.`,true);}
  function saveRecallSession(e){e.preventDefault();const val=id=>hubEl(id)?.value?.trim()||'';const recalled=val('hubRecallRecalled'),gaps=val('hubRecallGaps');if(!recalled&&!gaps){alert('Record what you recalled or at least one gap to fix.');return;}const subjectId=val('hubRecallSubject'),topicId=val('hubRecallTopic'),quality=Number(val('hubRecallConfidence'))||3,method=val('hubRecallMethod');fsState.journal.unshift({id:fid(),date:today(),category:'Theory recall',subjectId,topicId,severity:quality<=2?3:quality===3?2:1,issue:`Method: ${method}. Recall quality: ${quality}/5.
Reconstructed: ${recalled||'Not recorded.'}`,fix:gaps||'No specific gap recorded.',solved:!gaps});fsState.studyLogs.unshift({id:fid(),date:today(),minutes:0,type:'Theory recall',note:`${method}; quality ${quality}/5${topicId?' · '+(getTopic(topicId)?.name||'topic'):''}`});saveFs();renderHub();notify('Theory recall session saved to your journal.');}
  function bulkAction(action){const chosen=state.topics.filter(t=>fsState.selectedTopicIds.includes(t.id));if(!chosen.length){notify('Select topics in search results first.');return;}if(action==='bulk-export'){exportHubCsv('selected');return;}if(action==='bulk-clear'){fsState.selectedTopicIds=[];saveFs();renderHub();return;}if(action==='bulk-delete'){if(!confirm('Permanently delete '+chosen.length+' selected topic(s) and their saved review history? This cannot be undone. Export a backup first if unsure.'))return;const ids=new Set(chosen.map(t=>t.id));startUndo('Bulk topic deletion');state.topics=state.topics.filter(t=>!ids.has(t.id));state.history=state.history.filter(h=>!ids.has(h.topicId));fsState.selectedTopicIds=fsState.selectedTopicIds.filter(id=>!ids.has(id));save();renderAll();saveFs();renderHub();notify('Deleted '+chosen.length+' topic(s) and associated review history.');return;}let dueDate=today();if(action==='bulk-due-custom'){dueDate=hubEl('hubBulkDueDate')?.value||'';if(!safeDate(dueDate)){notify('Choose a valid custom due date first.');return;}}const label=action==='bulk-due-today'?'Set due date to today for':action==='bulk-due-custom'?'Set custom due date for':action==='bulk-archive'?'Archive':'Unarchive';if(!confirm(label+' '+chosen.length+' selected topic(s)?'))return;startUndo('Bulk topic update');chosen.forEach(t=>{if(action==='bulk-due-today'||action==='bulk-due-custom')t.dueDate=dueDate;if(action==='bulk-archive')t.archived=true;if(action==='bulk-unarchive')t.archived=false;});save();renderAll();saveFs();renderHub();notify('Updated '+chosen.length+' topic(s).',true);}
  function maybeNotify(){if(!fsState.settings.reminders)return;const now=new Date(),hh=String(now.getHours()).padStart(2,'0')+':'+String(now.getMinutes()).padStart(2,'0');if(hh!==fsState.settings.reminderTime||fsState.lastReminderAt===today())return;const count=activeTopics().filter(t=>['overdue','due'].includes(status(t))).length;fsState.lastReminderAt=today();saveFs();if(count&&'Notification'in window&&Notification.permission==='granted'){try{new Notification('Nexus study reminder',{body:`${count} topic(s) are due or overdue. Open Nexus to plan your session.`});}catch(_){notify(`Study reminder: ${count} topic(s) due or overdue.`);}}else if(count)notify(`Study reminder: ${count} topic(s) due or overdue.`);}
  function savePaper(e){e.preventDefault();const val=id=>hubEl(id)?.value?.trim()||'';const name=val('hubPaperName');if(!name)return;const score=val('hubPaperScore')===''?null:Number(val('hubPaperScore')),max=val('hubPaperMax')===''?null:Number(val('hubPaperMax'));if(score!==null&&max!==null&&(score<0||max<=0||score>max)){alert('Score must be between zero and the maximum score.');return;}const p={id:fid(),name:name.slice(0,160),subjectId:val('hubPaperSubject'),kind:val('hubPaperKind'),date:val('hubPaperDate')||today(),score:score===null?null:score,maxScore:max===null?null:max,duration:Math.max(0,Number(val('hubPaperDuration'))||0),errorCount:Math.max(0,Number(val('hubPaperErrors'))||0),weakAreas:val('hubPaperWeak').slice(0,1000),notes:val('hubPaperNotes').slice(0,2000)};fsState.papers.unshift(p);saveFs();renderHub();notify('Paper/practice record saved.');}
  function saveJournal(e){e.preventDefault();const val=id=>hubEl(id)?.value?.trim()||'';const issue=val('hubJournalIssue');if(!issue)return;fsState.journal.unshift({id:fid(),date:today(),category:val('hubJournalCategory'),subjectId:val('hubJournalSubject'),topicId:val('hubJournalTopic'),severity:Number(val('hubJournalSeverity'))||2,issue:issue.slice(0,3000),fix:val('hubJournalFix').slice(0,3000),solved:false});saveFs();renderHub();notify('Journal entry saved.');}
  function saveGoal(e){e.preventDefault();const title=hubEl('hubGoalTitle').value.trim(),unit=hubEl('hubGoalUnit').value,target=Number(hubEl('hubGoalTarget').value);if(!title||target<1){alert('Enter a milestone title and positive target.');return;}fsState.goals.unshift({id:fid(),title:title.slice(0,160),unit,target,progress:0,dueDate:hubEl('hubGoalDate').value||''});saveFs();renderHub();notify('Milestone added.');}
  function savePlannerSettings(){const daily=Number(hubEl('hubDailyMinutes').value),session=Number(hubEl('hubSessionMinutes').value),weekly=Number(hubEl('hubWeeklyGoal').value);if(!(daily>=10&&daily<=720)||!(session>=5&&session<=180)||!(weekly>=1&&weekly<=2000)){alert('Please enter valid time and target values.');return;}fsState.settings.dailyMinutes=daily;fsState.settings.sessionMinutes=session;fsState.settings.weeklyReviewGoal=weekly;fsState.settings.scheduler=hubEl('hubScheduler').value;saveFs();renderHub();notify('Planner settings saved.');}
  function saveTargets(){document.querySelectorAll('[data-target-subject]').forEach(el=>{const n=Math.max(0,Math.min(10000,Number(el.value)||0));if(n)fsState.syllabusTargets[el.dataset.targetSubject]=n;else delete fsState.syllabusTargets[el.dataset.targetSubject];});saveFs();renderHub();notify('Syllabus targets saved.');}
  function saveToolSettings(){fsState.settings.backlogDays=Math.max(1,Math.min(60,Number(hubEl('hubBacklogDays').value)||7));fsState.settings.reminderTime=hubEl('hubReminderTime').value||'08:00';fsState.settings.reminders=hubEl('hubRemindersEnabled').checked;saveFs();renderHub();notify('Reminder settings saved.');}
  function requestNotify(){if(!('Notification'in window)){alert('This browser does not support notification permission. Use the in-app reminder and due calendar.');return;}Notification.requestPermission().then(p=>{notify(p==='granted'?'Browser notifications enabled.':'Notifications not enabled. You can still use the in-app due reminder.');renderHub();});}
  function buildHelp(){return;}

  // Advanced scheduler: a simple adaptive heuristic; classic remains the default for compatibility.
  const classicInterval=interval;
  interval=function(rating,previous){const r=Number(rating),prev=Math.max(0,Number(previous)||0);if(fsState.settings.scheduler!=='fsrs-lite')return classicInterval(r,prev);const topic=(typeof reviewTopicId!=='undefined'&&reviewTopicId)?getTopic(reviewTopicId):null;const meta=topic?featureMeta(topic):{avg:topic?.lastRating||3};const avg=meta.avg||3;const multipliers={1:0.55,2:1.1,3:1.75,4:2.35,5:3.0};let days;if(r===1)days=1;else if(prev===0)days=({1:1,2:2,3:4,4:7,5:12})[r]||4;else days=Math.round(prev*(multipliers[r]||1.5)*(0.78+avg*0.09));return Math.max(1,Math.min(Math.max(120,Math.min(365,Number(fsState.settings.maxInterval)||120)),days));};
  // Preserve existing topic/review behavior while refreshing Hub views after core data changes.
  const baseRenderAll=renderAll;
  renderAll=function(){baseRenderAll();renderHomeConsistencySummary();if(hubEl('view-studyhub')&&hubEl('view-studyhub').classList.contains('active'))renderHub();};
  const baseExportBackup=exportBackup;
  exportBackup=function(){fullBackup();};
  const baseImportBackup=importBackup;
  importBackup=function(file){if(file)restoreOrMerge(file);};
  const baseResetAll=resetAll;
  resetAll=function(){baseResetAll();};
  // Add Study Hub to navigation and hook controls.
  const hubTabBtn=document.querySelector('[data-view="studyhub"]');if(hubTabBtn)hubTabBtn.addEventListener('click',()=>{hubTab='planner';renderHub();});
  hubEl('analyticsBackBtn').addEventListener('click',closeAnalyticsWindow);hubEl('openDangerZoneBtn').addEventListener('click',openDangerZone);hubEl('dangerBackBtn').addEventListener('click',closeDangerZone);
  document.querySelectorAll('[data-hub-tab]').forEach(b=>b.addEventListener('click',()=>hubSwitch(b.dataset.hubTab)));
  hubEl('hubQuickBackup').addEventListener('click',fullBackup);
  hubEl('hubContent').addEventListener('input',e=>{if(e.target.id==='hubGlobalSearch'){e.target.dataset.q=e.target.value;const out=hubEl('hubSearchResults');if(out)out.innerHTML=globalSearchMarkup(e.target.value);}});
  hubEl('hubContent').addEventListener('change',e=>{const el=e.target;if(['hubRatingGrouping','hubRatingEntity','hubRatingPeriod','hubStudyTimeGrouping'].includes(el.id))return;if(el.id==='hubRatingGrouping'||el.id==='hubRatingEntity'||el.id==='hubRatingPeriod'){if(el.id==='hubRatingGrouping'){fsState.analyticsRatingGrouping=el.value;fsState.analyticsRatingEntity='';}else if(el.id==='hubRatingEntity')fsState.analyticsRatingEntity=el.value;else fsState.analyticsPeriod=el.value;
      if(el.id==='hubRatingPeriod'||el.id==='hubRatingGrouping'){
        const level=['topic','subject','syllabus'].includes(fsState.analyticsRatingGrouping)?fsState.analyticsRatingGrouping:'topic';
        ensureAnalyticsEntityForRange(level);
      }
      saveFs();renderHub();}else if(el.dataset.hubAction==='check-task'){markTask(el.dataset.id,el.checked);}else if(el.dataset.hubAction==='select-topic'){const a=new Set(fsState.selectedTopicIds);el.checked?a.add(el.dataset.id):a.delete(el.dataset.id);fsState.selectedTopicIds=Array.from(a);saveFs();const inp=hubEl('hubGlobalSearch');if(inp){inp.dataset.q=inp.value;renderGlobalResults();}}});
  hubEl('hubContent').addEventListener('submit',e=>{if(e.target.id==='hubPaperForm')savePaper(e);if(e.target.id==='hubJournalForm')saveJournal(e);if(e.target.id==='hubGoalForm')saveGoal(e);if(e.target.id==='hubRecallForm')saveRecallSession(e);});
  hubEl('hubContent').addEventListener('click',e=>{const b=e.target.closest('[data-hub-action]');if(!b)return;const a=b.dataset.hubAction,id=b.dataset.id;
    if(['analytics-card-toggle','analytics-section','analytics-toggle-rating','analytics-custom-apply','analytics-export-pdf','analytics-export','analytics-retry'].includes(a))return;
    if(a==='analytics-card-toggle'){const card=b.closest('[data-analytics-collapsible]'),content=card?.querySelector('.analytics-card-content');if(!card||!content)return;content.hidden=!content.hidden;b.setAttribute('aria-expanded',String(!content.hidden));b.textContent=content.hidden?'Expand':'Collapse';return;}
    if(a==='analytics-section'){const next=b.dataset.analyticsSection;if(['presses','papers','activity'].includes(next)){analyticsSection=next;renderHub();}return;}
    if(a==='analytics-toggle-rating'){
      const rating=Number(b.dataset.ratingToggle),current=getVisibleAnalyticsRatings();
      if(!Number.isInteger(rating)||rating<1||rating>5)return;
      if(current.includes(rating)){
        if(current.length===1){notify('Keep at least one rating selected.');return;}
        fsState.analyticsVisibleRatings=current.filter(r=>r!==rating);
      }else fsState.analyticsVisibleRatings=[...current,rating].sort((x,y)=>x-y);
      saveFs();renderHub();return;
    }
    if(a==='review-topic'){openReview(id);return;}if(a==='open-calendar'){openReviewCalendar();return;}if(a==='edit-topic'){switchView('topics');openTopic(id);return;}
    if(a==='analytics-custom-apply'){const from=hubEl('hubRatingCustomStart')?.value||'',to=hubEl('hubRatingCustomEnd')?.value||'';if(!safeDate(from)||!safeDate(to)||from>to){notify('Choose valid dates. The From date must be on or before the To date.');return;}fsState.analyticsCustomStart=from;fsState.analyticsCustomEnd=to;fsState.analyticsPeriod='custom';saveFs();renderHub();return;}if(a==='analytics-export-pdf'){exportAnalyticsPdf();return;}if(a==='analytics-export'){const selection=getRatingAnalyticsSelection(),from=selection.from,to=selection.to,rows=[['Metric','Value'],['From',from],['To',to],['Reviews',state.history.filter(h=>h.reviewedAt>=from&&h.reviewedAt<=to).length],['Mean recall rating',(()=>{const r=state.history.filter(h=>h.reviewedAt>=from&&h.reviewedAt<=to);return r.length?(r.reduce((n,h)=>n+fNum(h.rating),0)/r.length).toFixed(2):'N/A';})()],['Active topics',activeTopics().length],['Mastered topics',activeTopics().filter(isMastered).length],['Overdue topics',activeTopics().filter(t=>status(t)==='overdue').length],['Study minutes in range',fsState.studyLogs.filter(l=>l.date>=from&&l.date<=to).reduce((n,l)=>n+studyLogMinutes(l),0)],['Generated at',new Date().toISOString()]],csv=rows.map(row=>row.map(v=>'"'+String(v??'').replace(/"/g,'""')+'"').join(',')).join('\\r\\n');downloadBlob('nexus-analytics-'+from+'-to-'+to+'.csv',csv,'text/csv;charset=utf-8');notify('Analytics CSV exported.');return;}if(a==='refresh-plan'){renderHub();return;}if(a==='toggle-final-revision'){fsState.settings.finalRevision=!fsState.settings.finalRevision;saveFs();renderHub();notify(fsState.settings.finalRevision?'Final-revision mode enabled. Non-mastered topics get higher priority.':'Final-revision mode disabled.');return;}if(a==='balance-workload'){balanceWorkload();return;}if(a==='backlog-plan'){spreadBacklog();return;}
    if(a==='save-planner-settings'){savePlannerSettings();return;}if(a==='focus-start'){startFocus();return;}if(a==='focus-stop'){logFocusStop();return;}if(a==='focus-discard'){discardFocusSession();return;}if(a==='study-history-toggle'){const target=hubEl(b.dataset.target);if(!target)return;target.hidden=!target.hidden;b.setAttribute('aria-expanded',String(!target.hidden));b.textContent=target.hidden?'Expand':'Collapse';return;}if(a==='study-history-more'){studyLogHistoryLimit+=100;renderHub();return;}if(a==='delete-study-log'){deleteStudyLog(id);return;}if(a==='save-targets'){saveTargets();return;}
    if(a==='delete-paper'){if(confirm('Delete this paper/practice record?')){fsState.papers=fsState.papers.filter(p=>p.id!==id);saveFs();renderHub();}return;}if(a==='export-papers'){exportHubCsv('papers');return;}
    if(a==='toggle-journal'){const j=fsState.journal.find(x=>x.id===id);if(j){j.solved=!j.solved;saveFs();renderHub();}return;}if(a==='delete-journal'){if(confirm('Delete this journal entry?')){fsState.journal=fsState.journal.filter(j=>j.id!==id);saveFs();renderHub();}return;}
    if(a==='save-tool-settings'){saveToolSettings();return;}if(a==='request-notifications'){requestNotify();return;}if(a==='check-reminder'){const c=activeTopics().filter(t=>['overdue','due'].includes(status(t))).length;notify(c?`${c} topic(s) due or overdue. Open Daily planner to prioritise them.`:'No topics due or overdue right now.');return;}
    if(a==='full-backup'){fullBackup();return;}if(a==='full-restore'){hubEl('hubImportFile').click();return;}if(a==='export-journal'){exportHubCsv('journal');return;}if(a==='export-study'){exportHubCsv('study');return;}if(a==='csv-template'){exportTemplate();return;}if(a==='csv-import'){hubEl('hubImportFile').accept='.csv';hubEl('hubImportFile').click();return;}
    if(a==='bulk-due-today'||a==='bulk-due-custom'||a==='bulk-archive'||a==='bulk-unarchive'||a==='bulk-export'||a==='bulk-delete'||a==='bulk-clear'){bulkAction(a);return;}
    if(a==='delete-goal'){if(confirm('Delete this milestone?')){fsState.goals=fsState.goals.filter(g=>g.id!==id);saveFs();renderHub();}return;}if(a==='goal-plus'){const g=fsState.goals.find(g=>g.id===id);if(g){g.progress=(g.progress||0)+1;saveFs();renderHub();}return;}
  });
  document.addEventListener('click',e=>{
    const toggle=e.target.closest('[data-home-collapse]');if(!toggle)return;
    const target=document.getElementById(toggle.dataset.homeCollapse);if(!target)return;
    target.hidden=!target.hidden;const expanded=!target.hidden;
    toggle.setAttribute('aria-expanded',String(expanded));toggle.textContent=expanded?'Collapse':'Expand';
  });
  document.addEventListener('click',e=>{
    const openButton=e.target.closest('#homeOpenAnalytics');
    if(openButton){e.preventDefault();openAnalyticsWindow();return;}
    const button=e.target.closest('[data-hub-action]');if(!button)return;
    const action=button.dataset.hubAction;
    if(!['analytics-card-toggle','analytics-section','analytics-toggle-rating','analytics-custom-apply','analytics-export-pdf','analytics-export','analytics-retry'].includes(action))return;
    if(!button.closest('#analyticsStandalone')&&!document.body.classList.contains('analytics-mode'))return;
    e.preventDefault();
    try{
      if(action==='analytics-card-toggle'){
        const card=button.closest('[data-analytics-collapsible]'),content=card?.querySelector('.analytics-card-content');
        if(!card||!content)return;
        content.hidden=!content.hidden;button.setAttribute('aria-expanded',String(!content.hidden));button.textContent=content.hidden?'Expand':'Collapse';return;
      }
      if(action==='analytics-section'){const next=button.dataset.analyticsSection;if(['presses','papers','activity'].includes(next)){analyticsSection=next;renderHub();}return;}
      if(action==='analytics-toggle-rating'){
        const rating=Number(button.dataset.ratingToggle),current=getVisibleAnalyticsRatings();
        if(!Number.isInteger(rating)||rating<1||rating>5)return;
        if(current.includes(rating)){
          if(current.length===1){notify('Keep at least one rating selected.');return;}
          fsState.analyticsVisibleRatings=current.filter(r=>r!==rating);
        }else fsState.analyticsVisibleRatings=[...current,rating].sort((x,y)=>x-y);
        saveFs();renderHub();return;
      }
      if(action==='analytics-custom-apply'){
        const from=hubEl('hubRatingCustomStart')?.value||'',to=hubEl('hubRatingCustomEnd')?.value||'';
        if(!safeDate(from)||!safeDate(to)||from>to){notify('Choose valid dates. The From date must be on or before the To date.');return;}
        fsState.analyticsCustomStart=from;fsState.analyticsCustomEnd=to;fsState.analyticsPeriod='custom';saveFs();renderHub();return;
      }
      if(action==='analytics-export-pdf'){openAnalyticsPdfDialog();return;}
      if(action==='analytics-export'){exportAnalyticsCsv();return;}
      if(action==='analytics-retry'){renderHub();return;}
    }catch(error){
      console.error('Nexus Analytics action failed ('+action+')',error);
      notify(action==='analytics-export-pdf'?'Could not generate the PDF report. Allow pop-ups and try again.':action==='analytics-export'?'Could not export analytics CSV. Please try again.':'Analytics could not update. Please try again.');
    }
  });
  document.addEventListener('change',e=>{
    const el=e.target;if(!el)return;
    if(['hubRatingGrouping','hubRatingEntity','hubRatingPeriod'].includes(el.id)){
      if(el.id==='hubRatingGrouping'){fsState.analyticsRatingGrouping=el.value;fsState.analyticsRatingEntity='';}
      else if(el.id==='hubRatingEntity')fsState.analyticsRatingEntity=el.value;
      else fsState.analyticsPeriod=el.value;
      if(el.id==='hubRatingPeriod'||el.id==='hubRatingGrouping'){
        const level=['topic','subject','syllabus'].includes(fsState.analyticsRatingGrouping)?fsState.analyticsRatingGrouping:'topic';
        ensureAnalyticsEntityForRange(level);
      }
      saveFs();try{renderHub();}catch(error){console.error('Analytics timeframe change failed',error);notify('Could not update the selected timeframe.');}return;
    }
    if(el.id==='hubStudyTimeGrouping'){fsState.studyTimeGrouping=el.value==='topic'?'topic':'subject';saveFs();try{renderHub();}catch(error){console.error('Study time grouping failed',error);notify('Could not update study-time grouping.');}return;}
    if(el.id==='homeHeatmapPeriod'){fsState.heatmapPeriod=el.value;saveFs();try{renderHomeConsistencySummary();}catch(error){console.error('Home heatmap update failed',error);notify('Could not update the Overview heatmap.');}}
  });
  hubEl('hubContent').addEventListener('input',e=>{if(e.target.id==='hubStudySearch'){fsState.studyTopicQuery=e.target.value;const sel=hubEl('hubStudyTopic');if(sel)sel.innerHTML=studyTopicOptionsMarkup(fsState.studyTopicQuery,focusTopicId,150);}});
  hubEl('hubContent').addEventListener('change',async e=>{if(e.target.id==='hubStudyTimeGrouping')return;if(e.target.id==='hubStudyTimeGrouping'){fsState.studyTimeGrouping=e.target.value==='topic'?'topic':'subject';saveFs();renderHub();return;}if(e.target.id==='hubStudyTopic'){focusTopicId=e.target.value;const t=getTopic(focusTopicId);focusSubjectId=t?(subjectFor(t)?.id||''):focusSubjectId;fsState.focusTopicId=focusTopicId;fsState.focusSubjectId=focusSubjectId;saveFs();return;}if(e.target.id==='hubTimerMinutes'){fsState.settings.sessionMinutes=Math.max(5,Math.min(240,Number(e.target.value)||25));saveFs();return;}if(e.target.id==='hubCalendarWindow'){fsState.calendarWindow=e.target.value;saveFs();renderHub();return;}if(e.target.id==='hubImportFile'){const f=e.target.files?.[0];e.target.value='';if(f)await restoreOrMerge(f);}});

  // Override reset to clear all extension data only after the user's existing reset flow confirms.
  const oldReset=resetAll;
  resetAll=async function(){
    const warning='Reset all Nexus workspace data?\\n\\nThis removes topics, review history, exams, Study Hub notes, papers, goals, FSRS memory, and scheduler preferences. If you are signed in, the empty workspace may sync to your cloud account and remove this study data from your other devices. Export a full JSON backup first.';
    if(!confirm(warning))return;
    const typed=prompt('Type RESET to confirm complete workspace removal:');
    if(typed!=='RESET'){notify('Reset cancelled.');return;}
    const queue=window.NexusOfflineSyncQueue;
    const owner=localStorage.getItem('nexus.cloud.last-user-id')||'';
    const hasPending=!!(queue&&queue.hasPending(localStorage,owner));
    if(hasPending&&!confirm('This account has unsynced local changes. The pending snapshot will be archived in local recovery metadata before the reset is queued. Continue?'))return;
    const defaultFsrs={request_retention:0.9,maximum_interval:120,enable_fuzz:false,w:null};
    try{
      if(!queue||typeof queue.commitWorkspace!=='function')throw new Error('Safe workspace reset is unavailable.');
      const resetState=window.NexusRepairCurriculumState?window.NexusRepairCurriculumState(baseState()):baseState();
      const resetFeatures=window.NexusNormalizeFeatureState({...freshFeatureState(),fsrsSettings:defaultFsrs});
      const entries=[
        {key:STORAGE_KEY,value:JSON.stringify(resetState)},
        {key:FEATURE_KEY,value:JSON.stringify(resetFeatures)},
        {key:'nexus.fsrs.cards.v1',value:'{}'},
        {key:'nexus.fsrs.settings.v1',value:JSON.stringify(resetFeatures.fsrsSettings)}
      ];
      queue.commitWorkspace(localStorage,entries,{state:resetState,featureState:resetFeatures},{archivePending:true,reason:'manual-reset',returnOperationPayload:false});
      state=resetState;fsState=resetFeatures;
      if(window.NexusFSRS&&typeof window.NexusFSRS.setSettings==='function')window.NexusFSRS.setSettings(resetFeatures.fsrsSettings,{syncFeature:false,persist:false});
      focusGoalCacheKey='';focusStart=null;focusPausedAt=null;focusTopicId='';focusSubjectId='';
      if(focusTimer){clearInterval(focusTimer);focusTimer=null;}
      if(window.NexusClearCascadeUndo)window.NexusClearCascadeUndo();
      const storage=window.NexusStorage;
      if(storage&&typeof storage.isEnabled==='function'&&storage.isEnabled()&&typeof storage.flush==='function')await storage.flush();
      OLD_KEYS.forEach(k=>localStorage.removeItem(k));
      if(storage&&typeof storage.isEnabled==='function'&&storage.isEnabled()&&typeof storage.flush==='function')await storage.flush();
      if(window.NexusCloudSync)window.NexusCloudSync.schedule();
      renderAll();renderHub();
      notify('Tracker and Study Hub data reset. If signed in, check cloud sync status before using another device.');
    }catch(error){
      console.error('Workspace reset failed',error);
      alert('Nexus could not confirm that the full reset was saved. Keep this tab open and do not clear site data. '+(error.message||'Export a backup before retrying.'));
    }
  };

  // Gentle reminder check and 60-second scheduled-time check while open.
  const dueCountAtOpen=activeTopics().filter(t=>['overdue','due'].includes(status(t))).length;
  if(dueCountAtOpen&&fsState.lastReminderAt!==today())setTimeout(()=>{if(fsState.settings.reminders)notify(`You have ${dueCountAtOpen} topic(s) due or overdue. Open Study Hub → Daily planner.`);},1200);
  setInterval(maybeNotify,60000);
  document.addEventListener('click',e=>{const b=e.target.closest('[data-focus-action]');if(b){const a=b.dataset.focusAction;if(a==='pause')toggleFocusPause();else if(a==='reset'){if(confirm('Reset this focus session? The elapsed time will not be logged.')){focusStart=Date.now();focusPausedAt=null;fsState.focusStartedAt=new Date(focusStart).toISOString();fsState.focusActualStartedAt=new Date(focusStart).toISOString();fsState.focusPausedAt=null;saveFs();refreshLiveFocusUi();}}else if(a==='stop')logFocusStop();else if(a==='discard')discardFocusSession();return;}const c=e.target.closest('[data-calendar-action]');if(c){const a=c.dataset.calendarAction;if(a==='close')document.getElementById('reviewCalendarDialog')?.close();else if(a==='prev'||a==='next'){calendarMonth.setMonth(calendarMonth.getMonth()+(a==='prev'?-1:1));renderReviewCalendar();}return;}const day=e.target.closest('[data-calendar-day]');if(day){calendarSelected=day.dataset.calendarDay;renderReviewCalendar();}});document.getElementById('reviewCalendarWindow')?.addEventListener('change',e=>{calendarMonths=Number(e.target.value)||1;calendarMonth.setMonth(calendarMonth.getMonth()+calendarMonths);calendarMonth.setDate(1);renderReviewCalendar();});document.getElementById('homeOpenCalendarSecondary')?.addEventListener('click',openReviewCalendar);function openReviewCalendar(){const d=document.getElementById('reviewCalendarDialog');if(!d)return;calendarMonth=new Date();calendarMonth.setDate(1);calendarSelected=today();renderReviewCalendar();d.showModal();}let calendarMonth=new Date(new Date().getFullYear(),new Date().getMonth(),1),calendarSelected=today(),calendarMonths=1;function renderReviewCalendar(){const grid=document.getElementById('reviewCalendarGrid'),monthLabel=document.getElementById('reviewCalendarMonth'),details=document.getElementById('reviewCalendarDetails');if(!grid||!monthLabel||!details)return;const year=calendarMonth.getFullYear(),month=calendarMonth.getMonth();monthLabel.textContent=calendarMonth.toLocaleDateString(undefined,{month:'long',year:'numeric'});const range=document.getElementById('reviewCalendarWindow');if(range)range.value=String(calendarMonths);const first=new Date(year,month,1),startOffset=(first.getDay()+6)%7,days=new Date(year,month+1,0).getDate(),prevDays=new Date(year,month,0).getDate();let html=['Mon','Tue','Wed','Thu','Fri','Sat','Sun'].map(x=>'<div class="calendar-weekday">'+x+'</div>').join('');for(let i=0;i<42;i++){let dayNum=i-startOffset+1,dt,outs=false;if(dayNum<1){dt=new Date(year,month-1,prevDays+dayNum);outs=true;}else if(dayNum>days){dt=new Date(year,month+1,dayNum-days);outs=true;}else dt=new Date(year,month,dayNum);const iso=dt.getFullYear()+'-'+String(dt.getMonth()+1).padStart(2,'0')+'-'+String(dt.getDate()).padStart(2,'0');const count=activeTopics().filter(t=>t.dueDate===iso||(!t.dueDate&&t.createdAt===iso)).length,exams=state.exams.filter(x=>x.date===iso);html+='<button type="button" class="calendar-day '+(outs?'outside ':'')+(iso===today()?'today ':'')+(iso===calendarSelected?'selected':'')+'" data-calendar-day="'+iso+'"><span class="calendar-day-number">'+dt.getDate()+'</span><span class="calendar-dots">'+(count?'<i title="'+count+' reviews"></i>':'')+(exams.length?'<i class="exam" title="Exam"></i>':'')+'</span><span class="calendar-day-count">'+(count?count+' due':'')+(exams.length?' · '+exams.length+' exam':'')+'</span></button>';}grid.innerHTML=html;const selectedDate=new Date(calendarSelected+'T12:00:00').toLocaleDateString(undefined,{weekday:'long',month:'long',day:'numeric',year:'numeric'});const topics=activeTopics().filter(t=>t.dueDate===calendarSelected||(!t.dueDate&&t.createdAt===calendarSelected));const exams=state.exams.filter(x=>x.date===calendarSelected);details.innerHTML='<h3>'+selectedDate+'</h3>'+(topics.map(t=>'<div class="calendar-event"><i class="legend-review"></i><div><strong>'+localEsc(t.name)+'</strong><span>'+localEsc(subjectFor(t)?.name||'Topic review')+'</span></div></div>').join(''))+(exams.map(x=>'<div class="calendar-event"><i class="legend-exam"></i><div><strong>'+localEsc(x.name)+'</strong><span>Exam · '+localEsc(x.type||'')+'</span></div></div>').join(''))+(!topics.length&&!exams.length?'<div class="muted small">Nothing scheduled for this day.</div>':'');} if(focusStart){focusTimer=setInterval(refreshLiveFocusUi,1000);}
  // Home is the normal startup view: avoid building the hidden Study Hub planner.
  // Preserve correct startup rendering if another flow has already activated Study Hub.
  const studyHubView=hubEl('view-studyhub');
  if(studyHubView?.classList.contains('active'))renderHub();
  try{renderHomeConsistencySummary();}catch(error){console.error('Nexus Overview consistency summary failed',error);}
  const restoreFocusUi=()=>{if(focusStart)openFocusMode();else refreshLiveFocusUi();};
  if(document.readyState==='loading'){document.addEventListener('DOMContentLoaded',restoreFocusUi,{once:true});}else{restoreFocusUi();}
})();
