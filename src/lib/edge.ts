// エッジ分析（プライスアクションの優位性検証）の純粋ドメインロジック。Worker とクライアントで共有する。
// ピンバー・包み足を OHLC から機械判定し、過去に同じパターンが出た後 N 本先の値動き（順方向pips）を
// 集計して「そのペア・その足でパターンに優位性があるか」を勝率・平均pips・プロフィットファクターで示す。
// 比較対象（ベースライン）は「全ての足で同方向に建てた場合」の勝率。差分(エッジ)がプラスなら優位性あり。
//
// 判定は確定足のみで行う（Yahoo の最終足は形成中のため呼び出し側で除外して渡す）。
// ※過去統計による参考情報であり、将来の値動きを保証しない。
import { pipSize } from './stoploss';

export type EdgeTimeframe = '1h' | '1d';
export const EDGE_TIMEFRAMES: EdgeTimeframe[] = ['1h', '1d'];

// 足ごとの Yahoo 取得設定（統計の母数を確保するため期間は長め）と、検証する保有本数。
export const EDGE_YAHOO: Record<EdgeTimeframe, { interval: string; range: string }> = {
  '1h': { interval: '60m', range: '3mo' },
  '1d': { interval: '1d', range: '2y' },
};
export const EDGE_HORIZON: Record<EdgeTimeframe, number> = { '1h': 4, '1d': 3 };

export const EDGE_PAIRS: string[] = [
  'USD_JPY',
  'EUR_JPY',
  'GBP_JPY',
  'AUD_JPY',
  'EUR_USD',
  'GBP_USD',
  'AUD_USD',
  'XAU_USD',
];

export const PINBAR_THRESHOLD = 0.66; // ヒゲが全値幅に占める割合のしきい値
export const MIN_SAMPLES = 8; // これ未満の出現回数は「サンプル不足」として優位性を判定しない

export interface OhlcCandle {
  open: number;
  high: number;
  low: number;
  close: number;
  t?: number; // 足の時刻（UNIX秒）
}

export type PatternKey = 'bull_pinbar' | 'bear_pinbar' | 'bull_engulfing' | 'bear_engulfing';
export const PATTERNS: PatternKey[] = ['bull_pinbar', 'bear_pinbar', 'bull_engulfing', 'bear_engulfing'];
export const PATTERN_DIRECTION: Record<PatternKey, 1 | -1> = {
  bull_pinbar: 1,
  bear_pinbar: -1,
  bull_engulfing: 1,
  bear_engulfing: -1,
};
export const PATTERN_LABEL: Record<PatternKey, string> = {
  bull_pinbar: '下ヒゲピンバー',
  bear_pinbar: '上ヒゲピンバー',
  bull_engulfing: '強気の包み足',
  bear_engulfing: '弱気の包み足',
};

/** 強気のピンバー（下ヒゲ）: 下ヒゲ ÷ 全値幅 ≥ threshold。 */
export function isBullishPinbar(c: OhlcCandle, threshold = PINBAR_THRESHOLD): boolean {
  const range = c.high - c.low;
  if (!(range > 0)) return false;
  const lowerWick = Math.min(c.open, c.close) - c.low;
  return lowerWick / range >= threshold;
}

/** 弱気のピンバー（上ヒゲ）: 上ヒゲ ÷ 全値幅 ≥ threshold。 */
export function isBearishPinbar(c: OhlcCandle, threshold = PINBAR_THRESHOLD): boolean {
  const range = c.high - c.low;
  if (!(range > 0)) return false;
  const upperWick = c.high - Math.max(c.open, c.close);
  return upperWick / range >= threshold;
}

/** 強気の包み足: 前足が陰線・今足が陽線で、今足の実体が前足の実体を包む。 */
export function isBullishEngulfing(prev: OhlcCandle, curr: OhlcCandle): boolean {
  return prev.close < prev.open && curr.close > curr.open && curr.open <= prev.close && curr.close >= prev.open;
}

/** 弱気の包み足: 前足が陽線・今足が陰線で、今足の実体が前足の実体を包む。 */
export function isBearishEngulfing(prev: OhlcCandle, curr: OhlcCandle): boolean {
  return prev.close > prev.open && curr.close < curr.open && curr.open >= prev.close && curr.close <= prev.open;
}

/** candles[i] で成立しているパターン一覧（包み足は i ≥ 1 のときのみ判定）。 */
export function detectPatterns(candles: OhlcCandle[], i: number, threshold = PINBAR_THRESHOLD): PatternKey[] {
  const c = candles[i];
  if (!c) return [];
  const out: PatternKey[] = [];
  if (isBullishPinbar(c, threshold)) out.push('bull_pinbar');
  if (isBearishPinbar(c, threshold)) out.push('bear_pinbar');
  const prev = candles[i - 1];
  if (prev) {
    if (isBullishEngulfing(prev, c)) out.push('bull_engulfing');
    if (isBearishEngulfing(prev, c)) out.push('bear_engulfing');
  }
  return out;
}

export type EdgeVerdict = 'strong' | 'weak' | 'none' | 'negative' | 'insufficient';
export const VERDICT_LABEL: Record<EdgeVerdict, string> = {
  strong: '優位性あり',
  weak: 'やや優位',
  none: '優位性なし',
  negative: '逆行傾向',
  insufficient: 'サンプル不足',
};

