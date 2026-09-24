/*!
 * archive-journey-core.js
 * DOM-free state machine for the Archive "Reading Mode" (Archive Journey).
 *
 * State:   status ('idle' | 'playing' | 'paused' | 'completed'),
 *          article (a), block (b), word (w), speed.
 * Rules:   * exactly ONE pending timer at any moment (setTimeout chain, never setInterval)
 *          * position only moves forward (a, b, w are never decremented by a tick)
 *          * progress percentage is monotonic (max-guarded)
 *          * nothing here touches the DOM; the UI layer plugs in through `host`
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ArchiveJourneyCore = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var SPEEDS = [0.5, 1, 1.5, 2];
  var BASE_MS = 300;        // dwell on one word at 1x when the host gives no per-word delay
  var BLOCK_GAP_MS = 280;   // extra breath at the start of a new block (scaled by speed)
  var ARTICLE_GAP_MS = 900; // extra breath on the first word of a new article (not scaled)

  function isSpeed(x) { return SPEEDS.indexOf(x) !== -1; }
  function sum(arr) { var s = 0; for (var i = 0; i < arr.length; i++) s += arr[i]; return s; }
  function toInt(n, d) { n = Number(n); return isFinite(n) && n >= 0 ? Math.floor(n) : d; }

  /**
   * host = {
   *   count()            -> number of articles
   *   load(a)            -> { blocks:[wordsInBlock...], delay?:(b,w)=>msAt1x }   (called ONLY when entering an article)
   *   onPos(info)        -> { a,b,w,pct,jump,blockChanged,articleChanged }
   *   onStatus(status)   -> status changed
   *   onSpeed(speed)
   *   onComplete()
   * }
   * timers (optional, for tests): { set, clear }
   */
  function createEngine(host, timers) {
    var T = timers || { set: function (f, ms) { return setTimeout(f, ms); }, clear: function (id) { clearTimeout(id); } };
    var st = { status: 'idle', a: 0, b: 0, w: 0, speed: 1, count: 0, meta: null, blocks: [], total: 0, pct: 0 };
    var timer = null;
    var epoch = 0;

    function clearTimer() { if (timer !== null) { T.clear(timer); timer = null; } }

    function setStatus(s) {
      if (st.status === s) return;
      st.status = s;
      if (host.onStatus) host.onStatus(s);
    }

    function wordsBefore() {
      var n = 0;
      for (var i = 0; i < st.b && i < st.blocks.length; i++) n += st.blocks[i];
      return n + st.w;
    }

    function rawPct() {
      if (!st.count) return 0;
      var frac = st.total ? wordsBefore() / st.total : 0;
      if (st.status === 'completed') return 100;
      return Math.min(100, ((st.a + frac) / st.count) * 100);
    }

    function bumpPct() { var r = rawPct(); if (r > st.pct) st.pct = r; return st.pct; }

    function emit(jump, blockChanged, articleChanged) {
      if (host.onPos) host.onPos({ a: st.a, b: st.b, w: st.w, pct: bumpPct(), jump: !!jump, blockChanged: !!blockChanged, articleChanged: !!articleChanged });
    }

    function loadArticle(a) {
      var meta;
      try { meta = host.load(a); } catch (e) { meta = null; }
      if (!meta || !meta.blocks) meta = { blocks: [] };
      st.meta = meta;
      st.blocks = meta.blocks.map(function (n) { return toInt(n, 0); });
      st.total = sum(st.blocks);
      return meta;
    }

    function firstBlock(from) {
      for (var i = from || 0; i < st.blocks.length; i++) if (st.blocks[i] > 0) return i;
      return -1;
    }

    // Enter article `a` (or the first later one that has readable words). Bounded loop.
    function enterFrom(a, b, w) {
      while (a < st.count) {
        loadArticle(a);
        var start = firstBlock(b || 0);
        if (start !== -1) {
          st.a = a;
          st.b = start;
          st.w = (start === (b || 0) && w < st.blocks[start]) ? w : 0;
          emit(true, true, true);
          return true;
        }
        a++; b = 0; w = 0;
      }
      complete();
      return false;
    }

    function complete() {
      clearTimer();
      epoch++;
      st.a = Math.max(0, st.count - 1);
      st.pct = 100;
      setStatus('completed');
      if (host.onComplete) host.onComplete();
    }

    function dwell() {
      var base = st.meta && typeof st.meta.delay === 'function' ? st.meta.delay(st.b, st.w) : BASE_MS;
      if (!isFinite(base) || base <= 0) base = BASE_MS;
      var ms = base;
      if (st.w === 0 && st.b > 0) ms += BLOCK_GAP_MS;
      ms = ms / st.speed;
      if (st.a > 0 && st.b === firstBlock(0) && st.w === 0) ms += ARTICLE_GAP_MS;
      return Math.max(30, Math.round(ms));
    }

    function schedule() {
      clearTimer();
      if (st.status !== 'playing') return;
      var my = ++epoch;
      timer = T.set(function () {
        if (my !== epoch || st.status !== 'playing') return; // stale callback guard
        timer = null;
        tick();
      }, dwell());
    }

    function tick() {
      var b = st.b, w = st.w + 1, blockChanged = false;
      if (w >= st.blocks[b]) {
        b++; w = 0; blockChanged = true;
        while (b < st.blocks.length && st.blocks[b] === 0) b++;
      }
      if (b < st.blocks.length) {
        st.b = b; st.w = w;
        emit(false, blockChanged, false);
      } else {
        enterFrom(st.a + 1, 0, 0);          // next article (or completes)
      }
      if (st.status === 'playing') schedule();
    }

    var api = {
      SPEEDS: SPEEDS,

      start: function (pos) {
        clearTimer(); epoch++;
        st.count = toInt(host.count(), 0);
        if (!st.count) { setStatus('idle'); return false; }
        pos = pos || {};
        if (isSpeed(pos.speed)) st.speed = pos.speed;
        st.pct = 0;
        var a = Math.min(toInt(pos.a, 0), st.count - 1);
        setStatus('playing');
        if (host.onSpeed) host.onSpeed(st.speed);
        var ok = enterFrom(a, toInt(pos.b, 0), toInt(pos.w, 0));
        if (ok && st.status === 'playing') schedule();
        return ok;
      },

      pause: function () {
        if (st.status !== 'playing') return;
        clearTimer(); epoch++;
        setStatus('paused');
      },

      resume: function () {
        if (st.status !== 'paused') return;
        setStatus('playing');
        schedule();
      },

      toggle: function () {
        if (st.status === 'playing') api.pause(); else if (st.status === 'paused') api.resume();
      },

      // Speed only affects the NEXT dwell: the running timer is never restarted.
      setSpeed: function (x) {
        x = Number(x);
        if (!isSpeed(x) || x === st.speed) return;
        st.speed = x;
        if (host.onSpeed) host.onSpeed(x);
      },

      stop: function () {
        clearTimer(); epoch++;
        var snap = api.snapshot();
        setStatus('idle');
        return snap;
      },

      // The current article was re-rendered (e.g. language switch): keep the same relative place.
      rebase: function (meta) {
        if (st.status === 'idle' || !meta || !meta.blocks) return;
        var frac = st.total ? wordsBefore() / st.total : 0;
        st.meta = meta;
        st.blocks = meta.blocks.map(function (n) { return toInt(n, 0); });
        st.total = sum(st.blocks);
        if (!st.total) return;
        var target = Math.min(st.total - 1, Math.round(frac * st.total));
        for (var i = 0; i < st.blocks.length; i++) {
          if (target < st.blocks[i]) { st.b = i; st.w = target; break; }
          target -= st.blocks[i];
        }
        emit(true, true, false);
      },

      snapshot: function () { return { a: st.a, b: st.b, w: st.w, speed: st.speed }; },

      state: function () {
        return { status: st.status, a: st.a, b: st.b, w: st.w, speed: st.speed, count: st.count,
                 blocks: st.blocks.length, pct: st.pct, timerActive: timer !== null };
      }
    };
    return api;
  }

  return { createEngine: createEngine, SPEEDS: SPEEDS, BASE_MS: BASE_MS };
});