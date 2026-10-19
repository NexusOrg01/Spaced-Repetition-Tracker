const CACHE_NAME='nexus-rating-analytics-v11';
const CORE_APP_SHELL=['./','./index.html','./fsrs-bundle.js','./backup-restore-utils.js','./manifest.webmanifest'];
const OPTIONAL_APP_SHELL=['./curricula/catalog.json','./icon.svg','./icon-192.png','./icon-512.png'];
self.addEventListener('install',event=>{event.waitUntil(caches.open(CACHE_NAME).then(async cache=>{
  await cache.addAll(CORE_APP_SHELL.map(u=>new Request(u,{cache:'reload'})));
  await Promise.all(OPTIONAL_APP_SHELL.map(u=>cache.add(new Request(u,{cache:'reload'})).catch(()=>{})));
}).then(()=>self.skipWaiting()));});
self.addEventListener('activate',event=>{event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE_NAME).map(k=>caches.delete(k)))).then(()=>self.clients.claim()));});
function putInCache(req,response){
  const url=new URL(req.url);
  // Do not cache callback URLs or other query-bearing pages (OAuth codes can arrive in the query).
  if(url.search||response&&response.status===200&&response.type==='basic'){
    if(url.search||!response||response.status!==200||response.type!=='basic')return response;
  }
  if(response&&response.status===200&&response.type==='basic'){
    const copy=response.clone();caches.open(CACHE_NAME).then(cache=>cache.put(req,copy));
  }
  return response;
}
self.addEventListener('fetch',event=>{
  const req=event.request;const url=new URL(req.url);
  if(req.method!=='GET'||url.origin!==self.location.origin||url.pathname.startsWith('/downloads/')||url.pathname.endsWith('.apk')||url.pathname.startsWith('/.well-known/'))return;
  const networkFirst=req.mode==='navigate'||url.pathname==='/'||url.pathname.endsWith('.html')||url.pathname.endsWith('.webmanifest')||url.pathname.endsWith('/curricula/catalog.json');
  if(networkFirst){event.respondWith(fetch(req,{cache:'no-store'}).then(r=>putInCache(req,r)).catch(()=>caches.match(req).then(c=>c||caches.match('./index.html'))));return;}
  event.respondWith(caches.match(req).then(cached=>{const network=fetch(req).then(r=>putInCache(req,r)).catch(()=>cached);return cached||network;}));
});
