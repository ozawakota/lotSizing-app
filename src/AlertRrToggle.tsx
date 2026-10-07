// ヘッダーのRR好機通知アイコン（ベルの左）。タップでポップアップを開き、RR≥1:3 の
// バックグラウンド通知を端末ごとに ON/OFF する。OFF で OS通知・アプリ内トーストの両方を止める。
// env 未設定/非対応なら非表示（AlertBell と同条件）。
import { useState } from 'react';
import { Target } from 'lucide-react';
import { Popup } from '@mobiscroll/react';
import { getRrEnabled, isPushConfigured, isPushSupported, setRrEnabled } from '@/lib/push';

// RR通知の監視対象（alert-worker の RR_INSTRUMENTS と対応）。
const RR_PAIRS = ['XAU/USD', 'USD/JPY', 'EUR/USD', 'GBP/USD'];

export default function AlertRrToggle() {
  const [open, setOpen] = useState(false);
  const [on, setOn] = useState(getRrEnabled);
  const [busy, setBusy] = useState(false);

  // AlertBell と同じ表示条件（設定済み＋対応、または iOS 要インストール）。
  const visible = isPushConfigured() && (isPushSupported() || true);
  if (!isPushConfigured()) return null;
  if (!visible) return null;

  const toggle = async () => {
    const next = !on;
    setOn(next); // 楽観的に反映
    setBusy(true);
    try {
      await setRrEnabled(next);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button
        type="button"
        aria-label="RR好機通知"
        onClick={() => setOpen(true)}
        className="relative text-gray-600 h-8 w-8 flex items-center justify-center rounded-full border border-gray-300"
      >
        <Target className="h-4 w-4" />
        {on && <span className="absolute top-1 right-1 h-2 w-2 rounded-full bg-orange-500" />}
      </button>

      <Popup
        isOpen={open}
        onClose={() => setOpen(false)}
        headerText="RR好機通知"
        buttons={[{ text: '閉じる', handler: () => setOpen(false) }]}
      >
        <div className="p-4 min-w-[260px] space-y-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-sm font-bold text-gray-700">RR好機通知</p>
              <p className="text-xs text-gray-500">リスクリワード1:3以上が狙える時間足を検知したら通知</p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={on}
              disabled={busy}
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

          <div className="flex flex-wrap gap-1">
            {RR_PAIRS.map((p) => (
              <span key={p} className="rounded bg-gray-100 px-1.5 py-0.5 text-[11px] font-mono font-semibold text-gray-700">
                {p}
              </span>
            ))}
          </div>

          <p className="text-[11px] text-gray-400">
            15m/30m/1h/4h を15分おきに判定。OS通知にはベル（相場変動通知）のONが必要です。
          </p>
        </div>
      </Popup>
    </>
  );
}
