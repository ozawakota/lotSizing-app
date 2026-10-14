// 通貨優位性ランキングのスコア計算（純粋関数・フロント/worker 共有）。
// 各ペア×TFの4シグナル（トレンド方向・PA・RR・ロールリバーサル）を符号付き[-1,1]に正規化し、
// TFスコア → ペアスコア（上位足を重く加重）→ 通貨スコア（base+/quote−で配分・出現数で平均）へ集約する。
// すべて AI 非依存。方向はトレンド構造とローソク足から決める。
import type { SlTimeframe } from './stoploss';

export const RANKING_TIMEFRAMES: SlTimeframe[] = ['15m', '30m', '1h', '4h'];

// 集計対象ペア（stoploss.ts の YAHOO_SYMBOL に対応）。XAU_USD のゴールドを含む。
export const RANKING_PAIRS: string[] = [
  'USD_JPY',
  'EUR_JPY',
  'GBP_JPY',
  'AUD_JPY',
  'EUR_USD',
  'GBP_USD',
  'AUD_USD',
  'XAU_USD',
];

// 構造的RRの最小値（これ以上を qualifies とみなす）。
export const RANKING_MIN_RR = 1.5;
// RR値を[0,1]に正規化する上限（RR_CAP 以上は満点扱い）。
export const RR_CAP = 3;

// TFの重み（上位足＝信頼度高めに加重）。
export const TF_WEIGHT: Record<SlTimeframe, number> = { '15m': 1, '30m': 1.5, '1h': 2, '4h': 2.5 };
// TF内の各シグナルの重み（既定は均等）。
export const SIGNAL_WEIGHT = { trend: 1, pa: 1, rr: 1, rrv: 1 } as const;

// 1ペア×1TFの生シグナル（worker が純粋関数から算出して渡す）。
export interface TfSignal {
  tf: SlTimeframe;
  trend: 'up' | 'down' | 'range';
  paDir: -1 | 0 | 1; // 直近ローソク足パターンの向き（強気+1/弱気-1/なし0）
  rrDir: -1 | 0 | 1; // 構造的RRの方向（long+1/short-1/なし0）
  rr: number | null; // qualifies した rr 値（>=RANKING_MIN_RR）。無ければ null
  rrvScore: number | null; // ロールリバーサル信用度 0–100。評価不能は null
  rrvSide: 'resistance' | 'support' | null; // resistance=強気+ / support=弱気-
}

export type RankVerdict = 'strong_buy' | 'buy' | 'neutral' | 'sell' | 'strong_sell';
export const RANK_VERDICT_LABEL: Record<RankVerdict, string> = {
  strong_buy: '強い買い優位',
  buy: '買い優位',
  neutral: '中立',
  sell: '売り優位',
  strong_sell: '強い売り優位',
};

export interface PairRanking {
  instrument: string;
  score: number; // -1..1（買い優位+ / 売り優位-）
  tfScores: { tf: SlTimeframe; score: number }[]; // TF別スコア（内訳表示用）
}

export interface CurrencyRank {
  currency: string; // USD/JPY/EUR/GBP/AUD/XAU
  score: number; // -100..100
  verdict: RankVerdict;
  pairs: number; // 寄与したペア数
}

export interface RankingSnapshot {
  currencies: CurrencyRank[]; // score 降順
  pairs: PairRanking[]; // ペア別スコア（内訳表示用）
  signals: Record<string, TfSignal[]>; // instrument -> TF別シグナル（内訳表示用）
  failed: string[]; // 取得に失敗したペア
  generatedAt: number;
}

const clamp = (x: number, lo: number, hi: number) => (x < lo ? lo : x > hi ? hi : x);
const dirValue = (trend: TfSignal['trend']): number => (trend === 'up' ? 1 : trend === 'down' ? -1 : 0);

// 1TFの合成スコア（-1..1）。4シグナルを符号付きに直して重み付き平均。
export function tfScore(sig: TfSignal): number {
  const trendComp = dirValue(sig.trend);
  const paComp = sig.paDir;
  const rrComp = sig.rr != null ? sig.rrDir * clamp(sig.rr / RR_CAP, 0, 1) : 0;
  const rrvComp = sig.rrvScore != null && sig.rrvSide ? (sig.rrvScore / 100) * (sig.rrvSide === 'resistance' ? 1 : -1) : 0;
  const w = SIGNAL_WEIGHT;
  const total = w.trend + w.pa + w.rr + w.rrv;
  return (w.trend * trendComp + w.pa * paComp + w.rr * rrComp + w.rrv * rrvComp) / total;
}

// 1ペアのスコア（-1..1）。TFを TF_WEIGHT で加重平均。
export function pairScore(instrument: string, sigs: TfSignal[]): PairRanking {
  const tfScores = sigs.map((s) => ({ tf: s.tf, score: tfScore(s) }));
  let num = 0;
  let den = 0;
  for (const s of sigs) {
    const w = TF_WEIGHT[s.tf] ?? 1;
    num += w * tfScore(s);
    den += w;
  }
  return { instrument, score: den > 0 ? num / den : 0, tfScores };
}

const verdictOf = (score: number): RankVerdict =>
  score >= 50 ? 'strong_buy' : score >= 15 ? 'buy' : score <= -50 ? 'strong_sell' : score <= -15 ? 'sell' : 'neutral';

// ペアスコアを通貨へ配分（base+/quote−）し、出現数で平均して -100..100 に換算。score 降順。
export function aggregateCurrencies(pairs: PairRanking[]): CurrencyRank[] {
  const sum: Record<string, number> = {};
  const cnt: Record<string, number> = {};
  for (const p of pairs) {
    const [base, quote] = p.instrument.split('_');
    if (!base || !quote) continue;
    sum[base] = (sum[base] ?? 0) + p.score;
    cnt[base] = (cnt[base] ?? 0) + 1;
    sum[quote] = (sum[quote] ?? 0) - p.score;
    cnt[quote] = (cnt[quote] ?? 0) + 1;
  }
  return Object.keys(sum)
    .map((currency) => {
      const score = Math.round(clamp((sum[currency] / cnt[currency]) * 100, -100, 100));
      return { currency, score, verdict: verdictOf(score), pairs: cnt[currency] };
    })
    .sort((a, b) => b.score - a.score);
}

// TF別シグナル（instrument -> TfSignal[]）からランキング全体を組み立てる。
export function buildRanking(signals: Record<string, TfSignal[]>, failed: string[] = []): RankingSnapshot {
  const pairs = Object.entries(signals).map(([instrument, sigs]) => pairScore(instrument, sigs));
  return { currencies: aggregateCurrencies(pairs), pairs, signals, failed, generatedAt: Date.now() };
}
