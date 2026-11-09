(function(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.NexusCurriculumIntegrity = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : null), function() {
  'use strict';

  const isRecord = value => !!value && typeof value === 'object' && !Array.isArray(value);
  const rows = value => Array.isArray(value) ? value : [];
  const uniqueStrings = value => Array.from(new Set(rows(value).filter(x => typeof x === 'string' && x.length > 0))).slice(-5000);
  const normalizeName = value => String(value || '').trim().toLocaleLowerCase();
  const packMarker = id => 'installed:pack:' + String(id);
  const subjectMarker = (id, subjectId) => 'installed:subject:' + String(id) + ':' + String(subjectId);
  const topicMarker = (id, subjectId, name) => 'installed:topic:' + String(id) + ':' + String(subjectId) + ':' + JSON.stringify(String(name));
  const deletedPack = id => 'deleted:pack:' + String(id);
  const deletedSubject = (id, subjectId) => 'deleted:subject:' + String(id) + ':' + String(subjectId);
  const deletedTopic = (id, subjectId, name) => 'deleted:topic:' + String(id) + ':' + String(subjectId) + ':' + JSON.stringify(String(name));
  const safePrefix = subject => String(subject && subject.legacyIdPrefix || '');
  const canonicalPrefix = subject => safePrefix(subject).replace(/^seed-/i, 'curr-');
  const legacyPrefix = subject => safePrefix(subject).replace(/^curr-/i, 'seed-');
  const topicIdFor = (subject, name) => {
    const index = rows(subject && subject.topics).indexOf(String(name)) + 1;
    const prefix = canonicalPrefix(subject);
    return index > 0 && prefix ? prefix + '-' + String(index).padStart(2, '0') : '';
  };
  const oldTopicIdFor = (subject, name) => {
    const index = rows(subject && subject.topics).indexOf(String(name)) + 1;
    const prefix = legacyPrefix(subject);
    return index > 0 && prefix ? prefix + '-' + String(index).padStart(2, '0') : '';
  };
  function ensureState(state) {
    if (!isRecord(state)) throw new Error('Curriculum integrity requires a workspace object.');
    if (!isRecord(state.settings)) state.settings = {};
    state.settings.installedCurricula = uniqueStrings(state.settings.installedCurricula);
    state.settings.curriculumTombstones = uniqueStrings(state.settings.curriculumTombstones);
    if (!Array.isArray(state.streams)) state.streams = [];
    if (!Array.isArray(state.subjects)) state.subjects = [];
    if (!Array.isArray(state.topics)) state.topics = [];
    return {
      installed: new Set(state.settings.installedCurricula),
      deleted: new Set(state.settings.curriculumTombstones)
    };
  }
  function findStream(state, pack) {
    return rows(state.streams).find(stream => pack.streamId && String(stream.id) === String(pack.streamId)) ||
      rows(state.streams).find(stream => normalizeName(stream.name) === normalizeName(pack.streamName)) || null;
  }
  function findSubject(state, pack, definition, stream) {
    const attached = stream && rows(state.subjects).find(subject => String(subject.streamId) === String(stream.id) &&
      ((definition.workspaceId && String(subject.id) === String(definition.workspaceId)) || normalizeName(subject.name) === normalizeName(definition.name)));
    if (attached) return attached;
    const byId = definition.workspaceId && rows(state.subjects).find(subject => String(subject.id) === String(definition.workspaceId));
    if (!byId) return null;
    const hasPackTopic = rows(state.topics).some(topic => String(topic.subjectId) === String(byId.id) &&
      (String(topic.id || '').startsWith(canonicalPrefix(definition) + '-') ||
       String(topic.id || '').startsWith(legacyPrefix(definition) + '-') || rows(definition.topics).includes(String(topic.name))));
    // Only reclaim the globally stable subject ID when actual catalogue-topic evidence
    // shows that a normalization step orphaned it from the Commerce stream. Otherwise a
    // custom subject that happens to use that ID must remain untouched.
    return hasPackTopic ? byId : null;
  }
  function topicByCatalogIdentity(state, definition, name, subject) {
    const ids = [topicIdFor(definition, name), oldTopicIdFor(definition, name)].filter(Boolean);
    return rows(state.topics).find(topic => ids.includes(String(topic.id))) ||
      (subject && rows(state.topics).find(topic => String(topic.subjectId) === String(subject.id) && String(topic.name) === String(name))) ||
      null;
  }
  function hasLegacyPackEvidence(state, pack) {
    const stream = findStream(state, pack);
    if (stream && pack.streamId && String(stream.id) === String(pack.streamId)) return true;
    for (const definition of rows(pack.subjects)) {
      const subject = findSubject(state, pack, definition, stream);
      if (!subject) continue;
      if (rows(state.topics).some(topic => {
        const id = String(topic.id || '');
        return String(topic.subjectId) === String(subject.id) &&
          (id.startsWith(canonicalPrefix(definition) + '-') || id.startsWith(legacyPrefix(definition) + '-') ||
            rows(definition.topics).includes(String(topic.name)));
      })) return true;
    }
    // The original startup cleanup could leave a reviewed seed topic but detach its parent.
    // The stable topic ID still identifies which catalogue subject owned that record.
    return rows(state.topics).some(topic => rows(pack.subjects).some(definition => {
      const prefix = canonicalPrefix(definition) + '-';
      const oldPrefix = legacyPrefix(definition) + '-';
      return (String(topic.id || '').startsWith(prefix) || String(topic.id || '').startsWith(oldPrefix)) &&
        rows(definition.topics).length > 0;
    }));
  }
  function ensureStream(state, pack, makeId) {
    let stream = findStream(state, pack);
    if (stream) return stream;
    let id = String(pack.streamId || (typeof makeId === 'function' ? makeId('stream') : 'stream-' + Date.now().toString(36)));
    if (rows(state.streams).some(item => String(item.id) === id)) id = typeof makeId === 'function' ? makeId('stream') : id + '-restored';
    stream = { id, name: String(pack.streamName || pack.title || 'Curriculum') };
    state.streams.push(stream);
    return stream;
  }
  function ensureSubject(state, pack, definition, stream, makeId) {
    let subject = findSubject(state, pack, definition, stream);
    if (subject) {
      // A normalized legacy snapshot can temporarily attach an orphaned catalogue topic
      // to a generic fallback subject. Reattach the known workspace subject by stable ID.
      if (String(subject.streamId) !== String(stream.id)) subject.streamId = stream.id;
      if (!Number.isFinite(Number(subject.order))) subject.order = rows(state.subjects).filter(item => String(item.streamId) === String(stream.id) && String(item.id) !== String(subject.id)).length;
      return subject;
    }
    let id = String(definition.workspaceId || (typeof makeId === 'function' ? makeId('subject') : 'subject-' + Date.now().toString(36)));
    if (rows(state.subjects).some(item => String(item.id) === id)) id = typeof makeId === 'function' ? makeId('subject') : id + '-restored';
    subject = { id, name: String(definition.name || 'Subject'), streamId: stream.id,
      order: rows(state.subjects).filter(item => String(item.streamId) === String(stream.id)).length };
    state.subjects.push(subject);
    return subject;
  }
  function makeTopicId(state, definition, name, makeId) {
    const stable = topicIdFor(definition, name);
    if (stable && !rows(state.topics).some(topic => String(topic.id) === stable)) return stable;
    return typeof makeId === 'function' ? makeId('topic') : 'topic-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);
  }
  function isInstalledMarkerForPack(marker, id) {
    return marker === packMarker(id) || marker.startsWith('installed:subject:' + id + ':') || marker.startsWith('installed:topic:' + id + ':');
  }
  function purgeDeletedScope(state, pack, deleted) {
    const id=String(pack.id),definitions=rows(pack.subjects),streamIds=new Set(rows(state.streams)
      .filter(item=>(pack.streamId&&String(item.id)===String(pack.streamId))||
        normalizeName(item.name)===normalizeName(pack.streamName)).map(item=>String(item.id)));
    const subjectIds=new Set(),topicIds=new Set(),deletedTopicNames=[];
    const definitionById=new Map(definitions.map(definition=>[String(definition.id),definition]));
    const deletedPackScope=deleted.has(deletedPack(id));
    const prefixes=definitions.filter(definition=>deletedPackScope||deleted.has(deletedSubject(id,definition.id)))
      .flatMap(definition=>[canonicalPrefix(definition)+'-',legacyPrefix(definition)+'-']);
    for(const subject of rows(state.subjects)){
      const subjectNameMatches=definitions.some(definition=>normalizeName(subject.name)===normalizeName(definition.name));
      if((deletedPackScope&&((definitions.some(definition=>definition.workspaceId&&String(definition.workspaceId)===String(subject.id)))||
          (streamIds.has(String(subject.streamId))&&subjectNameMatches)))||
        (!deletedPackScope&&definitions.some(definition=>deleted.has(deletedSubject(id,definition.id))&&
          ((definition.workspaceId&&String(definition.workspaceId)===String(subject.id))||
           (streamIds.has(String(subject.streamId))&&normalizeName(subject.name)===normalizeName(definition.name))))){
        subjectIds.add(String(subject.id));
      }
    }
    if(deletedPackScope){
      for(const topic of rows(state.topics)){
        const topicId=String(topic.id||'');
        if(subjectIds.has(String(topic.subjectId))||prefixes.some(prefix=>topicId.startsWith(prefix)))topicIds.add(topicId);
      }
    }else{
      for(const definition of definitions){
        for(const name of rows(definition.topics)){
          if(!deleted.has(deletedTopic(id,definition.id,name)))continue;
          const ids=new Set([topicIdFor(definition,name),oldTopicIdFor(definition,name)].filter(Boolean));
          const subject=rows(state.subjects).find(item=>
            (definition.workspaceId&&String(item.id)===String(definition.workspaceId))||
            (streamIds.has(String(item.streamId))&&normalizeName(item.name)===normalizeName(definition.name)));
          deletedTopicNames.push({subjectId:subject?String(subject.id):'',name:String(name)});
          for(const topic of rows(state.topics)){
            const currentId=String(topic.id||'');
            if(ids.has(currentId)||(subject&&String(topic.subjectId)===String(subject.id)&&String(topic.name)===String(name)))topicIds.add(currentId);
          }
        }
      }
      for(const topic of rows(state.topics)){
        const currentId=String(topic.id||'');
        if(subjectIds.has(String(topic.subjectId))||prefixes.some(prefix=>currentId.startsWith(prefix)))topicIds.add(currentId);
      }
    }
    const oldTopicCount=rows(state.topics).length,oldSubjectCount=rows(state.subjects).length;
    const oldHistoryCount=rows(state.history).length,oldStreamCount=rows(state.streams).length;
    if(topicIds.size)state.topics=rows(state.topics).filter(topic=>!topicIds.has(String(topic.id||'')));
    if(deletedPackScope){
      state.history=rows(state.history).filter(entry=>!subjectIds.has(String(entry.subjectId))&&
        !topicIds.has(String(entry.topicId))&&!(pack.streamId&&String(entry.streamId)===String(pack.streamId)));
      state.subjects=rows(state.subjects).filter(subject=>!subjectIds.has(String(subject.id)));
      state.streams=rows(state.streams).filter(item=>!(pack.streamId&&String(item.id)===String(pack.streamId))&&
        normalizeName(item.name)!==normalizeName(pack.streamName));
    }else{
      if(subjectIds.size||topicIds.size||deletedTopicNames.length){
        state.history=rows(state.history).filter(entry=>{
          if(subjectIds.has(String(entry.subjectId))||topicIds.has(String(entry.topicId)))return false;
          return !deletedTopicNames.some(item=>item.subjectId&&String(entry.subjectId||'')===item.subjectId&&String(entry.topicName||'')===item.name);
        });
      }
      if(subjectIds.size)state.subjects=rows(state.subjects).filter(subject=>!subjectIds.has(String(subject.id)));
    }
    return rows(state.topics).length!==oldTopicCount||rows(state.subjects).length!==oldSubjectCount||
      rows(state.history).length!==oldHistoryCount||rows(state.streams).length!==oldStreamCount;
  }
  function sameStringList(a,b){
    if(!Array.isArray(a)||!Array.isArray(b)||a.length!==b.length)return false;
    for(let i=0;i<a.length;i++)if(a[i]!==b[i])return false;
    return true;
  }
  function repair(state, packs, options) {
    const opts=options||{};
    if(!isRecord(state)||!Array.isArray(packs))return {state,changed:false,restoredStreams:0,restoredSubjects:0,restoredTopics:0};
    const beforeInstalled=state.settings&&state.settings.installedCurricula;
    const beforeDeleted=state.settings&&state.settings.curriculumTombstones;
    const marker=ensureState(state);
    let changed=!sameStringList(beforeInstalled,state.settings.installedCurricula)||
      !sameStringList(beforeDeleted,state.settings.curriculumTombstones);
    let restoredStreams=0,restoredSubjects=0,restoredTopics=0;
    for(const pack of packs){
      if(!isRecord(pack)||!pack.id||!Array.isArray(pack.subjects))continue;
      const id=String(pack.id);
      // Apply all tombstones with one workspace filtering pass per collection.
      // Never serialize the entire 77k+ workspace just to detect whether repair changed it.
      if(purgeDeletedScope(state,pack,marker.deleted))changed=true;
      if(marker.deleted.has(deletedPack(id)))continue;
      const existingStream=findStream(state,pack);
      let intent=rows(state.settings.installedCurricula).filter(value=>isInstalledMarkerForPack(value,id));
      if(!intent.length&&hasLegacyPackEvidence(state,pack)){
        marker.installed.add(packMarker(id));intent=[packMarker(id)];changed=true;
      }
      if(!intent.length)continue;
      const installAll=marker.installed.has(packMarker(id));
      const selected=pack.subjects.map(definition=>{
        const full=installAll||marker.installed.has(subjectMarker(id,definition.id));
        const topics=full?rows(definition.topics):rows(definition.topics).filter(name=>marker.installed.has(topicMarker(id,definition.id,name)));
        return {definition,full,topics};
      }).filter(entry=>entry.full||entry.topics.length);
      if(!selected.length)continue;
      const stream=existingStream||ensureStream(state,pack,opts.makeId);
      if(!existingStream){restoredStreams++;changed=true;}
      for(const entry of selected){
        const definition=entry.definition;
        if(marker.deleted.has(deletedSubject(id,definition.id)))continue;
        const oldSubjectLength=state.subjects.length;
        const subject=ensureSubject(state,pack,definition,stream,opts.makeId);
        if(state.subjects.length>oldSubjectLength){restoredSubjects++;changed=true;}
        else if(String(subject.streamId)!==String(stream.id)){changed=true;}
        for(const name of entry.topics){
          if(marker.deleted.has(deletedTopic(id,definition.id,name)))continue;
          const existing=topicByCatalogIdentity(state,definition,name,subject);
          if(existing){
            if(String(existing.subjectId)!==String(subject.id)){existing.subjectId=subject.id;changed=true;}
            continue;
          }
          state.topics.push({
            id:makeTopicId(state,definition,name,opts.makeId),subjectId:subject.id,name:String(name),
            notes:'',custom:false,createdAt:typeof opts.today==='function'?opts.today():new Date().toISOString().slice(0,10),
            lastReviewed:'',lastRating:null,dueDate:'',intervalDays:0,reviewCount:0,streak:0,lapses:0,archived:false
          });
          restoredTopics++;changed=true;
        }
      }
    }
    const installed=Array.from(marker.installed).slice(-5000),tombstones=Array.from(marker.deleted).slice(-5000);
    if(!sameStringList(state.settings.installedCurricula,installed)||
      !sameStringList(state.settings.curriculumTombstones,tombstones))changed=true;
    state.settings.installedCurricula=installed;
    state.settings.curriculumTombstones=tombstones;
    return {state,changed,restoredStreams,restoredSubjects,restoredTopics};
  }
  function markInstalled(state, pack, scope, subjectId, topicName) {
    if (!isRecord(state) || !isRecord(pack) || !pack.id) return;
    const marker = ensureState(state), id = String(pack.id), type = scope || 'pack';
    marker.deleted.delete(deletedPack(id));
    if (type === 'pack') {
      for (const item of Array.from(marker.installed)) if (isInstalledMarkerForPack(item, id)) marker.installed.delete(item);
      marker.installed.add(packMarker(id));
      for (const item of Array.from(marker.deleted)) if (item === deletedPack(id) || item.startsWith('deleted:subject:' + id + ':') || item.startsWith('deleted:topic:' + id + ':')) marker.deleted.delete(item);
    } else {
      const definition = pack.subjects.find(item => String(item.id) === String(subjectId));
      if (!definition) return;
      marker.deleted.delete(deletedSubject(id, definition.id));
      if (type === 'subject') {
        const hadFullPack = marker.installed.has(packMarker(id));
        marker.installed.delete(packMarker(id));
        marker.installed.add(subjectMarker(id, definition.id));
        for (const name of definition.topics) marker.deleted.delete(deletedTopic(id, definition.id, name));
        // If a full-pack marker existed, materialize its intent for every unaffected subject.
        if (hadFullPack) for (const other of pack.subjects) {
          if (String(other.id) !== String(definition.id) && !marker.deleted.has(deletedSubject(id, other.id)) &&
              !marker.installed.has(subjectMarker(id, other.id))) marker.installed.add(subjectMarker(id, other.id));
        }
      } else if (type === 'topic' && topicName !== undefined && topicName !== null) {
        marker.installed.add(topicMarker(id, definition.id, topicName));
        marker.deleted.delete(deletedTopic(id, definition.id, topicName));
      }
    }
    state.settings.installedCurricula = Array.from(marker.installed).slice(-5000);
    state.settings.curriculumTombstones = Array.from(marker.deleted).slice(-5000);
  }
  function packContext(state, packs, subject) {
    if (!subject) return null;
    const stream = rows(state.streams).find(item => String(item.id) === String(subject.streamId));
    for (const pack of rows(packs)) {
      if (!pack || !pack.id || !(pack.streamId && stream && String(stream.id) === String(pack.streamId)) &&
          normalizeName(stream && stream.name) !== normalizeName(pack && pack.streamName)) continue;
      const definition = rows(pack.subjects).find(item => (item.workspaceId && String(item.workspaceId) === String(subject.id)) || normalizeName(item.name) === normalizeName(subject.name));
      if (definition) return { pack, definition };
    }
    return null;
  }
  function markDeletedTopic(state, packs, topic) {
    if (!isRecord(state) || !topic) return;
    const subject = rows(state.subjects).find(item => String(item.id) === String(topic.subjectId));
    const context = packContext(state, packs, subject);
    if (!context) return;
    let catalogueName = rows(context.definition.topics).includes(String(topic.name)) ? String(topic.name) : '';
    if (!catalogueName) catalogueName = rows(context.definition.topics).find(name =>
      String(topic.id) === topicIdFor(context.definition, name) || String(topic.id) === oldTopicIdFor(context.definition, name)) || '';
    if (!catalogueName) return;
    const marker = ensureState(state);
    marker.deleted.add(deletedTopic(context.pack.id, context.definition.id, catalogueName));
    marker.installed.delete(topicMarker(context.pack.id, context.definition.id, catalogueName));
    state.settings.installedCurricula = Array.from(marker.installed).slice(-5000);
    state.settings.curriculumTombstones = Array.from(marker.deleted).slice(-5000);
  }
  function markDeletedSubject(state, packs, subject) {
    const context = packContext(state, packs, subject);
    if (!context) return;
    const marker = ensureState(state), id = String(context.pack.id), sid = String(context.definition.id);
    if (marker.installed.has(packMarker(id))) {
      marker.installed.delete(packMarker(id));
      for (const other of context.pack.subjects) if (String(other.id) !== sid && !marker.deleted.has(deletedSubject(id, other.id))) marker.installed.add(subjectMarker(id, other.id));
    }
    marker.installed.delete(subjectMarker(id, sid));
    for (const item of Array.from(marker.installed)) if (item.startsWith('installed:topic:' + id + ':' + sid + ':')) marker.installed.delete(item);
    marker.deleted.add(deletedSubject(id, sid));
    for (const name of context.definition.topics) marker.deleted.add(deletedTopic(id, sid, name));
    state.settings.installedCurricula = Array.from(marker.installed).slice(-5000);
    state.settings.curriculumTombstones = Array.from(marker.deleted).slice(-5000);
  }
  function markDeletedStream(state, packs, stream) {
    if (!isRecord(state) || !stream) return;
    const marker = ensureState(state);
    for (const pack of rows(packs)) {
      if (!(pack.streamId && String(stream.id) === String(pack.streamId)) && normalizeName(stream.name) !== normalizeName(pack.streamName)) continue;
      const id = String(pack.id);
      for (const item of Array.from(marker.installed)) if (isInstalledMarkerForPack(item, id)) marker.installed.delete(item);
      marker.deleted.add(deletedPack(id));
    }
    state.settings.installedCurricula = Array.from(marker.installed).slice(-5000);
    state.settings.curriculumTombstones = Array.from(marker.deleted).slice(-5000);
  }
  function diagnose(state, packs) {
    const results = [];
    for (const pack of rows(packs)) {
      const markers = rows(state && state.settings && state.settings.installedCurricula).filter(value => isInstalledMarkerForPack(value, String(pack.id)));
      results.push({ packId: pack.id, hasStream: !!findStream(state, pack), markerCount: markers.length,
        topicCount: rows(pack.subjects).reduce((total, subject) => total + rows(subject.topics).filter(name => {
          const sub = findSubject(state, pack, subject, findStream(state, pack));
          return !!sub && rows(state.topics).some(topic => String(topic.subjectId) === String(sub.id) && String(topic.name) === String(name));
        }).length, 0) });
    }
    return results;
  }
  function intentMarkerDetails(value) {
    const marker = String(value || '');
    const match = /^(installed|deleted):(pack|subject|topic):([^:]+)(?::([^:]+)(?::([\s\S]*))?)?$/.exec(marker);
    if (!match) return null;
    return {
      verb: match[1],
      action: match[1] === 'installed' ? 'install' : 'delete',
      scope: match[2],
      packId: match[3],
      subjectId: match[4] || '',
      topicToken: match[5] || '',
      token: marker.replace(/^(installed|deleted):/, '')
    };
  }
  function intentState(source) {
    const settings = isRecord(source && source.settings) ? source.settings : {};
    const installed = new Set(uniqueStrings(settings.installedCurricula));
    const deleted = new Set(uniqueStrings(settings.curriculumTombstones));
    const tokens = new Set();
    for (const marker of [...installed, ...deleted]) {
      const parsed = intentMarkerDetails(marker);
      if (parsed) tokens.add(parsed.token);
    }
    return { installed, deleted, tokens };
  }
  function intentForToken(map, token) {
    if (map.deleted.has('deleted:' + token)) return 'delete';
    if (map.installed.has('installed:' + token)) return 'install';
    return null;
  }
  function markerAffectedByLocalIntent(action, marker) {
    const target = intentMarkerDetails(marker);
    if (!target || target.packId !== action.packId) return false;
    if (action.action === 'install') {
      if (target.verb !== 'deleted') return false;
      if (action.scope === 'pack') return true;
      if (target.scope === 'pack') return true;
      if (action.scope === 'subject') return target.subjectId === action.subjectId;
      if (action.scope === 'topic') {
        if (target.subjectId !== action.subjectId) return false;
        return target.scope === 'subject' || (target.scope === 'topic' && target.token === action.token);
      }
      return false;
    }
    if (target.verb !== 'installed') return false;
    if (action.scope === 'pack') return true;
    if (action.scope === 'subject') return target.scope === 'pack' || target.subjectId === action.subjectId;
    if (action.scope === 'topic') return target.scope === 'topic' && target.token === action.token;
    return false;
  }
  function deletionBlocksInstalledMarker(installedMarker, deletedMarkers) {
    const target = intentMarkerDetails(installedMarker);
    if (!target || target.verb !== 'installed') return false;
    const id = target.packId;
    if (deletedMarkers.has(deletedPack(id))) return true;
    // A deleted subject removes the full-pack marker; keep it from being restored
    // just because an older baseline still said the whole pack was installed.
    if (target.scope === 'pack') {
      return Array.from(deletedMarkers).some(marker =>
        marker.startsWith('deleted:subject:' + id + ':'));
    }
    if (deletedMarkers.has(deletedSubject(id, target.subjectId))) return true;
    if (target.scope === 'topic' && deletedMarkers.has('deleted:' + target.token)) return true;
    return false;
  }
  function reconcileMergedIntents(baseState, localState, remoteState, mergedState) {
    if (!isRecord(mergedState)) return { changed: false, conflicts: [] };
    if (!isRecord(mergedState.settings)) mergedState.settings = {};
    const base = baseState ? intentState(baseState) : null;
    const local = intentState(localState);
    const remote = intentState(remoteState);
    const merged = intentState(mergedState);
    const actions = [];
    const tokens = new Set([...(base ? base.tokens : []), ...local.tokens]);
    for (const token of tokens) {
      const localIntent = intentForToken(local, token);
      const baseIntent = base ? intentForToken(base, token) : null;
      if (localIntent && (!base || localIntent !== baseIntent)) {
        const parsed = intentMarkerDetails((localIntent === 'install' ? 'installed:' : 'deleted:') + token);
        if (parsed) actions.push(parsed);
      }
    }
    const conflicts = [], seenConflicts = new Set();
    let changed = false;
    for (const action of actions) {
      const remoteOpposite = action.action === 'install' ? remote.deleted : remote.installed;
      const localOpposite = action.action === 'install' ? local.deleted : local.installed;
      const mergedOpposite = action.action === 'install' ? merged.deleted : merged.installed;
      const baseOpposite = base ? (action.action === 'install' ? base.deleted : base.installed) : new Set();
      for (const marker of remoteOpposite) {
        if (localOpposite.has(marker) || !markerAffectedByLocalIntent(action, marker)) continue;
        if (!mergedOpposite.delete(marker)) continue;
        changed = true;
        const remoteChanged = !base || !baseOpposite.has(marker);
        if (remoteChanged) {
          const conflictKey = action.token + '|' + marker;
          if (!seenConflicts.has(conflictKey)) {
            seenConflicts.add(conflictKey);
            conflicts.push({
              path: 'state.settings.curriculumIntent.' + action.token,
              base: base ? intentForToken(base, action.token) : null,
              local: action.action,
              remote: intentMarkerDetails(marker)?.action || (action.action === 'install' ? 'delete' : 'install'),
              basePresent: !!base,
              localPresent: true,
              remotePresent: true,
              resolution: 'local',
              marker
            });
          }
        }
      }
    }
    // Missing markers are not uninstall intent. Preserve local install intent and
    // recover it from the last verified base as well: an older incomplete cloud write
    // can remove the marker from BOTH the current local state and cloud, while the
    // queue's verified base is the only remaining evidence that the catalogue existed.
    // Explicit uninstall/delete tombstones still win.
    for (const marker of [...local.installed, ...(base ? base.installed : [])]) {
      if (deletionBlocksInstalledMarker(marker, merged.deleted)) continue;
      if (!merged.installed.has(marker)) {
        merged.installed.add(marker);
        changed = true;
      }
    }
    mergedState.settings.installedCurricula = Array.from(merged.installed).filter(marker => {
      const parsed = intentMarkerDetails(marker);
      return !parsed || parsed.verb === 'installed';
    }).slice(-5000);
    mergedState.settings.curriculumTombstones = Array.from(merged.deleted).filter(marker => {
      const parsed = intentMarkerDetails(marker);
      return !parsed || parsed.verb === 'deleted';
    }).slice(-5000);
    return { changed, conflicts };
  }
  function restoreMissingInstalledRows(baseState, localState, remoteState, mergedState, packs) {
    if (!isRecord(mergedState) || !Array.isArray(packs)) return { changed: false, restoredStreams: 0, restoredSubjects: 0, restoredTopics: 0 };
    if (!isRecord(mergedState.settings)) mergedState.settings = {};
    const intent = intentState(mergedState);
    const localIntent = intentState(localState);
    const baseIntent = baseState ? intentState(baseState) : { installed: new Set(), deleted: new Set(), tokens: new Set() };
    const sources = [localState, baseState].filter(isRecord);
    let changed = false, restoredStreams = 0, restoredSubjects = 0, restoredTopics = 0;
    const sourceStream = pack => sources.map(state => findStream(state, pack)).find(Boolean) || null;
    const sourceSubject = (pack, definition) => {
      for (const source of sources) {
        const stream = findStream(source, pack);
        const match = rows(source.subjects).find(subject =>
          (definition.workspaceId && String(subject.id) === String(definition.workspaceId)) ||
          (!!stream && String(subject.streamId) === String(stream.id) && normalizeName(subject.name) === normalizeName(definition.name)));
        if (match) return match;
      }
      return null;
    };
    for (const pack of packs) {
      if (!isRecord(pack) || !pack.id || !Array.isArray(pack.subjects)) continue;
      const id = String(pack.id);
      if (intent.deleted.has(deletedPack(id))) continue;
      // A subject deletion narrows a formerly full-pack install into the remaining
      // subjects. Do not let the cloud's missing sibling markers make all untouched
      // subjects vanish when only one subject has an explicit deletion tombstone.
      const wasFullInstalled = localIntent.installed.has(packMarker(id)) || baseIntent.installed.has(packMarker(id));
      const hasSubjectDeletion = rows(pack.subjects).some(definition => intent.deleted.has(deletedSubject(id, definition.id)));
      if (wasFullInstalled && hasSubjectDeletion) {
        if (intent.installed.delete(packMarker(id))) changed = true;
        for (const definition of pack.subjects) {
          if (intent.deleted.has(deletedSubject(id, definition.id))) continue;
          const scoped = subjectMarker(id, definition.id);
          if (!intent.installed.has(scoped)) { intent.installed.add(scoped); changed = true; }
        }
      }
      const installAll = intent.installed.has(packMarker(id));
      const selected = pack.subjects.map(definition => {
        if (intent.deleted.has(deletedSubject(id, definition.id))) return null;
        const full = installAll || intent.installed.has(subjectMarker(id, definition.id));
        const names = rows(definition.topics).filter(name =>
          (full || intent.installed.has(topicMarker(id, definition.id, name))) &&
          !intent.deleted.has(deletedTopic(id, definition.id, name)));
        return full || names.length ? { definition, names } : null;
      }).filter(Boolean);
      if (!selected.length) continue;

      let stream = findStream(mergedState, pack);
      if (!stream) {
        const existing = sourceStream(pack);
        const candidate = existing ? { ...existing } : {
          id: String(pack.streamId || 'stream-' + id),
          name: String(pack.streamName || pack.title || 'Curriculum')
        };
        if (rows(mergedState.streams).some(item => String(item.id) === String(candidate.id))) {
          candidate.id = String(pack.streamId || candidate.id) + '-restored';
          let suffix = 2;
          while (rows(mergedState.streams).some(item => String(item.id) === String(candidate.id))) {
            candidate.id = String(pack.streamId || 'stream-' + id) + '-restored-' + suffix++;
          }
        }
        mergedState.streams.push(candidate);
        stream = candidate;
        changed = true;
        restoredStreams++;
      }

      for (const entry of selected) {
        const definition = entry.definition;
        let subject = rows(mergedState.subjects).find(item =>
          (definition.workspaceId && String(item.id) === String(definition.workspaceId)) ||
          (String(item.streamId) === String(stream.id) && normalizeName(item.name) === normalizeName(definition.name)));
        if (!subject) {
          const source = sourceSubject(pack, definition);
          subject = source ? { ...source, streamId: String(stream.id) } : {
            id: String(definition.workspaceId || 'subject-' + id + '-' + definition.id),
            name: String(definition.name || 'Subject'),
            streamId: String(stream.id),
            order: rows(mergedState.subjects).filter(item => String(item.streamId) === String(stream.id)).length
          };
          if (rows(mergedState.subjects).some(item => String(item.id) === String(subject.id))) {
            subject.id = String(subject.id) + '-restored';
          }
          mergedState.subjects.push(subject);
          changed = true;
          restoredSubjects++;
        } else if (String(subject.streamId) !== String(stream.id)) {
          subject.streamId = String(stream.id);
          changed = true;
        }

        for (const name of entry.names) {
          if (topicByCatalogIdentity(mergedState, definition, name, subject)) continue;
          let sourceTopic = null;
          for (const sourceState of sources) {
            const sourceSubjectRecord = rows(sourceState.subjects).find(item =>
              (definition.workspaceId && String(item.id) === String(definition.workspaceId)) ||
              normalizeName(item.name) === normalizeName(definition.name));
            sourceTopic = topicByCatalogIdentity(sourceState, definition, name, sourceSubjectRecord);
            if (sourceTopic) break;
          }
          if (!sourceTopic) continue;
          mergedState.topics.push({ ...sourceTopic, subjectId: String(subject.id) });
          changed = true;
          restoredTopics++;
        }
      }
    }
    mergedState.settings.installedCurricula = Array.from(intent.installed).slice(-5000);
    mergedState.settings.curriculumTombstones = Array.from(intent.deleted).slice(-5000);
    return { changed, restoredStreams, restoredSubjects, restoredTopics };
  }
  return {
    keys: { pack: packMarker, subject: subjectMarker, topic: topicMarker, deletedPack, deletedSubject, deletedTopic },
    repair, markInstalled, markDeletedTopic, markDeletedSubject, markDeletedStream, diagnose, reconcileMergedIntents,
    restoreMissingInstalledRows
  };
});
