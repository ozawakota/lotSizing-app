// 抵抗帯（支持帯）をブレイクする可能性の目安と、ブレイクを狙う逆指値の目安（TF分析ページ）。純関数。
// ブレイクしやすさ = AI（Jev）のその方向へのブレイク確率を土台に、次の材料で加減点した目安（5〜90%）:
//   - ダウ理論の向き（帯の方向へのトレンドなら抜けやすい・逆なら跳ね返されやすい）
//   - 帯の強さ（★が多いほど抜けにくい）・何度も試されている帯（3回以上）は厚みが減って抜けやすい
//   - 現在値からの距離（1 ATR より遠いほど、その時間足のうちには届きにくい）
//   - 勢い（21SMA の上/下・RSI がその方向に 55〜75 / 25〜45）
// ※経験則にもとづく参考値で、過去データでの検証はしていない。投資助言ではない。
import { dowDirection, type DowAnalysis } from './dow';
import type { SrZone } from './srZones';
import type { BreakoutProb, SlDirection } from './stoploss';
import type { MaSet } from './entrySignal';

export type BreakLevel = 'high' | 'mid' | 'low';

export interface BreakFactor {
  label: string;
  points: number; // 加点(+)=抜けやすい / 減点(−)=跳ね返されやすい
}

export interface ZoneBreakOdds {
  pct: number; // ブレイクの可能性の目安（5〜90）
  level: BreakLevel; // high=抜けやすい(60以上) / mid=五分五分(40〜59) / low=跳ね返されやすい(40未満)
  base: number; // 土台にした確率（Jev のブレイク確率。無ければ 35）
  factors: BreakFactor[]; // 加減点の内訳（絶対値の大きい順）
}

export interface ZoneBreakInput {
  zone: SrZone;
  price: number;
  atr: number;
  pip: number;
  dow: DowAnalysis | null | undefined;
  breakout: BreakoutProb | null | undefined;
  rsi: number | null | undefined;
  ma?: MaSet | null;
}

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

/** 1つの帯をブレイクする可能性の目安。 */
export function zoneBreakOdds(i: ZoneBreakInput): ZoneBreakOdds {
  const up = i.zone.side === 'res'; // 抵抗帯=上抜け / 支持帯=下抜け
  const base = i.breakout ? (up ? i.breakout.up : i.breakout.down) : 35;
  const factors: BreakFactor[] = [];
  const add = (label: string, points: number) => {
    if (points !== 0) factors.push({ label, points });
  };

  const dir = dowDirection(i.dow ?? null);
  if (dir) {
    const toward = (dir === 'long') === up;
    add(toward ? `${up ? '上昇' : '下降'}トレンド（帯の方向）` : `${up ? '下降' : '上昇'}トレンド（逆向き）`, toward ? 10 : -10);
  }

  if (i.zone.stars === 3) add('強い帯★3', -12);
  else if (i.zone.stars === 2) add('帯★2', -6);
  if (i.zone.swingTouches >= 3) add(`${i.zone.swingTouches}回試されている（厚みが減りやすい）`, 6);

  if (i.atr > 0 && !i.zone.contains) {
    const distAtr = (i.zone.distancePips * i.pip) / i.atr;
    if (distAtr > 1) add(`遠い（${distAtr.toFixed(1)} ATR）`, -Math.min(20, Math.round((distAtr - 1) * 6)));
  }

  const sma = i.ma?.sma21;
  if (sma != null && (up ? i.price > sma : i.price < sma)) add(`21SMA の${up ? '上' : '下'}（勢いが帯の方向）`, 4);
  if (i.rsi != null && (up ? i.rsi >= 55 && i.rsi < 75 : i.rsi <= 45 && i.rsi > 25))
    add(`RSI ${Math.round(i.rsi)}（${up ? '上' : '下'}向きの勢い）`, 4);

  factors.sort((a, b) => Math.abs(b.points) - Math.abs(a.points));
  const pct = Math.round(clamp(base + factors.reduce((s, f) => s + f.points, 0), 5, 90));
  return { pct, level: pct >= 60 ? 'high' : pct >= 40 ? 'mid' : 'low', base, factors };
}

export interface StopEntryPlan {
  price: number; // 逆指値の価格（帯の外側 + 0.1 ATR）
  zoneLabel: string; // 例「R1（抵抗帯★2）」
  distancePips: number; // 現在値からの距離
  rr: number | null; // その価格で入った場合の RR（損切り・目標は同じ）
  breakPct: number; // その帯をブレイクする可能性の目安
}

/**
 * ブレイクを狙う逆指値の目安。トレンド方向のすぐ前（1.5 ATR 以内）の帯をブレイクする可能性が 50% 以上のときだけ、
 * 帯の外側（買い=上限の 0.1 ATR 上 / 売り=下限の 0.1 ATR 下）に逆指値を置く案を出す。
 * その価格で入った RR が 1 未満（目標が近すぎる）なら出さない。
 */
export function stopEntryPlan(i: {
  direction: SlDirection;
  price: number;
  atr: number;
  pip: number;
  ahead: { zone: SrZone; odds: ZoneBreakOdds; label: string } | null;
  rr: { stop: number; target: number; spreadPips: number } | null;
}): StopEntryPlan | null {
  if (!i.ahead || !(i.atr > 0)) return null;
  const { zone, odds, label } = i.ahead;
  const long = i.direction === 'long';
  if (zone.contains || (zone.distancePips * i.pip) / i.atr > 1.5 || odds.pct < 50) return null;
  const price = long ? zone.high + i.atr * 0.1 : zone.low - i.atr * 0.1;
  let rr: number | null = null;
  if (i.rr) {
    if (long ? i.rr.target <= price : i.rr.target >= price) return null;
    const risk = Math.abs(price - i.rr.stop) / i.pip + i.rr.spreadPips;
    const reward = Math.abs(i.rr.target - price) / i.pip - i.rr.spreadPips;
    rr = risk > 0 && reward > 0 ? Math.round((reward / risk) * 10) / 10 : null;
    if (rr == null || rr < 1) return null;
  }
  return {
    price,
    zoneLabel: label,
    distancePips: Math.round((Math.abs(price - i.price) / i.pip) * 10) / 10,
    rr,
    breakPct: odds.pct,
  };
}
