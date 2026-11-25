// エッジページ（RR好機ボード）の「小さく負けるポイント」。カードの価格から、負けを小さくする3つの手を求める（純関数）。
//   ① 撤退ライン: 損切りの価格・距離（pips）。ここを割ったらシナリオが崩れたと判断して切る
//   ② 指値で入る: 指値の目安が「エントリーと損切りの間（押し目・戻り）」にあれば、そこで入ったときの損失と RR
//   ③ 建値ストップ: 1R（損切りまでの距離）だけ有利に進んだら、損切りをエントリー価格へ移す（最悪でも ±0）
import type { RrCard } from './ranking';

export interface SmallLossPlan {
  stop: { price: number; pips: number };
  limit: { price: number; riskPips: number; savedPct: number; rr: number } | null;
  breakeven: { trigger: number; moveTo: number } | null;
}

const round1 = (v: number) => Math.round(v * 10) / 10;

export function smallLossPlan(card: Pick<RrCard, 'direction' | 'entry' | 'stop' | 'target' | 'riskPips' | 'timing'>, pip: number): SmallLossPlan {
  const long = card.direction === 'long';
  const risk = Math.abs(card.entry - card.stop);
  // ② 指値: 押し目買い（損切り < 指値 < エントリー）/ 戻り売り（エントリー < 指値 < 損切り）のときだけ
  let limit: SmallLossPlan['limit'] = null;
  const lp = card.timing?.limitPrice;
  if (lp != null && (long ? lp > card.stop && lp < card.entry : lp < card.stop && lp > card.entry)) {
    const r = Math.abs(lp - card.stop);
    const riskPips = round1(r / pip);
    const savedPct = Math.round((1 - r / risk) * 100);
    if (savedPct >= 5) limit = { price: lp, riskPips, savedPct, rr: round1(Math.abs(card.target - lp) / r) };
  }
  // ③ 建値ストップ: 1R 進んだ価格。目標より手前のときだけ（目標が 1R より近ければ使わない）
  const trigger = long ? card.entry + risk : card.entry - risk;
  const beforeTarget = long ? trigger < card.target : trigger > card.target;
  return {
    stop: { price: card.stop, pips: card.riskPips },
    limit,
    breakeven: risk > 0 && beforeTarget ? { trigger, moveTo: card.entry } : null,
  };
}
