(function(){
'use strict';

const CORE = window.PoppyArchiveJourneyCore;
if(!CORE) return;

const SETTINGS_URL = 'https://poppy-auth-api.hosseinasgari898989.workers.dev/api/auth/settings';
const BLOCK_SELECTOR = 'p,h3,h4,li,.quote';
const SAVE_DELAY = 1200;
const state = {
  active:false,
  paused:false,
  article:0,
  block:0,
  word:0,
  speed:1,
  completed:false,
  timer:null,
  saveTimer:null,
  persistInFlight:null,
  loadPromise:null,
  store:null,
  metrics:null,
  keys:null,
  intentionalClose:false
};

const $ = id => document.getElementById(id);

function authToken(){
  try { return localStorage.getItem('poppy_auth_token') || ''; } catch { return ''; }
}

function currentLanguage(){
  try { return currentLang === 'en' ? 'en' : 'fa'; } catch { return 'fa'; }
}

function languageText(fa,en){ return currentLanguage() === 'en' ? en : fa; }

function articleKeys(){
  if(!state.keys){
    state.keys = Array.from(document.querySelectorAll('.articleCard[data-article]')).map(c => c.dataset.article).filter(Boolean);
  }
  return state.keys;
}

function articleSource(key){
  const registry = typeof articles !== 'undefined' ? articles : null;
  const article = registry && registry[key];
  if(!article) return null;
  return article[currentLanguage()] || article.fa || article.en || null;
}

function extractBlocks(html){
  const host = document.createElement('div');
  host.innerHTML = html || '';
  return Array.from(host.querySelectorAll(BLOCK_SELECTOR)).map(node => ({
    html: node.outerHTML,
    wordCount: (node.textContent || '').split(/\s+/).filter(Boolean).length
  }));
}

function buildMetrics(){
  const metrics = {};
  let totalWords = 0;
  articleKeys().forEach(key => {
    const data = articleSource(key);
    const blocks = extractBlocks(data && data.content);
    const wordCounts = blocks.map(b => b.wordCount);
    const words = wordCounts.reduce((n,v) => n + v, 0);
    metrics[key] = { blocks, wordCounts, words };
    totalWords += words;
  });
  return { metrics, totalWords };
}

function makeStore(){
  return CORE.createProgressStore({
    getAuthToken: authToken,
    storage: localStorage,
    fetchImpl: window.fetch.bind(window),
    settingsUrl: SETTINGS_URL
  });
}

function guestMode(){
  return !authToken();
}

function clampState(input){
  const keys = articleKeys();
  if(!keys.length) return {article:0,block:0,word:0,speed:1,completed:false};
  let article = Math.max(0, Math.min(keys.length - 1, Math.trunc(Number(input && input.article) || 0)));
  const metric = state.metrics.metrics[keys[article]] || {wordCounts:[]};
  let block = Math.max(0, Math.min(Math.max(0, metric.wordCounts.length - 1), Math.trunc(Number(input && input.block) || 0)));
  const maxWord = Math.max(0, (metric.wordCounts[block] || 1) - 1);
  let word = Math.max(0, Math.min(maxWord, Math.trunc(Number(input && input.word) || 0)));
  return CORE.normalizeState({
    article, block, word,
    speed: input && input.speed,
    completed: input && input.completed
  }, keys.length, Math.max(1, metric.wordCounts.length), metric.wordCounts[block] || 1);
}

function progressState(){
  return {
    article: state.article,
    block: state.block,
    word: state.word,
    speed: state.speed,
    completed: state.completed
  };
}

function hasResume(stateValue){
  return !!stateValue && !stateValue.completed &&
    (stateValue.article > 0 || stateValue.block > 0 || stateValue.word > 0);
}

function totalPassedWords(){
  const keys = articleKeys();
  let total = 0;
  for(let i=0;i<state.article;i++){
    total += state.metrics.metrics[keys[i]].words;
  }
  const current = state.metrics.metrics[keys[state.article]];
  if(current){
    for(let i=0;i<state.block;i++) total += current.wordCounts[i] || 0;
    total += state.word;
  }
  return total;
}

function percent(){
  const total = state.metrics.totalWords || 1;
  return Math.min(100, Math.round(totalPassedWords() / total * 100));
}

function injectUI(){
  if(!$('archiveJourneyStyle')){
    const link = document.createElement('link');
    link.id = 'archiveJourneyStyle';
    link.rel = 'stylesheet';
    link.href = './archive-journey.css';
    document.head.appendChild(link);
  }

  const grid = document.querySelector('.navgrid');
  if(grid && !$('archiveJourneyNav')){
    const card = document.createElement('button');
    card.id = 'archiveJourneyNav';
    card.type = 'button';
    card.className = 'navcard archive-journey-nav';
    card.innerHTML = '<span class="aj-badge">✦</span><strong></strong><small></small>';
    card.querySelector('strong').textContent = languageText('حالت مطالعه','Archive Journey');
    card.querySelector('small').textContent = languageText('مطالعه‌ی خودکار مقاله‌ها','Guided article reading');
    card.addEventListener('click', startJourney);
    const news = grid.querySelector('[data-target="news"]');
    if(news && news.nextSibling) grid.insertBefore(card, news.nextSibling);
    else grid.appendChild(card);
  }

  if(!$('archiveJourneyBar')){
    const bar = document.createElement('div');
    bar.id = 'archiveJourneyBar';
    bar.innerHTML =
      '<div id="archiveJourneyMain"><div id="archiveJourneyTitle"></div><div id="archiveJourneyMeta"></div></div>' +
      '<div id="archiveJourneyPct">0٪</div>' +
      '<div id="archiveJourneyActions">' +
        '<button type="button" class="archive-journey-btn" id="archiveJourneyPause"></button>' +
        '<button type="button" class="archive-journey-btn" data-aj-speed="0.5">0.5x</button>' +
        '<button type="button" class="archive-journey-btn" data-aj-speed="1">1x</button>' +
        '<button type="button" class="archive-journey-btn" data-aj-speed="1.5">1.5x</button>' +
        '<button type="button" class="archive-journey-btn" data-aj-speed="2">2x</button>' +
        '<button type="button" class="archive-journey-btn exit" id="archiveJourneyExit"></button>' +
      '</div>' +
      '<div id="archiveJourneyProgress"><div id="archiveJourneyProgressFill"></div></div>';
    document.body.appendChild(bar);
    $('archiveJourneyPause').addEventListener('click', togglePause);
    $('archiveJourneyExit').addEventListener('click', exitJourney);
    bar.querySelectorAll('[data-aj-speed]').forEach(btn => btn.addEventListener('click', () => setSpeed(Number(btn.dataset.ajSpeed))));
  }

  if(!$('archiveJourneyToast')){
    const toast = document.createElement('div');
    toast.id = 'archiveJourneyToast';
    document.body.appendChild(toast);
  }

  if(!$('archiveJourneyResume')){
    const dialog = document.createElement('div');
    dialog.id = 'archiveJourneyResume';
    dialog.innerHTML =
      '<div class="aj-dialog">' +
        '<h3></h3><p></p>' +
        '<div class="aj-dialog-actions"><button type="button" class="primary" id="archiveJourneyResumeYes"></button><button type="button" id="archiveJourneyResumeNo"></button></div>' +
      '</div>';
    document.body.appendChild(dialog);
    $('archiveJourneyResumeYes').addEventListener('click', () => continueFromSaved(true));
    $('archiveJourneyResumeNo').addEventListener('click', () => continueFromSaved(false));
  }

  refreshUIStrings();
}

function refreshUIStrings(){
  const card = $('archiveJourneyNav');
  if(card){
    const strong = card.querySelector('strong'), small = card.querySelector('small');
    if(strong) strong.textContent = languageText('حالت مطالعه','Archive Journey');
    if(small) small.textContent = languageText('مطالعه‌ی خودکار مقاله‌ها','Guided article reading');
  }
  const pause = $('archiveJourneyPause');
  const exit = $('archiveJourneyExit');
  if(pause) pause.textContent = state.paused ? '▶ ' + languageText('ادامه','Resume') : '⏸ ' + languageText('توقف','Pause');
  if(exit) exit.textContent = languageText('خروج','Exit');
  const yes = $('archiveJourneyResumeYes'), no = $('archiveJourneyResumeNo'), dialog = $('archiveJourneyResume');
  if(yes) yes.textContent = languageText('ادامه','Resume');
  if(no) no.textContent = languageText('از اول','Start over');
  if(dialog){
    dialog.querySelector('h3').textContent = languageText('ادامه‌ی مطالعه؟','Resume reading?');
  }
}

function showToast(message){
  const toast = $('archiveJourneyToast');
  if(!toast) return;
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove('show'), 1900);
}

function showResumeDialog(saved){
  const dialog = $('archiveJourneyResume');
  if(!dialog) return;
  dialog.querySelector('p').textContent = languageText(
    'آخرین موقعیت ذخیره‌شده: مقاله ' + (saved.article + 1) + '، بخش ' + (saved.block + 1) + '، کلمه ' + (saved.word + 1) + '.',
    'Saved position: article ' + (saved.article + 1) + ', block ' + (saved.block + 1) + ', word ' + (saved.word + 1) + '.'
  );
  dialog.classList.add('show');
}

function hideResumeDialog(){
  const dialog = $('archiveJourneyResume');
  if(dialog) dialog.classList.remove('show');
}

function setBarVisible(show){
  const bar = $('archiveJourneyBar');
  if(bar) bar.classList.toggle('show', show);
}

function refreshProgressUI(){
  const keys = articleKeys();
  const key = keys[state.article];
  const data = articleSource(key) || {title:'',meta:''};
  const title = $('archiveJourneyTitle'), meta = $('archiveJourneyMeta');
  if(title) title.textContent = data.title || '';
  if(meta) meta.textContent = languageText(
    'مقاله ' + (state.article + 1) + ' از ' + keys.length + ' • بخش ' + (state.block + 1),
    'Article ' + (state.article + 1) + ' of ' + keys.length + ' • Block ' + (state.block + 1)
  );
  const pct = percent();
  if($('archiveJourneyPct')) $('archiveJourneyPct').textContent = pct + '٪';
  if($('archiveJourneyProgressFill')) $('archiveJourneyProgressFill').style.width = pct + '%';
  document.querySelectorAll('[data-aj-speed]').forEach(btn => btn.classList.toggle('active', Number(btn.dataset.ajSpeed) === state.speed));
  refreshUIStrings();
}

function decorateArticle(){
  const content = $('articleContent');
  if(!content) return;
  content.querySelectorAll('.archive-journey-block').forEach(el => el.classList.remove('archive-journey-block','active'));
  content.querySelectorAll('.archive-journey-word').forEach(el => el.replaceWith(document.createTextNode(el.textContent)));
  content.querySelectorAll(BLOCK_SELECTOR).forEach(block => {
    block.classList.add('archive-journey-block');
    wrapTextNodes(block);
  });
}

function wrapTextNodes(root){
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes = [];
  let node;
  while((node = walker.nextNode())) nodes.push(node);
  nodes.forEach(textNode => {
    if(!textNode.nodeValue || !textNode.nodeValue.trim()) return;
    if(textNode.parentElement && textNode.parentElement.closest('script,style')) return;
    const frag = document.createDocumentFragment();
    textNode.nodeValue.split(/(\s+)/).filter(Boolean).forEach(token => {
      if(/^\s+$/.test(token)){
        frag.appendChild(document.createTextNode(token));
      }else{
        const span = document.createElement('span');
        span.className = 'archive-journey-word';
        span.textContent = token;
        frag.appendChild(span);
      }
    });
    textNode.replaceWith(frag);
  });
}

function clearArticleJourneyClasses(){
  const content = $('articleContent');
  if(!content) return;
  content.querySelectorAll('.archive-journey-block').forEach(el => el.classList.remove('archive-journey-block','active'));
  content.querySelectorAll('.archive-journey-word').forEach(el => el.replaceWith(document.createTextNode(el.textContent)));
}

function paintCurrentWord(scrollIntoView){
  const content = $('articleContent');
  if(!content) return;
  const blocks = Array.from(content.querySelectorAll('.archive-journey-block'));
  blocks.forEach((block, bi) => {
    block.classList.toggle('active', bi === state.block);
    const words = Array.from(block.querySelectorAll('.archive-journey-word'));
    words.forEach((word, wi) => {
      word.classList.toggle('read', bi < state.block || (bi === state.block && wi < state.word));
      word.classList.toggle('current', bi === state.block && wi === state.word);
    });
  });
  const current = blocks[state.block] && blocks[state.block].querySelectorAll('.archive-journey-word')[state.word];
  if(current && scrollIntoView){
    const box = current.getBoundingClientRect();
    const viewTop = window.innerHeight * .24;
    const viewBottom = window.innerHeight * .78;
    if(box.top < viewTop || box.bottom > viewBottom) current.scrollIntoView({behavior:'smooth',block:'center'});
  }
  refreshProgressUI();
}

function openJourneyArticle(){
  const keys = articleKeys();
  const key = keys[state.article];
  if(!key) return false;
  state.intentionalClose = true;
  try{
    if(typeof window.openArticle === 'function') window.openArticle(key);
  }finally{
    state.intentionalClose = false;
  }
  const content = $('articleContent');
  if(!content) return false;
  decorateArticle();
  const modal = $('articleModal');
  if(modal) modal.classList.add('archive-journey-active');
  paintCurrentWord(false);
  return true;
}

async function loadSavedState(){
  const loaded = await state.store.load();
  if(!loaded) return null;
  return clampState(loaded);
}

function schedulePersist(immediate, keepalive){
  if(immediate){
    clearTimeout(state.saveTimer);
    state.saveTimer = null;
    return flushPersist(keepalive);
  }
  if(state.saveTimer) return state.saveTimer;
  state.saveTimer = setTimeout(() => {
    state.saveTimer = null;
    void flushPersist(false);
  }, SAVE_DELAY);
  return state.saveTimer;
}

async function flushPersist(keepalive){
  clearTimeout(state.saveTimer);
  state.saveTimer = null;
  const snapshot = progressState();
  if(state.persistInFlight){
    try{ await state.persistInFlight; }catch(_){}
  }
  const run = state.store.save(snapshot,{keepalive:!!keepalive});
  state.persistInFlight = Promise.resolve(run);
  try{ await state.persistInFlight; }
  catch(_){ if(!guestMode()) showToast(languageText('⚠️ ذخیره در سرور انجام نشد.','⚠️ Server save failed.')); }
  finally{ state.persistInFlight = null; }
}

function tick(){
  if(!state.active || state.paused) return;
  const content = $('articleContent');
  const activeBlock = content && content.querySelectorAll('.archive-journey-block')[state.block];
  const words = activeBlock ? activeBlock.querySelectorAll('.archive-journey-word') : [];
  if(!words.length){ advanceBlock(); return; }

  state.word++;
  if(state.word >= words.length){
    state.word = 0;
    advanceBlock();
  }else{
    paintCurrentWord(true);
    schedulePersist(false,false);
  }
}

function advanceBlock(){
  const keys = articleKeys();
  const currentMetric = state.metrics.metrics[keys[state.article]];
  state.block++;
  state.word = 0;
  if(state.block < currentMetric.wordCounts.length){
    paintCurrentWord(true);
    schedulePersist(true,false);
    return;
  }
  state.article++;
  state.block = 0;
  state.word = 0;
  if(state.article >= keys.length){
    state.article = keys.length - 1;
    state.completed = true;
    paintCurrentWord(false);
    schedulePersist(true,false).finally(finishJourney);
    return;
  }
  openJourneyArticle();
  schedulePersist(true,false);
}

function startTimer(){
  clearInterval(state.timer);
  if(state.active && !state.paused){
    state.timer = setInterval(tick, Math.max(70, 150 / state.speed));
  }
}

function togglePause(){
  if(!state.active) return;
  state.paused = !state.paused;
  refreshUIStrings();
  startTimer();
  schedulePersist(true,false);
  showToast(state.paused ? languageText('مطالعه متوقف شد','Reading paused') : languageText('مطالعه ادامه پیدا کرد','Reading resumed'));
}

function setSpeed(speed){
  state.speed = CORE.SPEEDS.includes(speed) ? speed : 1;
  refreshProgressUI();
  startTimer();
  schedulePersist(true,false);
  showToast(languageText('سرعت ' + state.speed + 'x شد','Speed set to ' + state.speed + 'x'));
}

async function continueFromSaved(resume){
  hideResumeDialog();
  if(!resume){
    state.article = 0; state.block = 0; state.word = 0; state.completed = false;
    await flushPersist(false);
  }
  openJourneyArticle();
  state.active = true;
  state.paused = false;
  setBarVisible(true);
  paintCurrentWord(false);
  startTimer();
}

async function startJourney(){
  if(state.active) return;
  if(!state.metrics){
    state.metrics = buildMetrics();
  }
  if(!state.store) state.store = makeStore();

  try{
    const saved = await loadSavedState();
    if(saved && saved.completed) {
      state.article = 0; state.block = 0; state.word = 0; state.speed = saved.speed || 1; state.completed = false;
    } else if(hasResume(saved)){
      state.article = saved.article; state.block = saved.block; state.word = saved.word; state.speed = saved.speed; state.completed = false;
      state.paused = false;
      state.active = true;
      setBarVisible(true);
      showResumeDialog(saved);
      refreshProgressUI();
      return;
    } else {
      state.article = 0; state.block = 0; state.word = 0; state.speed = (saved && saved.speed) || 1; state.completed = false;
    }
    openJourneyArticle();
    state.active = true;
    state.paused = false;
    setBarVisible(true);
    paintCurrentWord(false);
    startTimer();
    await flushPersist(false);
  }catch(_){
    showToast(languageText('⚠️ ذخیره‌سازی فعلاً در دسترس نیست؛ مطالعه از ابتدا شروع می‌شود.','⚠️ Progress storage is unavailable; starting from the beginning.'));
    state.article = 0; state.block = 0; state.word = 0; state.speed = 1; state.completed = false;
    openJourneyArticle();
    state.active = true;
    state.paused = false;
    setBarVisible(true);
    paintCurrentWord(false);
    startTimer();
  }
}

async function exitJourney(){
  if(!state.active && !$('archiveJourneyBar')?.classList.contains('show')) return;
  clearInterval(state.timer);
  state.timer = null;
  await flushPersist(true);
  state.active = false;
  state.paused = false;
  clearArticleJourneyClasses();
  const modal = $('articleModal');
  if(modal) modal.classList.remove('archive-journey-active');
  state.intentionalClose = true;
  try{
    if(typeof window.closeArticleModal === 'function') window.closeArticleModal();
    else if(typeof window.closeArticle === 'function') window.closeArticle();
    else if($('articleModal')) $('articleModal').classList.remove('show');
  }catch(_){}
  state.intentionalClose = false;
  setBarVisible(false);
  refreshUIStrings();
  showToast(languageText('موقعیتت ذخیره شد.','Your position was saved.'));
}

async function finishJourney(){
  clearInterval(state.timer);
  state.timer = null;
  state.active = false;
  state.paused = false;
  const modal = $('articleModal');
  if(modal) modal.classList.remove('archive-journey-active');
  state.intentionalClose = true;
  try{
    if(typeof window.closeArticleModal === 'function') window.closeArticleModal();
  }catch(_){}
  state.intentionalClose = false;
  setBarVisible(false);
  showToast(languageText('Journey تمام شد؛ مسیر مطالعه ذخیره شد.','Archive Journey completed; progress was saved.'));
}

function handleAuthChange(){
  const tokenNow = authToken();
  const registered = !!tokenNow;
  if(state.active){
    clearInterval(state.timer);
    state.timer = null;
    clearTimeout(state.saveTimer);
    state.saveTimer = null;
    state.active = false;
    state.paused = false;
    state.intentionalClose = true;
    try{
      if(typeof window.closeArticleModal === 'function') window.closeArticleModal();
    }catch(_){}
    state.intentionalClose = false;
    const modal = $('articleModal');
    if(modal) modal.classList.remove('archive-journey-active');
    setBarVisible(false);
  }
  if(registered){
    state.store && state.store.clearGuest();
  }
  state.store = makeStore();
}

function installAuthWatcher(){
  document.addEventListener('poppy-auth', handleAuthChange);
}

function installLanguageWatcher(){
  const oldSetLanguage = window.setLanguage;
  if(typeof oldSetLanguage === 'function' && !oldSetLanguage.__archiveJourney){
    const wrapped = function(){
      const result = oldSetLanguage.apply(this, arguments);
      refreshUIStrings();
      if(state.active) openJourneyArticle();
      return result;
    };
    wrapped.__archiveJourney = true;
    window.setLanguage = wrapped;
  }
}

function installArticleCloseWatcher(){
  const modal = $('articleModal');
  if(!modal) return;
  const observer = new MutationObserver(() => {
    if(state.active && !state.intentionalClose && !modal.classList.contains('show')){
      setTimeout(() => { if(state.active) openJourneyArticle(); }, 0);
    }
  });
  observer.observe(modal,{attributes:true,attributeFilter:['class']});
}

function installLifecycle(){
  document.addEventListener('visibilitychange', () => {
    if(document.hidden && state.active) void flushPersist(true);
  });
  window.addEventListener('pagehide', () => {
    if(state.active) void flushPersist(true);
  });
  document.addEventListener('keydown', event => {
    if(!state.active) return;
    if(event.key === 'Escape'){
      event.preventDefault();
      void exitJourney();
    }else if(event.key === ' ' && !/input|textarea|button/i.test(document.activeElement && document.activeElement.tagName || '')){
      event.preventDefault();
      togglePause();
    }
  });
}

async function init(){
  if(typeof articles === 'undefined') return;
  injectUI();
  state.store = makeStore();
  state.metrics = buildMetrics();
  installAuthWatcher();
  installLanguageWatcher();
  installArticleCloseWatcher();
  installLifecycle();
}

if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, {once:true});
else init();

window.ArchiveJourney = {
  start:startJourney,
  exit:exitJourney,
  pause:togglePause,
  setSpeed,
  getState:() => ({...progressState(),active:state.active,paused:state.paused,registered:!!authToken()}),
  clearGuestProgress:() => { state.store && state.store.clearGuest(); }
};

})();