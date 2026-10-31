// エントリーとイグジット（損切り・目標）が一目で分かるローソク足チャート（RR好機ボード・TF分析）。
// 直近の確定足（＋形成中の足を薄く）を左側に描き、右側にポジションの範囲を箱で描く:
//   - 緑の箱 = エントリー → 目標（利益の範囲）、赤の箱 = エントリー → 損切り（損失の範囲）
//   - 実線 = エントリー（成行=現在値）、破線 = 目標（緑）・損切り（赤）
//   - 点線 = 指値（Buy/Sell Limit）・逆指値（Buy/Sell Stop）の目安（あれば）
// 右端に各ラインの価格ラベル（重ならないように上下にずらす）。値幅は目標・損切りまで含めて縦軸を決める。
import type { OhlcCandle } from '@/lib/edge';
import type { SlDirection } from '@/lib/stoploss';

const UP = '#16a34a';
const DOWN = '#dc2626';
const ENTRY = '#111827';
const LIMIT = '#0d9488';
const STOP_ENTRY = '#9333ea';

type LineKind = 'target' | 'entry' | 'stop' | 'limit' | 'stopEntry';
const LINE: Record<LineKind, { color: string; label: string; dash?: string; width: number }> = {
  target: { color: UP, label: '目標', dash: '4 2', width: 1.2 },
  entry: { color: ENTRY, label: 'エントリー', width: 1.2 },
  stop: { color: DOWN, label: '損切り', dash: '4 2', width: 1.2 },
  limit: { color: LIMIT, label: '指値', dash: '1.5 2', width: 1 },
  stopEntry: { color: STOP_ENTRY, label: '逆指値', dash: '1.5 2', width: 1 },
};

