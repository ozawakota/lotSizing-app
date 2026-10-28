// 為替ニュース由来の売買シグナル（買い%/確信度）とトレンドの反転/継続判定の純ロジック。
// Worker とクライアントで共有。算出エンジン（Workers AI / Jev）はこの型に整形するだけで
// 差し替え可能にする。プロンプト生成と応答パースをここに集約して単体テストする。
import type { RateSeries } from './strength';
import type { EconEvent, NewsItem } from './news';

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
  rationale: string; // 日本語の一言根拠（ニュース由来）
  anomaly?: string; // いま当てはまるアノマリーを踏まえた一言（該当なし・旧キャッシュ・Jev は空/無し）
  // 合成の内訳（forecast.ts の blendSignal）。旧キャッシュには無い
  parts?: {
    news: number; // ニュース（AI）だけの買い%
    price: number | null; // 値動きだけの買い%（系列が無ければ null）
    agree?: boolean; // 両方が同じ向き
    disagree?: boolean; // 向きが食い違い（50% に寄せて確信度を下げた）
    priceNotes?: string[]; // 値動きの根拠（目立つものだけ）
    priceFactors?: { label: string; detail: string; lean: 1 | -1 | 0; weight: number }[]; // 値動きの材料すべて
    weightNews?: number; // 合成でのニュースの重み（0–1。値動き = 1 - weightNews）
    adaptive?: boolean; // 重みを的中率から決めたか
    newsConfidence?: number; // ニュース（AI）の確信度
    priceConfidence?: number; // 値動きの確信度
  };
  refs?: number[]; // 根拠にしたニュースの番号（payload.items の 0 始まりの位置）。Jev・旧キャッシュには無い
}

// 直近の値動き（反転/継続判定の state 用）。
export interface PairTrend {
  pair: SignalPair;
  changePct: number | null; // 直近 lookback 本での % 変化（不明なら null）
  direction: 'up' | 'down' | 'flat';
  change8hPct?: number | null; // 8時間（15分足32本）での % 変化
  change24hPct?: number | null; // 24時間（15分足96本）での % 変化
}

const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, n));

// RateSeries から各シグナルペアの価格系列を取り出す。
// 対円はそのまま、ドルストレートは X/JPY ÷ USD/JPY、XAU/USD は XAU/JPY ÷ USD/JPY で復元。
export function pairSeries(series: RateSeries, pair: SignalPair): number[] | null {
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
  const longer = (bars: number) => (s.length > bars && s[s.length - 1 - bars] > 0 ? (end / s[s.length - 1 - bars] - 1) * 100 : null);
  return { pair, changePct, direction, change8hPct: longer(32), change24hPct: longer(96) };
}

