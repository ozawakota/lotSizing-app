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

// CFTC Legacy コントラクトコード（通貨先物は対USD / 金はCOMEX / USDはICEドル指数）。Worker とバックテストで共有。
export const COT_CONTRACT_CODES: Record<CotCurrency, string> = {
  JPY: '097741', // JAPANESE YEN - CME
  EUR: '099741', // EURO FX - CME
  GBP: '096742', // BRITISH POUND - CME
  AUD: '232741', // AUSTRALIAN DOLLAR - CME
  NZD: '112741', // NZ DOLLAR - CME
  CAD: '090741', // CANADIAN DOLLAR - CME
  CHF: '092741', // SWISS FRANC - CME
  XAU: '088691', // GOLD - COMEX
  USD: '098662', // USD INDEX - ICE FUTURES U.S.
};

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

/**
 * ペア X/Y の投機筋ネット = net(X) − net(Y)。どちらかの通貨が欠ければ undefined。
 * ゴールド（XAU/USD）は金先物そのもののネットを使う（金先物はドル建てなので、金の買い越し＝XAU/USD の買い越し）。
 */
export function pairSpecNet(net: Partial<Record<CotCurrency, number>>, pair: FlowPair): number | undefined {
  const [base, quote] = pair.split('/') as [CotCurrency, CotCurrency];
  const b = net[base];
  if (pair === 'XAU/USD') return b;
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
  avgLongPrice?: number; // 個人の買いポジションの平均取得価格（Myfxbook。取得できたときのみ）
  avgShortPrice?: number; // 個人の売りポジションの平均取得価格（同上）
}

