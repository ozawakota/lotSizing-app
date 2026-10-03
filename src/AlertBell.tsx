// ヘッダーの通知ベル。タップでポップアップを開き、相場変動通知の ON/OFF を切り替える。
// （旧 MarketAlertCard のロジックをヘッダー用に移設。env 未設定/非対応なら非表示。）
import { useEffect, useState } from 'react';
import { Bell } from 'lucide-react';
import { Popup } from '@mobiscroll/react';
import {
  disableAlerts,
  enableAlerts,
  isIosNeedsInstall,
  isPushConfigured,
  isPushSupported,
  isSubscribed,
} from '@/lib/push';

export default function AlertBell() {
  const [open, setOpen] = useState(false);
  const [on, setOn] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const configured = isPushConfigured() && isPushSupported();

  useEffect(() => {
    if (configured) isSubscribed().then(setOn);
  }, [configured]);

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
            <p className="text-xs text-amber-700">
              iPhone/iPad では通知を受け取るために、共有メニューから「ホーム画面に追加」して起動してください。
            </p>
          )}
          {message && <p className="text-xs text-red-600">{message}</p>}
        </div>
      </Popup>
    </>
  );
}
