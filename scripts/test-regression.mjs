import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(resolve(root, 'index.html'), 'utf8');
const bundle = readFileSync(resolve(root, 'fsrs-bundle.js'), 'utf8');
const serviceWorker = readFileSync(resolve(root, 'sw.js'), 'utf8');

const integrationAt = bundle.indexOf('nexus-fsrs.js — glue between Nexus topics');
const coreEnd = integrationAt > 0 ? bundle.lastIndexOf('/*!', integrationAt) : -1;
assert.ok(coreEnd > 0, 'FSRS core and Nexus integration must remain separable for isolated scheduler tests');
const sandbox = { self: {}, Date, Math };
vm.createContext(sandbox);
vm.runInContext(bundle.slice(0, coreEnd), sandbox, { filename: 'fsrs-core.js' });
const Scheduler = sandbox.self.FSRS?.Scheduler;
assert.equal(typeof Scheduler, 'function', 'the FSRS-6 scheduler core must expose Scheduler');

const now = new Date(2026, 9, 19, 12, 0, 0);
const scheduler = new Scheduler({ request_retention: 0.9, maximum_interval: 120, enable_fuzz: false });
const empty = scheduler.emptyCard();
const preview = scheduler.preview(empty, now);
for (const grade of [1, 2, 3, 4]) {
  assert.ok(Number.isInteger(preview[grade]) && preview[grade] >= 1 && preview[grade] <= 120,
    'FSRS preview intervals must be bounded positive whole days');
}
assert.equal(preview[1], 1, 'Again must schedule a one-day retry');
assert.ok(preview[2] <= preview[3] && preview[3] < preview[4],
  'Hard, Good, and Easy intervals must be monotonic');

const firstGood = scheduler.review(empty, 3, now);
assert.ok(firstGood.card.stability > 0 && firstGood.card.difficulty >= 1 && firstGood.card.difficulty <= 10,
  'a saved FSRS review must produce valid memory stability and difficulty');
assert.equal(firstGood.card.reps, 1);
const expectedDue = sandbox.self.FSRS.util.isoDay(sandbox.self.FSRS.util.addDays(now, firstGood.intervalDays));
assert.equal(firstGood.due, expectedDue, 'due date must match the scheduled interval');
assert.ok(/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(firstGood.due), 'due date must use YYYY-MM-DD format');

const secondReview = scheduler.review(firstGood.card, 1, new Date(2026, 9, 25, 12, 0, 0));
assert.equal(secondReview.intervalDays, 1, 'Again must reset the next interval to one day');
assert.equal(secondReview.card.reps, 2);
assert.equal(secondReview.card.lapses, 1, 'Again after a prior review must count a lapse');
assert.ok(secondReview.retrievabilityBefore >= 0 && secondReview.retrievabilityBefore <= 1,
  'retrievability must remain a probability');

const strictRetention = new Scheduler({ request_retention: 0.97, maximum_interval: 120, enable_fuzz: false });
const relaxedRetention = new Scheduler({ request_retention: 0.7, maximum_interval: 120, enable_fuzz: false });
assert.ok(strictRetention.preview(empty, now)[3] <= relaxedRetention.preview(empty, now)[3],
  'higher desired retention should not produce a longer interval for the same fresh card');

const capped = new Scheduler({ request_retention: 0.9, maximum_interval: 30, enable_fuzz: false });
const cappedPreview = capped.preview(empty, now);
assert.ok(Object.values(cappedPreview).every(days => days <= 30), 'the configured maximum interval must cap every rating');

const replayed = scheduler.replay([
  { grade: 3, date: '2026-10-21' },
  { grade: 2, date: '2026-10-20' }
]);
assert.equal(replayed.lastReview, '2026-10-21', 'history replay must sort reviews chronologically');

assert.ok(html.includes('<script defer src="./fsrs-bundle.js"></script>'), 'the FSRS integration bundle must be loaded by the app');
assert.ok(bundle.includes('save = function () { persistCards(); return baseSave.apply(this, arguments); }'),
  'FSRS memory state must be persisted whenever Nexus saves tracker data');
assert.ok(bundle.includes('saveReview = function (rating)') && bundle.includes('t.fsrs = pending.fsrs;'),
  'a successful review must persist the computed FSRS memory state on its topic');
assert.ok(bundle.includes('if (/^\\d{4}-\\d{2}-\\d{2}$/.test(customDue)) pending.fsrs.due = customDue;'),
  'a user-selected due date must override the FSRS due date without discarding the memory update');
assert.ok(bundle.includes('function ensureMigrated()') && bundle.includes('N.migrateTopic(t, hs)'),
  'existing review history must be available for FSRS state migration');
assert.ok(serviceWorker.includes("'./fsrs-bundle.js'") && serviceWorker.includes("'./backup-restore-utils.js'"),
  'offline app shell must cache the scheduler and backup safety helpers');
assert.ok(serviceWorker.includes("nexus-rating-analytics-v11"), 'the service-worker cache must be versioned when the app shell changes');
assert.ok(serviceWorker.includes('if(url.search)return response'), 'OAuth callback and other query-bearing URLs must not be cached');
assert.ok(serviceWorker.includes('const CORE_APP_SHELL=') && serviceWorker.includes('const OPTIONAL_APP_SHELL=') && serviceWorker.includes('cache.add(new Request(u,{cache:\'reload\'})).catch(()=>{})'), 'optional icons and catalogue failures must not block offline shell installation');

console.log('FSRS and core feature regression tests passed.');