// Worker が /flow で返すスナップショット。
export interface FlowSnapshot {
  pairs: PairFlow[];
  updatedAt: string; // ISO8601（Worker が応答を組み立てた時刻）
  flowUpdatedAt?: string; // ISO8601（個人の建玉を Myfxbook から取得した時刻。古い Worker では無い）
  cotReportDate?: string; // CFTC 報告日（火曜時点・ISO8601）。COT を取得できた場合のみ
  cotUpdatedAt?: string; // Worker が CFTC を取得した時刻（ISO8601）
  goldOi?: GoldOi; // ゴールドの日次の大口推定（CME 金先物の建玉増減×値動き）。取れていなければ無い
  goldNet?: GoldNet; // ゴールドの大口ネットポジション（CFTC・枚数）。取れていなければ無い
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

// ---------------------------------------------------------------------------
// 個人投資家（Myfxbook）建玉の偏りによる逆張りフィルタ（RR好機通知で使用）
// ---------------------------------------------------------------------------
// 個人投資家は逆張り指標として扱う: 自分と同じ向きに建玉が偏っていれば不利、逆向きに偏っていれば有利。
export const RETAIL_CROWDED_PCT = 65; // 同じ向きの建玉がこの割合以上 → 群集と同方向として見送る
export const RETAIL_SUPPORT_PCT = 60; // 逆向きの建玉がこの割合以上 → 逆張りの裏付けあり

export type RetailBiasVerdict = 'supports' | 'neutral' | 'against';
export interface RetailBias {
  sameSidePct: number; // 自分と同じ向き（ロング=買い / ショート=売り）の建玉割合 %
  verdict: RetailBiasVerdict; // supports=逆張り支持 / neutral=偏りなし / against=群集と同方向
}

/**
 * ロング/ショートの setup に対する個人投資家建玉の偏りを判定する。
 * 例: ロングで個人の売りが 72% → 逆張り支持（supports）。ロングで個人の買いが 70% → against。
 */
export function retailBias(flow: Pick<PairFlow, 'longPct' | 'shortPct'>, direction: 'long' | 'short'): RetailBias {
  const same = direction === 'long' ? flow.longPct : flow.shortPct;
  const opposite = direction === 'long' ? flow.shortPct : flow.longPct;
  const verdict: RetailBiasVerdict =
    same >= RETAIL_CROWDED_PCT ? 'against' : opposite >= RETAIL_SUPPORT_PCT ? 'supports' : 'neutral';
  return { sameSidePct: same, verdict };
}

/** 'USD_JPY' 形式の instrument を FlowPair（'USD/JPY'）に変換する。対象外は null。 */
export function instrumentToFlowPair(instrument: string): FlowPair | null {
  const pair = instrument.replace('_', '/');
  return (FLOW_PAIRS as string[]).includes(pair) ? (pair as FlowPair) : null;
}

// ---------------------------------------------------------------------------
// 取引量・センチメント ページの表示用（偏りの大きさ・個人と大口の一致/逆行・並び順）
// ---------------------------------------------------------------------------

/** 個人投資家の建玉の多い側と、その割合。crowded=偏りが大きい（RETAIL_CROWDED_PCT 以上）。 */
export interface RetailSkew {
  side: Lean; // 割合の多い側（同率は neutral）
  pct: number; // 多い側の割合 %
  crowded: boolean;
}

export function retailSkew(flow: Pick<PairFlow, 'longPct' | 'shortPct'>): RetailSkew {
  const side: Lean = flow.longPct > flow.shortPct ? 'buy' : flow.shortPct > flow.longPct ? 'sell' : 'neutral';
  const pct = Math.max(flow.longPct, flow.shortPct);
  return { side, pct, crowded: pct >= RETAIL_CROWDED_PCT };
}

/** 個人と大口（投機筋）の向きの関係。どちらかが中立・データなしなら none。 */
export type FlowContrast = 'opposite' | 'same' | 'none';

export function flowContrast(flow: Pick<PairFlow, 'longPct' | 'shortPct' | 'cot'>): FlowContrast {
  const retail = retailSkew(flow).side;
  const spec = flow.cot?.lean ?? 'neutral';
  if (retail === 'neutral' || spec === 'neutral') return 'none';
  return retail === spec ? 'same' : 'opposite';
}

/** custom=ユーザーの並び / skew=個人の偏りが大きい順 / opposite=個人と大口が逆のペアのみ */
export type FlowSortMode = 'custom' | 'skew' | 'opposite';
export const FLOW_SORT_STORAGE_KEY = 'flowSortMode';

/**
 * 表示するペアの並びを返す。データの無いペアは skew では末尾、opposite では除外する。
 * skew の同率はユーザーの並び順を保つ。
 */
export function sortFlowPairs(order: FlowPair[], byPair: Map<FlowPair, PairFlow>, mode: FlowSortMode): FlowPair[] {
  if (mode === 'custom') return order;
  if (mode === 'opposite') return order.filter((p) => {
    const f = byPair.get(p);
    return f !== undefined && flowContrast(f) === 'opposite';
  });
  const skew = (p: FlowPair) => {
    const f = byPair.get(p);
    return f ? retailSkew(f).pct : -1;
  };
  return order
    .map((p, i) => ({ p, i, s: skew(p) }))
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map(({ p }) => p);
}

// ---------------------------------------------------------------------------
// 逆張りのエントリー候補（取引量・センチメント ページ）
// 個人投資家の建玉が片側に大きく偏ったペアで、その逆向きを候補にする。大口（CFTC 投機筋）で確からしさを付ける:
//   A = 大口が候補の向き（個人と逆）… 個人と大口の考えが割れていて、大口の側につく形
//   B = 大口は中立・データなし
//   C = 大口も個人と同じ向き … 逆張りの根拠が弱い（注意として残す）
// 大口のネットが前週から候補の向きに動いていれば「大口が積み増し中」を添える。
// ※エントリーの合図ではなく、TF分析で流れ・抵抗線・入りどきを確かめる前の絞り込み。
// ---------------------------------------------------------------------------

export type ContrarianGrade = 'A' | 'B' | 'C';

export interface ContrarianCandidate {
  pair: FlowPair;
  direction: 'buy' | 'sell'; // 候補の向き（個人の多い側の逆）
  grade: ContrarianGrade;
  retailPct: number; // 個人の多い側の割合 %
  spec: Lean | null; // 大口の向き（データなしは null）
  specAdding: boolean; // 大口が前週から候補の向きに積み増し
  reasons: string[]; // 短い理由（例「個人の売り 72%」「大口は買い越し」）
}

const GRADE_ORDER: Record<ContrarianGrade, number> = { A: 0, B: 1, C: 2 };

export function contrarianCandidates(pairs: PairFlow[]): ContrarianCandidate[] {
  const out: ContrarianCandidate[] = [];
  for (const p of pairs) {
    const skew = retailSkew(p);
    if (!skew.crowded || skew.side === 'neutral') continue;
    const direction: 'buy' | 'sell' = skew.side === 'buy' ? 'sell' : 'buy';
    const reasons = [`個人の${skew.side === 'buy' ? '買い' : '売り'} ${Math.round(skew.pct)}%`];
    const spec = p.cot?.lean ?? 'neutral';
    let grade: ContrarianGrade;
    if (spec === direction) {
      grade = 'A';
      reasons.push(`大口は${direction === 'buy' ? '買い越し' : '売り越し'}`);
    } else if (spec === 'neutral') {
      grade = 'B';
      reasons.push(p.cot ? '大口は中立' : '大口のデータなし');
    } else {
      grade = 'C';
      reasons.push(`大口も${spec === 'buy' ? '買い越し' : '売り越し'}（根拠弱め）`);
    }
    const d = p.cot?.deltaNet;
    const specAdding = d != null && Math.abs(d) >= 0.01 && (d > 0 ? 'buy' : 'sell') === direction;
    if (specAdding) reasons.push('大口が積み増し中');
    out.push({ pair: p.pair, direction, grade, retailPct: skew.pct, spec: p.cot ? spec : null, specAdding, reasons });
  }
  return out.sort((a, b) => GRADE_ORDER[a.grade] - GRADE_ORDER[b.grade] || b.retailPct - a.retailPct);
}

// ---------------------------------------------------------------------------
// 大口（CFTC COT）の発表スケジュール
// CFTC は毎週火曜時点の建玉を、金曜 15:30（米東部時間）に公表する（祝日の週は月曜などにずれる）。
// 「いま手元にあるべき最新の報告日（火曜）」を求め、キャッシュが古ければ取り直す・画面で知らせるのに使う。
// ---------------------------------------------------------------------------

const NY_PARTS = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
  weekday: 'short',
});
const WEEKDAY: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** 直近の発表（金曜 15:30 米東部）が済んだ週の報告日（火曜）を "YYYY-MM-DD" で返す。 */
export function expectedCotReportDate(now: Date): string {
  const parts = Object.fromEntries(NY_PARTS.formatToParts(now).map((p) => [p.type, p.value]));
  const dow = WEEKDAY[parts.weekday];
  const minutes = Number(parts.hour) * 60 + Number(parts.minute);
  // 米東部の日付で、直近の「発表済みの金曜」までさかのぼる日数
  let back = (dow - 5 + 7) % 7;
  if (back === 0 && minutes < 15 * 60 + 30) back = 7; // 金曜の発表前は先週の金曜
  const ny = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day));
  const tuesday = new Date(ny - (back + 3) * 86_400_000); // 金曜の3日前＝火曜
  return tuesday.toISOString().slice(0, 10);
}

