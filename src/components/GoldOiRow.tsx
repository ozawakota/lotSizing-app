// 取引量ページ・XAU/USD のカードに出す「売買シグナル＋大口のネットポジション」。
//   上: 結論（買いシグナル/売りシグナル/様子見と★）と、判断材料4つ（goldSignal）を ↑↓ つきのチップで
//   下: 大口ネットの確定（CFTC）と推定（確定＋CME 日次）を1行ずつ、直近5日の日次の推定を色の四角で
import type { FC } from 'react';
import { ArrowDown, ArrowUp, Minus } from 'lucide-react';
import {
  OI_SIGNAL_LABEL,
  estimateGoldNet,
  goldSignal,
  type GoldNet,
  type GoldOi,
  type OiSignal,
  type PairFlow,
  type SignalDir,
} from '@/lib/flow';

const SQUARE: Record<OiSignal, string> = {
  new_long: 'bg-green-500',
  short_cover: 'bg-green-200',
  flat: 'bg-gray-200',
  long_liq: 'bg-red-200',
  new_short: 'bg-red-500',
};
const fmt = (v: number) => Math.abs(Math.round(v)).toLocaleString('ja-JP');
const md = (date: string) => `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}`;
const netText = (net: number) => `${net >= 0 ? '買い越し' : '売り越し'} ${fmt(net)}枚`;

const VERDICT: Record<SignalDir, { label: string; box: string; badge: string }> = {
  buy: { label: '買いシグナル', box: 'border-green-300 bg-green-50', badge: 'bg-green-600 text-white' },
  sell: { label: '売りシグナル', box: 'border-red-300 bg-red-50', badge: 'bg-red-600 text-white' },
  neutral: { label: '様子見', box: 'border-gray-200 bg-gray-50', badge: 'bg-gray-500 text-white' },
};
const FACTOR: Record<SignalDir, { Icon: typeof ArrowUp; cls: string }> = {
  buy: { Icon: ArrowUp, cls: 'border-green-200 bg-white text-green-700' },
  sell: { Icon: ArrowDown, cls: 'border-red-200 bg-white text-red-600' },
  neutral: { Icon: Minus, cls: 'border-gray-200 bg-white text-gray-400' },
};

const GoldNetPanel: FC<{ net?: GoldNet; oi?: GoldOi; retail?: Pick<PairFlow, 'longPct' | 'shortPct'> }> = ({ net, oi, retail }) => {
  const signal = goldSignal({ net, oi, retail });
  if (!signal && !net && !oi?.days.length) return null;
  const est = net && oi ? estimateGoldNet(net, oi.days) : null;
  const recent = oi?.days.slice(-5) ?? [];
  const v = signal ? VERDICT[signal.verdict] : null;

  return (
    <div className="space-y-1.5" aria-label="ゴールドの売買シグナルと大口のネットポジション">
      {/* 結論と判断材料 */}
      {signal && v && (
        <div className={`rounded-lg border px-2 py-1.5 ${v.box}`}>
          <div className="flex items-center gap-1.5">
            <span className={`rounded-md px-2 py-0.5 text-[13px] font-bold ${v.badge}`}>{v.label}</span>
            {signal.stars > 0 && <span className="text-[12px] tracking-tight text-orange-500">{'★'.repeat(signal.stars)}</span>}
            <span className="ml-auto text-[10px] text-gray-400">材料 {signal.factors.length}つ・合計 {signal.score > 0 ? '+' : ''}{signal.score}</span>
          </div>
          <div className="mt-1 flex flex-wrap gap-1">
            {signal.factors.map((f) => {
              const { Icon, cls } = FACTOR[f.dir];
              return (
                <span key={f.key} className={`flex items-center gap-0.5 rounded border px-1 text-[10px] font-semibold ${cls}`}>
                  <Icon className="h-3 w-3" aria-hidden="true" />
                  {f.label}
                </span>
              );
            })}
          </div>
        </div>
      )}

      {/* 大口のネットポジション（確定・推定）と日次 */}
      {(net || recent.length > 0) && (
        <div className="space-y-0.5 rounded-lg bg-amber-50/60 px-2 py-1.5">
          {net && (
            <div className="flex items-baseline gap-1.5 text-[11px]">
              <span className="w-7 shrink-0 font-semibold text-gray-500">確定</span>
              <span className={`font-bold tabular-nums ${net.net >= 0 ? 'text-green-700' : 'text-red-600'}`}>{netText(net.net)}</span>
              <span className="ml-auto text-[10px] text-gray-400">{md(net.reportDate)}時点・CFTC</span>
            </div>
          )}
          {est && (
            <div className="flex items-baseline gap-1.5 text-[11px]">
              <span className="w-7 shrink-0 font-semibold text-amber-700">推定</span>
              <span className={`font-bold tabular-nums ${est.net >= 0 ? 'text-green-700' : 'text-red-600'}`}>{netText(est.net)}</span>
              <span className="ml-auto text-[10px] text-gray-400">{md(est.through)}まで</span>
            </div>
          )}
          {recent.length > 0 && (
            <div className="flex items-center gap-1.5 text-[11px]">
              <span className="w-7 shrink-0 font-semibold text-gray-500">日次</span>
              <span className="flex gap-0.5" role="list" aria-label="直近の推定">
                {recent.map((d) => (
                  <span key={d.date} role="listitem" title={`${md(d.date)} ${OI_SIGNAL_LABEL[d.signal]}`} className={`block h-2.5 w-4 rounded-sm ${SQUARE[d.signal]}`} />
                ))}
              </span>
              <span className="text-[10px] text-gray-600">
                {md(recent[recent.length - 1].date)} {OI_SIGNAL_LABEL[recent[recent.length - 1].signal]}
              </span>
            </div>
          )}
        </div>
      )}
      <p className="text-[9px] leading-snug text-gray-400">
        シグナル＝大口の増減（前週比・今週の推定・日次5日）と個人の逆張りの合計（+2 以上で買い・−2 以下で売り）。推定は建玉の増減をすべて大口と仮定するため大きめ。※投資助言ではありません
      </p>
    </div>
  );
};

export default GoldNetPanel;
