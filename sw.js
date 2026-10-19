const CACHE_PREFIX='nexus-rating-analytics-';
const CACHE_NAME=CACHE_PREFIX+'v14';
const CORE_APP_SHELL=['./','./index.html','./fsrs-bundle.js','./backup-restore-utils.js','./manifest.webmanifest'];
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
  const networkFirst=req.mode==='navigate'||url.pathname==='/'||url.pathname.endsWith('.html')||url.pathname.endsWith('.webmanifest')||url.pathname.endsWith('/curricula/catalog.json');
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
