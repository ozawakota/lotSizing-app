// 為替ニュース由来の売買シグナル（買い%/確信度）とトレンドの反転/継続判定の純ロジック。
// Worker とクライアントで共有。算出エンジン（Workers AI / Jev）はこの型に整形するだけで
// 差し替え可能にする。プロンプト生成と応答パースをここに集約して単体テストする。
import type { RateSeries } from './strength';
import type { NewsItem } from './news';

// シグナル対象ペア（直近トレンドを intraday シリーズから得られるものを既定とする）。
export type SignalPair =
  | 'USD/JPY'
  | 'EUR/JPY'
  | 'GBP/JPY'
  | 'AUD/JPY'
  | 'NZD/JPY'
  | 'CAD/JPY'
  | 'EUR/USD'
  | 'GBP/USD'
  | 'XAU/USD';
export const SIGNAL_PAIRS: SignalPair[] = [
  'USD/JPY',
  'EUR/JPY',
  'GBP/JPY',
  'AUD/JPY',
  'NZD/JPY',
  'CAD/JPY',
  'EUR/USD',
  'GBP/USD',
  'XAU/USD',
];

// トレンドの継続 / 反転 / 中立。
export type TrendLabel = 'continuation' | 'reversal' | 'neutral';

// 1ペア分のシグナル結果。
export interface PairSignal {
  pair: SignalPair;
  buyPct: number; // 0-100（売り = 100 - buyPct）
  confidence: number; // 0-1
  trend: TrendLabel; // 継続 / 反転 / 中立
  trendPct: number; // 0-100（選ばれた trend の確からしさ）
  rationale: string; // 日本語の一言根拠
}

// 直近の値動き（反転/継続判定の state 用）。
export interface PairTrend {
  pair: SignalPair;
  changePct: number | null; // 直近 lookback 本での % 変化（不明なら null）
  direction: 'up' | 'down' | 'flat';
}

const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, n));

// RateSeries から各シグナルペアの価格系列を取り出す。
// 対円はそのまま、ドルストレートは X/JPY ÷ USD/JPY、XAU/USD は XAU/JPY ÷ USD/JPY で復元。
function pairSeries(series: RateSeries, pair: SignalPair): number[] | null {
  const r = series.rates;
  const cross = (a?: number[], b?: number[]): number[] | null =>
    a && b ? a.map((v, i) => v / b[i]) : null;
  switch (pair) {
    case 'USD/JPY':
      return r.USD ?? null;
    case 'EUR/JPY':
      return r.EUR ?? null;
    case 'GBP/JPY':
      return r.GBP ?? null;
    case 'AUD/JPY':
      return r.AUD ?? null;
    case 'NZD/JPY':
      return r.NZD ?? null;
    case 'CAD/JPY':
      return r.CAD ?? null;
    case 'EUR/USD':
      return cross(r.EUR, r.USD);
    case 'GBP/USD':
      return cross(r.GBP, r.USD);
    case 'XAU/USD':
      return cross(r.XAU, r.USD);
  }
}

/** 直近 `lookback` 本ぶんの変化から、そのペアの足元トレンドを求める。 */
export function computeRecentTrend(series: RateSeries | null, pair: SignalPair, lookback = 8): PairTrend {
  const s = series ? pairSeries(series, pair) : null;
  if (!s || s.length < 2) return { pair, changePct: null, direction: 'flat' };
  const end = s[s.length - 1];
  const start = s[Math.max(0, s.length - 1 - lookback)];
  if (!(start > 0) || !(end > 0)) return { pair, changePct: null, direction: 'flat' };
  const changePct = (end / start - 1) * 100;
  const direction = changePct > 0.05 ? 'up' : changePct < -0.05 ? 'down' : 'flat';
  return { pair, changePct, direction };
}

/** ニュースと直近トレンドから、LLM に厳密 JSON を返させるプロンプトを組み立てる。 */
export function buildSignalPrompt(
  items: NewsItem[],
  trends: PairTrend[],
  pairs: SignalPair[] = SIGNAL_PAIRS,
): string {
  const news = items.map((it, i) => `${i + 1}. ${it.title} — ${it.description}`).join('\n');
  const trendLines = trends
    .map(
      (t) =>
        `- ${t.pair}: 直近トレンド ${t.direction}${t.changePct != null ? ` (${t.changePct.toFixed(2)}%)` : '（不明）'}`,
    )
    .join('\n');
  return [
    '以下の為替ニュースと各ペアの直近トレンドを踏まえ、ペアごとに「売買の傾き」と「トレンドの継続/反転」を推定してください。',
    '',
    '# ニュース',
    news,
    '',
    '# 直近トレンド',
    trendLines,
    '',
    '# 出力ルール',
    `対象ペア: ${pairs.join(', ')}`,
    '次のJSONのみを返してください（前置き・説明・コードフェンスなし）。',
    '{"signals":[{"pair":"USD/JPY","buyPct":<0-100の整数>,"confidence":<0-1の小数>,"trend":"continuation|reversal|neutral","trendPct":<0-100の整数>,"rationale":"<日本語の一言>"}]}',
    'buyPct は買い優勢度（売り=100-buyPct）。trend は直近トレンドが継続か反転か。確信が低ければ confidence を小さく。',
  ].join('\n');
}

// LLM 応答から JSON オブジェクトを頑健に取り出す（コードフェンス除去＋最初の { … } を採用）。
function extractJson(raw: string): unknown {
  if (!raw) return null;
  const cleaned = raw.replace(/```json\s*|```/gi, '');
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return null;
  }
}

