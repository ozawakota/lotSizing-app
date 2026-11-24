import { describe, it, expect } from 'vitest';
import { contrarianCandidates, type PairFlow } from '../flow';

const flow = (pair: PairFlow['pair'], longPct: number, cot?: PairFlow['cot']): PairFlow => ({
  pair,
  longPct,
  shortPct: 100 - longPct,
  longVolume: 0,
  shortVolume: 0,
  dominant: 'neutral',
  cot,
});

describe('contrarianCandidates', () => {
  it('個人が65%以上偏ったペアだけを、その逆向きの候補にする', () => {
    const c = contrarianCandidates([flow('USD/JPY', 72), flow('EUR/JPY', 28), flow('GBP/JPY', 60)]);
    expect(c.map((x) => [x.pair, x.direction])).toEqual([
      ['USD/JPY', 'sell'],
      ['EUR/JPY', 'buy'],
    ]);
    expect(c[0].reasons[0]).toBe('個人の買い 72%');
  });

  it('大口が候補の向き=A、中立/なし=B、個人と同じ向き=C の順に並べる', () => {
    const c = contrarianCandidates([
      flow('USD/JPY', 80, { net: 0.3, lean: 'buy' }), // 個人も大口も買い → 売り候補は C
      flow('EUR/USD', 70), // 大口なし → B
      flow('GBP/JPY', 30, { net: 0.2, lean: 'buy', deltaNet: 0.05 }), // 個人売り70%・大口買い越し＋積み増し → 買い候補 A
    ]);
    expect(c.map((x) => [x.pair, x.grade])).toEqual([
      ['GBP/JPY', 'A'],
      ['EUR/USD', 'B'],
      ['USD/JPY', 'C'],
    ]);
    expect(c[0].reasons).toContain('大口が積み増し中');
    expect(c[2].reasons.some((r) => r.includes('根拠弱め'))).toBe(true);
  });

  it('同じ確からしさなら、偏りが大きい順', () => {
    const c = contrarianCandidates([flow('USD/JPY', 68), flow('AUD/JPY', 85)]);
    expect(c.map((x) => x.pair)).toEqual(['AUD/JPY', 'USD/JPY']);
  });
});
