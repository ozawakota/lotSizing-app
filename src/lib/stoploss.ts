// 損切り提案の純粋ドメインロジック。Worker とクライアントで共有する。
// ロウソク足(OHLC)から構造（直近スイング高安・トレンド）を機械的に求め、方向に応じた
// 損切り価格を算出する。プライスアクション分類(反転/戻り売り/押し目買い/レンジ)は
// Jev(Choice) もしくは Workers AI(JSON) に投げるためのリクエスト生成・応答パースを提供する。

export type SlTimeframe = '15m' | '30m' | '1h' | '4h';
export const SL_TIMEFRAMES: SlTimeframe[] = ['15m', '30m', '1h', '4h'];
export type SlDirection = 'long' | 'short';

// 表示ペア(instrument, 例 'GBP_USD') → Yahoo Finance のシンボル。XAU/USD は金先物(GC=F)を代理に。
export const YAHOO_SYMBOL: Record<string, string> = {
  USD_JPY: 'USDJPY=X',
  EUR_JPY: 'EURJPY=X',
  GBP_JPY: 'GBPJPY=X',
  AUD_JPY: 'AUDJPY=X',
  EUR_USD: 'EURUSD=X',
  GBP_USD: 'GBPUSD=X',
  AUD_USD: 'AUDUSD=X',
  XAU_USD: 'GC=F',
};
// アプリの足 → Yahoo の interval。
export const YAHOO_INTERVAL: Record<SlTimeframe, string> = {
  '15m': '15m',
  '30m': '30m',
  '1h': '60m',
  '4h': '4h',
};

export interface Candle {
  high: number;
  low: number;
  close: number;
}

// プライスアクション分類。
export type PaClass = 'reversal' | 'sell_rally' | 'buy_dip' | 'range';
export const PA_CRITERIA: Record<PaClass, string> = {
  reversal: '直近トレンドの反転が起きている/起きやすい局面',
  sell_rally: '下降トレンド中の戻り(上昇)で、戻り売りが有効な局面',
  buy_dip: '上昇トレンド中の押し目(下落)で、押し目買いが有効な局面',
  range: '明確な方向感の無いレンジ/中立',
};

export interface SlStructure {
  trend: 'up' | 'down' | 'range';
  swingHigh: number;
  swingLow: number;
  currentRate: number;
}

export interface SlSuggestion {
  price: number; // 損切り価格
  distancePips: number; // エントリー(無ければ現在値)からの距離(pips)
  basis: 'swing_low' | 'swing_high';
  reference: number; // 基準にしたスイング価格
}

export interface PaResult {
  pa: PaClass;
  paPct: number; // 0-100 その分類の確からしさ
  confidence: number; // 0-1
}

const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, n));

/** instrument の pip サイズ（XAU=0.1ドル, 対円=0.01, その他=0.0001）。 */
export function pipSize(instrument: string): number {
  if (instrument.startsWith('XAU')) return 0.1;
  if (instrument.endsWith('JPY')) return 0.01;
  return 0.0001;
}

/** ロウソク足から直近 lookback 本の構造（スイング高安・トレンド）を求める。 */
export function computeStructure(candles: Candle[], currentRate: number, lookback = 24): SlStructure {
  const recent = candles.slice(-lookback);
  if (recent.length === 0) {
    return { trend: 'range', swingHigh: currentRate, swingLow: currentRate, currentRate };
  }
  const swingHigh = Math.max(...recent.map((c) => c.high));
  const swingLow = Math.min(...recent.map((c) => c.low));
  const closes = recent.map((c) => c.close);
  const changePct = (closes[closes.length - 1] / closes[0] - 1) * 100;
  const trend: SlStructure['trend'] = changePct > 0.1 ? 'up' : changePct < -0.1 ? 'down' : 'range';
  return { trend, swingHigh, swingLow, currentRate };
}

