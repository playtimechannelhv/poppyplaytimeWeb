/*!
 * archive-journey.js  —  Reading Mode UI layer (needs archive-journey-core.js first)
 *
 * Integration points with the existing site (all read-only, nothing is overridden):
 *   window.openArticle(key) / window.closeArticleModal()   -> open / close the article modal
 *   #articleModal > .articleModalBox                       -> the REAL scroll container of an article
 *   #articleTitle, #articleContent                         -> article DOM
 *   #news .articleCard[data-article]                       -> real article order
 *   <html lang>                                            -> current language ('fa' | 'en')
 *   localStorage                                           -> persistence (the site has no server-side settings endpoint)
 * No analytics / telemetry / network requests of any kind.
 */
(function () {
  'use strict';
  if (window.ArchiveJourney) return;
  var Core = window.ArchiveJourneyCore;
  if (!Core) { try { console.warn('[Archive Journey] core file is missing'); } catch (e) {} return; }

  var D = document, R = D.documentElement;
  var STORE = 'poppy_journey_v1';

  /* ------------------------------------------------------------------ i18n */
  var TXT = {
    fa: { article: 'مقاله', of: 'از', block: 'بخش', pause: '⏸ توقف', resume: '▶ ادامه', exit: 'خروج',
          done: 'پایان مطالعه ✓', doneToast: '🎉 مطالعه‌ی همه‌ی مقاله‌ها تمام شد', resumeQ: 'ادامه‌ی مطالعه؟',
          resumeGo: 'ادامه', resumeNew: 'از اول', bar: 'حالت مطالعه', speed: 'سرعت', pct: '٪',
          unavailable: '⚠️ مقاله‌ای برای مطالعه پیدا نشد.' },
    en: { article: 'Article', of: 'of', block: 'Block', pause: '⏸ Pause', resume: '▶ Resume', exit: 'Exit',
          done: 'Reading finished ✓', doneToast: '🎉 Finished reading all articles', resumeQ: 'Continue reading?',
          resumeGo: 'Resume', resumeNew: 'Start over', bar: 'Reading mode', speed: 'Speed', pct: '%',
          unavailable: '⚠️ No articles found to read.' }
  };
  function isEn() { return R.lang === 'en'; }
  function T(k) { return (isEn() ? TXT.en : TXT.fa)[k]; }
  function num(n) {
    if (isEn()) return String(n);
    try { return Number(n).toLocaleString('fa-IR', { useGrouping: false }); } catch (e) { return String(n); }
  }
  function toast(msg, type) { try { if (typeof window.showToast === 'function') window.showToast(msg, type || ''); } catch (e) {} }
  function $(id) { return D.getElementById(id); }
  function now() { return (window.performance && performance.now) ? performance.now() : Date.now(); }
  function reduced() { try { return !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches); } catch (e) { return false; } }

  /* --------------------------------------------------------------- storage */
  // Guests and signed-in users both use the site's own persistence layer (localStorage):
  // the site has no server-side settings endpoint, so none is invented here.
  function storeKey() {
    try {
      if (localStorage.getItem('poppy_auth_token')) return STORE + ':u:' + (localStorage.getItem('poppy_auth_display') || 'user');
    } catch (e) {}
    return STORE + ':guest';
  }
  function loadSaved() {
    try {
      var raw = localStorage.getItem(storeKey()); if (!raw) return null;
      var o = JSON.parse(raw);
      return (o && o.v === 1 && typeof o.key === 'string') ? o : null;
    } catch (e) { return null; }
  }
  function writeSaved(o) { try { localStorage.setItem(storeKey(), JSON.stringify(o)); } catch (e) {} }
  function clearSaved() { try { localStorage.removeItem(storeKey()); } catch (e) {} }

  /* ----------------------------------------------------------------- state */
  var engine = null, ui = null;
  var active = false, exiting = false, resumeOpen = false;
  var keys = [], curKey = null;
  var blocks = [], cur = null, activeBlock = null;
  var scroller = null, anim = null, holdUntil = 0, lastSave = 0, recenterTimer = 0;
  var bar = { a: 0, n: 0, b: 0, nb: 0, pct: 0, title: '', shownPct: -1 };

  /* ------------------------------------------------------ article discovery */
  function getKeys() {
    var out = [], seen = {}, cards = D.querySelectorAll('#news .articleCard[data-article]');
    if (!cards.length) cards = D.querySelectorAll('.articleCard[data-article]');
    for (var i = 0; i < cards.length; i++) {
      var k = cards[i].getAttribute('data-article');
      if (!k || seen[k]) continue;
      try { if (typeof articles === 'object' && articles && !articles[k]) continue; } catch (e) {}
      seen[k] = 1; out.push(k);
    }
    return out;
  }
  function articleLabel(key) {
    try { var d = articles[key][isEn() ? 'en' : 'fa']; if (d && d.title) return d.title; } catch (e) {}
    var c = D.querySelector('.articleCard[data-article="' + key + '"] h4');
    return c ? c.textContent.trim() : key;
  }

  /* -------------------------------------------------------- DOM -> word list */
  var LETTER; try { LETTER = new RegExp('[\\p{L}\\p{N}]', 'u'); } catch (e) { LETTER = /[A-Za-z0-9\u0600-\u06FF]/; }
  var BLOCKISH = /^(P|H[1-6]|BLOCKQUOTE|LI|PRE|FIGCAPTION|DT|DD|TD|TH)$/;
  var CONTAINER = /^(UL|OL|DL|TABLE|THEAD|TBODY|TFOOT|TR)$/;
  var WRAPPER = /^(DIV|SECTION|ARTICLE|ASIDE|FIGURE|DETAILS|MAIN)$/;

  function hasBlockish(el) { return !!el.querySelector('p,h1,h2,h3,h4,h5,h6,blockquote,li,pre,dt,dd'); }
  function collectBlocks(root, out) {
    for (var c = root.firstElementChild; c; c = c.nextElementSibling) {
      var tag = c.tagName;
      if (tag === 'SCRIPT' || tag === 'STYLE') continue;
      if (CONTAINER.test(tag)) collectBlocks(c, out);
      else if (WRAPPER.test(tag) && hasBlockish(c)) collectBlocks(c, out);
      else out.push(c);
    }
    return out;
  }
  // Wrap every word of `el` in <span class="aj-w"> (once per article render). Inline tags (b, i, a) are preserved.
  function wrapWords(el) {
    var walker = D.createTreeWalker(el, NodeFilter.SHOW_TEXT, null), nodes = [], n;
    while ((n = walker.nextNode())) {
      var p = n.parentNode;
      if (p && (p.nodeName === 'SCRIPT' || p.nodeName === 'STYLE')) continue;
      if (p && p.classList && p.classList.contains('aj-w')) continue;         // already wrapped
      if (/\S/.test(n.nodeValue)) nodes.push(n);
    }
    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i], txt = node.nodeValue, frag = D.createDocumentFragment(), last = 0, re = /\S+/g, m;
      while ((m = re.exec(txt))) {
        if (m.index > last) frag.appendChild(D.createTextNode(txt.slice(last, m.index)));
        if (LETTER.test(m[0])) { var s = D.createElement('span'); s.className = 'aj-w'; s.textContent = m[0]; frag.appendChild(s); }
        else frag.appendChild(D.createTextNode(m[0]));                         // lone dashes / bullets are not "words"
        last = re.lastIndex;
      }
      if (last < txt.length) frag.appendChild(D.createTextNode(txt.slice(last)));
      node.parentNode.replaceChild(frag, node);
    }
    return Array.prototype.slice.call(el.querySelectorAll('.aj-w'));
  }
  var STOP = /[.!?؟…]["'”’»)\]]*$/, PART = /[,،;؛:]["'”’»)\]]*$/;
  function wordDelay(span) {
    var t = span.textContent, ms = 230 + Math.min(t.length, 14) * 14;          // ≈300 ms for a 5-letter word at 1x
    if (STOP.test(t)) ms += 260; else if (PART.test(t)) ms += 120;
    return ms;
  }

  // Processes the CURRENT #articleContent once and returns the meta the engine needs.
  function prepareDom() {
    var content = $('articleContent');
    blocks = []; cur = null; activeBlock = null;
    if (!content) return { blocks: [] };
    var els = collectBlocks(content, []), counts = [], delays = [];
    for (var i = 0; i < els.length; i++) {
      var words = wrapWords(els[i]);
      if (!words.length) continue;
      els[i].classList.add('aj-blk');
      blocks.push({ el: els[i], words: words });
      counts.push(words.length);
      delays.push(words.map(wordDelay));
    }
    var first = content.firstElementChild;
    if (first) first.__ajPrep = true;                                          // lets the observer tell "our" render from a foreign one
    return { blocks: counts, delay: function (b, w) { return (delays[b] && delays[b][w]) || 300; } };
  }

  /* -------------------------------------------------------------- painting */
  function paintFull(b, w) {
    if (!blocks[b]) return;
    for (var i = 0; i < blocks.length; i++) {
      blocks[i].el.classList.toggle('aj-done', i < b);
      blocks[i].el.classList.toggle('aj-active', i === b);
    }
    var ws = blocks[b].words;
    for (var j = 0; j < w; j++) ws[j].classList.add('aj-read');                // words before the current one are "read"
    if (cur && cur !== ws[w]) cur.classList.remove('aj-cur');
    cur = ws[w] || null;
    activeBlock = blocks[b].el;
    if (cur) { cur.classList.remove('aj-read'); cur.classList.add('aj-cur'); }
  }
  function paintStep(b, w, blockChanged) {
    if (cur) { cur.classList.remove('aj-cur'); cur.classList.add('aj-read'); }
    if (blockChanged) {
      if (activeBlock) { activeBlock.classList.remove('aj-active'); activeBlock.classList.add('aj-done'); }
      activeBlock = blocks[b].el; activeBlock.classList.add('aj-active');
    }
    cur = blocks[b].words[w] || null;
    if (cur) cur.classList.add('aj-cur');
  }

  /* ---------------------------------------------------------------- scroll */
  function findScroller() {
    var content = $('articleContent'), el = content && content.closest ? content.closest('.articleModalBox') : null;
    if (el) return el;
    for (el = content && content.parentElement; el && el !== D.body && el !== R; el = el.parentElement) {
      var oy = getComputedStyle(el).overflowY;
      if ((oy === 'auto' || oy === 'scroll') && el.scrollHeight > el.clientHeight) return el;
    }
    return null;                                                               // never fall back to the page/body scroll
  }
  function attachScroller() {
    var s = findScroller();
    if (s !== scroller) { scroller = s; }
    if (scroller && !scroller.__ajHold) {
      scroller.__ajHold = true;
      var hold = function () {
        holdUntil = now() + 2500;
        cancelAnim();
        if (recenterTimer) { clearTimeout(recenterTimer); recenterTimer = 0; }
      }; // user takes over for a moment

      var scheduleReturnToCurrent = function () {
        if (!active || !cur) return;
        if (recenterTimer) clearTimeout(recenterTimer);

        // After the user's scroll settles, smoothly return to the exact word
        // currently being highlighted by the reading marker.
        recenterTimer = setTimeout(function () {
          recenterTimer = 0;
          if (!active || !cur) return;
          holdUntil = 0;
          autoScroll(cur);
        }, 850);
      };

      scroller.addEventListener('wheel', hold, { passive: true });
      scroller.addEventListener('touchstart', hold, { passive: true });
      scroller.addEventListener('mousedown', hold, { passive: true });
      scroller.addEventListener('scroll', function () {
        if (now() <= holdUntil) scheduleReturnToCurrent();
      }, { passive: true });
    }
    if (scroller) scroller.style.scrollBehavior = 'auto';
  }
  function cancelAnim() { if (anim) { if (anim.raf) cancelAnimationFrame(anim.raf); anim = null; } }
  function wordTop(el) {                                                       // layout offset inside the scroller (immune to transforms)
    var y = 0, n = el;
    while (n && n !== scroller) { y += n.offsetTop; n = n.offsetParent; }
    if (n !== scroller) { var cr = scroller.getBoundingClientRect(), wr = el.getBoundingClientRect(); return wr.top - cr.top - scroller.clientTop + scroller.scrollTop; }
    return y;
  }
  function maxScroll() { return Math.max(0, scroller.scrollHeight - scroller.clientHeight); }
  function clampT(v) { return Math.max(0, Math.min(v, maxScroll())); }
  function animateTo(target) {
    cancelAnim();
    var start = scroller.scrollTop, dist = target - start;
    if (Math.abs(dist) < 1) return;
    if (reduced() || D.hidden) { scroller.scrollTop = target; return; }
    var dur = Math.max(300, Math.min(720, 240 + Math.abs(dist) * 0.55)), me = { raf: 0, t0: null };
    anim = me;
    me.raf = requestAnimationFrame(function frame(ts) {
      if (anim !== me) return;                                                 // cancelled / superseded
      if (me.t0 === null) me.t0 = ts;
      var p = Math.min(1, (ts - me.t0) / dur), e = p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
      scroller.scrollTop = start + dist * e;
      if (p < 1) me.raf = requestAnimationFrame(frame); else anim = null;
    });
  }
  // Called once per word. Does nothing while the word is inside the safe band; otherwise ONE eased move.
  function autoScroll(el) {
    if (!scroller || !el || now() < holdUntil) return;
    var H = scroller.clientHeight; if (!H) return;
    var top = wordTop(el) - scroller.scrollTop, bot = top + (el.offsetHeight || 20);
    if (top >= H * 0.18 && bot <= H * 0.62) return;                            // safe band
    var hard = top < 0 || bot > H;                                              // word is actually off screen
    if (anim && !hard) return;                                                  // let the running animation finish
    var target = clampT(scroller.scrollTop + top - H * 0.26);
    if (Math.abs(target - scroller.scrollTop) < 2) return;
    animateTo(target);
  }
  function alignInstant(el) {
    if (!scroller || !el) return;
    cancelAnim();
    var H = scroller.clientHeight, top = wordTop(el) - scroller.scrollTop;
    if (top >= H * 0.18 && top + (el.offsetHeight || 20) <= H * 0.62) return;
    scroller.scrollTop = clampT(scroller.scrollTop + top - H * 0.26);
  }
  function resetScroll() { cancelAnim(); if (scroller) scroller.scrollTop = 0; }

  /* ------------------------------------------------------------------ bar UI */
  function buildUI() {
    if (ui) return;
    var wrap = D.createElement('div');
    wrap.innerHTML =
      '<div id="ajBar" role="region" aria-hidden="true">' +
        '<div class="aj-row1"><div class="aj-title" id="ajTitle"></div><div class="aj-pct" id="ajPct">0</div></div>' +
        '<div class="aj-info" id="ajInfo"></div>' +
        '<div class="aj-track" id="ajTrack" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><div class="aj-fill" id="ajFill"></div></div>' +
        '<div class="aj-row3">' +
          '<button type="button" class="aj-btn" id="ajToggle"></button>' +
          '<div class="aj-speeds" id="ajSpeeds" role="group">' +
            '<button type="button" class="aj-btn aj-sp" data-sp="0.5">0.5x</button>' +
            '<button type="button" class="aj-btn aj-sp" data-sp="1">1x</button>' +
            '<button type="button" class="aj-btn aj-sp" data-sp="1.5">1.5x</button>' +
            '<button type="button" class="aj-btn aj-sp" data-sp="2">2x</button>' +
          '</div>' +
          '<button type="button" class="aj-btn aj-exit" id="ajExit"></button>' +
        '</div>' +
      '</div>' +
      '<div id="ajResume" role="dialog" aria-modal="true" aria-labelledby="ajResumeT" aria-hidden="true">' +
        '<div class="aj-dlg"><h3 id="ajResumeT"></h3><p id="ajResumeP"></p>' +
        '<div class="aj-actions"><button type="button" class="aj-btn on" id="ajResumeGo"></button><button type="button" class="aj-btn" id="ajResumeNew"></button></div></div>' +
      '</div>';
    while (wrap.firstChild) D.body.appendChild(wrap.firstChild);
    ui = { bar: $('ajBar'), title: $('ajTitle'), pct: $('ajPct'), info: $('ajInfo'), track: $('ajTrack'), fill: $('ajFill'),
           toggle: $('ajToggle'), speeds: $('ajSpeeds'), exit: $('ajExit'),
           dlg: $('ajResume'), dlgT: $('ajResumeT'), dlgP: $('ajResumeP'), go: $('ajResumeGo'), fresh: $('ajResumeNew'), dlgSaved: null };

    ui.toggle.addEventListener('click', function () { if (engine) engine.toggle(); });
    ui.exit.addEventListener('click', function () { exit(); });
    ui.speeds.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('.aj-sp') : null;
      if (b && engine) engine.setSpeed(parseFloat(b.getAttribute('data-sp')));
    });
    ui.go.addEventListener('click', function () { var s = ui.dlgSaved; hideResume(); begin(s); });
    ui.fresh.addEventListener('click', function () { clearSaved(); hideResume(); begin(null); });
    ui.dlg.addEventListener('click', function (e) { if (e.target === ui.dlg) hideResume(); });

    if (window.ResizeObserver) new ResizeObserver(setOffset).observe(ui.bar);
    else window.addEventListener('resize', setOffset);
  }
  function setOffset() {                                                       // keep the article modal just below the bar
    if (!ui || !active) return;
    var top = parseFloat(getComputedStyle(ui.bar).top) || 10;
    R.style.setProperty('--aj-off', Math.round(ui.bar.offsetHeight + top + 12) + 'px');
  }
  function applyLang() {
    if (!ui) return;
    ui.bar.dir = isEn() ? 'ltr' : 'rtl';
    ui.dlg.dir = isEn() ? 'ltr' : 'rtl';
    ui.bar.setAttribute('aria-label', T('bar'));
    ui.exit.textContent = T('exit');
    ui.speeds.setAttribute('aria-label', T('speed'));
    ui.dlgT.textContent = T('resumeQ'); ui.go.textContent = T('resumeGo'); ui.fresh.textContent = T('resumeNew');
    if (ui.dlgSaved) renderResumeText();
    bar.shownPct = -1;
    renderBar();
    syncButtons();
    setOffset();
  }
  function syncButtons() {
    if (!ui || !engine) return;
    var s = engine.state();
    ui.bar.classList.toggle('aj-paused', s.status === 'paused');
    ui.bar.classList.toggle('aj-finished', s.status === 'completed');
    ui.toggle.textContent = s.status === 'paused' ? T('resume') : T('pause');
    ui.toggle.classList.toggle('on', s.status === 'paused');
    ui.toggle.disabled = s.status === 'completed';
    var sp = ui.speeds.querySelectorAll('.aj-sp');
    for (var i = 0; i < sp.length; i++) {
      var on = parseFloat(sp[i].getAttribute('data-sp')) === s.speed;
      sp[i].classList.toggle('on', on); sp[i].setAttribute('aria-pressed', on ? 'true' : 'false');
      sp[i].disabled = s.status === 'completed';
    }
  }
  function renderBar() {
    if (!ui) return;
    var s = engine ? engine.state() : null;
    if (bar.title !== ui.title.textContent) ui.title.textContent = bar.title;
    var info = (s && s.status === 'completed') ? T('done')
      : T('article') + ' ' + num(bar.a + 1) + ' ' + T('of') + ' ' + num(bar.n) + ' · ' + T('block') + ' ' + num(bar.b + 1) + ' ' + T('of') + ' ' + num(bar.nb);
    if (ui.info.textContent !== info) ui.info.textContent = info;
    var p = Math.min(100, Math.floor(bar.pct));
    if (bar.shownPct !== p) {
      bar.shownPct = p;
      ui.pct.textContent = num(p) + T('pct');
      ui.fill.style.width = bar.pct.toFixed(1) + '%';
      ui.track.setAttribute('aria-valuenow', String(p));
    }
  }
  function showBar() { ui.bar.setAttribute('aria-hidden', 'false'); void ui.bar.offsetWidth; ui.bar.classList.add('aj-show'); }
  function hideBar() { if (!ui) return; ui.bar.classList.remove('aj-show', 'aj-paused'); ui.bar.setAttribute('aria-hidden', 'true'); }

  /* ------------------------------------------------------------ resume dialog */
  function renderResumeText() {
    var s = ui.dlgSaved, i = keys.indexOf(s.key);
    ui.dlgP.textContent = T('article') + ' ' + num(i + 1) + ' ' + T('of') + ' ' + num(keys.length) + ' — ' + articleLabel(s.key);
  }
  function showResume(saved) {
    buildUI(); ui.dlgSaved = saved; resumeOpen = true;
    ui.dlg.dir = isEn() ? 'ltr' : 'rtl';
    ui.dlgT.textContent = T('resumeQ'); ui.go.textContent = T('resumeGo'); ui.fresh.textContent = T('resumeNew');
    renderResumeText();
    ui.dlg.setAttribute('aria-hidden', 'false'); void ui.dlg.offsetWidth; ui.dlg.classList.add('aj-show');
    try { ui.go.focus({ preventScroll: true }); } catch (e) {}
  }
  function hideResume() { if (!ui) return; resumeOpen = false; ui.dlg.classList.remove('aj-show'); ui.dlg.setAttribute('aria-hidden', 'true'); }

  /* ------------------------------------------------------------- engine host */
  function loadArticle(a) {                                                    // called by the engine ONLY when entering an article
    curKey = keys[a];
    bar.a = a; bar.n = keys.length;
    if (typeof window.openArticle === 'function') window.openArticle(curKey);
    try { if (typeof currentArticleKey !== 'undefined' && currentArticleKey !== curKey) return { blocks: [] }; } catch (e) {}
    attachScroller();
    var meta = prepareDom();
    resetScroll();
    var t = $('articleTitle'); bar.title = t ? t.textContent : '';
    bar.b = 0; bar.nb = meta.blocks.length;
    return meta;
  }
  function onPos(p) {
    if (!active) return;
    bar.a = p.a; bar.b = p.b; bar.nb = blocks.length; bar.pct = p.pct;
    if (p.articleChanged || p.jump) { paintFull(p.b, p.w); alignInstant(cur); }
    else { paintStep(p.b, p.w, p.blockChanged); autoScroll(cur); }
    renderBar();
    if (now() - lastSave > 1500) persist();
  }
  function onStatus(s) {
    if (!active) return;
    syncButtons(); renderBar();
    if (s === 'paused') persist();
  }
  function onSpeed() { syncButtons(); }
  function onComplete() {
    if (!active) return;
    bar.pct = 100;
    if (cur) { cur.classList.remove('aj-cur'); cur.classList.add('aj-read'); }
    if (activeBlock) { activeBlock.classList.remove('aj-active'); activeBlock.classList.add('aj-done'); }
    clearSaved();
    syncButtons(); renderBar();
    toast(T('doneToast'), 'success');
  }
  function persist() {
    if (!active || !engine || !curKey) return;
    var s = engine.state();
    if (s.status !== 'playing' && s.status !== 'paused') return;
    lastSave = now();
    writeSaved({ v: 1, key: curKey, a: s.a, b: s.b, w: s.w, speed: s.speed, ts: Date.now() });
  }

  /* ------------------------------------------------------------ start / exit */
  function begin(pos) {
    if (active) return;
    keys = getKeys();
    if (!keys.length || typeof window.openArticle !== 'function') { toast(T('unavailable'), 'error'); return; }
    buildUI();
    var a = 0, b = 0, w = 0, speed = 1;
    if (pos) {
      var i = keys.indexOf(pos.key);
      if (i >= 0) { a = i; b = pos.b | 0; w = pos.w | 0; speed = pos.speed || 1; }
    }
    active = true; exiting = false; lastSave = 0;
    R.classList.add('aj-on');
    applyLang(); showBar(); setOffset();
    if (!engine.start({ a: a, b: b, w: w, speed: speed })) exit();
  }
  function exit() {
    if (!active || exiting) return;
    exiting = true;
    var s = engine.state(), snap = engine.stop();
    cancelAnim();
    if (recenterTimer) { clearTimeout(recenterTimer); recenterTimer = 0; }
    if (s.status === 'completed') clearSaved();
    else if (curKey) writeSaved({ v: 1, key: curKey, a: snap.a, b: snap.b, w: snap.w, speed: snap.speed, ts: Date.now() });
    active = false;
    if (scroller) scroller.style.scrollBehavior = '';
    var m = $('articleModal');
    if (m && m.classList.contains('show') && typeof window.closeArticleModal === 'function') window.closeArticleModal();
    hideBar();
    R.classList.remove('aj-on'); R.style.removeProperty('--aj-off');
    blocks = []; cur = null; activeBlock = null; curKey = null;
    exiting = false;
  }
  function onCardClick() {
    if (active || resumeOpen) return;
    keys = getKeys();
    var saved = loadSaved();
    if (saved && keys.indexOf(saved.key) >= 0) showResume(saved);
    else { if (saved) clearSaved(); begin(null); }
  }

  /* --------------------------------------------------------------- observers */
  function watch() {
    var modal = $('articleModal'), content = $('articleContent');
    if (window.MutationObserver) {
      if (modal) new MutationObserver(function () {                            // normal close (×, backdrop) => leave cleanly, position is saved
        if (active && !exiting && !modal.classList.contains('show')) exit();
      }).observe(modal, { attributes: true, attributeFilter: ['class'] });
      if (content) new MutationObserver(function () {                          // content replaced by someone else (e.g. language switch)
        if (!active || exiting) return;
        var f = content.firstElementChild;
        if (!f || f.__ajPrep) return;                                          // our own render
        try { if (typeof currentArticleKey !== 'undefined' && currentArticleKey !== curKey) { exit(); return; } } catch (e) {}
        var meta = prepareDom(); attachScroller();
        var t = $('articleTitle'); bar.title = t ? t.textContent : bar.title;
        engine.rebase(meta);
      }).observe(content, { childList: true });
      new MutationObserver(applyLang).observe(R, { attributes: true, attributeFilter: ['lang'] });
    }
    D.addEventListener('keydown', function (e) { if (e.key === 'Escape' && resumeOpen) hideResume(); });
    window.addEventListener('pagehide', persist);
    D.addEventListener('visibilitychange', function () { if (D.hidden) persist(); });
  }

  /* -------------------------------------------------------------------- init */
  function init() {
    engine = Core.createEngine({ count: function () { return keys.length; }, load: loadArticle,
      onPos: onPos, onStatus: onStatus, onSpeed: onSpeed, onComplete: onComplete });
    var card = $('journeyStartCard');
    if (card) card.addEventListener('click', onCardClick);
    watch();
  }

  window.ArchiveJourney = {
    start: onCardClick, exit: exit,
    pause: function () { if (engine) engine.pause(); }, resume: function () { if (engine) engine.resume(); },
    setSpeed: function (x) { if (engine) engine.setSpeed(x); },
    isActive: function () { return active; }, state: function () { return engine ? engine.state() : null; }
  };
  if (D.readyState === 'loading') D.addEventListener('DOMContentLoaded', init); else init();
})();