function normalizeSignal(pair: SignalPair, s: Record<string, unknown> | undefined): PairSignal {
  const buyRaw = Number(s?.buyPct);
  const buyPct = Number.isFinite(buyRaw) ? Math.round(clamp(buyRaw, 0, 100)) : 50;
  const confRaw = Number(s?.confidence);
  const confidence = Number.isFinite(confRaw) ? clamp(confRaw, 0, 1) : 0.3;
  const trend: TrendLabel =
    s?.trend === 'continuation' || s?.trend === 'reversal' ? s.trend : 'neutral';
  const tpRaw = Number(s?.trendPct);
  const trendPct = Number.isFinite(tpRaw) ? Math.round(clamp(tpRaw, 0, 100)) : 50;
  const rationale = typeof s?.rationale === 'string' ? s.rationale.slice(0, 120) : '';
  return { pair, buyPct, confidence, trend, trendPct, rationale };
}

/**
 * エンジンの生応答を検証・クランプして、対象ペアぶんの PairSignal に整える。
 * 応答は「JSON文字列」「既にパース済みのオブジェクト/配列」のいずれでも受け付ける
 * （Workers AI は response を文字列・オブジェクトどちらでも返し得る）。
 * 欠損・壊れた応答でも各ペアを中立(50/確信0.3/neutral)で必ず埋める。
 */
export function parseSignalResponse(raw: unknown, pairs: SignalPair[] = SIGNAL_PAIRS): PairSignal[] {
  const parsed = typeof raw === 'string' ? extractJson(raw) : raw;
  const arr: Record<string, unknown>[] = Array.isArray(parsed)
    ? (parsed as Record<string, unknown>[])
    : Array.isArray((parsed as { signals?: unknown })?.signals)
      ? ((parsed as { signals: unknown[] }).signals as Record<string, unknown>[])
      : [];
  const byPair = new Map<string, Record<string, unknown>>();
  for (const s of arr) {
    if (s && typeof s.pair === 'string') byPair.set(s.pair, s);
  }
  return pairs.map((pair) => normalizeSignal(pair, byPair.get(pair)));
}

// ---------------------------------------------------------------------------
// Jev (typesafe.ai) エンジン: POST https://api.typesafe.ai/v1/systemone
// 1リクエストに state(ニュース+トレンド) と、ペア×2問(買い/反転継続)の Choice を詰める。
//   買い%   = Choice{buy,sell} の buy 確率
//   反転継続 = Choice{continuation,reversal,neutral} の choice とその確率
// ---------------------------------------------------------------------------
export interface JevRequestBody {
  state: unknown;
  questions: Record<string, unknown>;
}

// 質問キーに使えるよう 'USD/JPY' → 'USD_JPY'。
const jevKey = (pair: SignalPair): string => pair.replace(/\//g, '_');

/** Jev の systemone リクエスト body（model 以外）を組み立てる。 */
export function buildJevRequest(
  items: NewsItem[],
  trends: PairTrend[],
  pairs: SignalPair[] = SIGNAL_PAIRS,
): JevRequestBody {
  const dirByPair = new Map(trends.map((t) => [t.pair, t.direction]));
  const state = {
    news: items.map((it) => ({ title: it.title, summary: it.description })),
    trends: trends.map((t) => ({ pair: t.pair, direction: t.direction, changePct: t.changePct })),
  };
  const questions: Record<string, unknown> = {};
  for (const pair of pairs) {
    const k = jevKey(pair);
    const dir = dirByPair.get(pair) ?? 'flat';
    questions[`buy_${k}`] = {
      type: 'choice',
      instructions: `${pair} について、ニュースと直近トレンドを踏まえ、短期的に買い(上昇)と売り(下落)のどちらが優勢か。`,
      criteria: { buy: '買い優勢（上昇が優勢）', sell: '売り優勢（下落が優勢）' },
    };
    questions[`trend_${k}`] = {
      type: 'choice',
      instructions: `${pair} の直近トレンド(${dir})が今後も継続するか、反転するか、どちらとも言えないか。`,
      criteria: {
        continuation: '直近トレンドが継続する',
        reversal: '直近トレンドが反転する',
        neutral: 'どちらとも言えない/中立',
      },
    };
  }
  return { state, questions };
}

interface JevAnswer {
  choice?: string;
  probabilities?: Record<string, number>;
  confidence?: number;
}

/** Jev の answers を PairSignal[] に整形（欠損は中立で補完）。 */
export function parseJevAnswers(
  answers: Record<string, JevAnswer> | undefined,
  pairs: SignalPair[] = SIGNAL_PAIRS,
): PairSignal[] {
  const a = answers ?? {};
  return pairs.map((pair) => {
    const k = jevKey(pair);
    const buyA = a[`buy_${k}`];
    const trA = a[`trend_${k}`];

    // 買い%: buy の確率を優先、無ければ choice から。
    let buyPct = 50;
    const pBuy = buyA?.probabilities?.buy;
    if (typeof pBuy === 'number') buyPct = Math.round(clamp(pBuy * 100, 0, 100));
    else if (buyA?.choice === 'buy') buyPct = 100;
    else if (buyA?.choice === 'sell') buyPct = 0;

    const confidence = typeof buyA?.confidence === 'number' ? clamp(buyA.confidence, 0, 1) : 0.5;

    // 反転/継続: choice とその確率。
    const trend: TrendLabel =
      trA?.choice === 'continuation' || trA?.choice === 'reversal' ? trA.choice : 'neutral';
    const pTrend = trA?.probabilities?.[trA?.choice ?? ''];
    const trendPct = typeof pTrend === 'number' ? Math.round(clamp(pTrend * 100, 0, 100)) : 50;

    return { pair, buyPct, confidence, trend, trendPct, rationale: '' };
  });
}
