// 相場変動通知の Service Worker。
// Alert Worker からの「ペイロードレス Web Push」を受けて、/recent から直近アラートを
// 取得し通知表示する。tag=ペア で同一ペアの通知を置き換え、重複を防ぐ。
//
// Alert Worker の URL はページ側が Cache Storage("market-alert-cfg" の "alert-url") に
// 書き込む。SW 再起動後もここから読めるため永続化不要。

const CFG_CACHE = 'market-alert-cfg';

async function getAlertUrl() {
  const cache = await caches.open(CFG_CACHE);
  const res = await cache.match('alert-url');
  return res ? (await res.text()) : null;
}

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  event.waitUntil(
    (async () => {
      const base = await getAlertUrl();
      if (!base) return;
      let alerts = [];
      try {
        const res = await fetch(`${base}/recent`);
        if (res.ok) alerts = await res.json();
      } catch (e) {
        // 取得失敗時は汎用文言で1件だけ出す。
        alerts = [{ pair: 'market', title: '相場変動通知', body: '相場が大きく変動しました' }];
      }
      await Promise.all(
        alerts.map((a) =>
          // タイトルにペア＋変動（例「GBP/JPY 急変動 25pips」）。古い通知/取得失敗は pair かフォールバック。
          self.registration.showNotification(a.title || a.pair || '相場変動通知', {
            body: a.body,
            tag: a.pair, // 同一ペアは置き換え（重複防止）
            renotify: true,
            icon: 'vite.svg',
            badge: 'vite.svg',
          }),
        ),
      );
    })(),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    (async () => {
      const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of all) {
        if ('focus' in client) return client.focus();
      }
      return self.clients.openWindow(self.registration.scope);
    })(),
  );
});
