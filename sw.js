const CACHE_PREFIX='nexus-rating-analytics-';
const CACHE_NAME=CACHE_PREFIX+'v34';
const CORE_APP_SHELL=['./','./index.html','./app-core.js','./study-hub.js','./fsrs-bundle.js','./backup-restore-utils.js','./offline-sync-queue.js','./curriculum-integrity.js','./workspace-isolation-guard.js','./nexus-build-config.js','./cloud-sync-recovery.js','./workspace-sync-merge.js','./cloud-sync.js','./manifest.webmanifest'];
const OPTIONAL_APP_SHELL=['./curricula/catalog.json','./icon.svg','./icon-192.png','./icon-512.png'];
self.addEventListener('install',event=>{event.waitUntil(caches.open(CACHE_NAME).then(async cache=>{
  await cache.addAll(CORE_APP_SHELL.map(u=>new Request(u,{cache:'reload'})));
  await Promise.all(OPTIONAL_APP_SHELL.map(u=>cache.add(new Request(u,{cache:'reload'})).catch(()=>{})));
}).then(()=>self.skipWaiting()));});
self.addEventListener('activate',event=>{event.waitUntil(caches.keys().then(keys=>Promise.all(
  keys.filter(k=>k.startsWith(CACHE_PREFIX)&&k!==CACHE_NAME).map(k=>caches.delete(k))
)).then(()=>self.clients.claim()));});
function putInCache(req,response){
  const url=new URL(req.url);
  // Query strings can contain OAuth codes and must never be persisted in the cache.
  if(url.search||!response||response.status!==200||response.type!=='basic')return Promise.resolve(response);
  const copy=response.clone();
  return caches.open(CACHE_NAME).then(cache=>cache.put(req,copy)).then(()=>response).catch(()=>response);
}
function matchAppCache(req){
  // Do not read or serve entries from unrelated apps sharing the same origin.
  return caches.open(CACHE_NAME).then(cache=>cache.match(req));
}
self.addEventListener('fetch',event=>{
  const req=event.request;const url=new URL(req.url);
  if(req.method!=='GET'||url.origin!==self.location.origin||url.pathname.startsWith('/api/')||url.pathname.startsWith('/downloads/')||url.pathname.endsWith('.apk')||url.pathname.startsWith('/.well-known/'))return;
  // Keep HTML and coupled app JavaScript in step while online, with the versioned cache as an offline fallback.
  const networkFirst=req.mode==='navigate'||url.pathname==='/'||url.pathname.endsWith('.html')||url.pathname.endsWith('.webmanifest')||url.pathname.endsWith('/curricula/catalog.json')||url.pathname.endsWith('/backup-restore-utils.js')||url.pathname.endsWith('/offline-sync-queue.js')||url.pathname.endsWith('/curriculum-integrity.js')||url.pathname.endsWith('/workspace-isolation-guard.js')||url.pathname.endsWith('/nexus-build-config.js')||url.pathname.endsWith('/cloud-sync-recovery.js')||url.pathname.endsWith('/workspace-sync-merge.js')||url.pathname.endsWith('/cloud-sync.js')||url.pathname.endsWith('/fsrs-bundle.js')||url.pathname.endsWith('/app-core.js')||url.pathname.endsWith('/study-hub.js');
  if(networkFirst){
    const network=fetch(req,{cache:'no-store'}).then(r=>putInCache(req,r));
    event.waitUntil(network.then(()=>undefined,()=>undefined));
    event.respondWith(network.catch(()=>matchAppCache(req).then(c=>c||matchAppCache('./index.html'))));
    return;
  }
  // Truly cache-first: defer the network request until a cache miss is confirmed.
  event.respondWith(matchAppCache(req).then(cached=>{
    if(cached)return cached;
    return fetch(req).then(r=>putInCache(req,r));
  }));
});
