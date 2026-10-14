import { describe, it, expect } from 'vitest';
import {
  aggregateCurrencies,
  buildRanking,
  pairScore,
  tfScore,
  RR_CAP,
  type PairRanking,
  type TfSignal,
} from '../ranking';

const sig = (over: Partial<TfSignal> = {}): TfSignal => ({
  tf: '1h',
  trend: 'range',
  paDir: 0,
  rrDir: 0,
  rr: null,
  rrvScore: null,
  rrvSide: null,
  ...over,
});

describe('tfScore', () => {
  it('全シグナル中立なら0', () => {
    expect(tfScore(sig())).toBe(0);
  });

  it('全シグナルが強気一致なら+1に近づく（上限1）', () => {
    const s = tfScore(sig({ trend: 'up', paDir: 1, rrDir: 1, rr: RR_CAP, rrvScore: 100, rrvSide: 'resistance' }));
    expect(s).toBeCloseTo(1, 10);
  });

  it('全シグナルが弱気一致なら-1に近づく', () => {
    const s = tfScore(sig({ trend: 'down', paDir: -1, rrDir: -1, rr: RR_CAP, rrvScore: 100, rrvSide: 'support' }));
    expect(s).toBeCloseTo(-1, 10);
  });

  it('RR値は RR_CAP で頭打ち（超えても寄与は同じ）', () => {
    const a = tfScore(sig({ rrDir: 1, rr: RR_CAP }));
    const b = tfScore(sig({ rrDir: 1, rr: RR_CAP * 5 }));
    expect(a).toBeCloseTo(b, 10);
  });

  it('ロールリバーサルは side で符号が決まる', () => {
    const res = tfScore(sig({ rrvScore: 80, rrvSide: 'resistance' }));
    const sup = tfScore(sig({ rrvScore: 80, rrvSide: 'support' }));
    expect(res).toBeGreaterThan(0);
    expect(sup).toBeLessThan(0);
    expect(res).toBeCloseTo(-sup, 10);
  });
});

describe('pairScore', () => {
  it('上位足(4h)が下位足(15m)より重く効く', () => {
    const bull15 = pairScore('USD_JPY', [sig({ tf: '15m', trend: 'up' }), sig({ tf: '4h', trend: 'down' })]);
    const bull4h = pairScore('USD_JPY', [sig({ tf: '15m', trend: 'down' }), sig({ tf: '4h', trend: 'up' })]);
    // 4h が強気の方が合計スコアは高い（15m と 4h を入れ替えただけ）。
    expect(bull4h.score).toBeGreaterThan(bull15.score);
  });

  it('tfScores を各TFぶん返す', () => {
    const p = pairScore('USD_JPY', [sig({ tf: '15m' }), sig({ tf: '4h' })]);
    expect(p.tfScores.map((t) => t.tf)).toEqual(['15m', '4h']);
  });
});

describe('aggregateCurrencies', () => {
  it('base は+、quote は−に配分される', () => {
    const pairs: PairRanking[] = [{ instrument: 'USD_JPY', score: 1, tfScores: [] }];
    const cur = aggregateCurrencies(pairs);
    const usd = cur.find((c) => c.currency === 'USD')!;
    const jpy = cur.find((c) => c.currency === 'JPY')!;
    expect(usd.score).toBe(100);
    expect(jpy.score).toBe(-100);
    expect(usd.verdict).toBe('strong_buy');
    expect(jpy.verdict).toBe('strong_sell');
  });

  it('複数ペアに登場する通貨は平均される', () => {
    const pairs: PairRanking[] = [
      { instrument: 'USD_JPY', score: 1, tfScores: [] }, // USD +1
      { instrument: 'EUR_USD', score: 1, tfScores: [] }, // USD -1 (quote)
    ];
    const usd = aggregateCurrencies(pairs).find((c) => c.currency === 'USD')!;
    expect(usd.score).toBe(0); // (+1 -1)/2 = 0
    expect(usd.pairs).toBe(2);
  });

  it('score 降順でソートされる', () => {
    const pairs: PairRanking[] = [
      { instrument: 'USD_JPY', score: 0.8, tfScores: [] },
      { instrument: 'EUR_USD', score: -0.5, tfScores: [] },
    ];
    const scores = aggregateCurrencies(pairs).map((c) => c.score);
    for (let i = 1; i < scores.length; i++) expect(scores[i - 1]).toBeGreaterThanOrEqual(scores[i]);
  });

  it('ゴールド(XAU)は XAU_USD の base として独立にランクされる', () => {
    const pairs: PairRanking[] = [{ instrument: 'XAU_USD', score: 0.6, tfScores: [] }];
    const xau = aggregateCurrencies(pairs).find((c) => c.currency === 'XAU')!;
    expect(xau.score).toBe(60);
    expect(xau.verdict).toBe('strong_buy');
  });
});

describe('buildRanking', () => {
  it('signals からペア・通貨・failed を組み立てる', () => {
    const snap = buildRanking(
      { USD_JPY: [sig({ tf: '4h', trend: 'up', rrDir: 1, rr: 3 })] },
      ['GBP_USD'],
    );
    expect(snap.pairs[0].instrument).toBe('USD_JPY');
    expect(snap.pairs[0].score).toBeGreaterThan(0);
    expect(snap.currencies.find((c) => c.currency === 'USD')!.score).toBeGreaterThan(0);
    expect(snap.failed).toEqual(['GBP_USD']);
    expect(snap.generatedAt).toBeGreaterThan(0);
  });
});
