/* MovAi service worker v2.1.12 — Web Push (push + notificationclick + install/activate). */
self.addEventListener('install', function (e) { self.skipWaiting(); });
self.addEventListener('activate', function (e) { e.waitUntil(self.clients.claim()); });
self.addEventListener('push', function (e) {
  var data = {};
  try { data = e.data ? e.data.json() : {}; } catch (_) {}
  var title = data.title || 'MovAi';
  var options = {
    body: data.body || '',
    tag: data.tag || 'movai',
    data: data
  };
  e.waitUntil(self.registration.showNotification(title, options));
});
self.addEventListener('notificationclick', function (e) {
  e.notification.close();
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
      for (var i = 0; i < list.length; i++) {
        if ('focus' in list[i]) return list[i].focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow('/');
    })
  );
});