/** 手元の報告日が、発表済みの最新より古いか（"YYYY-MM-DD..." を比較）。報告日が無ければ古い扱い。 */
export function cotIsBehind(reportDate: string | undefined, now: Date): boolean {
  if (!reportDate) return true;
  return reportDate.slice(0, 10) < expectedCotReportDate(now);
}

// ---------------------------------------------------------------------------
// ゴールド（XAU/USD）の日次の大口推定: CME 金先物（GC）の建玉（取組高）の増減 × 値動き
// CFTC は週1回（火曜時点を金曜に公表）なので、その間を日次で補う。
//   建玉↑ × 値上がり = 新規の買い / 建玉↑ × 値下がり = 新規の売り
//   建玉↓ × 値上がり = 売りの買い戻し / 建玉↓ × 値下がり = 買いの手じまい
// 建玉の増減が全体の 0.1% 未満、または値動きが無い日は「様子見」。
// ---------------------------------------------------------------------------

export type OiSignal = 'new_long' | 'new_short' | 'short_cover' | 'long_liq' | 'flat';

export const OI_SIGNAL_LABEL: Record<OiSignal, string> = {
  new_long: '新規の買い',
  new_short: '新規の売り',
  short_cover: '売りの買い戻し',
  long_liq: '買いの手じまい',
  flat: '様子見',
};

