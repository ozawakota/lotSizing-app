// ニュースページの売買予測の精度を上げる純ロジック（Worker とクライアントで共有）。
//  1) priceSignal: 15分足の値動きだけから求める予測（2h/8h/24h のモメンタム・EMA20/60・RSI の行き過ぎ）
//  2) blendSignal: AI のニュース予測と値動きの予測を重み付けで合成。食い違うときは 50% に寄せて確信度を下げる
//  3) 予測の記録と答え合わせ: 予測時の価格を記録し、FORECAST_HORIZON_H 時間後の値動きで当たり/外れを判定
//  4) accuracyStats / blendWeights: 直近の的中率を集計し、当たっている方（ニュース/値動き）の重みを上げる
// ※過去の的中率は将来を保証しない参考値。
import { pairSeries, signalVerdict, type PairSignal, type SignalPair } from './signal';
import type { RateSeries } from './strength';

export const FORECAST_HORIZON_H = 8; // 答え合わせをする時間（予測の対象期間）
export const HISTORY_DAYS = 14; // 記録を残す日数
export const STATS_DAYS = 7; // 的中率を集計する日数
export const MIN_MOVE_PCT = 0.02; // これ未満の値動きは「動かなかった」として集計しない
const MIN_SAMPLES_FOR_WEIGHTS = 12; // これ未満なら重みは既定（半々）

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

/** 値動きだけから求めた予測（買い% 0–100・確信度 0–1）。 */
export interface PriceSignal {
  buyPct: number;
  confidence: number;
  notes: string[]; // 例「24時間で上昇（+0.85%）」
}

function emaLast(values: number[], period: number): number | null {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  let e = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) e = values[i] * k + e * (1 - k);
  return e;
}

function rsiLast(values: number[], period = 14): number | null {
  if (values.length <= period) return null;
  let gain = 0;
  let loss = 0;
  for (let i = values.length - period; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    if (d > 0) gain += d;
    else loss -= d;
  }
  if (gain + loss === 0) return 50;
  return (100 * gain) / (gain + loss);
}

/**
 * 15分足の終値（古い順）から値動きの予測を求める。
 * モメンタムは各期間の対数リターンを「その期間のふつうの値動き（15分足の標準偏差×√本数）」で割った z 値。
 * 2h/8h/24h のモメンタムと EMA20/60 の傾きを合成し、RSI が極端なら逆方向に少し戻す（行き過ぎの反動）。
 */
export function priceSignal(closes: number[] | null): PriceSignal | null {
  if (!closes || closes.length < 40) return null;
  const rets: number[] = [];
  for (let i = 1; i < closes.length; i++) rets.push(Math.log(closes[i] / closes[i - 1]));
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const vol = Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / rets.length);
  if (!(vol > 0)) return null;
  const last = closes[closes.length - 1];
  const z = (bars: number) => {
    const n = Math.min(bars, closes.length - 1);
    return Math.log(last / closes[closes.length - 1 - n]) / (vol * Math.sqrt(n));
  };
  const chg = (bars: number) => (last / closes[closes.length - 1 - Math.min(bars, closes.length - 1)] - 1) * 100;
  const z2 = z(8);
  const z8 = z(32);
  const z24 = z(96);
  const fast = emaLast(closes, 20);
  const slow = emaLast(closes, 60);
  const zt = fast != null && slow != null ? Math.log(fast / slow) / (vol * Math.sqrt(20)) : 0;
  let m = 0.2 * z2 + 0.3 * z8 + 0.3 * z24 + 0.2 * zt;
  const notes: string[] = [];
  const dirJa = (v: number) => (v > 0 ? '上昇' : '下落');
  if (Math.abs(z24) >= 1) notes.push(`24時間で${dirJa(z24)}（${chg(96) >= 0 ? '+' : ''}${chg(96).toFixed(2)}%）`);
  if (Math.abs(z8) >= 1) notes.push(`8時間で${dirJa(z8)}（${chg(32) >= 0 ? '+' : ''}${chg(32).toFixed(2)}%）`);
  if (fast != null && slow != null && Math.abs(zt) >= 0.5) notes.push(fast > slow ? '短期の移動平均が上向き' : '短期の移動平均が下向き');
  const rsi = rsiLast(closes);
  if (rsi != null && rsi >= 75) {
    m -= 0.5;
    notes.push(`RSI ${Math.round(rsi)}（買われすぎ・反動に注意）`);
  } else if (rsi != null && rsi <= 25) {
    m += 0.5;
    notes.push(`RSI ${Math.round(rsi)}（売られすぎ・反動に注意）`);
  }
  return {
    buyPct: Math.round(50 + 40 * Math.tanh(m / 1.5)),
    confidence: Math.round(clamp(Math.abs(m) / 2, 0, 1) * 100) / 100,
    notes,
  };
}

