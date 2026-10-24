/*!
 * fsrs.js — dependency-free FSRS-6 scheduler (UMD, works in browser + Node)
 *
 * Implements the Free Spaced Repetition Scheduler (DSR memory model):
 *   D = Difficulty (1..10), S = Stability (days for R to fall to 90%),
 *   R = Retrievability (probability of recall right now).
 *
 * Grades: 1 = Again, 2 = Hard, 3 = Good, 4 = Easy
 * Day-granular: Nexus schedules by calendar day, not by minutes.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.FSRS = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // Current baseline FSRS-6 parameter set (21 weights) from the open-spaced-repetition
  // algorithm specification. These are defaults, not user-trained personal parameters.
  const DEFAULT_W = [
    0.212, 1.2931, 2.3065, 8.2956, 6.4133, 0.8334, 3.0194, 0.001, 1.8722,
    0.1666, 0.796, 1.4835, 0.0614, 0.2629, 1.6483, 0.6014, 1.8729, 0.5425,
    0.0912, 0.0658, 0.1542,
  ];

  const DEFAULTS = {
    request_retention: 0.9, // desired retention, 0.70 – 0.97
    maximum_interval: 365,  // cap in days (old app used 120)
    w: DEFAULT_W,
    enable_fuzz: false,
    enable_short_term: true, // same-day re-reviews use the short-term formula
  };

  const clamp = (n, lo, hi) => Math.min(Math.max(n, lo), hi);

  // ---- date helpers (local calendar days) ----
  function toDate(d) {
    if (d instanceof Date) return new Date(d.getTime());
    if (typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d)) {
      const [y, m, day] = d.split("-").map(Number);
      return new Date(y, m - 1, day);
    }
    return new Date(d);
  }
  function dayNumber(d) {
    const x = toDate(d);
    return Math.floor(Date.UTC(x.getFullYear(), x.getMonth(), x.getDate()) / 86400000);
  }
  function dayDiff(from, to) { return dayNumber(to) - dayNumber(from); }
  function addDays(d, n) {
    const x = toDate(d);
    return new Date(x.getFullYear(), x.getMonth(), x.getDate() + n);
  }
  function isoDay(d) {
    const x = toDate(d);
    const p = (n) => String(n).padStart(2, "0");
    return `${x.getFullYear()}-${p(x.getMonth() + 1)}-${p(x.getDate())}`;
  }

  class Scheduler {
    constructor(params = {}) {
      this.p = Object.assign({}, DEFAULTS, params);
      if (!Array.isArray(this.p.w) || this.p.w.length !== 21) this.p.w = DEFAULT_W.slice();
      this.p.request_retention = clamp(this.p.request_retention, 0.7, 0.99);
      this._setDecay();
    }

    _setDecay() {
      this.decay = -this.p.w[20];
      this.factor = Math.pow(0.9, 1 / this.decay) - 1;
    }

    /** A fresh, never-reviewed card. */
    emptyCard() {
      return { stability: 0, difficulty: 0, reps: 0, lapses: 0, lastReview: null, due: null, intervalDays: 0 };
    }

    /** Probability of recall for a card at `now`. */
    retrievability(card, now = new Date()) {
      if (!card || !card.reps || !card.lastReview || !card.stability) return null;
      const t = Math.max(0, dayDiff(card.lastReview, now));
      return Math.pow(1 + (this.factor * t) / card.stability, this.decay);
    }

    /** Interval (days, float) at which retention drops to request_retention. */
    nextInterval(S) {
      const r = this.p.request_retention;
      return (S / this.factor) * (Math.pow(r, 1 / this.decay) - 1);
    }

    // ---- memory model ----
    _initS(g) { return Math.max(this.p.w[g - 1], 0.1); }
    _initD(g) {
      const w = this.p.w;
      return clamp(w[4] - Math.exp(w[5] * (g - 1)) + 1, 1, 10);
    }
    _nextD(D, g) {
      const w = this.p.w;
      const delta = -w[6] * (g - 3);
      const damped = D + (delta * (10 - D)) / 9;
      // mean reversion toward the initial difficulty of an "Easy" first review
      return clamp(w[7] * this._initD(4) + (1 - w[7]) * damped, 1, 10);
    }
    _recallS(D, S, R, g) {
      const w = this.p.w;
      const hard = g === 2 ? w[15] : 1;
      const easy = g === 4 ? w[16] : 1;
      return S * (1 + Math.exp(w[8]) * (11 - D) * Math.pow(S, -w[9]) *
        (Math.exp(w[10] * (1 - R)) - 1) * hard * easy);
    }
    _forgetS(D, S, R) {
      const w = this.p.w;
      const sf = w[11] * Math.pow(D, -w[12]) * (Math.pow(S + 1, w[13]) - 1) * Math.exp(w[14] * (1 - R));
      return Math.min(sf, S);
    }
    _shortS(S, g) {
      const w = this.p.w;
      let inc = Math.exp(w[17] * (g - 3 + w[18])) * Math.pow(S, -w[19]);
      if (g >= 3) inc = Math.max(inc, 1);
      return S * inc;
    }

    _fuzz(interval, minI, maxI) {
      if (!this.p.enable_fuzz || interval < 2.5) return interval;
      const ranges = [
        { s: 2.5, e: 7, f: 0.15 }, { s: 7, e: 20, f: 0.1 }, { s: 20, e: Infinity, f: 0.05 },
      ];
      let delta = 1;
      for (const r of ranges) delta += r.f * Math.max(Math.min(interval, r.e) - r.s, 0);
      let lo = Math.max(minI, Math.round(interval - delta));
      let hi = Math.min(maxI, Math.round(interval + delta));
      if (lo > hi) lo = hi;
      return Math.floor(Math.random() * (hi - lo + 1)) + lo;
    }

    _scheduleOne(card, g, now) {
      let S, D, R = null;
      const first = !card.reps || !card.stability;
      if (first) {
        S = this._initS(g);
        D = this._initD(g);
      } else {
        const t = Math.max(0, dayDiff(card.lastReview, now));
        R = this.retrievability(card, now);
        D = this._nextD(card.difficulty, g);
        if (t < 1 && this.p.enable_short_term) S = this._shortS(card.stability, g);
        else if (g === 1) S = this._forgetS(card.difficulty, card.stability, R);
        else S = this._recallS(card.difficulty, card.stability, R, g);
      }
      S = clamp(S, 0.1, 36500);
      return { S, D, R, raw: this.nextInterval(S) };
    }

    /**
     * Compute results for all four grades with monotonic intervals
     * (Hard <= Good < Easy) and the 1-day floor / max cap applied.
     * @returns {{1:Result,2:Result,3:Result,4:Result}}
     */
    scheduleAll(card, now = new Date()) {
      const max = this.p.maximum_interval;
      const res = {};
      for (let g = 1; g <= 4; g++) res[g] = this._scheduleOne(card, g, now);

      const lim = (x) => clamp(Math.round(x), 1, max);
      const iv = { 1: 1, 2: lim(res[2].raw), 3: lim(res[3].raw), 4: lim(res[4].raw) };
      // enforce ordering when we are past the first review
      iv[2] = Math.min(iv[2], iv[3]);
      iv[3] = Math.max(iv[3], Math.min(iv[2] + 1, max));
      iv[4] = Math.max(iv[4], Math.min(iv[3] + 1, max));

      const out = {};
      for (let g = 1; g <= 4; g++) {
        const interval = g === 1 ? 1 : this._fuzz(iv[g], 1, max);
        const lapse = g === 1 && card.reps > 0 && card.stability > 0;
        out[g] = {
          grade: g,
          intervalDays: interval,
          due: isoDay(addDays(now, interval)),
          card: {
            stability: res[g].S,
            difficulty: res[g].D,
            reps: (card.reps || 0) + 1,
            lapses: (card.lapses || 0) + (lapse ? 1 : 0),
            lastReview: isoDay(now),
            due: isoDay(addDays(now, interval)),
            intervalDays: interval,
          },
          retrievabilityBefore: res[g].R,
        };
      }
      return out;
    }

    /** Apply a grade (1-4). Returns {card, intervalDays, due, retrievabilityBefore}. */
    review(card, grade, now = new Date()) {
      return this.scheduleAll(card || this.emptyCard(), now)[clamp(Math.round(grade), 1, 4)];
    }

    /** Next-interval preview for each grade: {1:days,2:days,3:days,4:days}. */
    preview(card, now = new Date()) {
      const all = this.scheduleAll(card || this.emptyCard(), now);
      return { 1: all[1].intervalDays, 2: all[2].intervalDays, 3: all[3].intervalDays, 4: all[4].intervalDays };
    }

    /**
     * Rebuild a card by replaying an ordered review log [{date, grade}, ...].
     * Used to migrate existing history into FSRS state.
     */
    replay(log) {
      let card = this.emptyCard();
      const sorted = [...log].sort((a, b) => toDate(a.date) - toDate(b.date));
      for (const e of sorted) card = this.review(card, e.grade, toDate(e.date)).card;
      return card;
    }
  }

  return { Scheduler, DEFAULT_W, DEFAULTS, util: { dayDiff, addDays, isoDay, toDate } };
});
/*!
 * nexus-fsrs.js — glue between Nexus topics (1–5 ratings) and fsrs.js.
 * Load AFTER fsrs.js and BEFORE the main app script. Exposes window.NexusFSRS.
 * FSRS memory state lives on each topic as `topic.fsrs`.
 */
