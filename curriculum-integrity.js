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
    const id = String(pack.id), stream = findStream(state, pack);
    const streamMatches = subject => {
      const parent = rows(state.streams).find(item => String(item.id) === String(subject.streamId));
      return !!parent && ((pack.streamId && String(parent.id) === String(pack.streamId)) ||
        normalizeName(parent.name) === normalizeName(pack.streamName));
    };
    const definitions = rows(pack.subjects);
    if (deleted.has(deletedPack(id))) {
      const subjectIds = new Set(rows(state.subjects).filter(subject =>
        definitions.some(definition => definition.workspaceId && String(subject.id) === String(definition.workspaceId)) ||
        (streamMatches(subject) && definitions.some(definition =>
          normalizeName(subject.name) === normalizeName(definition.name)))).map(subject => String(subject.id)));
      const topicIds = new Set(rows(state.topics).filter(topic => {
        const subject = rows(state.subjects).find(item => String(item.id) === String(topic.subjectId));
        return subjectIds.has(String(topic.subjectId)) || definitions.some(definition => {
          const prefix = canonicalPrefix(definition) + '-', oldPrefix = legacyPrefix(definition) + '-';
          return String(topic.id || '').startsWith(prefix) || String(topic.id || '').startsWith(oldPrefix);
        });
      }).map(topic => String(topic.id)));
      state.topics = rows(state.topics).filter(topic => !topicIds.has(String(topic.id)));
      state.history = rows(state.history).filter(entry => !subjectIds.has(String(entry.subjectId)) &&
        !topicIds.has(String(entry.topicId)) && !(pack.streamId && String(entry.streamId) === String(pack.streamId)));
      state.subjects = rows(state.subjects).filter(subject => !subjectIds.has(String(subject.id)));
      state.streams = rows(state.streams).filter(item =>
        !(pack.streamId && String(item.id) === String(pack.streamId)) &&
        normalizeName(item.name) !== normalizeName(pack.streamName));
      return;
    }
    for (const definition of definitions) {
      if (deleted.has(deletedSubject(id, definition.id))) {
        const subjectIds = new Set(rows(state.subjects).filter(subject =>
          (definition.workspaceId && String(subject.id) === String(definition.workspaceId)) ||
          (streamMatches(subject) && normalizeName(subject.name) === normalizeName(definition.name))).map(subject => String(subject.id)));
        const topicIds = new Set(rows(state.topics).filter(topic => {
          const currentId = String(topic.id || '');
          return subjectIds.has(String(topic.subjectId)) ||
            currentId.startsWith(canonicalPrefix(definition) + '-') ||
            currentId.startsWith(legacyPrefix(definition) + '-');
        }).map(topic => String(topic.id)));
        state.topics = rows(state.topics).filter(topic => !topicIds.has(String(topic.id)));
        state.history = rows(state.history).filter(entry => !subjectIds.has(String(entry.subjectId)) && !topicIds.has(String(entry.topicId)));
        state.subjects = rows(state.subjects).filter(subject => !subjectIds.has(String(subject.id)));
      }
      for (const name of rows(definition.topics)) {
        if (!deleted.has(deletedTopic(id, definition.id, name))) continue;
        const ids = new Set([topicIdFor(definition, name), oldTopicIdFor(definition, name)].filter(Boolean));
        const subject = rows(state.subjects).find(item =>
          (definition.workspaceId && String(item.id) === String(definition.workspaceId)) ||
          (stream && String(item.streamId) === String(stream.id) && normalizeName(item.name) === normalizeName(definition.name)));
        const removed = rows(state.topics).filter(topic => ids.has(String(topic.id)) ||
          (!!subject && String(topic.subjectId) === String(subject.id) && String(topic.name) === String(name)));
        const topicIds = new Set(removed.map(topic => String(topic.id)));
        state.topics = rows(state.topics).filter(topic => !topicIds.has(String(topic.id)));
        state.history = rows(state.history).filter(entry => !topicIds.has(String(entry.topicId)) &&
          !(String(entry.subjectId || '') === String(subject && subject.id || '') && String(entry.topicName || '') === String(name)));
      }
    }
  }
  function repair(state, packs, options) {
    const opts = options || {};
    if (!isRecord(state) || !Array.isArray(packs)) return { state, changed: false, restoredStreams: 0, restoredSubjects: 0, restoredTopics: 0 };
    const marker = ensureState(state);
    const before = JSON.stringify({ settings: state.settings, streams: state.streams, subjects: state.subjects, topics: state.topics });
    let restoredStreams = 0, restoredSubjects = 0, restoredTopics = 0;
    for (const pack of packs) {
      if (!isRecord(pack) || !pack.id || !Array.isArray(pack.subjects)) continue;
      const id = String(pack.id);
      // Deletion tombstones must also remove matching rows from a stale snapshot before
      // repair. Merely skipping reconstruction would allow a cloud merge to resurrect them.
      purgeDeletedScope(state, pack, marker.deleted);
      if (marker.deleted.has(deletedPack(id))) continue;
      const existingStream = findStream(state, pack);
      let intent = rows(state.settings.installedCurricula).filter(value => isInstalledMarkerForPack(value, id));
      if (!intent.length && hasLegacyPackEvidence(state, pack)) {
        marker.installed.add(packMarker(id));
        intent = [packMarker(id)];
      }
      if (!intent.length) continue;
      const installAll = marker.installed.has(packMarker(id));
      const selected = pack.subjects.map(definition => {
        const full = installAll || marker.installed.has(subjectMarker(id, definition.id));
        const topics = full ? rows(definition.topics) : rows(definition.topics).filter(name => marker.installed.has(topicMarker(id, definition.id, name)));
        return { definition, full, topics };
      }).filter(entry => entry.full || entry.topics.length);
      if (!selected.length) continue;
      const stream = existingStream || ensureStream(state, pack, opts.makeId);
      if (!existingStream) restoredStreams++;
      for (const entry of selected) {
        const definition = entry.definition;
        if (marker.deleted.has(deletedSubject(id, definition.id))) continue;
        const beforeSubjectCount = state.subjects.length;
        const subject = ensureSubject(state, pack, definition, stream, opts.makeId);
        if (state.subjects.length > beforeSubjectCount) restoredSubjects++;
        for (const name of entry.topics) {
          if (marker.deleted.has(deletedTopic(id, definition.id, name))) continue;
          const existing = topicByCatalogIdentity(state, definition, name, subject);
          if (existing) {
            // Keep edited names, notes, reviews, FSRS state, and history IDs. Stable catalogue
            // IDs map a renamed topic back to its identity without cloning the original name.
            if (String(existing.subjectId) !== String(subject.id)) existing.subjectId = subject.id;
            continue;
          }
          const topic = {
            id: makeTopicId(state, definition, name, opts.makeId),
            subjectId: subject.id,
            name: String(name),
            notes: '',
            custom: false,
            createdAt: typeof opts.today === 'function' ? opts.today() : new Date().toISOString().slice(0, 10),
            lastReviewed: '',
            lastRating: null,
            dueDate: '',
            intervalDays: 0,
            reviewCount: 0,
            streak: 0,
            lapses: 0,
            archived: false
          };
          state.topics.push(topic);
          restoredTopics++;
        }
      }
    }
    state.settings.installedCurricula = Array.from(marker.installed).slice(-5000);
    state.settings.curriculumTombstones = Array.from(marker.deleted).slice(-5000);
    const after = JSON.stringify({ settings: state.settings, streams: state.streams, subjects: state.subjects, topics: state.topics });
    return { state, changed: before !== after, restoredStreams, restoredSubjects, restoredTopics };
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
    const match = /^(installed|deleted):(pack|subject|topic):([^:]+)(?::([^:]+)(?::([\\s\\S]*))?)?$/.exec(marker);
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
  return {
    keys: { pack: packMarker, subject: subjectMarker, topic: topicMarker, deletedPack, deletedSubject, deletedTopic },
    repair, markInstalled, markDeletedTopic, markDeletedSubject, markDeletedStream, diagnose, reconcileMergedIntents
  };
});