export interface PatternStats {
  pattern: PatternKey;
  count: number; // 検証できた出現回数（N本先が存在するもの）
  winRate: number; // 順方向に動いた割合（%）
  avgPips: number; // N本先までの順方向の平均値幅（pips）
  profitFactor: number | null; // 総利益 ÷ 総損失（損失0なら null）
  baselineWinRate: number; // 全足で同方向に建てた場合の勝率（%）
  edge: number; // winRate − baselineWinRate（%ポイント）
  verdict: EdgeVerdict;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

/** 出現回数・エッジ・平均pipsから優位性を段階判定する。 */
export function verdictOf(count: number, edge: number, avgPips: number): EdgeVerdict {
  if (count < MIN_SAMPLES) return 'insufficient';
  if (edge >= 10 && avgPips > 0) return 'strong';
  if (edge >= 3 && avgPips > 0) return 'weak';
  if (edge <= -5) return 'negative';
  return 'none';
}

/**
 * パターンごとに「出現足の終値 → horizon 本先の終値」の順方向pipsを集計する。
 * 最後の horizon 本は結果が未確定のため母数から除く。
 */
export function computePatternStats(
  candles: OhlcCandle[],
  instrument: string,
  horizon: number,
  threshold = PINBAR_THRESHOLD,
): PatternStats[] {
  const pip = pipSize(instrument);
  const last = candles.length - 1 - horizon; // 検証可能な最後の添字
  const moves: Record<PatternKey, number[]> = { bull_pinbar: [], bear_pinbar: [], bull_engulfing: [], bear_engulfing: [] };
  let upCount = 0;
  let downCount = 0;
  let total = 0;
  for (let i = 0; i <= last; i++) {
    const diff = candles[i + horizon].close - candles[i].close;
    total++;
    if (diff > 0) upCount++;
    else if (diff < 0) downCount++;
    for (const p of detectPatterns(candles, i, threshold)) {
      moves[p].push((diff * PATTERN_DIRECTION[p]) / pip);
    }
  }
  const baseUp = total > 0 ? (upCount / total) * 100 : 0;
  const baseDown = total > 0 ? (downCount / total) * 100 : 0;

  return PATTERNS.map((pattern) => {
    const m = moves[pattern];
    const count = m.length;
    const wins = m.filter((x) => x > 0).length;
    const gain = m.filter((x) => x > 0).reduce((a, b) => a + b, 0);
    const loss = -m.filter((x) => x < 0).reduce((a, b) => a + b, 0);
    const winRate = count > 0 ? (wins / count) * 100 : 0;
    const avgPips = count > 0 ? m.reduce((a, b) => a + b, 0) / count : 0;
    const baselineWinRate = PATTERN_DIRECTION[pattern] === 1 ? baseUp : baseDown;
    const edge = count > 0 ? winRate - baselineWinRate : 0;
    return {
      pattern,
      count,
      winRate: round1(winRate),
      avgPips: round1(avgPips),
      profitFactor: loss > 0 ? Math.round((gain / loss) * 100) / 100 : null,
      baselineWinRate: round1(baselineWinRate),
      edge: round1(edge),
      verdict: verdictOf(count, edge, avgPips),
    };
  });
}

export type EdgeSignal = 'buy' | 'sell' | 'neutral';
export const SIGNAL_LABEL: Record<EdgeSignal, string> = { buy: '買い優位', sell: '売り優位', neutral: '様子見' };

export interface PairEdge {
  instrument: string;
  lastClosedAt: number | null; // 最新確定足の時刻（UNIX秒）
  stats: PatternStats[];
  current: PatternKey[]; // 最新確定足で成立しているパターン
  signal: EdgeSignal;
  score: number; // シグナルの強さ＝根拠パターンのエッジ合計（%ポイント, 売りは負）
}

/**
 * 確定足の列からペアのエッジを求める。最新確定足に出たパターンのうち、過去統計で優位性
 * （strong/weak）があるものだけを根拠に売買シグナルを出す。買い・売りの根拠が拮抗したら様子見。
 */
export function analyzePairEdge(
  candles: OhlcCandle[],
  instrument: string,
  horizon: number,
  threshold = PINBAR_THRESHOLD,
): PairEdge {
  const stats = computePatternStats(candles, instrument, horizon, threshold);
  const lastIdx = candles.length - 1;
  const current = lastIdx >= 0 ? detectPatterns(candles, lastIdx, threshold) : [];
  let score = 0;
  for (const p of current) {
    const s = stats.find((x) => x.pattern === p);
    if (s && (s.verdict === 'strong' || s.verdict === 'weak')) score += s.edge * PATTERN_DIRECTION[p];
  }
  score = round1(score);
  const signal: EdgeSignal = score > 0 ? 'buy' : score < 0 ? 'sell' : 'neutral';
  return { instrument, lastClosedAt: candles[lastIdx]?.t ?? null, stats, current, signal, score };
}

export interface CurrencyBias {
  currency: string;
  score: number; // 正=買い優位、負=売り優位
}

/**
 * ペアのシグナルを通貨単位に振り分ける（買いシグナル=基軸通貨+／決済通貨−）。
 * 各通貨の優位性を横断的に見る用途。score 降順。
 */
export function currencyBias(pairs: PairEdge[]): CurrencyBias[] {
  const acc: Record<string, number> = {};
  for (const p of pairs) {
    const [base, quote] = p.instrument.split('_');
    if (!base || !quote) continue;
    acc[base] = (acc[base] ?? 0) + p.score;
    acc[quote] = (acc[quote] ?? 0) - p.score;
  }
  return Object.entries(acc)
    .map(([currency, score]) => ({ currency, score: round1(score) }))
    .sort((a, b) => b.score - a.score);
}

export interface EdgeSnapshot {
  timeframe: EdgeTimeframe;
  horizon: number;
  pairs: PairEdge[];
  currencies: CurrencyBias[];
  failed: string[]; // 取得に失敗したペア
  generatedAt: number;
}
