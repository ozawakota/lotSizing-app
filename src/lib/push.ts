// 相場変動通知のクライアント側ヘルパ（Web Push 購読の登録/解除）。
// Alert Worker の URL と VAPID 公開鍵はビルド時の環境変数から読む:
//   VITE_ALERT_URL         … Alert Worker のベースURL（未設定なら機能は無効）
//   VITE_VAPID_PUBLIC_KEY  … Alert Worker と同じ VAPID 公開鍵（base64url）

const ALERT_URL = import.meta.env.VITE_ALERT_URL as string | undefined;
const VAPID_PUBLIC_KEY = import.meta.env.VITE_VAPID_PUBLIC_KEY as string | undefined;
const CFG_CACHE = 'market-alert-cfg';

// 機能が使える構成か（HTTPS/localhost かつ SW・Push 対応かつ env 設定済み）。
export function isPushConfigured(): boolean {
  return Boolean(ALERT_URL && VAPID_PUBLIC_KEY);
}

export function isPushSupported(): boolean {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

// iOS/iPadOS かつ「ホーム画面に追加した PWA（standalone）」でない場合は true。
// iOS は PWA でのみ Web Push が使えるため、インストール案内の表示に使う。
export function isIosNeedsInstall(): boolean {
  const ua = navigator.userAgent;
  const isIos = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const standalone =
    window.matchMedia('(display-mode: standalone)').matches ||
    (navigator as unknown as { standalone?: boolean }).standalone === true;
  return isIos && !standalone;
}

// base64url の VAPID 公開鍵を applicationServerKey 用の Uint8Array に変換。
function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const normalized = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(normalized);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

async function registerServiceWorker(): Promise<ServiceWorkerRegistration> {
  const reg = await navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`);
  await navigator.serviceWorker.ready;
  return reg;
}

// SW が push 受信時に参照できるよう、Alert Worker の URL を Cache に保存。
async function storeAlertUrl(): Promise<void> {
  const cache = await caches.open(CFG_CACHE);
  await cache.put('alert-url', new Response(ALERT_URL));
}

// ---------------------------------------------------------------------------
// RR好機通知の端末ローカル設定（既定ON）。OFF にすると OS通知・アプリ内トーストの
// 両方で RR通知を止める。SW が push 受信時に読めるよう Cache にも保存する。
// ---------------------------------------------------------------------------
const RR_PREF_KEY = 'rrAlertsEnabled';

export function getRrEnabled(): boolean {
  return localStorage.getItem(RR_PREF_KEY) !== '0'; // 未設定は ON
}

// Cache に RR可否を保存（SW が push 時に参照）。
async function storeRrEnabled(enabled: boolean): Promise<void> {
  try {
    const cache = await caches.open(CFG_CACHE);
    await cache.put('rr-enabled', new Response(enabled ? '1' : '0'));
  } catch {
    // Cache 非対応環境は無視
  }
}

export async function setRrEnabled(enabled: boolean): Promise<void> {
  localStorage.setItem(RR_PREF_KEY, enabled ? '1' : '0');
  await storeRrEnabled(enabled);
  // 購読中なら Alert Worker の購読フラグも更新（RR無効端末には RR push を送らない）。
  if (ALERT_URL && isPushSupported()) {
    try {
      const reg = await navigator.serviceWorker.getRegistration();
      const sub = reg ? await reg.pushManager.getSubscription() : null;
      if (sub) {
        await fetch(`${ALERT_URL}/rr-pref`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ endpoint: sub.endpoint, enabled }),
        });
      }
    } catch {
      // 失敗は無視（次回トグルで回復）
    }
  }
}

// アプリ内「最近のアラート」履歴の1件。
export interface AlertHistoryItem {
  id: number;
  pair: string;
  title: string | null;
  body: string;
  created_at: number;
}

// Alert Worker の /alerts から直近アラート履歴を取得（新しい順）。未設定なら空配列。
export async function fetchAlertHistory(limit = 30): Promise<AlertHistoryItem[]> {
  if (!ALERT_URL) return [];
  const res = await fetch(`${ALERT_URL}/alerts?limit=${limit}`);
  if (!res.ok) throw new Error(`アラート履歴 HTTP ${res.status}`);
  return (await res.json()) as AlertHistoryItem[];
}

// lastSeenId より新しいアラートを古い順に返す（in-app トースト用）。
export function pickNewAlerts(alerts: AlertHistoryItem[], lastSeenId: number): AlertHistoryItem[] {
  return alerts.filter((a) => a.id > lastSeenId).sort((a, b) => a.id - b.id);
}

// 現在この端末が購読中かどうか。
export async function isSubscribed(): Promise<boolean> {
  if (!isPushSupported()) return false;
  const reg = await navigator.serviceWorker.getRegistration();
  if (!reg) return false;
  const sub = await reg.pushManager.getSubscription();
  return sub != null;
}

// 通知を有効化：許可要求 → SW登録 → 購読 → Alert Worker に登録。
// 成功で true。許可拒否や未対応は false。
export async function enableAlerts(): Promise<boolean> {
  if (!isPushConfigured() || !isPushSupported()) return false;

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return false;

  const reg = await registerServiceWorker();
  await storeAlertUrl();
  await storeRrEnabled(getRrEnabled());

  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY as string),
    });
  }

  const res = await fetch(`${ALERT_URL}/subscribe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...sub.toJSON(), rrEnabled: getRrEnabled() }),
  });
  return res.ok;
}

// 通知を無効化：購読解除 → Alert Worker から削除。
export async function disableAlerts(): Promise<void> {
  if (!isPushSupported()) return;
  const reg = await navigator.serviceWorker.getRegistration();
  if (!reg) return;
  const sub = await reg.pushManager.getSubscription();
  if (!sub) return;
  const { endpoint } = sub;
  await sub.unsubscribe();
  if (ALERT_URL) {
    await fetch(`${ALERT_URL}/unsubscribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpoint }),
    }).catch(() => {});
  }
}
