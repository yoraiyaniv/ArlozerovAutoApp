const CACHE = 'arlo-shell-v1';
const STATIC = ['/offline.html', '/icon-192.png', '/icon-512.png', '/icon-maskable.png', '/apple-touch-icon.png'];
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(STATIC)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k.startsWith('arlo-shell-') && k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('push', event => {
  let data = {};
  try { data = event.data.json(); } catch { /* show a generic notice below */ }
  event.waitUntil(self.registration.showNotification(data.title || 'Arlo Auto', { body: data.body || 'Open the app for details.', tag: data.tag, icon: '/icon-192.png', data: { url: data.url || '/' } }));
});
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const target = event.notification.data?.url || '/';
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(windows => {
    const open = windows.find(w => new URL(w.url).origin === self.location.origin);
    return open ? open.focus().then(w => w.navigate(target)).catch(() => {}) : self.clients.openWindow(target);
  }));
});
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  // Never cache authentication, account data, schedules, or booking API calls.
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/') || event.request.method !== 'GET') return;
  if (event.request.mode === 'navigate') {
    event.respondWith(fetch(event.request).catch(() => caches.match('/offline.html')));
    return;
  }
  if (STATIC.includes(url.pathname)) event.respondWith(caches.match(event.request).then(cached => cached || fetch(event.request)));
});
