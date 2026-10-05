// 相場変動の in-app トースト通知。アプリを開いている間、/alerts を定期ポーリングし、
// 前回より新しいアラートが出たら画面上部に帯状トーストを表示する（OS通知のON/OFFに依存しない）。
// 初回ポーリングはベースライン記録のみ（既存の過去分はトーストしない）。
import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { fetchAlertHistory, isPushConfigured, pickNewAlerts, type AlertHistoryItem } from '@/lib/push';

const POLL_MS = 60_000; // 60秒
const AUTO_DISMISS_MS = 8_000; // 8秒で自動消滅
const MAX_TOASTS = 3;

export default function AlertToast() {
  const [toasts, setToasts] = useState<AlertHistoryItem[]>([]);
  const lastSeenId = useRef(0);
  const initialized = useRef(false);

  useEffect(() => {
    if (!isPushConfigured()) return;
    let timer: ReturnType<typeof setInterval> | undefined;

    const poll = async () => {
      try {
        const alerts = await fetchAlertHistory(10);
        if (alerts.length === 0) return;
        const maxId = Math.max(...alerts.map((a) => a.id));
        // 初回はベースライン記録のみ（過去分はトーストしない）。
        if (!initialized.current) {
          initialized.current = true;
          lastSeenId.current = maxId;
          return;
        }
        const fresh = pickNewAlerts(alerts, lastSeenId.current);
        if (fresh.length > 0) {
          lastSeenId.current = maxId;
          setToasts((prev) => [...prev, ...fresh].slice(-MAX_TOASTS));
        }
      } catch {
        // 取得失敗は無視（次回ポーリングで回復）
      }
    };

    const start = () => {
      void poll();
      timer = setInterval(() => void poll(), POLL_MS);
    };
    const stop = () => {
      if (timer) clearInterval(timer);
      timer = undefined;
    };
    const onVisibility = () => {
      stop();
      if (document.visibilityState === 'visible') start();
    };

    if (document.visibilityState === 'visible') start();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  // 最も古いトーストを一定時間で自動的に消す。
  useEffect(() => {
    if (toasts.length === 0) return;
    const t = setTimeout(() => setToasts((prev) => prev.slice(1)), AUTO_DISMISS_MS);
    return () => clearTimeout(t);
  }, [toasts]);

  const dismiss = (id: number) => setToasts((prev) => prev.filter((t) => t.id !== id));

  if (toasts.length === 0) return null;

  return (
    <div className="fixed inset-x-0 top-2 z-50 flex flex-col items-center gap-1 px-3">
      {toasts.map((t) => (
        <div
          key={t.id}
          className="flex w-full max-w-md items-start gap-2 rounded-lg border-l-4 border-orange-500 bg-white px-3 py-2 shadow-lg"
        >
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-bold text-gray-800">{t.title || t.pair}</p>
            <p className="text-xs text-gray-600">{t.body}</p>
          </div>
          <button
            type="button"
            aria-label="閉じる"
            onClick={() => dismiss(t.id)}
            className="shrink-0 text-gray-400 hover:text-gray-600"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      ))}
    </div>
  );
}
