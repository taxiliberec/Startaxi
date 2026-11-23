self.addEventListener('install',event=>event.waitUntil(self.skipWaiting()));
self.addEventListener('activate',event=>event.waitUntil(self.clients.claim()));
self.addEventListener('fetch',event=>{
  if(event.request.mode!=='navigate') return;
  event.respondWith(fetch(event.request).catch(()=>new Response(
    '<!doctype html><html lang="cs"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Startaxi</title><h1>Startaxi</h1><p>Objednávky potřebují připojení k internetu.</p><a href="/customer/">Zkusit znovu</a></html>',
    {headers:{'Content-Type':'text/html; charset=utf-8'}}
  )));
});