// 大口の向きへの寄与（新規の買い・買い戻し＝買い寄り、新規の売り・手じまい＝売り寄り）。新規の方を重く見る。
const OI_SIGNAL_WEIGHT: Record<OiSignal, number> = { new_long: 2, short_cover: 1, flat: 0, long_liq: -1, new_short: -2 };

export interface GoldOiDay {
  date: string; // 取引日 "YYYY-MM-DD"
  oi: number; // 取引終了時の建玉（全限月合計）
  oiChange: number; // 前日比の建玉の増減
  priceChange: number; // 前日比の値動き（金先物の終値）
  signal: OiSignal;
  final: boolean; // CME の確定値か（false＝速報値）
}

export interface GoldOi {
  days: GoldOiDay[]; // 古い順（最大 15 日）
  updatedAt: string; // Worker が取得した時刻（ISO8601）
}

export function classifyOi(oiChange: number, priceChange: number, oi: number): OiSignal {
  if (!priceChange || Math.abs(oiChange) < Math.max(1, oi * 0.001)) return 'flat';
  if (oiChange > 0) return priceChange > 0 ? 'new_long' : 'new_short';
  return priceChange > 0 ? 'short_cover' : 'long_liq';
}

/** 直近 n 日の推定から、大口の向き（買い寄り/売り寄り/中立）をまとめる。 */
export function goldOiLean(days: GoldOiDay[], n = 5): { lean: Lean; score: number; days: number } {
  const recent = days.slice(-n);
  const score = recent.reduce((s, d) => s + OI_SIGNAL_WEIGHT[d.signal], 0);
  // 1日の新規（±2）だけでは決めず、合計が ±2 を超えたら向きありとする
  const lean: Lean = score > 2 ? 'buy' : score < -2 ? 'sell' : 'neutral';
  return { lean, score, days: recent.length };
}

/** 新しい日の推定を履歴に入れる（同じ日は置き換え＝速報→確定の更新）。古い順・最大 max 日。変化があったか返す。 */
export function mergeGoldOiDay(days: GoldOiDay[], day: GoldOiDay, max = 15): { days: GoldOiDay[]; changed: boolean } {
  const prev = days.find((d) => d.date === day.date);
  if (prev && prev.oi === day.oi && prev.oiChange === day.oiChange && prev.priceChange === day.priceChange && prev.final === day.final) {
    return { days, changed: false };
  }
  const next = [...days.filter((d) => d.date !== day.date), day].sort((a, b) => (a.date < b.date ? -1 : 1)).slice(-max);
  return { days: next, changed: true };
}

// ---------------------------------------------------------------------------
// ゴールドの大口ネットポジション（枚数）
//   確定: CFTC（金先物・投機筋）の買い建玉 − 売り建玉。火曜時点を金曜に公表
//   推定: 確定値に、報告日より後の CME の日次の建玉増減を、推定した向きで足し引きしたもの
//         （新規の買い・売りの買い戻し＝足す / 新規の売り・買いの手じまい＝引く）。
//         建玉の増減をすべて大口によるものと仮定するので、実際より大きめに出やすい。毎週の確定値でリセットされる。
// ---------------------------------------------------------------------------

export interface GoldNet {
  reportDate: string; // CFTC 報告日（ISO8601・火曜時点）
  long: number; // 投機筋の買い建玉（枚）
  short: number; // 投機筋の売り建玉（枚）
  net: number; // 買い − 売り（枚）
  change?: number; // 前週比（枚）
}

const OI_NET_SIGN: Record<OiSignal, number> = { new_long: 1, short_cover: 1, flat: 0, new_short: -1, long_liq: -1 };

/** 確定ネットに、報告日より後の日次の推定を足し引きした「今日のネット（推定）」。足す日が無ければ null。 */
export function estimateGoldNet(
  gold: Pick<GoldNet, 'net' | 'reportDate'>,
  days: GoldOiDay[],
): { net: number; delta: number; through: string; days: number } | null {
  const from = gold.reportDate.slice(0, 10);
  const after = days.filter((d) => d.date > from);
  if (!after.length) return null;
  const delta = after.reduce((s, d) => s + OI_NET_SIGN[d.signal] * Math.abs(d.oiChange), 0);
  return { net: gold.net + delta, delta, through: after[after.length - 1].date, days: after.length };
}

