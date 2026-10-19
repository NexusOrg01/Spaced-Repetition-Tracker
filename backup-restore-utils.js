/* Small, dependency-free helpers for safe Nexus JSON backup restoration. */
(function(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.NexusBackupRestoreUtils = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : null), function() {
  'use strict';
  const isRecord = value => Boolean(value && typeof value === 'object' && !Array.isArray(value));
  const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
  const copy = value => JSON.parse(JSON.stringify(value));

  function cleanRecordMap(value, field, valueKind) {
    if (value === undefined || value === null) return {};
    if (!isRecord(value)) throw new Error('Backup section "' + field + '" must be an object.');
    const keys = Object.keys(value);
    if (keys.length > 50000) throw new Error('Backup section "' + field + '" has too many entries.');
    const result = {};
    for (const key of keys) {
      if (!key || key.length > 200 || key === '__proto__' || key === 'prototype' || key === 'constructor') {
        throw new Error('Backup section "' + field + '" contains an invalid key.');
      }
      const item = value[key];
      if (valueKind === 'number') {
        if (typeof item !== 'number' || !Number.isFinite(item) || item < 0 || item > 100000) {
          throw new Error('Backup section "' + field + '" contains an invalid target.');
        }
        result[key] = item;
      } else {
        if (!Array.isArray(item) || item.length > 10000 || item.some(entry => typeof entry !== 'string' && typeof entry !== 'number')) {
          throw new Error('Backup section "' + field + '" contains an invalid task checklist.');
        }
        result[key] = Array.from(new Set(item.map(entry => String(entry).slice(0, 200))));
      }
    }
    return result;
  }

  function cleanRows(value, field) {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value)) throw new Error('Backup section "' + field + '" must be an array.');
    if (value.length > 100000) throw new Error('Backup section "' + field + '" has too many records.');
    return value.map((row, index) => {
      if (!isRecord(row)) throw new Error('Backup section "' + field + '" contains a malformed record.');
      const id = row.id === undefined || row.id === null || row.id === '' ? field + '-restored-' + index : row.id;
      if (typeof id !== 'string' && typeof id !== 'number') throw new Error('Backup section "' + field + '" contains an invalid record ID.');
      return { ...row, id: String(id).slice(0, 200) };
    });
  }

  function boundedSetting(key, value, fallback) {
    if (typeof fallback === 'number') {
      if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
      const ranges = {
        dailyMinutes: [5, 1440], sessionMinutes: [1, 240], weeklyReviewGoal: [1, 10000],
        backlogDays: [1, 90], maxInterval: [1, 120], workloadDays: [1, 60]
      };
      const range = ranges[key] || [-100000, 100000];
      return Math.min(range[1], Math.max(range[0], value));
    }
    if (typeof fallback === 'boolean') return typeof value === 'boolean' ? value : fallback;
    if (typeof fallback === 'string') {
      if (typeof value !== 'string' || value.length > 100) return fallback;
      if (key === 'scheduler' && !['classic', 'adaptive'].includes(value)) return fallback;
      if (key === 'reminderTime' && !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) return fallback;
      return value;
    }
    return fallback;
  }

  function cleanTimestamp(value, fallback) {
    if (value === undefined) return fallback;
    if (value === null || value === '') return null;
    if (typeof value !== 'string' && typeof value !== 'number') return fallback;
    const stamp = new Date(value).getTime();
    return Number.isFinite(stamp) ? (typeof value === 'number' ? stamp : new Date(stamp).toISOString()) : fallback;
  }

  function validateBackupState(input) {
    if (!isRecord(input)) throw new Error('Invalid backup state.');
    const modern = Array.isArray(input.streams) && Array.isArray(input.subjects) && Array.isArray(input.topics);
    const legacy = Array.isArray(input.topics) && (Array.isArray(input.history) || Array.isArray(input.subjects));
    if (!modern && !legacy) throw new Error('This file is not a recognized Nexus backup.');
    for (const key of ['streams', 'subjects', 'topics', 'history', 'exams']) {
      if (own(input, key) && !Array.isArray(input[key])) {
        throw new Error('Backup section "' + key + '" must be an array.');
      }
      if (Array.isArray(input[key]) && input[key].length > 200000) {
        throw new Error('Backup section "' + key + '" contains too many records.');
      }
    }
    if (modern) {
      if (own(input, 'settings') && !isRecord(input.settings)) {
        throw new Error('Backup section "settings" must be an object.');
      }
      const requireNamedRows = (rows, field, requireId) => {
        rows.forEach(row => {
          if (!isRecord(row) || typeof row.name !== 'string' || !row.name.trim() ||
              (requireId && !((typeof row.id === 'string' && row.id.trim()) ||
                (typeof row.id === 'number' && Number.isFinite(row.id))))) {
            throw new Error('Backup section "' + field + '" contains a malformed record.');
          }
        });
      };
      requireNamedRows(input.streams, 'streams', true);
      requireNamedRows(input.subjects, 'subjects', true);
      requireNamedRows(input.topics, 'topics', true);
      for (const field of ['history', 'exams']) {
        if (Array.isArray(input[field]) && input[field].some(row => !isRecord(row))) {
          throw new Error('Backup section "' + field + '" contains a malformed record.');
        }
      }
    }
    return input;
  }

  function normalizeFeatureState(input, defaults) {
    if (!isRecord(defaults) || !isRecord(defaults.settings)) throw new Error('Internal Study Hub defaults are invalid.');
    if (input === undefined) return copy(defaults);
    if (!isRecord(input)) throw new Error('The backup Study Hub section must be an object.');
    const rawSettings = input.settings === undefined || input.settings === null ? {} : input.settings;
    if (!isRecord(rawSettings)) throw new Error('Backup Study Hub settings must be an object.');
    const settings = { ...defaults.settings };
    for (const key of Object.keys(defaults.settings)) {
      if (own(rawSettings, key)) settings[key] = boundedSetting(key, rawSettings[key], defaults.settings[key]);
    }
    const result = {
      ...copy(defaults),
      version: typeof input.version === 'number' && Number.isFinite(input.version) ? Math.max(1, Math.min(100, input.version)) : defaults.version,
      settings,
      syllabusTargets: cleanRecordMap(input.syllabusTargets, 'syllabusTargets', 'number'),
      taskChecks: cleanRecordMap(input.taskChecks, 'taskChecks', 'arrays'),
      journal: cleanRows(input.journal, 'journal'),
      papers: cleanRows(input.papers, 'papers'),
      goals: cleanRows(input.goals, 'goals'),
      studyLogs: cleanRows(input.studyLogs, 'studyLogs'),
      selectedTopicIds: (() => {
        const ids = input.selectedTopicIds === undefined || input.selectedTopicIds === null ? [] : input.selectedTopicIds;
        if (!Array.isArray(ids) || ids.length > 100000 || ids.some(id => typeof id !== 'string' && typeof id !== 'number')) {
          throw new Error('Backup section "selectedTopicIds" must be an array of topic IDs.');
        }
        return Array.from(new Set(ids.map(id => String(id).slice(0, 200))));
      })(),
      lastBackupAt: typeof input.lastBackupAt === 'string' && input.lastBackupAt.length <= 100 ? input.lastBackupAt : defaults.lastBackupAt,
      lastReminderAt: typeof input.lastReminderAt === 'string' && input.lastReminderAt.length <= 100 ? input.lastReminderAt : defaults.lastReminderAt,
      focusStartedAt: cleanTimestamp(input.focusStartedAt, defaults.focusStartedAt ?? null),
      focusPausedAt: cleanTimestamp(input.focusPausedAt, defaults.focusPausedAt ?? null),
      focusTopicId: typeof input.focusTopicId === 'string' ? input.focusTopicId.slice(0, 200) : '',
      focusSubjectId: typeof input.focusSubjectId === 'string' ? input.focusSubjectId.slice(0, 200) : ''
    };
    return result;
  }

  function mergeFeatureState(currentInput, importedInput, defaults, rawImported) {
    const current = normalizeFeatureState(currentInput, defaults);
    const imported = normalizeFeatureState(importedInput, defaults);
    const raw = isRecord(rawImported) ? rawImported : {};
    const result = current;
    for (const field of ['journal', 'papers', 'goals', 'studyLogs']) {
      const seen = new Set(result[field].map(row => row.id));
      for (const row of imported[field]) {
        if (!seen.has(row.id)) {
          result[field].push(row);
          seen.add(row.id);
        }
      }
    }
    if (isRecord(raw.settings)) {
      for (const key of Object.keys(defaults.settings)) {
        if (own(raw.settings, key)) result.settings[key] = imported.settings[key];
      }
    }
    result.syllabusTargets = { ...imported.syllabusTargets, ...current.syllabusTargets };
    result.taskChecks = { ...imported.taskChecks, ...current.taskChecks };
    result.selectedTopicIds = Array.from(new Set([...current.selectedTopicIds, ...imported.selectedTopicIds]));
    return result;
  }

  function commitLocalStorageAtomically(storage, entries) {
    if (!storage || !Array.isArray(entries) || entries.length === 0) throw new Error('Invalid local restore transaction.');
    const seen = new Set();
    for (const entry of entries) {
      if (!entry || typeof entry.key !== 'string' || typeof entry.value !== 'string' || seen.has(entry.key)) {
        throw new Error('Invalid local restore transaction entries.');
      }
      seen.add(entry.key);
    }
    const previous = entries.map(entry => ({ key: entry.key, value: storage.getItem(entry.key) }));
    let attempted = -1;
    try {
      for (let i = 0; i < entries.length; i++) {
        attempted = i;
        storage.setItem(entries[i].key, entries[i].value);
      }
    } catch (cause) {
      const rollbackErrors = [];
      for (let i = attempted; i >= 0; i--) {
        try {
          if (previous[i].value === null) storage.removeItem(previous[i].key);
          else storage.setItem(previous[i].key, previous[i].value);
        } catch (error) {
          rollbackErrors.push(error);
        }
      }
      const error = new Error('Could not save the complete restore to this browser. ' +
        (rollbackErrors.length ? 'Automatic rollback was not fully successful; do not close or reload Nexus yet.' :
          'The previous saved data has been restored. Check available browser storage and try again.'));
      error.cause = cause;
      error.rollbackSucceeded = rollbackErrors.length === 0;
      throw error;
    }
    return true;
  }

  function parseCsv(input) {
    const source = String(input ?? '').replace(/^\uFEFF/, '');
    const maxCharacters = 5 * 1024 * 1024;
    const maxRows = 10001;
    const maxColumns = 64;
    const maxFieldLength = 10000;
    if (source.length > maxCharacters) throw new Error('CSV is too large. Use a file no larger than 5 MiB.');
    const rows = [];
    let row = [], field = '', quoted = false, afterQuote = false;
    const append = c => {
      if (field.length >= maxFieldLength) throw new Error('CSV contains a field longer than 10,000 characters.');
      field += c;
    };
    const endField = () => {
      row.push(field);
      if (row.length > maxColumns) throw new Error('CSV contains more than 64 columns.');
      field = '';
      afterQuote = false;
    };
    const endRow = () => {
      endField();
      if (row.some(cell => String(cell).trim())) {
        rows.push(row.slice());
        if (rows.length > maxRows) throw new Error('CSV contains more than 10,000 data rows plus a header.');
      }
      row = [];
    };
    for (let i = 0; i < source.length; i++) {
      const c = source[i];
      if (quoted) {
        if (c === '"') {
          if (source[i + 1] === '"') { append('"'); i++; }
          else { quoted = false; afterQuote = true; }
        } else append(c);
        continue;
      }
      if (afterQuote) {
        if (c === ',') { endField(); continue; }
        if (c === '\n' || c === '\r') {
          if (c === '\r' && source[i + 1] === '\n') i++;
          endRow();
          continue;
        }
        if (c === ' ' || c === '\t') continue;
        throw new Error('Malformed CSV: unexpected character after a quoted field.');
      }
      if (c === '"') {
        if (field.length !== 0) throw new Error('Malformed CSV: quote inside an unquoted field.');
        quoted = true;
      } else if (c === ',') endField();
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && source[i + 1] === '\n') i++;
        endRow();
      } else append(c);
    }
    if (quoted) throw new Error('Malformed CSV: a quoted field was not closed.');
    if (field.length || row.length || afterQuote) endRow();
    return rows;
  }

  return { validateBackupState, normalizeFeatureState, mergeFeatureState, commitLocalStorageAtomically, parseCsv };
});
