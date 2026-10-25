// ダウ理論によるトレンド判定（純関数）。Worker の /mtf と TF分析ページで共有する。
// 確定足のスイング（ピボット高値・安値）を交互に並べ、直前の同種スイングと比べて
//   高値: HH（切り上げ）/ LH（切り下げ）/ EH（ほぼ同値）
//   安値: HL（切り上げ）/ LL（切り下げ）/ EL（ほぼ同値）
// に分類する。最新の高値・安値がそろって HH・HL なら上昇、LH・LL なら下降、それ以外はレンジ（転換途中を含む）。
// 上昇中は「押し安値」（最後の HL）、下降中は「戻り高値」（最後の LH）が、終値で割れる/超えるとトレンド終了となる重要ライン。
// ※表示用。RR・通知・好機ボードのトレンド（computeStructure）は従来どおりで、ここでは置き換えない。
import { averageTrueRange, pivotIndices, type Candle } from './stoploss';

export type DowTrend = 'up' | 'down' | 'range';
/**
 * extending=高値（安値）を更新中 / pullback=押し目（戻り）を形成中 / continuing=押し目（戻り）から再び伸び始めた /
 * broken=押し安値（戻り高値）を終値で割った（超えた）＝トレンド終了・転換の兆し / none=レンジ
 */
export type DowPhase = 'extending' | 'pullback' | 'continuing' | 'broken' | 'none';
export type SwingLabel = 'HH' | 'LH' | 'EH' | 'HL' | 'LL' | 'EL';

export interface SwingPoint {
  kind: 'high' | 'low';
  price: number;
  index: number; // 渡した足の配列での位置
  barsAgo: number; // 最新の確定足から何本前か
  label: SwingLabel | null; // 最初の同種スイングは比較対象が無いので null
}

export interface DowAnalysis {
  trend: DowTrend;
  phase: DowPhase;
  strength: number; // トレンド方向にそろったスイングが末尾から何個続いているか（0〜6）
  swings: SwingPoint[]; // 直近のスイング（古い→新しい、最大6点）
  keyLevel: { price: number; kind: 'pullback_low' | 'rally_high' } | null; // 押し安値（上昇）/ 戻り高値（下降）
  extremeLevel: { price: number; kind: 'high' | 'low' } | null; // 更新を見るライン: 上昇=直近高値 / 下降=直近安値
  rangeHigh: number | null; // レンジ時の上限（直近の高値スイング）
  rangeLow: number | null; // レンジ時の下限（直近の安値スイング）
}

export interface DowOptions {
  lookback?: number; // 判定に使う確定足の本数（既定 150）
  pivotK?: number; // ピボットの左右の本数（既定 3）
  equalAtr?: number; // この ATR 倍以内の差は同値（EH/EL）とみなす（既定 0.1）
}

const DEFAULTS: Required<DowOptions> = { lookback: 150, pivotK: 3, equalAtr: 0.1 };

/** 高値・安値のピボットを時系列で並べ、同種が続いたらより極端な方だけ残して交互にする。 */
function alternateSwings(candles: Candle[], k: number): { kind: 'high' | 'low'; price: number; index: number }[] {
  const pts = [
    ...pivotIndices(candles, 'high', k).map((i) => ({ kind: 'high' as const, price: candles[i].high, index: i })),
    ...pivotIndices(candles, 'low', k).map((i) => ({ kind: 'low' as const, price: candles[i].low, index: i })),
  ].sort((a, b) => a.index - b.index || (a.kind === 'high' ? -1 : 1));
  const out: typeof pts = [];
  for (const p of pts) {
    const last = out[out.length - 1];
    if (last && last.kind === p.kind) {
      const moreExtreme = p.kind === 'high' ? p.price > last.price : p.price < last.price;
      if (moreExtreme) out[out.length - 1] = p;
      continue;
    }
    // 同じ足が高値・安値の両方のピボットになった場合は、後から来た方を捨てる（交互を保つ）。
    if (last && last.index === p.index) continue;
    out.push(p);
  }
  return out;
}

/**
 * 確定足（古い→新しい。形成中の足は含めない）からダウ理論の判定を求める。
 * スイングが足りない（高値・安値が2つずつ無い）ときは null。
 */
