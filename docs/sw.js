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

// RR好機通知の端末設定（"rr-enabled" が "0" のときだけ無効。未設定は有効）。
async function isRrEnabled() {
  try {
    const cache = await caches.open(CFG_CACHE);
    const res = await cache.match('rr-enabled');
    return res ? (await res.text()) !== '0' : true;
  } catch {
    return true;
  }
}

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  event.waitUntil(
    (async () => {
      // push は必ず1件は通知を出す（userVisibleOnly 準拠）。内容は push 本体に無いため
      // サーバから取得するが、配信遅延で /recent(直近) が空になることがある。その場合は
      // /alerts?limit=1（最新の実アラート）→ 汎用文言 の順にフォールバックする。
      let alerts = [];
      const base = await getAlertUrl();
      if (base) {
        try {
          let res = await fetch(`${base}/recent`);
          if (res.ok) alerts = await res.json();
          if (alerts.length === 0) {
            // 遅延配信：直近窓を外れていても最新のアラートを1件表示する。
            res = await fetch(`${base}/alerts?limit=1`);
            if (res.ok) alerts = await res.json();
          }
        } catch (e) {
          // 取得失敗 → 下の汎用フォールバックで1件出す。
        }
      }
      // RR好機通知（pair が "RR:" 始まり）は端末設定が OFF なら表示しない。
      if (!(await isRrEnabled())) {
        alerts = alerts.filter((a) => !String(a.pair || '').startsWith('RR:'));
      }
      if (alerts.length === 0) {
        alerts = [{ pair: 'market', title: '相場変動通知', body: '相場が大きく変動しました。アプリで確認してください。' }];
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
