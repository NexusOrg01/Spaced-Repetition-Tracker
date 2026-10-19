import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = readFileSync(resolve(root, 'sw.js'), 'utf8');
const ORIGIN = 'https://nexus.test/';
const CACHE_NAME = 'nexus-rating-analytics-v14';
const CACHE_PREFIX = 'nexus-rating-analytics-';

function response(status = 200, type = 'basic') {
  return { status, type, clone() { return response(status, type); } };
}

function createHarness(networkHandler = async () => response()) {
  const listeners = Object.create(null);
  const store = new Map();
  let networkCalls = 0;
  let skipWaitingCalled = false;

  class RequestStub {
    constructor(input, options = {}) {
      const raw = typeof input === 'string' ? input : input.url;
      this.url = new URL(raw, ORIGIN).href;
      this.method = options.method || (typeof input !== 'string' && input.method) || 'GET';
      this.mode = options.mode || (typeof input !== 'string' && input.mode) || 'cors';
      this.cache = options.cache || (typeof input !== 'string' && input.cache) || 'default';
    }
  }

  class CacheStub {
    constructor(name) { this.name = name; this.entries = new Map(); }
    async put(req, value) {
      const request = new RequestStub(req);
      this.entries.set(request.url, value && typeof value.clone === 'function' ? value.clone() : value);
    }
    async match(req) {
      const request = new RequestStub(req);
      const value = this.entries.get(request.url);
      return value && typeof value.clone === 'function' ? value.clone() : value;
    }
    async add(req) {
      const value = await network(req);
      if (!value || value.status < 200 || value.status >= 300) throw new Error('Cache.add received a failed response.');
      await this.put(req, value);
    }
    async addAll(requests) { await Promise.all(requests.map(req => this.add(req))); }
  }

  const caches = {
    async open(name) {
      if (!store.has(name)) store.set(name, new CacheStub(name));
      return store.get(name);
    },
    async keys() { return [...store.keys()]; },
    async delete(name) { return store.delete(name); },
    async match(req) {
      for (const cache of store.values()) {
        const value = await cache.match(req);
        if (value) return value;
      }
      return undefined;
    }
  };

  async function network(req, options) {
    networkCalls++;
    return networkHandler(new RequestStub(req, options), options);
  }

  const self = {
    location: { origin: new URL(ORIGIN).origin },
    clients: { claim: async () => undefined },
    addEventListener(name, handler) { listeners[name] = handler; },
    skipWaiting() { skipWaitingCalled = true; return Promise.resolve(); }
  };
  const context = { self, caches, fetch: network, Request: RequestStub, URL, Promise };
  vm.createContext(context);
  vm.runInContext(source, context, { filename: 'sw.js' });

  return {
    listeners, caches, RequestStub, response,
    get networkCalls() { return networkCalls; },
    get skipWaitingCalled() { return skipWaitingCalled; },
    resetNetworkCalls() { networkCalls = 0; }
  };
}

function eventFor(request) {
  return {
    request,
    waits: [],
    response: null,
    waitUntil(value) { this.waits.push(Promise.resolve(value)); },
    respondWith(value) { this.response = Promise.resolve(value); }
  };
}

async function settle(event) {
  if (event.response) await event.response;
  await Promise.all(event.waits);
}

{
  const h = createHarness(async () => response());
  await h.caches.open(CACHE_PREFIX + 'v11');
  await h.caches.open('another-app-cache-v4');
  await h.caches.open(CACHE_NAME);
  const activation = eventFor(undefined);
  h.listeners.activate(activation);
  await settle(activation);
  const keys = await h.caches.keys();
  assert.deepEqual(keys.sort(), [CACHE_NAME, 'another-app-cache-v4'].sort(),
    'activation should delete only old Nexus-prefixed caches and preserve other apps’ caches');
}

{
  const h = createHarness(async () => response());
  const cache = await h.caches.open(CACHE_NAME);
  const request = new h.RequestStub('./fsrs-bundle.js');
  await cache.put(request, response());
  h.resetNetworkCalls();
  const event = eventFor(new h.RequestStub('./fsrs-bundle.js'));
  h.listeners.fetch(event);
  const cached = await event.response;
  await Promise.all(event.waits);
  assert.equal(cached.status, 200);
  assert.equal(h.networkCalls, 0, 'a cache hit must not initiate a background network request');
}

{
  const h = createHarness(async () => response());
  const request = new h.RequestStub('./new-asset.js');
  const event = eventFor(request);
  h.listeners.fetch(event);
  const result = await event.response;
  await Promise.all(event.waits);
  assert.equal(result.status, 200);
  const cache = await h.caches.open(CACHE_NAME);
  assert.equal((await cache.match(request))?.status, 200,
    'a cache miss should fetch and await the successful response cache write');
  assert.equal(h.networkCalls, 1, 'a cache miss should issue one network request');
}

{
  const h = createHarness(async req => {
    const path = new URL(req.url).pathname;
    if (path.endsWith('/icon.svg') || path.endsWith('/icon-192.png') || path.endsWith('/icon-512.png')) return response(404);
    return response();
  });
  const event = eventFor(undefined);
  h.listeners.install(event);
  await settle(event);
  assert.equal(h.skipWaitingCalled, true,
    'missing optional icon assets must not prevent the core offline shell from installing');
  const cache = await h.caches.open(CACHE_NAME);
  assert.ok(await cache.match('./index.html'), 'the core HTML shell should be cached during install');
}

{
  const h = createHarness(async () => response());
  const event = eventFor(new h.RequestStub('https://nexus.test/api/private'));
  h.listeners.fetch(event);
  assert.equal(event.response, null, 'same-origin API requests must bypass the service worker cache');
  assert.equal(h.networkCalls, 0);
}

{
  const h = createHarness(async () => response());
  const request = new h.RequestStub('./?code=oauth-test', { mode: 'navigate' });
  const event = eventFor(request);
  h.listeners.fetch(event);
  const result = await event.response;
  await Promise.all(event.waits);
  assert.equal(result.status, 200);
  const cache = await h.caches.open(CACHE_NAME);
  assert.equal(await cache.match(request), undefined,
    'query-bearing authentication callback URLs must not be written to the cache');
}

assert.ok(source.includes('keys.filter(k=>k.startsWith(CACHE_PREFIX)&&k!==CACHE_NAME)'),
  'the activation handler must scope cache cleanup to Nexus-owned cache names');
assert.ok(source.includes('const CACHE_NAME=CACHE_PREFIX+\'v14\';') || source.includes("const CACHE_NAME=CACHE_PREFIX+'v14';"),
  'the app-shell cache version must advance after service-worker behavior changes');
console.log('Service-worker reliability tests passed.');
