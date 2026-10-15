// エントリーサイン（押し目/戻り/反転警戒）の純粋ロジック。RR好機ボードで、順張 setup の
// 「今が入りどきか」を 移動平均(SMA21/EMA75/EMA200)・ストキャス・プライスアクション から判定する。
// setup 方向基準: 押し目=買い方向への押し / 戻り=売り方向への戻し / 反転警戒=行き過ぎor逆パターン。
import type { SlDirection } from './stoploss';

export type EntryKind = 'pullback' | 'tentative' | 'caution';
export interface EntrySignal {
  kind: EntryKind;
  label: string; // 押し目 / 戻り / 様子見 / 反転警戒
}

// 並び順への反映: 押し目/戻り は加点、反転警戒は減点、様子見は中立。
export const ENTRY_DELTA: Record<EntryKind, number> = { pullback: 12, tentative: 0, caution: -18 };

// 単純移動平均（本数不足は null）。
export function sma(values: number[], period: number): number | null {
  if (values.length < period) return null;
  let s = 0;
  for (let i = values.length - period; i < values.length; i++) s += values[i];
  return s / period;
}

// 指数移動平均（初期値は先頭 period 本の SMA、本数不足は null）。
export function ema(values: number[], period: number): number | null {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  let e = 0;
  for (let i = 0; i < period; i++) e += values[i];
  e /= period;
  for (let i = period; i < values.length; i++) e = values[i] * k + e * (1 - k);
  return e;
}

export interface MaSet {
  sma21: number | null;
  ema75: number | null;
  ema200: number | null;
}
export function computeMaSet(closes: number[]): MaSet {
  return { sma21: sma(closes, 21), ema75: ema(closes, 75), ema200: ema(closes, 200) };
}

// setup 方向基準でエントリータイミングを分類する。stoch/パターンは任意（null/0 可）。
export function classifyEntry(opts: {
  closes: number[]; // 古い→新しい
  price: number; // 現在値
  direction: SlDirection; // long/short
  stoch: { k: number; d: number } | null;
  patternDir: 1 | -1 | 0; // 有効パターンの向き（強気+1/弱気-1/なし0）
}): EntrySignal {
  const { closes, price, direction, stoch, patternDir } = opts;
  const { sma21, ema75, ema200 } = computeMaSet(closes);
  const long = direction === 'long';
  const k = stoch?.k ?? null;
  const turningWith = stoch ? (long ? stoch.k >= stoch.d : stoch.k <= stoch.d) : false; // 順方向へ転換

  // 順張トレンド整合（長期MA側に居るか。MA が無ければ price 自身で緩く許容）。
  const trendOk = long
    ? (ema200 == null || price > ema200) && (ema75 == null || price > ema75 || (sma21 != null && sma21 >= ema75))
    : (ema200 == null || price < ema200) && (ema75 == null || price < ema75 || (sma21 != null && sma21 <= ema75));

  // 押し目/戻りゾーン: 短期MA(SMA21)へ押し/戻しつつ、中期MA(EMA75)は割っていない。
  const pulledToSma = sma21 != null && (long ? price <= sma21 : price >= sma21);
  const notBrokenMid = ema75 == null || (long ? price >= ema75 * 0.999 : price <= ema75 * 1.001);
  const pullbackZone = pulledToSma && notBrokenMid;

  // 行き過ぎ（反転警戒）: ストキャスが順方向で極端 かつ 短期MAから乖離。
  const extended = sma21 != null && k != null && (long ? k >= 85 && price > sma21 : k <= 15 && price < sma21);
  // 逆向きの有効パターンが極端域で出ている＝反転リスク。
  const opposite = long ? patternDir === -1 : patternDir === 1;
  const oppAtExtreme = opposite && k != null && (long ? k >= 70 : k <= 30);

  if (extended || oppAtExtreme) return { kind: 'caution', label: '反転警戒' };
  if (trendOk && pullbackZone && (stoch == null || turningWith) && !opposite) {
    return { kind: 'pullback', label: long ? '押し目' : '戻り' };
  }
  return { kind: 'tentative', label: '様子見' };
}
