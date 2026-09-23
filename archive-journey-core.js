(function(root, factory){
  if(typeof module === 'object' && module.exports){
    module.exports = factory();
  }else{
    root.PoppyArchiveJourneyCore = factory();
  }
})(typeof self !== 'undefined' ? self : this, function(){
  'use strict';

  const SPEEDS = [0.5, 1, 1.5, 2];
  const GUEST_KEY = 'poppy_archive_journey_guest_v1';
  const AUTH_KEY = 'poppy_archive_journey_v1';

  function clampInt(value, min, max, fallback){
    const n = Number.isFinite(Number(value)) ? Math.trunc(Number(value)) : fallback;
    return Math.max(min, Math.min(max, n));
  }

  function normalizeSpeed(value){
    const n = Number(value);
    return SPEEDS.includes(n) ? n : 1;
  }

  function normalizeState(input, articleCount, blockCount, wordCount){
    const maxArticle = Math.max(0, Number(articleCount || 1) - 1);
    const maxBlock = Math.max(0, Number(blockCount || 1) - 1);
    const maxWord = Math.max(0, Number.isFinite(Number(wordCount)) ? Number(wordCount) - 1 : 1000000);
    return {
      article: clampInt(input && input.article, 0, maxArticle, 0),
      block: clampInt(input && input.block, 0, maxBlock, 0),
      word: clampInt(input && input.word, 0, maxWord, 0),
      speed: normalizeSpeed(input && input.speed),
      completed: input && input.completed === true
    };
  }

  function parseStored(value){
    if(!value) return null;
    try{
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' ? parsed : null;
    }catch(_){
      return null;
    }
  }

  function createProgressStore(options){
    const opts = options || {};
    const storage = opts.storage || null;
    const fetchImpl = opts.fetchImpl || (typeof fetch === 'function' ? fetch.bind(globalThis) : null);
    const settingsUrl = String(opts.settingsUrl || '');
    const getAuthToken = typeof opts.getAuthToken === 'function' ? opts.getAuthToken : () => '';

    async function load(){
      const token = String(getAuthToken() || '').trim();
      if(!token){
        if(!storage) return null;
        return parseStored(storage.getItem(GUEST_KEY));
      }
      if(!fetchImpl || !settingsUrl) throw new Error('registered_store_unavailable');

      const response = await fetchImpl(settingsUrl, {
        method:'GET',
        headers:{ Authorization:'Bearer ' + token },
        cache:'no-store'
      });
      if(!response.ok) throw new Error('settings_load_failed');
      const payload = await response.json();
      const raw = payload && payload.success && payload.settings
        ? payload.settings[AUTH_KEY]
        : null;
      return parseStored(raw);
    }

    async function save(state, options){
      const token = String(getAuthToken() || '').trim();
      const value = JSON.stringify(state);
      if(!token){
        if(!storage) return false;
        storage.setItem(GUEST_KEY, value);
        return true;
      }
      if(!fetchImpl || !settingsUrl) throw new Error('registered_store_unavailable');

      const response = await fetchImpl(settingsUrl, {
        method:'PUT',
        headers:{
          'Content-Type':'application/json',
          Authorization:'Bearer ' + token
        },
        body:JSON.stringify({ key:AUTH_KEY, value }),
        keepalive:!!(options && options.keepalive)
      });
      if(!response.ok) throw new Error('settings_save_failed');
      return true;
    }

    function clearGuest(){
      if(storage) storage.removeItem(GUEST_KEY);
    }

    return { load, save, clearGuest, keys:{guest:GUEST_KEY, auth:AUTH_KEY} };
  }

  return {
    SPEEDS,
    GUEST_KEY,
    AUTH_KEY,
    normalizeState,
    createProgressStore
  };
});