/** 方向とエントリー(任意)から損切り価格・距離を算出。long=スイング安値の下、short=スイング高値の上。 */
export function computeStopLoss(
  structure: SlStructure,
  direction: SlDirection,
  entry: number | null,
  instrument: string,
): SlSuggestion {
  const pip = pipSize(instrument);
  const range = Math.max(structure.swingHigh - structure.swingLow, 0);
  const buffer = Math.max(range * 0.05, pip * 2); // 直近レンジの5% か 最低2pips
  const ref = direction === 'long' ? structure.swingLow : structure.swingHigh;
  const price = direction === 'long' ? ref - buffer : ref + buffer;
  const from = entry != null && entry > 0 ? entry : structure.currentRate;
  const distancePips = Math.round((Math.abs(from - price) / pip) * 10) / 10;
  return {
    price,
    distancePips,
    basis: direction === 'long' ? 'swing_low' : 'swing_high',
    reference: ref,
  };
}

// ---------------------------------------------------------------------------
// プライスアクション分類: Jev(Choice) / Workers AI(JSON)
// ---------------------------------------------------------------------------
export interface JevBody {
  state: unknown;
  questions: Record<string, unknown>;
}

const paState = (structure: SlStructure, recentCloses: number[]): unknown => ({
  trend: structure.trend,
  currentRate: structure.currentRate,
  swingHigh: structure.swingHigh,
  swingLow: structure.swingLow,
  recentCloses: recentCloses.slice(-12),
});

/** Jev systemone リクエスト body（model 以外）。1問の Choice でプライスアクションを分類。 */
export function buildPaJevRequest(structure: SlStructure, recentCloses: number[]): JevBody {
  return {
    state: paState(structure, recentCloses),
    questions: {
      price_action: {
        type: 'choice',
        instructions:
          '直近のトレンド・スイング高安・現在値・最近の終値列から、現在の相場のプライスアクションを分類してください。',
        criteria: PA_CRITERIA,
      },
    },
  };
}

interface JevChoiceAnswer {
  choice?: string;
  probabilities?: Record<string, number>;
  confidence?: number;
}

/** Jev の answers を PaResult に整形（欠損はレンジ/中立）。 */
export function parsePaJev(answers: Record<string, JevChoiceAnswer> | undefined): PaResult {
  const q = (answers ?? {}).price_action;
  const valid: PaClass[] = ['reversal', 'sell_rally', 'buy_dip', 'range'];
  const pa = valid.includes(q?.choice as PaClass) ? (q!.choice as PaClass) : 'range';
  const p = q?.probabilities?.[pa];
  const paPct = typeof p === 'number' ? Math.round(clamp(p * 100, 0, 100)) : 50;
  const confidence = typeof q?.confidence === 'number' ? clamp(q.confidence, 0, 1) : 0.5;
  return { pa, paPct, confidence };
}

/** Workers AI フォールバック用プロンプト（厳密JSONを要求）。 */
export function buildPaPrompt(structure: SlStructure, recentCloses: number[]): string {
  return [
    '次の相場状態から、現在のプライスアクションを分類してください。',
    JSON.stringify(paState(structure, recentCloses)),
    '分類の定義:',
    ...Object.entries(PA_CRITERIA).map(([k, v]) => `- ${k}: ${v}`),
    '次のJSONのみ返してください（説明なし）:',
    '{"pa":"reversal|sell_rally|buy_dip|range","paPct":<0-100>,"confidence":<0-1>}',
  ].join('\n');
}

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

/** Workers AI の応答(JSON文字列/オブジェクト)を PaResult に整形。 */
export function parsePaAi(raw: unknown): PaResult {
  const o = (typeof raw === 'string' ? extractJson(raw) : raw) as Record<string, unknown> | null;
  const valid: PaClass[] = ['reversal', 'sell_rally', 'buy_dip', 'range'];
  const pa = valid.includes(o?.pa as PaClass) ? (o!.pa as PaClass) : 'range';
  const paRaw = Number(o?.paPct);
  const paPct = Number.isFinite(paRaw) ? Math.round(clamp(paRaw, 0, 100)) : 50;
  const confRaw = Number(o?.confidence);
  const confidence = Number.isFinite(confRaw) ? clamp(confRaw, 0, 1) : 0.5;
  return { pa, paPct, confidence };
}