export function TradeChart({
  bars,
  forming,
  direction,
  entry,
  stop,
  target,
  digits,
  pip,
  limitPrice = null,
  stopEntryPrice = null,
}: {
  bars: OhlcCandle[];
  forming?: OhlcCandle | null;
  direction: SlDirection;
  entry: number;
  stop: number;
  target: number;
  digits: number;
  pip: number;
  limitPrice?: number | null;
  stopEntryPrice?: number | null;
}) {
  if (bars.length < 2) return null;
  const long = direction === 'long';
  const all = forming ? [...bars, forming] : bars;

  const W = 320;
  const H = 150;
  const padL = 4;
  const padR = 74; // 右端の価格ラベル（5桁の価格＋見出しが入る幅）
  const padY = 8;
  const plotW = W - padL - padR;
  const candleW = plotW * 0.7; // 左 70% にローソク足、右 30% にポジションの箱
  const boxX = padL + candleW;
  const boxW = plotW - candleW;

  const levels = [entry, stop, target, ...(limitPrice != null ? [limitPrice] : []), ...(stopEntryPrice != null ? [stopEntryPrice] : [])];
  const lo = Math.min(...all.map((b) => b.low), ...levels);
  const hi = Math.max(...all.map((b) => b.high), ...levels);
  const span = hi - lo || 1;
  const y = (p: number) => padY + ((hi - p) / span) * (H - padY * 2);
  const slot = candleW / all.length;
  const cx = (i: number) => padL + slot * (i + 0.5);
  const bodyW = Math.max(1.2, slot * 0.6);
  const fmt = (p: number) => p.toFixed(digits);
  const pips = (a: number, b: number) => (Math.abs(a - b) / pip).toFixed(1);

  const lines: { kind: LineKind; price: number }[] = [
    { kind: 'target', price: target },
    { kind: 'entry', price: entry },
    { kind: 'stop', price: stop },
    ...(limitPrice != null ? [{ kind: 'limit' as const, price: limitPrice }] : []),
    ...(stopEntryPrice != null ? [{ kind: 'stopEntry' as const, price: stopEntryPrice }] : []),
  ];
  const labels = spreadLabels(lines.map((l) => ({ ...l, y: y(l.price) })), H);

  const rewardTop = y(Math.max(entry, target));
  const rewardBottom = y(Math.min(entry, target));
  const riskTop = y(Math.max(entry, stop));
  const riskBottom = y(Math.min(entry, stop));
  const ey = y(entry);
  const ty = y(target);

  return (
    <div className="rounded-lg bg-gray-50 px-2 py-1.5">
      <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label={`ローソク足とエントリー・損切り・目標（${long ? '買い' : '売り'}）`}>
        {/* ポジションの箱（右側）: 利益の範囲（緑）・損失の範囲（赤） */}
        <rect x={boxX} y={rewardTop} width={boxW} height={Math.max(1, rewardBottom - rewardTop)} fill={UP} opacity="0.16" />
        <rect x={boxX} y={riskTop} width={boxW} height={Math.max(1, riskBottom - riskTop)} fill={DOWN} opacity="0.16" />
        {/* ローソク足（形成中の足は薄く） */}
        {all.map((b, i) => {
          const up = b.close >= b.open;
          const color = up ? UP : DOWN;
          const top = y(Math.max(b.open, b.close));
          const bh = Math.max(0.8, y(Math.min(b.open, b.close)) - top);
          const isForming = !!forming && i === all.length - 1;
          return (
            <g key={i} opacity={isForming ? 0.4 : 1}>
              <line x1={cx(i)} x2={cx(i)} y1={y(b.high)} y2={y(b.low)} stroke={color} strokeWidth="0.9" />
              <rect x={cx(i) - bodyW / 2} y={top} width={bodyW} height={bh} fill={up ? 'white' : color} stroke={color} strokeWidth="0.8" />
            </g>
          );
        })}
        {/* ライン（左端から右端まで） */}
        {lines.map((l) => (
          <line
            key={l.kind}
            x1={padL}
            x2={W - padR}
            y1={y(l.price)}
            y2={y(l.price)}
            stroke={LINE[l.kind].color}
            strokeWidth={LINE[l.kind].width}
            strokeDasharray={LINE[l.kind].dash}
            opacity={l.kind === 'entry' ? 0.9 : 0.8}
          />
        ))}
        {/* エントリーの印と、目標への矢印 */}
        <circle cx={boxX} cy={ey} r="3" fill={ENTRY} />
        <line x1={boxX + boxW * 0.5} x2={boxX + boxW * 0.5} y1={ey} y2={ty + (long ? 5 : -5)} stroke={UP} strokeWidth="1.4" />
        <path
          d={long
            ? `M ${boxX + boxW * 0.5 - 4} ${ty + 6} L ${boxX + boxW * 0.5} ${ty} L ${boxX + boxW * 0.5 + 4} ${ty + 6} Z`
            : `M ${boxX + boxW * 0.5 - 4} ${ty - 6} L ${boxX + boxW * 0.5} ${ty} L ${boxX + boxW * 0.5 + 4} ${ty - 6} Z`}
          fill={UP}
        />
        {/* 右端の価格ラベル */}
        {labels.map((l) => (
          <g key={l.kind}>
            <rect x={W - padR + 1} y={l.ly - 5.5} width={padR - 1} height="11" rx="2" fill={LINE[l.kind].color} opacity={l.kind === 'entry' ? 1 : 0.9} />
            <text x={W - padR + 3} y={l.ly + 2.6} className="text-[7px] font-bold" fill="white">
              {LINE[l.kind].label} {fmt(l.price)}
            </text>
          </g>
        ))}
      </svg>
      <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[10px] text-gray-500">
        <span className="flex items-center gap-1">
          <span aria-hidden className="inline-block h-2 w-3 rounded-sm bg-green-600/30" />
          利益の範囲 <span className="font-semibold text-green-700">+{pips(target, entry)}pips</span>
        </span>
        <span className="flex items-center gap-1">
          <span aria-hidden className="inline-block h-2 w-3 rounded-sm bg-red-600/30" />
          損失の範囲 <span className="font-semibold text-red-700">−{pips(stop, entry)}pips</span>
        </span>
        {limitPrice != null && <span style={{ color: LIMIT }}>‥ 指値で入る案</span>}
        {stopEntryPrice != null && <span style={{ color: STOP_ENTRY }}>‥ 逆指値で入る案</span>}
      </div>
    </div>
  );
}

/** ラベルの縦位置を、重ならないように最小間隔ずつずらす（上から順に）。 */
function spreadLabels<T extends { y: number }>(items: T[], H: number): (T & { ly: number })[] {
  const GAP = 12;
  const sorted = [...items].sort((a, b) => a.y - b.y).map((it) => ({ ...it, ly: it.y }));
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].ly - sorted[i - 1].ly < GAP) sorted[i].ly = sorted[i - 1].ly + GAP;
  }
  // 下にはみ出したら、下から押し戻す
  const bottom = H - 6;
  for (let i = sorted.length - 1; i >= 0; i--) {
    const limit = i === sorted.length - 1 ? bottom : sorted[i + 1].ly - GAP;
    if (sorted[i].ly > limit) sorted[i].ly = limit;
  }
  return sorted;
}
