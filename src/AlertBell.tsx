// ヘッダーの通知ベル。タップでポップアップを開き、相場変動通知の ON/OFF を切り替える。
// （旧 MarketAlertCard のロジックをヘッダー用に移設。env 未設定/非対応なら非表示。）
import { useEffect, useState } from 'react';
import { Bell } from 'lucide-react';
import { Popup } from '@mobiscroll/react';
import {
  disableAlerts,
  enableAlerts,
  fetchAlertHistory,
  isIosNeedsInstall,
  isPushConfigured,
  isPushSupported,
  isSubscribed,
  type AlertHistoryItem,
} from '@/lib/push';
import { ALERT_PAIRS, PAIR_CONFIG } from '@/lib/alert';

const CLEARED_KEY = 'alertsClearedAt';

// created_at(ms) を「◯分前 / ◯時間前 / 日付」の相対表記にする。
const relativeTime = (ms: number): string => {
  const diff = Date.now() - ms;
  const min = Math.floor(diff / 60000);
  if (min < 1) return 'たった今';
  if (min < 60) return `${min}分前`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}時間前`;
  return new Date(ms).toLocaleDateString('ja-JP', { month: 'numeric', day: 'numeric' });
};

export default function AlertBell() {
  const [open, setOpen] = useState(false);
  const [on, setOn] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [history, setHistory] = useState<AlertHistoryItem[]>([]);
  const [clearedAt, setClearedAt] = useState<number>(() => Number(localStorage.getItem(CLEARED_KEY)) || 0);
  const supported = isPushConfigured() && isPushSupported();
  const needsInstall = isIosNeedsInstall();
  // iOS Safari（ホーム画面に未追加）は PushManager/Notification が未公開のため
  // isPushSupported() が false になるが、インストール案内を見せるために
  // ベルは表示する。実際の購読操作は supported のときのみ有効。
  const visible = supported || (isPushConfigured() && needsInstall);

  useEffect(() => {
    if (supported) isSubscribed().then(setOn);
  }, [supported]);

  // ポップアップを開いたら最近のアラート履歴を取得。
  useEffect(() => {
    if (open && isPushConfigured()) {
      fetchAlertHistory(30)
        .then(setHistory)
        .catch(() => setHistory([]));
    }
  }, [open]);

  if (!visible) return null;

  // クリア時刻より新しいアラートだけ表示（非破壊・端末ごと）。
  const shownHistory = history.filter((a) => a.created_at > clearedAt);

  const clearHistory = () => {
    const now = Date.now();
    localStorage.setItem(CLEARED_KEY, String(now));
    setClearedAt(now);
  };

  const toggle = async () => {
    setBusy(true);
    setMessage('');
    try {
      if (on) {
        await disableAlerts();
        setOn(false);
      } else {
        const ok = await enableAlerts();
        setOn(ok);
        if (!ok) setMessage('通知を有効にできませんでした（許可が必要です）');
      }
    } catch {
      setMessage('エラーが発生しました');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button
        type="button"
        aria-label="相場変動通知"
        onClick={() => setOpen(true)}
        className="relative text-gray-600 h-8 w-8 flex items-center justify-center rounded-full border border-gray-300"
      >
        <Bell className="h-4 w-4" />
        {on && <span className="absolute top-1 right-1 h-2 w-2 rounded-full bg-orange-500" />}
      </button>

      <Popup
        isOpen={open}
        onClose={() => setOpen(false)}
        headerText="相場変動通知"
        buttons={[{ text: '閉じる', handler: () => setOpen(false) }]}
      >
        <div className="p-4 min-w-[260px] space-y-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-sm font-bold text-gray-700">相場変動通知</p>
              <p className="text-xs text-gray-500">下記ペアが15分で急変動したら通知</p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={on}
              disabled={busy || needsInstall}
              onClick={toggle}
              className={`relative inline-flex h-7 w-12 shrink-0 items-center rounded-full transition-colors disabled:opacity-50 ${
                on ? 'bg-orange-500' : 'bg-gray-300'
              }`}
            >
              <span
                className={`inline-block h-5 w-5 transform rounded-full bg-white transition-transform ${
                  on ? 'translate-x-6' : 'translate-x-1'
                }`}
              />
            </button>
          </div>

          {/* 対象通貨としきい値（監視中のペアが一目で分かる） */}
          <div className="flex flex-wrap gap-1">
            {ALERT_PAIRS.map((p) => (
              <span key={p} className="rounded bg-gray-100 px-1.5 py-0.5 text-[11px] text-gray-700">
                <span className="font-mono font-semibold">{p}</span>{' '}
                <span className="text-gray-400">
                  {PAIR_CONFIG[p].thresholdPips}
                  {PAIR_CONFIG[p].unit}
                </span>
              </span>
            ))}
          </div>
          {needsInstall && (
            <p className="text-xs text-amber-700">
              iPhone/iPad では通知を受け取るために、共有メニューから「ホーム画面に追加」して起動してください。
            </p>
          )}
          {message && <p className="text-xs text-red-600">{message}</p>}

          {/* 最近のアラート（何が動いたかの履歴） */}
          <div className="border-t border-gray-100 pt-2">
            <div className="mb-1 flex items-center justify-between">
              <p className="text-xs font-bold text-gray-700">最近のアラート</p>
              {shownHistory.length > 0 && (
                <button type="button" onClick={clearHistory} className="text-[11px] text-gray-400 hover:text-gray-600">
                  クリア
                </button>
              )}
            </div>
            {shownHistory.length === 0 ? (
              <p className="text-[11px] text-gray-400">まだありません</p>
            ) : (
              <ul className="max-h-48 space-y-1 overflow-y-auto">
                {shownHistory.map((a) => (
                  <li key={a.id} className="rounded bg-gray-50 px-2 py-1">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="text-xs font-semibold text-gray-700">{a.title || a.pair}</span>
                      <span className="shrink-0 text-[10px] text-gray-400">{relativeTime(a.created_at)}</span>
                    </div>
                    <p className="text-[11px] text-gray-500">{a.body}</p>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </Popup>
    </>
  );
}
