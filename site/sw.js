const C='tp-v16';const F=['./','index.html','backup.js','import.js','vendor/supabase-2.45.4.js','privacy.html','setup.html','terms.html','manifest.webmanifest','icon-192.png','icon-512.png'];
self.addEventListener('install',e=>{e.waitUntil(caches.open(C).then(c=>c.addAll(F)));self.skipWaiting()});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(k=>Promise.all(k.filter(x=>x!==C).map(x=>caches.delete(x)))));self.clients.claim()});
self.addEventListener('fetch',e=>{if(e.request.method!=='GET')return;e.respondWith(caches.match(e.request).then(r=>r||fetch(e.request).then(n=>{const cp=n.clone();if(n.ok&&new URL(e.request.url).origin===location.origin)caches.open(C).then(c=>c.put(e.request,cp));return n}).catch(()=>caches.match('index.html'))))});