/** ニュースと直近トレンドから、LLM に厳密 JSON を返させるプロンプトを組み立てる。 */
export function buildSignalPrompt(
  items: NewsItem[],
  trends: PairTrend[],
  pairs: SignalPair[] = SIGNAL_PAIRS,
  econNote = '', // 高重要度の経済指標ダイジェスト（空なら節を出さない）
  anomalyNote = '', // いま意識されやすいアノマリー（src/lib/anomaly.ts の formatAnomalyDigest。空なら節を出さない）
): string {
  const news = items.map((it, i) => `${i + 1}. ${it.title} — ${it.description}`).join('\n');
  const pct = (v: number | null | undefined) => (v == null ? '不明' : `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`);
  const trendLines = trends
    .map(
      (t) =>
        `- ${t.pair}: 直近2時間 ${t.direction}${t.changePct != null ? ` (${t.changePct.toFixed(2)}%)` : '（不明）'}` +
        (t.change8hPct !== undefined || t.change24hPct !== undefined ? ` / 8時間 ${pct(t.change8hPct)} / 24時間 ${pct(t.change24hPct)}` : ''),
    )
    .join('\n');
  return [
    '以下の為替ニュースと各ペアの直近トレンドを踏まえ、ペアごとに「今後8時間程度の売買の傾き」と「トレンドの継続/反転」を推定してください。',
    'そのペアの通貨に直接関係するニュースが無ければ、buyPct は 50 に近づけ confidence を低く（0.3以下）してください。',
    '',
    '# ニュース',
    news,
    '',
    '# 直近トレンド',
    trendLines,
    // 高重要度の経済指標を加味（発表前後は様子見・ボラ拡大の可能性を考慮させる）。
    ...(econNote
      ? ['', '# 経済指標（高重要度・今週）', econNote, '', '発表前後は様子見やボラティリティ拡大の可能性を考慮してください。']
      : []),
    // 五十日・月末・季節性・指標前後などの経験則（アノマリー）。ニュースと矛盾すればニュースを優先させる。
    ...(anomalyNote
      ? ['', '# いま意識されやすいアノマリー（経験則）', anomalyNote, '', 'アノマリーは補助材料です。ニュースや直近トレンドと食い違う場合はそちらを優先してください。']
      : []),
    '',
    '# 出力ルール',
    `対象ペア: ${pairs.join(', ')}`,
    '次のJSONのみを返してください（前置き・説明・コードフェンスなし）。',
    '{"signals":[{"pair":"USD/JPY","buyPct":<0-100の整数>,"confidence":<0-1の小数>,"trend":"continuation|reversal|neutral","trendPct":<0-100の整数>,"rationale":"<ニュースを根拠にした日本語の一言>","refs":[<根拠にしたニュースの番号（上の一覧の番号）。最大3つ。無ければ空配列>],"anomaly":"<そのペアに当てはまるアノマリーの解説を日本語で一言。無ければ空文字>"}]}',
    'buyPct は買い優勢度（売り=100-buyPct）。trend は直近トレンドが継続か反転か。確信が低ければ confidence を小さく。',
    'rationale と anomaly はそれぞれ60字以内。anomaly は上のアノマリー一覧に該当があるペアだけ書き、ニュースとどう組み合わさるかに触れてください。',
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
  const anomaly = typeof s?.anomaly === 'string' ? s.anomaly.trim().slice(0, 120) : '';
  // 根拠のニュース番号（プロンプトは 1 始まり → 0 始まりに。重複・不正値は除く・最大3つ）。
  const refs = Array.isArray(s?.refs)
    ? [...new Set((s.refs as unknown[]).map((v) => Math.round(Number(v)) - 1).filter((v) => Number.isInteger(v) && v >= 0))].slice(0, 3)
    : [];
  return { pair, buyPct, confidence, trend, trendPct, rationale, anomaly, ...(refs.length ? { refs } : {}) };
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
  econEvents: EconEvent[] = [], // 高重要度の経済指標（state に calendar として加味）
  anomalies: { title: string; when: string; detail: string }[] = [], // いま意識されやすいアノマリー（state に加味）
): JevRequestBody {
  const dirByPair = new Map(trends.map((t) => [t.pair, t.direction]));
  const state = {
    news: items.map((it) => ({ title: it.title, summary: it.description })),
    trends: trends.map((t) => ({
      pair: t.pair,
      direction: t.direction,
      changePct: t.changePct,
      change8hPct: t.change8hPct ?? null,
      change24hPct: t.change24hPct ?? null,
    })),
    ...(econEvents.length
      ? { calendar: econEvents.map((e) => ({ date: e.date, country: e.country, title: e.title, forecast: e.forecast, previous: e.previous })) }
      : {}),
    ...(anomalies.length ? { anomalies: anomalies.map((a) => ({ title: a.title, when: a.when, detail: a.detail })) } : {}),
  };
  const questions: Record<string, unknown> = {};
  for (const pair of pairs) {
    const k = jevKey(pair);
    const dir = dirByPair.get(pair) ?? 'flat';
    questions[`buy_${k}`] = {
      type: 'choice',
      instructions: `${pair} について、ニュースと直近トレンド（2時間・8時間・24時間の変化）を踏まえ、今後8時間程度で買い(上昇)と売り(下落)のどちらが優勢か。`,
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

// ---------------------------------------------------------------------------
// 為替ニュースタブの表示用（予測の向き・確信度の段階・並び順）
// ---------------------------------------------------------------------------
export type SignalVerdict = 'up' | 'down' | 'flat';
export const VERDICT_UP_PCT = 60; // 買い%がこれ以上 → 上昇予想
export const VERDICT_DOWN_PCT = 40; // 買い%がこれ以下 → 下落予想

/** 買い%から予測の向きを決める（40〜60% は方向感なし）。 */
export function signalVerdict(s: Pick<PairSignal, 'buyPct'>): SignalVerdict {
  if (s.buyPct >= VERDICT_UP_PCT) return 'up';
  if (s.buyPct <= VERDICT_DOWN_PCT) return 'down';
  return 'flat';
}

export type ConfidenceLevel = 'high' | 'mid' | 'low';
export function confidenceLevel(confidence: number): ConfidenceLevel {
  if (confidence >= 0.7) return 'high';
  if (confidence >= 0.4) return 'mid';
  return 'low';
}

/** 傾きの強さ（買い%の50からの距離 × 確信度）が大きい順。同率は元の順。 */
export function sortSignalsByStrength(signals: PairSignal[]): PairSignal[] {
  const score = (s: PairSignal) => Math.abs(s.buyPct - 50) * s.confidence;
  return signals
    .map((s, i) => ({ s, i }))
    .sort((a, b) => score(b.s) - score(a.s) || a.i - b.i)
    .map(({ s }) => s);
}
