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

// ---------------------------------------------------------------------------
// 投機筋（CFTC COT / Legacy 非商業 Non-Commercial）
// ---------------------------------------------------------------------------
// Myfxbook が「リテール（個人投資家）」の建玉なのに対し、CFTC COT は CME 先物の
// 大口投機筋（スマートマネー）のネットポジション。週次（毎週金曜に火曜時点を発表）。
// CME 通貨先物は「対USD」で建つため、各通貨のネットを正規化し、ペア X/Y の
// 投機筋リーン = net(X) − net(Y) として全11ペア（クロス含む）を合成する。
// これにより USD/JPY は net(USD)−net(JPY) となり、符号反転（JPY買い越し＝USD/JPY売り）も自動で処理される。

// COT で扱う通貨・金（CFTC 先物が存在する単位）。
export type CotCurrency = 'USD' | 'JPY' | 'EUR' | 'GBP' | 'AUD' | 'NZD' | 'CAD' | 'CHF' | 'XAU';

// 1ペア分の投機筋ポジション（CFTC 由来・合成）。
export interface PairCot {
  net: number; // 投機筋ネット = net(base) − net(quote)。範囲 −2〜+2（正=買い越し / 負=売り越し）
  lean: Lean; // 買い越し=buy / 売り越し=sell / 中立=neutral
  deltaNet?: number; // 前週比のネット変化（符号付き）。前週データが無ければ undefined
}

// |net| がこの範囲内なら中立扱いにするデッドバンド。
const SPEC_LEAN_DEADBAND = 0.05;

/** 投機筋のグロス建玉からネットを正規化する: (long − short) / (long + short)。範囲 −1〜+1。建玉ゼロは 0。 */
export function normalizeNet(long: number, short: number): number {
  const total = long + short;
  if (total <= 0) return 0;
  return (long - short) / total;
}

/** 正規化ネット差（−2〜+2）から買い越し/売り越し/中立を判定する。 */
export function specLean(pairNet: number): Lean {
  if (pairNet > SPEC_LEAN_DEADBAND) return 'buy';
  if (pairNet < -SPEC_LEAN_DEADBAND) return 'sell';
  return 'neutral';
}

// 投機筋リーンの強さ（偏りの大きさ）。現実的な範囲（概ね ±1）を3等分して弱/中/強に区分。
export type SpecStrength = 'weak' | 'mid' | 'strong';
export function specStrength(pairNet: number): SpecStrength {
  const a = Math.abs(pairNet);
  if (a < 0.34) return 'weak';
  if (a < 0.67) return 'mid';
  return 'strong';
}

/** ペア X/Y の投機筋ネット = net(X) − net(Y)。どちらかの通貨が欠ければ undefined。 */
export function pairSpecNet(net: Partial<Record<CotCurrency, number>>, pair: FlowPair): number | undefined {
  const [base, quote] = pair.split('/') as [CotCurrency, CotCurrency];
  const b = net[base];
  const q = net[quote];
  if (b === undefined || q === undefined) return undefined;
  return b - q;
}

/** 当週・前週の通貨別ネットから 1ペア分の PairCot を組み立てる。合成できなければ undefined。 */
export function toPairCot(
  net: Partial<Record<CotCurrency, number>>,
  prevNet: Partial<Record<CotCurrency, number>>,
  pair: FlowPair,
): PairCot | undefined {
  const value = pairSpecNet(net, pair);
  if (value === undefined) return undefined;
  const prev = pairSpecNet(prevNet, pair);
  return { net: value, lean: specLean(value), deltaNet: prev === undefined ? undefined : value - prev };
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
  cot?: PairCot; // 投機筋（CFTC COT）のネットポジション（取得できたペアのみ）
}

// Worker が /flow で返すスナップショット。
export interface FlowSnapshot {
  pairs: PairFlow[];
  updatedAt: string; // ISO8601（Worker が算出した時刻）
  cotReportDate?: string; // CFTC 報告日（火曜時点・ISO8601）。COT を取得できた場合のみ
  cotUpdatedAt?: string; // Worker が CFTC を取得した時刻（ISO8601）
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
