// 相場変動通知の ON/OFF カード（計算機ページに配置）。
// 外貨ex 準拠: 対象ペアの Bid が15分で大きく変動（FX=25pips / XAU/USD=5ドル）したらプッシュ通知。
// 検知/送信は Alert Worker が担い、本カードは購読の登録/解除と状態表示のみ。
import { useEffect, useState } from 'react';
import {
  disableAlerts,
  enableAlerts,
  isIosNeedsInstall,
  isPushConfigured,
  isPushSupported,
  isSubscribed,
} from '@/lib/push';

export default function MarketAlertCard() {
  const [on, setOn] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const configured = isPushConfigured() && isPushSupported();

  useEffect(() => {
    if (!configured) return;
    isSubscribed().then(setOn);
  }, [configured]);

  // 構成未設定（env 未設定）や非対応環境では何も表示しない。
  if (!configured) return null;

  const needsInstall = isIosNeedsInstall();

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
    <div className="bg-amber-50 rounded-md p-3 border border-amber-200 mx-3 my-2">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-sm font-bold text-gray-700">相場変動通知</p>
          <p className="text-xs text-gray-500">対象ペアが15分で急変動したら通知</p>
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

      {needsInstall && (
        <p className="mt-2 text-xs text-amber-700">
          iPhone/iPad では通知を受け取るために、共有メニューから「ホーム画面に追加」して起動してください。
        </p>
      )}
      {message && <p className="mt-2 text-xs text-red-600">{message}</p>}
    </div>
  );
}