/** 15分足の系列から、ペアごとの値動きの予測。 */
export function priceSignals(series: RateSeries | null, pairs: SignalPair[]): Map<SignalPair, PriceSignal | null> {
  return new Map(pairs.map((p) => [p, priceSignal(series ? pairSeries(series, p) : null)]));
}

export interface BlendWeights {
  news: number; // 0–1（値動き = 1 - news）
  adaptive: boolean; // 的中率から決めたか（false=既定の半々）
}

/** AI のニュース予測と値動きの予測を合成する。値動きが無ければ AI のまま。 */
export function blendSignal(ai: PairSignal, price: PriceSignal | null, w: BlendWeights): PairSignal {
  if (!price) return { ...ai, parts: { news: ai.buyPct, price: null } };
  const dn = ai.buyPct - 50;
  const dp = price.buyPct - 50;
  let dev = w.news * dn + (1 - w.news) * dp;
  const disagree = Math.abs(dn) >= 5 && Math.abs(dp) >= 5 && Math.sign(dn) !== Math.sign(dp);
  const agree = Math.abs(dn) >= 5 && Math.abs(dp) >= 5 && Math.sign(dn) === Math.sign(dp);
  if (disagree) dev *= 0.6; // 食い違い → 方向感を弱める
  let confidence = w.news * ai.confidence + (1 - w.news) * price.confidence;
  if (agree) confidence += 0.15;
  if (disagree) confidence = Math.min(confidence, 0.35);
  return {
    ...ai,
    buyPct: Math.round(clamp(50 + dev, 0, 100)),
    confidence: Math.round(clamp(confidence, 0, 1) * 100) / 100,
    parts: { news: ai.buyPct, price: price.buyPct, agree, disagree, priceNotes: price.notes },
  };
}

// ---------------------------------------------------------------------------
// 予測の記録と答え合わせ
// ---------------------------------------------------------------------------
export interface ForecastRecord {
  at: number; // 予測した時刻（ms）
  baseTime: number; // 予測の基準にした足の時刻（ms）
  pairs: Partial<Record<SignalPair, { price: number; final: number; news: number; tech: number | null }>>;
  moves?: Partial<Record<SignalPair, number>>; // 答え合わせ後: FORECAST_HORIZON_H 時間後までの値動き（%）
  expired?: boolean; // 答え合わせに必要な足が取れなかった
}

/** "YYYY-MM-DD HH:mm:ss"（JST）→ ms。 */
export const jstToMs = (s: string): number => Date.parse(`${s.replace(' ', 'T')}+09:00`);

/** 15分足の系列から、新しい予測の記録を作る（基準 = 系列の最新の足）。 */
export function makeRecord(now: number, series: RateSeries, final: PairSignal[], newsBuy: Map<SignalPair, number>): ForecastRecord | null {
  const baseTime = jstToMs(series.datetimes[series.datetimes.length - 1] ?? '');
  if (!Number.isFinite(baseTime)) return null;
  const pairs: ForecastRecord['pairs'] = {};
  for (const s of final) {
    const ser = pairSeries(series, s.pair);
    const price = ser?.[ser.length - 1];
    if (!(price != null && price > 0)) continue;
    pairs[s.pair] = { price, final: s.buyPct, news: newsBuy.get(s.pair) ?? s.buyPct, tech: s.parts?.price ?? null };
  }
  return { at: now, baseTime, pairs };
}

