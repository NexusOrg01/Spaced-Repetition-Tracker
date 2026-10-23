(function(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.NexusExploreCurriculum = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : null), function() {
  'use strict';

  const isRecord = value => !!value && typeof value === 'object' && !Array.isArray(value);
  const rows = value => Array.isArray(value) ? value : [];
  function validateCatalog(raw) {
    if (!raw || raw.version !== 1 || !Array.isArray(raw.packs) || !raw.packs.length) {
      throw new Error('Catalogue must contain a version 1 packs array.');
    }
    const packIds = new Set();
    const packs = raw.packs.map((entry, packIndex) => {
      if (!isRecord(entry)) throw new Error('Invalid pack at position ' + (packIndex + 1) + '.');
      const id = String(entry.id || '').trim();
      const title = String(entry.title || '').trim();
      const country = String(entry.country || '').trim();
      const exam = String(entry.exam || '').trim();
      const language = String(entry.language || '').trim();
      const streamName = String(entry.streamName || '').trim();
      if (!/^[a-z0-9][a-z0-9-]{1,79}$/i.test(id) || !title || !country || !exam || !language || !streamName) {
        throw new Error('Pack metadata is incomplete or has an invalid id: ' + (id || 'unnamed pack'));
      }
      if (packIds.has(id)) throw new Error('Duplicate pack id: ' + id);
      packIds.add(id);
      if (!Array.isArray(entry.subjects) || !entry.subjects.length) throw new Error('Pack ' + id + ' must contain subjects.');
      const subjectIds = new Set();
      const cleanSubjects = entry.subjects.map((subject, subjectIndex) => {
        if (!isRecord(subject)) throw new Error('Invalid subject in pack ' + id + '.');
        const sid = String(subject.id || '').trim();
        const name = String(subject.name || '').trim();
        if (!/^[a-z0-9][a-z0-9-]{0,79}$/i.test(sid) || !name) {
          throw new Error('Subject metadata is incomplete in pack ' + id + ', position ' + (subjectIndex + 1) + '.');
        }
        if (subjectIds.has(sid)) throw new Error('Duplicate subject id ' + sid + ' in pack ' + id + '.');
        subjectIds.add(sid);
        if (!Array.isArray(subject.topics) || !subject.topics.length) throw new Error('Subject ' + name + ' in pack ' + id + ' must contain topics.');
        const topicNames = new Set();
        const topics = subject.topics.map(value => {
          if (typeof value !== 'string') throw new Error('Topics must be plain strings in ' + id + '/' + sid + '.');
          const topic = value.trim();
          if (!topic || topic.length > 240) throw new Error('A topic in ' + id + '/' + sid + ' is empty or exceeds 240 characters.');
          const key = topic.toLocaleLowerCase();
          if (topicNames.has(key)) throw new Error('Duplicate topic ' + topic + ' in ' + id + '/' + sid + '.');
          topicNames.add(key);
          return topic;
        });
        const workspaceId = typeof subject.workspaceId === 'string' && subject.workspaceId.trim() ? subject.workspaceId.trim() : '';
        const legacyIdPrefix = typeof subject.legacyIdPrefix === 'string' && /^[a-z0-9-]+$/i.test(subject.legacyIdPrefix) ? subject.legacyIdPrefix : '';
        return { id: sid, name, workspaceId, legacyIdPrefix, topics };
      });
      const keywords = Array.isArray(entry.keywords) ? entry.keywords.filter(x => typeof x === 'string' && x.trim()).map(x => x.trim()) : [];
      return {
        id, title, country, exam, language, streamName,
        streamId: typeof entry.streamId === 'string' ? entry.streamId.trim() : '',
        description: String(entry.description || '').trim(),
        keywords, subjects: cleanSubjects
      };
    });
    if (!packs.some(pack => pack.id === 'sl-al-commerce-si')) throw new Error('The existing Commerce starter pack must remain in the catalogue.');
    return packs;
  }

  function clone(value) { return JSON.parse(JSON.stringify(value)); }
  const normalizedName = value => String(value || '').trim().toLocaleLowerCase();

  function create(deps) {
    const d = deps || {};
    if (typeof d.getState !== 'function' || typeof d.setState !== 'function' ||
        typeof d.getPacks !== 'function' || typeof d.setPacks !== 'function' ||
        typeof d.save !== 'function' || typeof d.renderAll !== 'function') {
      throw new Error('Explore Curriculum requires explicit workspace and persistence adapters.');
    }
    const doc = d.document || (typeof document !== 'undefined' ? document : null);
    const fetcher = d.fetch || (typeof fetch === 'function' ? fetch.bind(typeof globalThis !== 'undefined' ? globalThis : null) : null);

    function findPackStream(pack, state) {
      const streams = rows(state && state.streams);
      return (pack.streamId ? streams.find(stream => String(stream.id) === String(pack.streamId)) : null) ||
        streams.find(stream => normalizedName(stream.name) === normalizedName(pack.streamName)) || null;
    }
    function findPackSubject(pack, subject, stream, state) {
      if (!stream) return null;
      const subjects = rows(state && state.subjects);
      return (subject.workspaceId ? subjects.find(item => String(item.streamId) === String(stream.id) && String(item.id) === String(subject.workspaceId)) : null) ||
        subjects.find(item => String(item.streamId) === String(stream.id) && normalizedName(item.name) === normalizedName(subject.name)) || null;
    }
    function topicCatalogueId(subject, name) {
      if (!subject.legacyIdPrefix) return '';
      const index = subject.topics.indexOf(name);
      return index < 0 ? '' : subject.legacyIdPrefix + '-' + String(index + 1).padStart(2, '0');
    }
    function installedTopicCount(pack, subject, state) {
      const stream = findPackStream(pack, state);
      const installedSubject = findPackSubject(pack, subject, stream, state);
      if (!installedSubject) return 0;
      return rows(state.topics).filter(topic => String(topic.subjectId) === String(installedSubject.id) &&
        (subject.topics.includes(String(topic.name)) || subject.topics.some(name => topicCatalogueId(subject, name) && String(topic.id) === topicCatalogueId(subject, name)))).length;
    }
    function esc(value) {
      if (typeof d.esc === 'function') return d.esc(value);
      return String(value == null ? '' : value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    }
    function render() {
      if (!doc) return;
      const host = doc.getElementById('exploreGrid');
      if (!host) return;
      const search = doc.getElementById('exploreSearch');
      const query = String(search && search.value || '').trim().toLocaleLowerCase();
      const packs = rows(d.getPacks()).map(pack => {
        const packText = [pack.title, pack.country, pack.exam, pack.language, pack.streamName, pack.description, ...pack.keywords].join(' ').toLocaleLowerCase();
        const packMatches = !query || packText.includes(query);
        const visibleSubjects = pack.subjects.map(subject => ({
          ...subject,
          visibleTopics: subject.topics.filter(topic => !query || packMatches || subject.name.toLocaleLowerCase().includes(query) || topic.toLocaleLowerCase().includes(query))
        })).filter(subject => !query || packMatches || subject.visibleTopics.length > 0 || subject.name.toLocaleLowerCase().includes(query));
        return { ...pack, visibleSubjects, packMatches, totalTopics: pack.subjects.reduce((n, subject) => n + subject.topics.length, 0) };
      }).filter(pack => !query || pack.packMatches || pack.visibleSubjects.length);
      const catalogCount = doc.getElementById('exploreCatalogCount');
      const resultCount = doc.getElementById('exploreResultCount');
      if (catalogCount) catalogCount.textContent = rows(d.getPacks()).reduce((n, pack) => n + pack.subjects.reduce((m, subject) => m + subject.topics.length, 0), 0);
      if (resultCount) resultCount.textContent = packs.reduce((n, pack) => n + pack.visibleSubjects.reduce((m, subject) => m + subject.visibleTopics.length, 0), 0) + ' topics shown';
      const state = d.getState();
      host.innerHTML = packs.map(pack => {
        const installed = pack.subjects.reduce((n, subject) => n + installedTopicCount(pack, subject, state), 0);
        const courseAction = installed ? 'Add missing topics' : 'Install full pack';
        const cards = pack.visibleSubjects.map(subject => {
          const count = installedTopicCount(pack, subject, state);
          return '<section class="explore-subject-card"><div class="explore-subject-head"><div><h4>' + esc(subject.name) + '</h4><p>' +
            subject.visibleTopics.length + ' matching of ' + subject.topics.length + ' topics</p></div><span class="explore-count-pill">' +
            count + '/' + subject.topics.length + ' added</span></div><details class="explore-topic-details"><summary>Preview topic list</summary><ol>' +
            subject.visibleTopics.map(topic => '<li class="explore-topic-row"><span>' + esc(topic) + '</span><button type="button" class="btn btn-sm" data-explore-action="install-topic" data-pack-id="' +
              esc(pack.id) + '" data-subject-id="' + esc(subject.id) + '" data-topic-name="' + esc(topic) + '">Add topic</button></li>').join('') +
            '</ol></details><button type="button" class="btn btn-sm" data-explore-action="install-subject" data-pack-id="' + esc(pack.id) +
            '" data-subject-id="' + esc(subject.id) + '">' + (count === subject.topics.length ? 'Check for updates' : 'Add subject') + '</button></section>';
        }).join('');
        return '<article class="explore-course-card panel"><div class="explore-course-top"><div><span class="explore-course-kicker">' +
          esc(pack.country) + ' · ' + esc(pack.exam) + ' · ' + esc(pack.language) + '</span><h3>' + esc(pack.title) + '</h3><p>' +
          esc(pack.description) + '</p></div><span class="explore-count-pill">' + pack.totalTopics + ' topics</span></div><div class="explore-course-actions"><button type="button" class="btn btn-primary" data-explore-action="install-pack" data-pack-id="' +
          esc(pack.id) + '">' + courseAction + ' <svg class="nexus-action-icon" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14m-6-6 6 6-6 6"/></svg></button><span class="muted small">Install a whole pack, an individual subject, or individual topics. Existing topics and review schedules are preserved.</span></div><div class="explore-subject-grid">' +
          (cards || '<div class="empty">No matching subjects or topics.</div>') + '</div></article>';
      }).join('') || '<div class="empty"><strong>No matching curricula</strong>Try another search term.</div>';
    }

    async function loadCatalog() {
      if (!fetcher) throw new Error('Catalogue loading is unavailable in this environment.');
      try {
        const response = await fetcher('./curricula/catalog.json');
        if (!response || !response.ok) throw new Error('Catalogue request returned ' + (response && response.status || 'an invalid response') + '.');
        const loaded = validateCatalog(await response.json());
        d.setPacks(loaded);
        if (typeof d.onCatalogLoaded === 'function') d.onCatalogLoaded(loaded);
        else render();
        return loaded;
      } catch (error) {
        if (typeof d.onCatalogError === 'function') d.onCatalogError(error);
        render();
        return rows(d.getPacks());
      }
    }

    function install(packId, subjectId, topicName) {
      const packs = rows(d.getPacks());
      const pack = packs.find(item => item.id === packId);
      if (!pack) return false;
      const scope = topicName != null ? 'topic' : subjectId ? 'subject' : 'pack';
      const targetSubject = subjectId == null ? null : pack.subjects.find(subject => String(subject.id) === String(subjectId));
      if (subjectId != null && !targetSubject) return false;
      if (topicName != null && (!targetSubject || !targetSubject.topics.includes(String(topicName)))) return false;
      const selectedSubjects = pack.subjects.filter(subject => !subjectId || String(subject.id) === String(subjectId));
      if (!selectedSubjects.length) return false;
      const previous = clone(d.getState());
      const next = clone(previous);
      if (!Array.isArray(next.streams) || !Array.isArray(next.subjects) || !Array.isArray(next.topics)) {
        return false;
      }
      if (!isRecord(next.settings)) next.settings = {};
      let added = 0;
      try {
        let stream = findPackStream(pack, next);
        if (!stream) {
          let streamId = pack.streamId || d.makeId('stream');
          if (next.streams.some(item => String(item.id) === String(streamId))) streamId = d.makeId('stream');
          stream = { id: streamId, name: pack.streamName };
          next.streams.push(stream);
        }
        for (const subject of selectedSubjects) {
          const selectedTopics = subject.topics.filter(topic => topicName == null || topic === String(topicName));
          if (!selectedTopics.length) continue;
          let installedSubject = findPackSubject(pack, subject, stream, next);
          if (!installedSubject) {
            let id = subject.workspaceId || d.makeId('subject');
            if (next.subjects.some(item => String(item.id) === String(id))) id = d.makeId('subject');
            installedSubject = { id, name: subject.name, streamId: stream.id, order: next.subjects.filter(item => String(item.streamId) === String(stream.id)).length };
            next.subjects.push(installedSubject);
          }
          for (const name of selectedTopics) {
            if (next.topics.some(topic => String(topic.subjectId) === String(installedSubject.id) &&
                (String(topic.name) === name || (topicCatalogueId(subject, name) && String(topic.id) === topicCatalogueId(subject, name))))) continue;
            const topicIndex = subject.topics.indexOf(name) + 1;
            let id = subject.legacyIdPrefix ? subject.legacyIdPrefix + '-' + String(topicIndex).padStart(2, '0') : d.makeId('topic');
            if (next.topics.some(topic => String(topic.id) === String(id))) id = d.makeId('topic');
            next.topics.push({
              id, subjectId: installedSubject.id, name, notes: '', custom: false, createdAt: d.today(),
              lastReviewed: '', lastRating: null, dueDate: '', intervalDays: 0, reviewCount: 0, streak: 0, lapses: 0, archived: false
            });
            added++;
          }
        }
        const integrity = typeof d.getIntegrity === 'function' ? d.getIntegrity() : null;
        if (integrity && typeof integrity.markInstalled === 'function') integrity.markInstalled(next, pack, scope, subjectId, topicName == null ? null : String(topicName));
        d.setState(next);
      } catch (error) {
        d.setState(previous);
        d.notify && d.notify('Could not install this curriculum selection. Your existing study data was preserved.');
        return false;
      }
      let saved = false;
      try { saved = d.save() !== false; } catch (_) { saved = false; }
      if (!saved) {
        d.setState(previous);
        d.renderAll();
        render();
        return false;
      }
      if (typeof window !== 'undefined' && window.NexusCloudSync && typeof window.NexusCloudSync.recordInstall === 'function') window.NexusCloudSync.recordInstall(d.getState());
      d.renderAll();
      render();
      if (typeof d.notify === 'function') {
        d.notify(added ? 'Added ' + added + ' curriculum topic' + (added === 1 ? '' : 's') + ' to your Library.' : 'Everything in this selection is already installed.');
      }
      return true;
    }

    return { loadCatalog, render, install, validateCatalog };
  }

  return { create, validateCatalog };
});
