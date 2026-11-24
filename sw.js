/* Service Worker：缓存应用本身（离线可打开），接收「分享到行迹」的 GPX 文件。
 * 卫星瓦片不在这里缓存（跨域瓦片缓存会大量占用配额），交给浏览器自身的 HTTP 缓存。 */
const VER = 'xingji-v3';
const SHELL = ['./', './index.html', './style.css?v=4', './app.js?v=3', './manifest.webmanifest', './icons/icon-192.png', './icons/icon-512.png',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css', 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VER).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== VER && k !== 'share-inbox').map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const req = e.request, url = new URL(req.url);
  // 分享目标：把文件暂存到 share-inbox，再跳回应用
  if (req.method === 'POST' && url.pathname.endsWith('/share-target')) {
    e.respondWith((async () => {
      const fd = await req.formData(), c = await caches.open('share-inbox');
      for (const f of fd.getAll('gpx')) if (f && f.size) await c.put(`./inbox/${Date.now()}-${Math.random()}`, new Response(f, { headers: { 'x-name': encodeURIComponent(f.name || 'shared.gpx') } }));
      return Response.redirect('./?share=1', 303);
    })());
    return;
  }
  if (req.method !== 'GET') return;
  const isShell = url.origin === location.origin || url.href.startsWith('https://unpkg.com/leaflet@1.9.4/');
  if (!isShell) return;
  // 联网优先（保证改版后立即生效），3 秒没响应或离线时用缓存
  e.respondWith((async () => {
    const c = await caches.open(VER);
    const net = fetch(req).then(r => { if (r.ok) c.put(req, r.clone()); return r; }).catch(() => null);
    const timeout = new Promise(r => setTimeout(() => r(null), 3000));
    const fresh = await Promise.race([net, timeout]);
    if (fresh) return fresh;
    const hit = await c.match(req, { ignoreSearch: req.mode === 'navigate' }) || (req.mode === 'navigate' && await c.match('./index.html'));
    return hit || (await net) || Response.error();
  })());
});