/** 未判定の記録を、系列に答え（基準から FORECAST_HORIZON_H 時間後の足）があれば判定する。古い記録は捨てる。 */
export function evaluateHistory(history: ForecastRecord[], series: RateSeries | null, now: number): ForecastRecord[] {
  const horizon = FORECAST_HORIZON_H * 3600_000;
  const times = series ? series.datetimes.map(jstToMs) : [];
  const first = times[0] ?? Infinity;
  const last = times[times.length - 1] ?? -Infinity;
  return history
    .filter((r) => now - r.at <= HISTORY_DAYS * 86_400_000)
    .map((r) => {
      if (r.moves || r.expired) return r;
      const target = r.baseTime + horizon;
      if (target > last) return r; // まだ答えが出ていない
      if (target < first) return { ...r, expired: true }; // 系列が先に進みすぎて答えの足が無い
      const idx = times.findIndex((t) => t >= target);
      if (idx < 0 || times[idx] - target > 45 * 60_000) return { ...r, expired: true }; // 休場などで足が無い
      const moves: ForecastRecord['moves'] = {};
      for (const [pair, p] of Object.entries(r.pairs) as [SignalPair, { price: number }][]) {
        const ser = series ? pairSeries(series, pair) : null;
        const after = ser?.[idx];
        if (after != null && after > 0) moves[pair] = Math.round(((after / p.price - 1) * 100) * 10000) / 10000;
      }
      return { ...r, moves };
    });
}

export interface HitRate {
  hit: number;
  n: number; // 方向を出した予測のうち、答えが出た件数
}
export interface ForecastAccuracy {
  horizonH: number;
  days: number;
  final: HitRate; // 表示している予測（合成後）
  news: HitRate; // ニュース（AI）だけ
  price: HitRate; // 値動きだけ
  byPair: Partial<Record<SignalPair, HitRate>>; // 合成後のペア別
  weights: BlendWeights; // 今回の合成に使った重み
}

const verdictOf = (buyPct: number) => signalVerdict({ buyPct });

/** 直近 STATS_DAYS 日の的中率（買い60%以上=上昇・40%以下=下落を出した予測だけ数える）。 */
export function accuracyStats(history: ForecastRecord[], now: number): Omit<ForecastAccuracy, 'weights'> {
  const empty = (): HitRate => ({ hit: 0, n: 0 });
  const final = empty();
  const news = empty();
  const price = empty();
  const byPair: ForecastAccuracy['byPair'] = {};
  const score = (h: HitRate, buyPct: number | null, move: number) => {
    if (buyPct == null) return;
    const v = verdictOf(buyPct);
    if (v === 'flat') return;
    h.n++;
    if ((v === 'up') === move > 0) h.hit++;
  };
  for (const r of history) {
    if (!r.moves || now - r.at > STATS_DAYS * 86_400_000) continue;
    for (const [pair, p] of Object.entries(r.pairs) as [SignalPair, NonNullable<ForecastRecord['pairs'][SignalPair]>][]) {
      const move = r.moves[pair];
      if (move == null || Math.abs(move) < MIN_MOVE_PCT) continue;
      score(final, p.final, move);
      score(news, p.news, move);
      score(price, p.tech, move);
      score((byPair[pair] ??= empty()), p.final, move);
    }
  }
  return { horizonH: FORECAST_HORIZON_H, days: STATS_DAYS, final, news, price, byPair };
}

/**
 * 合成の重み。ニュース・値動きとも十分な件数があれば、的中率が 45% をどれだけ上回るか（エッジ）の比で配分する。
 * 片方に寄りすぎないよう 0.25〜0.75 に収める。件数が足りなければ半々。
 */
export function blendWeights(acc: Pick<ForecastAccuracy, 'news' | 'price'>): BlendWeights {
  if (acc.news.n < MIN_SAMPLES_FOR_WEIGHTS || acc.price.n < MIN_SAMPLES_FOR_WEIGHTS) return { news: 0.5, adaptive: false };
  const edge = (h: HitRate) => Math.max(0.02, h.hit / h.n - 0.45);
  const en = edge(acc.news);
  const ep = edge(acc.price);
  return { news: Math.round(clamp(en / (en + ep), 0.25, 0.75) * 100) / 100, adaptive: true };
}
