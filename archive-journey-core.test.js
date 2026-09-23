const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeState, createProgressStore } = require('./archive-journey-core.js');

test('normalizeState keeps an exact word-level reading position and clamps invalid values', () => {
  const out = normalizeState({ article: 2, block: 4, word: 9, speed: 1.5, completed: false }, 7, 5);
  assert.deepEqual(out, { article: 2, block: 4, word: 9, speed: 1.5, completed: false });
  const clamped = normalizeState({ article: 99, block: -4, word: 99, speed: 7, completed: 'x' }, 2, 3, 3);
  assert.deepEqual(clamped, { article: 1, block: 0, word: 2, speed: 1, completed: false });
});

test('guest store uses only local storage', async () => {
  const memory = new Map();
  let fetchCalls = 0;
  const store = createProgressStore({
    getAuthToken: () => '',
    storage: {
      getItem: key => memory.get(key) ?? null,
      setItem: (key, value) => memory.set(key, value),
      removeItem: key => memory.delete(key)
    },
    fetchImpl: async () => { fetchCalls++; throw new Error('network should not be used for guests'); },
    settingsUrl: 'https://example.invalid/api/auth/settings'
  });
  await store.save({ article: 1, block: 2, word: 3, speed: 1.5, completed: false });
  assert.equal(fetchCalls, 0);
  assert.deepEqual(await store.load(), { article: 1, block: 2, word: 3, speed: 1.5, completed: false });
});

test('registered store reads and writes progress through the authenticated D1 settings API', async () => {
  const memory = new Map();
  const requests = [];
  const serverState = { article: 3, block: 1, word: 7, speed: 2, completed: false };
  const store = createProgressStore({
    getAuthToken: () => 'session-token',
    storage: {
      getItem: key => memory.get(key) ?? null,
      setItem: (key, value) => memory.set(key, value),
      removeItem: key => memory.delete(key)
    },
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      if (options.method === 'GET') {
        return { ok: true, status: 200, json: async () => ({ success: true, settings: { poppy_archive_journey_v1: JSON.stringify(serverState) } }) };
      }
      serverState.article = 4;
      return { ok: true, status: 200, json: async () => ({ success: true }) };
    },
    settingsUrl: 'https://auth.example/api/auth/settings'
  });
  assert.deepEqual(await store.load(), serverState);
  await store.save({ article: 4, block: 0, word: 2, speed: 1, completed: false });
  assert.equal(requests.length, 2);
  assert.equal(requests[0].options.headers.Authorization, 'Bearer session-token');
  assert.equal(requests[1].options.headers.Authorization, 'Bearer session-token');
  const payload = JSON.parse(requests[1].options.body);
  assert.equal(payload.key, 'poppy_archive_journey_v1');
  assert.deepEqual(JSON.parse(payload.value), { article: 4, block: 0, word: 2, speed: 1, completed: false });
  assert.equal(memory.has('poppy_archive_journey_guest_v1'), false);
});
