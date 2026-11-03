const C='tp-v23';const F=['./','index.html','backup.js','import.js','vendor/supabase-2.45.4.js','privacy.html','setup.html','terms.html','manifest.webmanifest','icon-192.png','icon-512.png','topo.svg','topo-w.svg'];
self.addEventListener('install',e=>{e.waitUntil(caches.open(C).then(c=>c.addAll(F)));self.skipWaiting()});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(k=>Promise.all(k.filter(x=>x!==C).map(x=>caches.delete(x)))));self.clients.claim()});
/* Own files: network first (so a new version shows at once when there is signal), saved copy when offline or slow.
   Other sites are not intercepted. */
self.addEventListener('fetch',e=>{const r=e.request;if(r.method!=='GET')return;const own=new URL(r.url).origin===location.origin;
  if(!own)return; // other sites (weather, fonts, Supabase): let the browser handle them
  e.respondWith(new Promise(res=>{let done=false;const fall=()=>caches.match(r).then(x=>x||(r.mode==='navigate'?caches.match('index.html'):undefined)).then(x=>{if(x&&!done){done=true;res(x)}return x});
    const t=setTimeout(fall,4000);
    fetch(r,{cache:'no-cache'}).then(n=>{clearTimeout(t);if(n.ok){const cp=n.clone();caches.open(C).then(c=>c.put(r,cp))}if(!done){done=true;res(n)}})
      .catch(()=>{clearTimeout(t);fall().then(x=>{if(!done){done=true;res(x||Response.error())}})})}))});
