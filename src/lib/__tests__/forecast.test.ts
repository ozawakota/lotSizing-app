import { describe, it, expect } from 'vitest';
import {
  FORECAST_HORIZON_H,
  accuracyStats,
  blendSignal,
  blendWeights,
  evaluateHistory,
  makeRecord,
  priceSignal,
  type ForecastRecord,
} from '../forecast';
import type { PairSignal } from '../signal';
import type { RateSeries } from '../strength';

// 15分足の終値（ゆらぎつき）。drift は1本あたりの変化率。
function closes(n: number, drift: number, start = 150): number[] {
  const out: number[] = [];
  let p = start;
  for (let i = 0; i < n; i++) {
    p *= 1 + drift + 0.0004 * Math.sin(i * 1.7);
    out.push(p);
  }
  return out;
}

const ai = (buyPct: number, confidence = 0.6): PairSignal => ({
  pair: 'USD/JPY', buyPct, confidence, trend: 'neutral', trendPct: 50, rationale: '',
});

// JST の "YYYY-MM-DD HH:mm:ss" を 15 分刻みで n 本。
function datetimes(n: number, startMs: number): string[] {
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(startMs + i * 15 * 60_000 + 9 * 3600_000);
    return d.toISOString().slice(0, 19).replace('T', ' ');
  });
}
function series(usd: number[], startMs: number): RateSeries {
  const n = usd.length;
  const flat = Array(n).fill(100);
  return {
    interval: '15min',
    datetimes: datetimes(n, startMs),
    rates: { USD: usd, EUR: flat, GBP: flat, AUD: flat, NZD: flat, CAD: flat, CHF: flat } as unknown as RateSeries['rates'],
  };
}

describe('priceSignal', () => {
  it('上昇が続けば買い寄り、下落が続けば売り寄り', () => {
    expect(priceSignal(closes(130, 0.0003))!.buyPct).toBeGreaterThan(60);
    expect(priceSignal(closes(130, -0.0003))!.buyPct).toBeLessThan(40);
  });
  it('材料ごとの向きと重みを返す（理由の表示用）', () => {
    const f = priceSignal(closes(130, 0.0003))!.factors;
    expect(f.map((x) => x.label)).toEqual(['2時間の値動き', '8時間の値動き', '24時間の値動き', '移動平均（EMA20/60）', 'RSI(14)']);
    expect(f.find((x) => x.label === '24時間の値動き')).toMatchObject({ lean: 1, weight: 30 });
    expect(f.find((x) => x.label === '移動平均（EMA20/60）')?.detail).toBe('EMA20 が EMA60 の上');
    expect(f.reduce((a, x) => a + x.weight, 0)).toBe(100);
  });
  it('本数が足りなければ null', () => {
    expect(priceSignal(closes(20, 0.001))).toBeNull();
    expect(priceSignal(null)).toBeNull();
  });
});

describe('blendSignal', () => {
  const half = { news: 0.5, adaptive: false };
  it('同じ向きなら合成して確信度を上げる', () => {
    const r = blendSignal(ai(70), { buyPct: 66, confidence: 0.6, notes: [], factors: [] }, half);
    expect(r.buyPct).toBe(68);
    expect(r.confidence).toBeCloseTo(0.75, 5);
    expect(r.parts).toMatchObject({ news: 70, price: 66, agree: true, disagree: false, weightNews: 0.5, newsConfidence: 0.6, priceConfidence: 0.6 });
  });
  it('向きが食い違えば 50% に寄せ、確信度を 0.35 以下に', () => {
    const r = blendSignal(ai(80, 0.9), { buyPct: 30, confidence: 0.8, notes: [], factors: [] }, half);
    expect(r.buyPct).toBe(53); // 50 + (15 - 10) * 0.6
    expect(r.confidence).toBeLessThanOrEqual(0.35);
    expect(r.parts?.disagree).toBe(true);
  });
  it('値動きが無ければ AI のまま', () => {
    const r = blendSignal(ai(72), null, half);
    expect(r.buyPct).toBe(72);
    expect(r.parts).toEqual({ news: 72, price: null, newsConfidence: 0.6 });
  });
});

describe('予測の記録と答え合わせ', () => {
  const start = Date.UTC(2026, 9, 26, 0, 0);
  const up = closes(130, 0.0003);

  it(`基準から${FORECAST_HORIZON_H}時間後の足で値動きを判定し、的中率を数える`, () => {
    // 予測時点 = 先頭から 40 本目までの系列
    const early = series(up.slice(0, 40), start);
    const blended = [{ ...ai(70), parts: { news: 65, price: 75 } }];
    const rec = makeRecord(start + 40 * 15 * 60_000, early, blended, new Map([['USD/JPY', 65]]))!;
    expect(rec.pairs['USD/JPY']).toMatchObject({ final: 70, news: 65, tech: 75 });

    // まだ答えが出ていない（系列が 8 時間先まで無い）
    expect(evaluateHistory([rec], early, rec.at)[0].moves).toBeUndefined();

    // 系列が進んだら判定（上昇なので「上昇予想」は当たり）
    const full = series(up, start);
    const [done] = evaluateHistory([rec], full, rec.at + 9 * 3600_000);
    expect(done.moves?.['USD/JPY']).toBeGreaterThan(0);
    const acc = accuracyStats([done], rec.at + 9 * 3600_000);
    expect(acc.final).toEqual({ hit: 1, n: 1 });
    expect(acc.news).toEqual({ hit: 1, n: 1 });
    expect(acc.byPair['USD/JPY']).toEqual({ hit: 1, n: 1 });
  });

  it('方向を出していない予測（40〜60%）と小さすぎる値動きは数えない', () => {
    const r: ForecastRecord = {
      at: 0,
      baseTime: 0,
      pairs: { 'USD/JPY': { price: 150, final: 55, news: 70, tech: 30 }, 'EUR/JPY': { price: 160, final: 70, news: 70, tech: 70 } },
      moves: { 'USD/JPY': 0.3, 'EUR/JPY': 0.01 },
    };
    const acc = accuracyStats([r], 1000);
    expect(acc.final.n).toBe(0);
    expect(acc.news).toEqual({ hit: 1, n: 1 });
    expect(acc.price).toEqual({ hit: 0, n: 1 });
  });

  it('古すぎる記録は捨て、答えの足が無い記録は expired にする', () => {
    const full = series(up, start);
    const old: ForecastRecord = { at: start - 20 * 86_400_000, baseTime: start - 20 * 86_400_000, pairs: {} };
    const gone: ForecastRecord = { at: start - 86_400_000, baseTime: start - 86_400_000, pairs: { 'USD/JPY': { price: 150, final: 70, news: 70, tech: 70 } } };
    const out = evaluateHistory([old, gone], full, start + 30 * 3600_000);
    expect(out).toHaveLength(1);
    expect(out[0].expired).toBe(true);
  });
});

describe('blendWeights', () => {
  it('件数が足りなければ半々', () => {
    expect(blendWeights({ news: { hit: 5, n: 8 }, price: { hit: 7, n: 8 } })).toEqual({ news: 0.5, adaptive: false });
  });
  it('当たっている方の重みを上げる（0.25〜0.75）', () => {
    const w = blendWeights({ news: { hit: 10, n: 20 }, price: { hit: 14, n: 20 } });
    expect(w.adaptive).toBe(true);
    expect(w.news).toBeLessThan(0.5);
    expect(w.news).toBeGreaterThanOrEqual(0.25);
  });
});
