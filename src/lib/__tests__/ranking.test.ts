import { describe, it, expect } from 'vitest';
import { RANKING_PAIRS, RANKING_TIMEFRAMES, sortCards, type RrCard } from '../ranking';

const card = (over: Partial<RrCard> = {}): RrCard => ({
  instrument: 'USD_JPY',
  tf: '1h',
  direction: 'long',
  entry: 157,
  stop: 156.8,
  target: 157.6,
  rr: 3,
  riskPips: 20,
  rewardPips: 60,
  spreadPips: 0.3,
  confidence: 60,
  confidenceSource: 'jev',
  ...over,
});

describe('RANKING 定数', () => {
  it('対象は8ペア・XAU/USD を含む', () => {
    expect(RANKING_PAIRS).toHaveLength(8);
    expect(RANKING_PAIRS).toContain('XAU_USD');
  });
  it('対象TFは 15m/30m/1h/4h', () => {
    expect(RANKING_TIMEFRAMES).toEqual(['15m', '30m', '1h', '4h']);
  });
});

describe('sortCards', () => {
  it('信用度の高い順に並ぶ', () => {
    const out = sortCards([card({ confidence: 40 }), card({ confidence: 80 }), card({ confidence: 60 })]);
    expect(out.map((c) => c.confidence)).toEqual([80, 60, 40]);
  });

  it('信用度が同率なら RR の高い順', () => {
    const out = sortCards([card({ confidence: 70, rr: 2.6 }), card({ confidence: 70, rr: 3.4 })]);
    expect(out.map((c) => c.rr)).toEqual([3.4, 2.6]);
  });

  it('信用度 null（取得不可）は最後に回る', () => {
    const out = sortCards([card({ confidence: null }), card({ confidence: 10 })]);
    expect(out[0].confidence).toBe(10);
    expect(out[1].confidence).toBeNull();
  });

  it('元配列を破壊しない', () => {
    const input = [card({ confidence: 10 }), card({ confidence: 90 })];
    sortCards(input);
    expect(input.map((c) => c.confidence)).toEqual([10, 90]);
  });
});