(function (root) {
  "use strict";
  const { Scheduler, util } = root.FSRS;
  const SETTINGS_KEY = "nexus.fsrs.settings.v1";
  const clamp = (n, a, b) => Math.min(Math.max(n, a), b);

  // Nexus 1–5 -> FSRS grade (1 Again, 2 Hard, 3 Good, 4 Easy).
  // Rating 4 uses Good's memory update with an interval midway between Good and Easy.
  const RATING_TO_GRADE = { 1: 1, 2: 2, 3: 3, 4: 3, 5: 4 };
  const gradeOf = (r) => RATING_TO_GRADE[r] || 3;

  // maximum_interval defaults to 120 because the app's data normalisers clamp intervalDays to 120.
  const defaults = { enabled: true, request_retention: 0.9, maximum_interval: 120, enable_fuzz: false, w: null };

  function normalizeSettings(value, fallback = defaults) {
    const input = value && typeof value === "object" && !Array.isArray(value) ? value : {};
    const base = fallback && typeof fallback === "object" ? fallback : defaults;
    const rawW = input.w === undefined ? base.w : input.w;
    const w = Array.isArray(rawW) && rawW.length === 21 && rawW.every(n => typeof n === "number" && Number.isFinite(n))
      ? rawW.map(n => clamp(n, -1000, 1000))
      : null;
    const retention = Number(input.request_retention === undefined ? base.request_retention : input.request_retention);
    const maximum = Number(input.maximum_interval === undefined ? base.maximum_interval : input.maximum_interval);
    return {
      enabled: typeof (input.enabled === undefined ? base.enabled : input.enabled) === "boolean"
        ? (input.enabled === undefined ? base.enabled : input.enabled) : defaults.enabled,
      request_retention: clamp(Number.isFinite(retention) ? retention : defaults.request_retention, 0.7, 0.97),
      maximum_interval: clamp(Number.isFinite(maximum) ? maximum : defaults.maximum_interval, 30, 120),
      enable_fuzz: typeof (input.enable_fuzz === undefined ? base.enable_fuzz : input.enable_fuzz) === "boolean"
        ? (input.enable_fuzz === undefined ? base.enable_fuzz : input.enable_fuzz) : defaults.enable_fuzz,
      w
    };
  }
  function load() {
    try { return normalizeSettings(JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}")); }
    catch (_) { return normalizeSettings(defaults); }
  }
  let settings = load();
  let sched = build();
  function build() {
    const p = {
      request_retention: settings.request_retention,
      maximum_interval: clamp(Number(settings.maximum_interval) || 120, 30, 3650),
      enable_fuzz: !!settings.enable_fuzz,
    };
    if (Array.isArray(settings.w) && settings.w.length === 21) p.w = settings.w;
    return new Scheduler(p);
  }

  const cardOf = (t) => (t && t.fsrs && t.fsrs.stability > 0 ? t.fsrs : sched.emptyCard());

  const api = {
    settings: () => Object.assign({}, settings),
    setSettings(patch, options = {}) {
      settings = normalizeSettings({ ...settings, ...(patch && typeof patch === "object" ? patch : {}) });
      if (options.persist !== false) {
        try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (_) {}
      }
      sched = build();
      // Backup/cloud restores can change scheduler settings after the controls
      // have already been wired. Keep the visible controls in sync with the
      // active scheduler instead of leaving a stale checkbox/value on screen.
      const enabledControl = document.getElementById("fsrsEnabled");
      const retentionControl = document.getElementById("fsrsRetention");
      const retentionOutput = document.getElementById("fsrsRetentionOut");
      const maximumControl = document.getElementById("fsrsMax");
      if (enabledControl) enabledControl.checked = settings.enabled;
      if (retentionControl) retentionControl.value = String(settings.request_retention);
      if (retentionOutput) retentionOutput.textContent = Math.round(settings.request_retention * 100) + "%";
      if (maximumControl) maximumControl.value = String(settings.maximum_interval);
      // FSRS configuration belongs to the workspace, not only this browser.
      // A caller applying a remote/backup snapshot can suppress this reverse-sync
      // to avoid a second feature-state save while the atomic workspace is committing.
      if (options.syncFeature !== false && typeof root.NexusGetFeatureState === "function" &&
          typeof root.NexusSetFeatureState === "function") {
        try {
          const featureState = root.NexusGetFeatureState();
          featureState.fsrsSettings = Object.assign({}, settings);
          root.NexusSetFeatureState(featureState, { persist: true, render: false, applyFsrs: false });
        } catch (error) {
          try { console.warn("FSRS settings are active locally but could not be added to the saved workspace.", error); } catch (_) {}
        }
      }
    },

    /** Validate/clean a stored card (used when loading data). Returns undefined if unusable. */
    sanitize(c) {
      if (!c || typeof c !== "object") return undefined;
      const S = Number(c.stability), D = Number(c.difficulty);
      if (!(S > 0) || !isFinite(S) || !isFinite(D)) return undefined;
      return {
        stability: clamp(S, 0.1, 36500), difficulty: clamp(D, 1, 10),
        reps: Math.max(0, Number(c.reps) || 0), lapses: Math.max(0, Number(c.lapses) || 0),
        lastReview: typeof c.lastReview === "string" ? c.lastReview : null,
        due: typeof c.due === "string" ? c.due : null,
        intervalDays: Math.max(0, Number(c.intervalDays) || 0),
      };
    },

    /** Intervals (days) for the five rating buttons: {1..5}. */
    previewButtons(topic, now = new Date()) {
      const p = sched.preview(cardOf(topic), now);
      const max = sched.p.maximum_interval;
      const easy = Math.min(Math.max(p[4], p[3] + 2), max);
      const veryGood = Math.min(Math.max(Math.round((p[3] + easy) / 2), p[3]), easy);
      return { 1: p[1], 2: p[2], 3: p[3], 4: veryGood, 5: easy };
    },

    /** Compute a review. Returns { fsrs, intervalDays, due, retrievabilityBefore }; does not mutate the topic. */
    review(topic, rating, now = new Date()) {
      const r = sched.review(cardOf(topic), gradeOf(rating), now);
      const days = rating === 4 ? api.previewButtons(topic, now)[4] : r.intervalDays;
      const due = util.isoDay(util.addDays(now, days));
      r.card.intervalDays = days;
      r.card.due = due;
      return { fsrs: r.card, intervalDays: days, due, retrievabilityBefore: r.retrievabilityBefore };
    },

    /** Current recall probability 0..1, or null if never reviewed. */
    retrievability(topic, now = new Date()) {
      const c = topic && topic.fsrs;
      return c ? sched.retrievability(c, now) : null;
    },

    /** Rebuild a card by replaying history rows [{rating, reviewedAt}]. Sets topic.fsrs. */
    migrateTopic(topic, entries) {
      const log = (entries || [])
        .filter((e) => e.rating >= 1 && e.rating <= 5 && /^\d{4}-\d{2}-\d{2}$/.test(e.reviewedAt || ""))
        .map((e) => ({ grade: gradeOf(Number(e.rating)), date: e.reviewedAt }));
      if (log.length) topic.fsrs = sched.replay(log);
      return topic;
    },

    /** Approximate a card from topic fields when no history exists (e.g. history was cleared). */
    seedFromTopic(topic) {
      const r = topic.lastRating || 3;
      return {
        stability: Math.max(1, topic.intervalDays || 1),
        difficulty: clamp(9.5 - 1.5 * (r - 1), 1, 10),
        reps: topic.reviewCount || 1, lapses: topic.lapses || 0,
        lastReview: topic.lastReviewed || null, due: topic.dueDate || null,
        intervalDays: topic.intervalDays || 0,
      };
    },
  };
  root.NexusFSRS = api;
})(window);
/*!
 * fsrs-integration.js — hooks FSRS into the existing Nexus app.
 * Loaded with `defer` from <head>, so it runs after the whole page and all other scripts.
 * FSRS cards are kept in their own localStorage key (nexus.fsrs.cards.v1), so index.html's
 * data loader does not need to change.
 */
(function () {
  "use strict";
  if (!window.NexusFSRS) { console.warn("NexusFSRS missing; FSRS not active"); return; }
  const N = window.NexusFSRS;

  // 0) Card storage, separate from the app's own data so nothing else has to change.
  const CARDS_KEY = "nexus.fsrs.cards.v1";
  const readCards = () => { try { return JSON.parse(localStorage.getItem(CARDS_KEY) || "{}") || {}; } catch (_) { return {}; } };
  function persistCards() {
    const stored = readCards(), out = {}, ids = new Set(state.topics.map((t) => t.id));
    for (const id of ids) if (stored[id]) out[id] = stored[id];
    for (const t of state.topics) {
      if (t.fsrs) out[t.id] = t.fsrs;
      else if (!(t.reviewCount > 0)) delete out[t.id];
    }
    try { localStorage.setItem(CARDS_KEY, JSON.stringify(out)); } catch (_) {}
  }
  const baseSave = save;
  save = function () { persistCards(); return baseSave.apply(this, arguments); };

  // 1) Interval used by the preview buttons, the review preview and saveReview().
  const prevInterval = interval;
  interval = function (rating, previous) {
    if (!N.settings().enabled) return prevInterval(rating, previous);
    const t = reviewTopicId ? getTopic(reviewTopicId) : null;
    if (!t) return prevInterval(rating, previous);
    return N.previewButtons(t)[Number(rating)] || prevInterval(rating, previous);
  };

  // 2) Store FSRS memory state when a review is saved.
  const origSave = saveReview;
  saveReview = function (rating) {
    const t = getTopic(reviewTopicId);
    const r = Number(rating === undefined ? selectedReviewRating : rating);
    const pending = t && r >= 1 && r <= 5 ? N.review(t, r, new Date()) : null;
    const before = t ? t.reviewCount : 0;
    if (rating === undefined) origSave(); else origSave(rating);
    if (pending && t.reviewCount > before) {
      // A user-selected date overrides the scheduled due date, but not the FSRS memory update.
      // Keep the stored card's due date aligned with the date shown in Nexus.
      const customDue = document.getElementById("reviewCustomDue")?.value || "";
      if (/^\d{4}-\d{2}-\d{2}$/.test(customDue)) pending.fsrs.due = customDue;
      t.fsrs = pending.fsrs;
      save();
    } // origSave returns early on invalid input
  };

  // 3) One-time/ongoing migration: build FSRS state for reviewed topics that lack it.
  function ensureMigrated() {
    const stored = readCards();
    for (const t of state.topics) if (!t.fsrs && stored[t.id]) t.fsrs = N.sanitize(stored[t.id]);
    // After migration, ordinary saves/view renders should not rescan years of history.
    const candidates = state.topics.filter((t) => !t.fsrs && t.reviewCount > 0);
    if (!candidates.length) return;
    const pendingIds = new Set(candidates.map((t) => t.id));
    const byTopic = new Map();
    for (const h of state.history) {
      if (!pendingIds.has(h.topicId)) continue;
      if (!byTopic.has(h.topicId)) byTopic.set(h.topicId, []);
      byTopic.get(h.topicId).push(h);
    }
    let changed = false;
    for (const t of candidates) {
      const hs = byTopic.get(t.id);
      if (hs && hs.length) N.migrateTopic(t, hs);
      if (!t.fsrs) t.fsrs = N.seedFromTopic(t);
      changed = true;
    }
    if (changed) save();
  }
  // 4) Show current recall probability on topic cards.
  function decorateTopics() {
    document.querySelectorAll("#topicGrid .topic-card").forEach((card) => {
      const id = card.querySelector("[data-id]")?.dataset.id;
      const t = id && getTopic(id);
      const R = t ? N.retrievability(t) : null;
      const box = card.querySelector(".topic-details");
      if (R != null && box && !box.querySelector(".fsrs-r"))
        box.insertAdjacentHTML("beforeend", `<span class="fsrs-r">Recall now: ${Math.round(R * 100)}%</span>`);
    });
  }
  const baseRenderTopics = renderTopics;
  renderTopics = function () { baseRenderTopics(); decorateTopics(); };
  const baseRenderAll = renderAll;
  renderAll = function () { ensureMigrated(); baseRenderAll(); };

  // 5) Settings panel (markup is added by apply_fsrs_patch.py).
  function wireSettings() {
    const en = document.getElementById("fsrsEnabled"), ret = document.getElementById("fsrsRetention"),
      out = document.getElementById("fsrsRetentionOut"), max = document.getElementById("fsrsMax");
    if (!en || !ret || !max) return;
    const s = N.settings();
    en.checked = s.enabled; ret.value = s.request_retention; max.value = s.maximum_interval;
    out.textContent = Math.round(s.request_retention * 100) + "%";
    ret.addEventListener("input", () => { out.textContent = Math.round(ret.value * 100) + "%"; });
    const apply = () => {
      N.setSettings({
        enabled: en.checked, request_retention: Number(ret.value),
        maximum_interval: Math.min(120, Math.max(30, Number(max.value) || 120)),
      });
      notify("Scheduler settings saved. They apply to future reviews.");
    };
    [en, ret, max].forEach((el) => el.addEventListener("change", apply));
  }

  // 6) Study Hub: the old "FSRS-inspired" selector is superseded. Keep the <select> in the DOM
  //    (the hub's save function reads it) but hide it and fix the explanatory note.
  const hub = document.getElementById("hubContent");
  if (hub) new MutationObserver(() => {
    const sel = document.getElementById("hubScheduler");
    const f = sel && sel.closest(".hub-field");
    if (f && !f.dataset.fsrs) { f.dataset.fsrs = "1"; f.style.display = "none"; }
    hub.querySelectorAll(".hub-note").forEach((n) => {
      if (!n.dataset.fsrs && n.textContent.includes("FSRS-inspired")) {
        n.dataset.fsrs = "1";
        n.textContent = "Intervals are scheduled by FSRS-6 (see Setup & data → Review schedule). Existing due dates are preserved; changes apply to future reviews.";
      }
    });
  }).observe(hub, { childList: true, subtree: true });

  // 7) Replace the old "Review schedule" panel with the FSRS settings, and fix the help text.
  const PANEL = `<section class="panel" style="margin-top:15px"><div class="panel-head"><div><h3>Review schedule · FSRS-6</h3><p>Intervals are predicted from each topic's memory stability and difficulty.</p></div></div><div class="panel-body"><div class="form-grid"><div class="helper"><strong>1 — Again</strong><br>Forgotten: interval resets to 1 day.</div><div class="helper"><strong>2 — Hard</strong><br>Recalled with difficulty: small growth.</div><div class="helper"><strong>3 — Good</strong><br>Standard FSRS growth.</div><div class="helper"><strong>4 — Very good</strong><br>Good update, interval between Good and Easy.</div><div class="helper"><strong>5 — Easy</strong><br>Largest growth; difficulty drops.</div><div class="helper"><strong>Recall now</strong><br>Topic cards show the predicted chance you could recall it today.</div></div><div class="divider"></div><div class="form-grid"><div class="form-group full"><label class="form-label"><input type="checkbox" id="fsrsEnabled"> Use FSRS-6 scheduler (uncheck for the old multiplier method)</label></div><div class="form-group"><label class="form-label" for="fsrsRetention">Desired retention: <span id="fsrsRetentionOut">90%</span></label><input type="range" id="fsrsRetention" min="0.7" max="0.97" step="0.01"></div><div class="form-group"><label class="form-label" for="fsrsMax">Maximum interval (days, 30–120)</label><input class="control" type="number" id="fsrsMax" min="30" max="120"></div></div><p class="muted small">Higher retention means shorter intervals and more reviews. 90% is the standard. Changes apply to future reviews; existing due dates are kept.</p></div></section>`;
  const oldPanel = [...document.querySelectorAll("#view-setup .panel")].find((p) => p.querySelector("h3")?.textContent.trim() === "Review schedule");
  if (oldPanel) { oldPanel.outerHTML = PANEL; wireSettings(); }
  document.querySelectorAll("#helpDialog .help-content p").forEach((p) => {
    p.innerHTML = p.innerHTML
      .replace("Rating 1 resets to one day; higher ratings progressively increase the interval. The maximum interval is 120 days.",
        "Intervals are calculated by the FSRS-6 algorithm from your rating, the topic's stability and difficulty, and your desired retention. Rating 1 resets to one day. The maximum interval is 120 days.")
      .replace("an FSRS-inspired optional schedule heuristic, ", "");
  });

  // Initial pass (the main script already rendered once before this file loaded).
  ensureMigrated();
  renderAll();
})();