// ---------------------------------------------------------------------------
// ゴールド（XAU/USD）の売買シグナル: 大口の動きと個人の偏りをまとめて、買い優勢/売り優勢/様子見を出す
//   ① 大口ネットの前週比（CFTC 確定）       … 買い越しが増えた＝買い +1 / 減った＝売り −1
//   ② 確定後〜今日の推定の増減（CME 日次）    … 同上
//   ③ 日次の推定の直近5日の傾き（goldOiLean） … 買い寄り +1 / 売り寄り −1
//   ④ 個人の偏り（逆張り）                     … 個人が 65% 以上 買い＝売り −1 / 売り＝買い +1
// 合計が +2 以上で買い、−2 以下で売り、それ以外は様子見。強さは |合計|（2=★、3=★★、4=★★★）。
// 増減が小さい（ネットの 2% 未満かつ 1,000 枚未満）ときは 0 とする。※投資助言ではない参考情報。
// ---------------------------------------------------------------------------

export type SignalDir = 'buy' | 'sell' | 'neutral';

export interface GoldSignalFactor {
  key: 'weekly' | 'estimate' | 'daily' | 'retail';
  label: string; // 例「大口 前週比 +8,200枚」
  dir: SignalDir;
}

export interface GoldSignal {
  verdict: SignalDir;
  score: number; // −4〜+4
  stars: number; // 0〜3（様子見は 0）
  factors: GoldSignalFactor[]; // 判定に使った材料（データが無いものは入らない）
}

const fmtSigned = (v: number) => `${v > 0 ? '+' : v < 0 ? '−' : '±'}${Math.abs(Math.round(v)).toLocaleString('ja-JP')}`;

export function goldSignal(i: {
  net?: GoldNet;
  oi?: GoldOi;
  retail?: Pick<PairFlow, 'longPct' | 'shortPct'>;
}): GoldSignal | null {
  const factors: GoldSignalFactor[] = [];
  const base = Math.abs(i.net?.net ?? 0);
  const meaningful = (v: number) => Math.abs(v) >= Math.min(1000, base * 0.02 || 1000);
  const dirOf = (v: number): SignalDir => (!meaningful(v) ? 'neutral' : v > 0 ? 'buy' : 'sell');
  if (i.net?.change != null) {
    factors.push({ key: 'weekly', label: `大口 前週比 ${fmtSigned(i.net.change)}枚`, dir: dirOf(i.net.change) });
  }
  const est = i.net && i.oi ? estimateGoldNet(i.net, i.oi.days) : null;
  if (est) factors.push({ key: 'estimate', label: `今週の推定 ${fmtSigned(est.delta)}枚`, dir: dirOf(est.delta) });
  if (i.oi?.days.length) {
    const l = goldOiLean(i.oi.days);
    const word = l.lean === 'buy' ? '買い寄り' : l.lean === 'sell' ? '売り寄り' : '方向感なし';
    factors.push({ key: 'daily', label: `日次 ${l.days}日 ${word}`, dir: l.lean });
  }
  if (i.retail) {
    const s = retailSkew(i.retail);
    const dir: SignalDir = !s.crowded || s.side === 'neutral' ? 'neutral' : s.side === 'buy' ? 'sell' : 'buy';
    factors.push({ key: 'retail', label: `個人 ${s.side === 'sell' ? '売り' : '買い'}${Math.round(s.pct)}%${dir === 'neutral' ? '' : '（逆張り）'}`, dir });
  }
  if (!factors.length) return null;
  const score = factors.reduce((s, f) => s + (f.dir === 'buy' ? 1 : f.dir === 'sell' ? -1 : 0), 0);
  const verdict: SignalDir = score >= 2 ? 'buy' : score <= -2 ? 'sell' : 'neutral';
  const stars = verdict === 'neutral' ? 0 : Math.min(3, Math.abs(score) - 1);
  return { verdict, score, stars, factors };
}
