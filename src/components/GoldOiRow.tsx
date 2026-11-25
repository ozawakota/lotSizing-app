// 取引量ページ・XAU/USD のカードに出す「大口（日次）」。CME 金先物の建玉の増減 × 値動きからの推定。
// CFTC（週1回）の間を補う: 最新の取引日の推定を色つきの言葉で、直近5日を色の四角で並べ、5日の傾き（買い寄り/売り寄り）を添える。
import type { FC } from 'react';
import { OI_SIGNAL_LABEL, goldOiLean, type GoldOi, type OiSignal } from '@/lib/flow';

const SIGNAL_STYLE: Record<OiSignal, string> = {
  new_long: 'bg-green-500 text-white',
  short_cover: 'bg-green-100 text-green-700',
  flat: 'bg-gray-100 text-gray-500',
  long_liq: 'bg-red-100 text-red-600',
  new_short: 'bg-red-500 text-white',
};
const SQUARE: Record<OiSignal, string> = {
  new_long: 'bg-green-500',
  short_cover: 'bg-green-200',
  flat: 'bg-gray-200',
  long_liq: 'bg-red-200',
  new_short: 'bg-red-500',
};
const signed = (v: number, digits = 0) => `${v > 0 ? '+' : v < 0 ? '−' : '±'}${Math.abs(v).toLocaleString('ja-JP', { maximumFractionDigits: digits })}`;
const md = (date: string) => `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}`;

const GoldOiRow: FC<{ data: GoldOi }> = ({ data }) => {
  const last = data.days[data.days.length - 1];
  if (!last) return null;
  const recent = data.days.slice(-5);
  const lean = goldOiLean(data.days);
  return (
    <div className="rounded-lg bg-amber-50/60 px-2 py-1.5" aria-label="大口（日次・CME 金先物の建玉）">
      <div className="flex items-center gap-1.5">
        <span className="w-7 shrink-0 text-[11px] font-semibold text-gray-500">日次</span>
        <span className={`rounded px-1.5 py-px text-[11px] font-bold ${SIGNAL_STYLE[last.signal]}`}>{OI_SIGNAL_LABEL[last.signal]}</span>
        <span className="text-[10px] tabular-nums text-gray-500">
          建玉{signed(last.oiChange)}・値{signed(last.priceChange, 1)}
        </span>
        <span className="ml-auto text-[10px] text-gray-400">
          {md(last.date)}
          {last.final ? '' : '速報'}
        </span>
      </div>
      <div className="mt-1 flex items-center gap-1.5">
        <span className="w-7 shrink-0" />
        <span className="flex gap-0.5" role="list" aria-label="直近の推定">
          {recent.map((d) => (
            <span key={d.date} role="listitem" title={`${md(d.date)} ${OI_SIGNAL_LABEL[d.signal]}`} className={`block h-2.5 w-4 rounded-sm ${SQUARE[d.signal]}`} />
          ))}
        </span>
        <span className={`text-[10px] font-semibold ${lean.lean === 'buy' ? 'text-green-700' : lean.lean === 'sell' ? 'text-red-600' : 'text-gray-500'}`}>
          {lean.days}日で{lean.lean === 'buy' ? '買い寄り' : lean.lean === 'sell' ? '売り寄り' : '方向感なし'}
        </span>
        <span className="ml-auto text-[9px] text-gray-400">CME 金先物の建玉×値動き</span>
      </div>
    </div>
  );
};

export default GoldOiRow;
