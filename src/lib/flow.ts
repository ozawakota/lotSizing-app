// 取引量・センチメント ページの純粋ドメインロジック。
// 設計: 当初の Twelve Data tick volume は FX では常に 0 で使えなかったため、
// 取引量は Myfxbook Community Outlook の実建玉 volume（buy/sell）に一本化した。
//
// Myfxbook Community Outlook はペアごとに以下を返す:
//  - longPercentage / shortPercentage … 建玉の割合（%）
//  - longVolume / shortVolume         … 買い量 / 売り量（実取引量）
// 「一番多い取引量が買いか売りか」= longVolume と shortVolume の多い方。
// Worker(Cron+KV) がこれをキャッシュし、Worker とクライアントが本モジュールを共有する。

// 対象ペア：X/JPY メジャー7本 ＋ ユーロドル(EUR/USD) ＋ ゴールド(XAU/USD)。
export type FlowPair =
  | 'USD/JPY'
  | 'EUR/JPY'
  | 'GBP/JPY'
  | 'AUD/JPY'
  | 'NZD/JPY'
  | 'CAD/JPY'
  | 'CHF/JPY'
  | 'EUR/USD'
  | 'GBP/USD'
  | 'AUD/USD'
  | 'XAU/USD';
export const FLOW_PAIRS: FlowPair[] = [
  'USD/JPY',
  'EUR/JPY',
  'GBP/JPY',
  'AUD/JPY',
  'NZD/JPY',
  'CAD/JPY',
  'CHF/JPY',
  'EUR/USD',
  'GBP/USD',
  'AUD/USD',
  'XAU/USD',
];

// 買い寄り / 売り寄り / 中立。
export type Lean = 'buy' | 'sell' | 'neutral';

// 前回スナップショット比の合計取引量の動き。
//  - entry      … 建玉が積み増された（新規エントリーが決済を上回った）
//  - settlement … 建玉が巻き戻された（決済が新規を上回った）
//  - flat       … 変化なし
// 注: Myfxbook は建玉の純増減しか取れないため、エントリーと決済を個別には観測できない。
export type FlowDirection = 'entry' | 'settlement' | 'flat';

// 合計取引量の前回比（符号付きの差分 + 向き）。初回（前回値なし）は付与しない。
export interface FlowDelta {
  value: number; // 合計取引量の前回比（符号付き。正=積み増し / 負=巻き戻し）
  direction: FlowDirection;
}

// 記録開始以降で「合計取引量(買い+売り)」が最大だった時点の記録。
// Myfxbook は履歴を持たないため Worker が毎時スナップショットから自前で蓄積する。
export interface VolumePeak {
  volume: number; // 合計取引量(買い+売り)のピーク値
  datetime: string; // ISO8601（ピークを記録した時刻）
  rate: number | null; // ピーク時のスポットレート（取得失敗時は null）
}

// 1ペア分の建玉情報（Myfxbook 由来）。
export interface PairFlow {
  pair: FlowPair;
  longPct: number; // 買い建玉の割合 %
  shortPct: number; // 売り建玉の割合 %
  longVolume: number; // 買い量（実取引量）
  shortVolume: number; // 売り量（実取引量）
  dominant: Lean; // 取引量(volume)の多い方
  peak?: VolumePeak; // 記録開始以降の合計取引量ピーク
  delta?: FlowDelta; // 前回スナップショット比の合計取引量の動き（初回は無し）
}

// Worker が /flow で返すスナップショット。
export interface FlowSnapshot {
  pairs: PairFlow[];
  updatedAt: string; // ISO8601（Worker が算出した時刻）
}

// ユーザーが並び替えた表示順を保存する localStorage キー。
export const FLOW_ORDER_STORAGE_KEY = 'flowPairOrder';

/**
 * 保存済みの表示順を現在の対象ペアに適用する。
 * - 保存順のうち現存するペアを順に採用（重複は無視）。
 * - 保存順に無い新規ペア（例: 後から追加した EUR/USD など）は既定順で末尾に追加。
 * - 対象外になったペアは除外。保存が空なら既定順そのまま。
 */
export function applyPairOrder(savedOrder: string[], all: FlowPair[]): FlowPair[] {
  const allSet = new Set<string>(all);
  const result: FlowPair[] = [];
  const seen = new Set<string>();
  for (const p of savedOrder) {
    if (allSet.has(p) && !seen.has(p)) {
      result.push(p as FlowPair);
      seen.add(p);
    }
  }
  for (const p of all) {
    if (!seen.has(p)) {
      result.push(p);
      seen.add(p);
    }
  }
  return result;
}

/**
 * 合計取引量のピークを更新する。前回が無い、または今回の方が大きければ今回で更新。
 * それ以外は前回を維持。
 */
export function updatePeak(
  prev: VolumePeak | undefined,
  volume: number,
  datetime: string,
  rate: number | null,
): VolumePeak {
  if (!prev || volume > prev.volume) return { volume, datetime, rate };
  return prev;
}

/** 買い量と売り量の多い方を返す。同量は neutral。 */
export function dominantByVolume(longVolume: number, shortVolume: number): Lean {
  if (longVolume > shortVolume) return 'buy';
  if (shortVolume > longVolume) return 'sell';
  return 'neutral';
}

/** 合計取引量の符号付き差分から動きの向きを判定する。正=entry / 負=settlement / 0=flat。 */
export function flowDirection(value: number): FlowDirection {
  if (value > 0) return 'entry';
  if (value < 0) return 'settlement';
  return 'flat';
}

/**
 * 前回スナップショットの合計取引量と今回を比較し、前回比（差分＋向き）を返す。
 * 前回値が無い（初回）場合は比較できないため undefined。
 */
export function computeDelta(prevTotal: number | undefined, currentTotal: number): FlowDelta | undefined {
  if (prevTotal === undefined) return undefined;
  const value = currentTotal - prevTotal;
  return { value, direction: flowDirection(value) };
}

/** 1ペア分の建玉情報を組み立てる（dominant は取引量基準）。 */
export function toPairFlow(
  pair: FlowPair,
  longPct: number,
  shortPct: number,
  longVolume: number,
  shortVolume: number,
): PairFlow {
  return { pair, longPct, shortPct, longVolume, shortVolume, dominant: dominantByVolume(longVolume, shortVolume) };
}
