self.addEventListener('install', event => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', event => {
  if(event.request.mode!=='navigate') return;
  event.respondWith(fetch(event.request).catch(()=>new Response(
    '<!doctype html><html lang="cs"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>taximetr</title><h1>taximetr</h1><p>Dispečink potřebuje připojení k internetu.</p><a href="/">Zkusit znovu</a></html>',
    {headers:{'Content-Type':'text/html; charset=utf-8'}}
  )));
});

self.addEventListener('push', event=>{
  event.waitUntil(self.registration.showNotification('taximetr · Nová zakázka',{
    body:'Otevřete aplikaci a potvrďte přijetí.',
    icon:'/taximetr-192.png',tag:'new-ride',renotify:true,vibrate:[250,100,250]
  }));
});
self.addEventListener('notificationclick', event=>{
  event.notification.close();
  event.waitUntil(self.clients.matchAll({type:'window',includeUncontrolled:true}).then(clients=>{
    const app=clients.find(client=>new URL(client.url).origin===self.location.origin);
    return app?app.focus():self.clients.openWindow('/');
  }));
});