export function analyzeDow(closed: Candle[], opts: DowOptions = {}): DowAnalysis | null {
  const o = { ...DEFAULTS, ...opts };
  const candles = closed.slice(-o.lookback);
  if (candles.length < o.pivotK * 2 + 5) return null;
  const atr = averageTrueRange(candles);
  const eq = atr * o.equalAtr;
  const raw = alternateSwings(candles, o.pivotK);

  // ラベル付け（直前の同種スイングとの比較）。
  let prevHigh: number | null = null;
  let prevLow: number | null = null;
  const lastIdx = candles.length - 1;
  const swings: SwingPoint[] = raw.map((p) => {
    let label: SwingLabel | null = null;
    if (p.kind === 'high') {
      if (prevHigh != null) label = p.price > prevHigh + eq ? 'HH' : p.price < prevHigh - eq ? 'LH' : 'EH';
      prevHigh = p.price;
    } else {
      if (prevLow != null) label = p.price > prevLow + eq ? 'HL' : p.price < prevLow - eq ? 'LL' : 'EL';
      prevLow = p.price;
    }
    return { ...p, barsAgo: lastIdx - p.index, label };
  });

  const highs = swings.filter((s) => s.kind === 'high');
  const lows = swings.filter((s) => s.kind === 'low');
  if (highs.length < 2 || lows.length < 2) return null;
  const lastHigh = highs[highs.length - 1];
  const lastLow = lows[lows.length - 1];

  let trend: DowTrend = 'range';
  if (lastHigh.label === 'HH' && lastLow.label === 'HL') trend = 'up';
  else if (lastHigh.label === 'LH' && lastLow.label === 'LL') trend = 'down';

  // 末尾からトレンド方向にそろったスイングの数。
  let strength = 0;
  if (trend !== 'range') {
    const ok = trend === 'up' ? ['HH', 'HL'] : ['LH', 'LL'];
    for (let i = swings.length - 1; i >= 0 && ok.includes(swings[i].label ?? ''); i--) strength++;
  }

  const close = candles[lastIdx].close;
  const lastSwing = swings[swings.length - 1];
  let phase: DowPhase = 'none';
  let keyLevel: DowAnalysis['keyLevel'] = null;
  let extremeLevel: DowAnalysis['extremeLevel'] = null;
  if (trend === 'up') {
    keyLevel = { price: lastLow.price, kind: 'pullback_low' };
    extremeLevel = { price: lastHigh.price, kind: 'high' };
    if (close < lastLow.price) phase = 'broken';
    else if (close > lastHigh.price) phase = 'extending';
    else phase = lastSwing.kind === 'high' ? 'pullback' : 'continuing';
  } else if (trend === 'down') {
    keyLevel = { price: lastHigh.price, kind: 'rally_high' };
    extremeLevel = { price: lastLow.price, kind: 'low' };
    if (close > lastHigh.price) phase = 'broken';
    else if (close < lastLow.price) phase = 'extending';
    else phase = lastSwing.kind === 'low' ? 'pullback' : 'continuing';
  }

  return {
    trend,
    phase,
    strength: Math.min(strength, 6),
    swings: swings.slice(-6),
    keyLevel,
    extremeLevel,
    rangeHigh: trend === 'range' ? lastHigh.price : null,
    rangeLow: trend === 'range' ? lastLow.price : null,
  };
}

const TREND_JA: Record<DowTrend, string> = { up: '上昇', down: '下降', range: 'レンジ' };

/** 一言の説明（例: 「上昇・押し目形成中」「下降・戻り高値を上抜け（転換の兆し）」）。 */
export function dowSummary(d: DowAnalysis): string {
  const t = TREND_JA[d.trend];
  if (d.trend === 'range') return 'レンジ（高値・安値の向きがそろわない）';
  const up = d.trend === 'up';
  switch (d.phase) {
    case 'extending':
      return `${t}・${up ? '高値' : '安値'}を更新中`;
    case 'pullback':
      return `${t}・${up ? '押し目' : '戻り'}を形成中`;
    case 'continuing':
      return `${t}・${up ? '押し目から再上昇' : '戻りから再下落'}`;
    case 'broken':
      return `${t}・${up ? '押し安値を割り込み' : '戻り高値を上抜け'}（転換の兆し）`;
    default:
      return t;
  }
}

export const FIB_RATIOS = [0.382, 0.5, 0.618] as const;

/**
 * 直近のスイングの値幅（最後の2つのスイング a→b）に対する押し・戻しのフィボナッチ水準。
 * a=安値→b=高値なら b から下へ（押し目の候補＝支持）、a=高値→b=安値なら b から上へ（戻りの候補＝抵抗）。
 */
export function fibLevels(d: DowAnalysis): { price: number; ratio: number; label: string }[] {
  const n = d.swings.length;
  if (n < 2) return [];
  const a = d.swings[n - 2];
  const b = d.swings[n - 1];
  const range = b.price - a.price;
  if (range === 0) return [];
  return FIB_RATIOS.map((r) => ({ price: b.price - range * r, ratio: r, label: `フィボ${(r * 100).toFixed(1)}%` }));
}
