// 各時間足のロウソク足が確定（クローズ）するまでの残り時間を1秒ごとに表示する。
// 15m/30m/1h は UTC エポック基準（Date.now() % 足の長さ）で求めるため時差に依存しない。
// 4h は Yahoo足が NY取引日クローズ（17:00 ET）基準で区切られるため、NY現地の
// 壁掛け時計で「時 ≡ 1 (mod 4)」を境界とする（夏/冬時間は Intl が自動吸収）。
// TF分析ページ・レジサポページの両方で共通利用する。
import { useEffect, useState } from 'react';
import type { SlTimeframe } from '@/lib/stoploss';

const TF_MS: Record<SlTimeframe, number> = {
  '15m': 15 * 60_000,
  '30m': 30 * 60_000,
  '1h': 60 * 60_000,
  '4h': 4 * 60 * 60_000,
};

// 残りミリ秒を mm:ss（1時間未満）または h:mm:ss（1時間以上）に整形する。
const formatRemaining = (ms: number): string => {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
};

// NY現地の「時・分・秒」を取り出す（4h足の境界判定用）。
const nyHms = (at: Date): { hour: number; minute: number; second: number } => {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(at);
  const get = (t: string) => parseInt(parts.find((p) => p.type === t)?.value ?? '0', 10);
  let hour = get('hour');
  if (hour === 24) hour = 0; // 一部環境で深夜0時を 24 と返すため正規化
  return { hour, minute: get('minute'), second: get('second') };
};

// 4h足クローズ（NY 17:00 ET 基準）までの残りミリ秒。境界は NY現地で時≡1(mod4)。
const remaining4h = (now: number): number => {
  const { hour, minute, second } = nyHms(new Date(now));
  const intoCycleSec = (((hour - 1) % 4 + 4) % 4) * 3600 + minute * 60 + second;
  return (4 * 3600 - intoCycleSec) * 1000 - (now % 1000);
};

const remainingFor = (tf: SlTimeframe, now: number): number => {
  if (tf === '4h') return remaining4h(now);
  const span = TF_MS[tf];
  return span - (now % span);
};

export default function TfCountdown({ tf }: { tf: SlTimeframe }) {
  const [remaining, setRemaining] = useState<number>(() => remainingFor(tf, Date.now()));

  useEffect(() => {
    setRemaining(remainingFor(tf, Date.now()));
    const timer = setInterval(() => setRemaining(remainingFor(tf, Date.now())), 1000);
    return () => clearInterval(timer);
  }, [tf]);

  // 残り1分を切ったら確定間近として色を強調。
  const soon = remaining <= 60_000;

  return (
    <span
      className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium tabular-nums ${
        soon ? 'bg-orange-100 text-orange-700' : 'bg-gray-100 text-gray-500'
      }`}
      title="この足が確定するまでの残り時間"
    >
      <span aria-hidden>⏱</span>
      {formatRemaining(remaining)}
    </span>
  );
}
