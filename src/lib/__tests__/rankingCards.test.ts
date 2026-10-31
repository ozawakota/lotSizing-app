import { describe, it, expect } from 'vitest';
import { cardsFromMtf, type MtfLike } from '../rankingCards';
import type { RrSetup } from '../stoploss';

const rr = (o: Partial<RrSetup> = {}): RrSetup => ({
  direction: 'long', entry: 150, stop: 149.5, target: 151.5, riskPips: 50.3, rewardPips: 149.7, spreadPips: 0.3,
  rr: 3.0, qualifies: true, stopReasons: ['押し安値'], stopStrength: 60, ...o,
});

const mtf = (): MtfLike => ({
  instrument: 'USD_JPY',
  currentRate: 150,
  timeframes: [
    { tf: '15m', rr: rr(), breakout: { up: 60, down: 20, range: 20 },
      timing: { verdict: 'ok', score: 0, reasons: [], limit: null, mas: [] }, stopEntry: null },
    { tf: '30m', rr: rr({ rr: 2.2, qualifies: false }), breakout: null,
      timing: { verdict: 'avoid', score: 5, reasons: [], limit: { price: 149.8, basis: '押し目50%', distancePips: 20, rr: 4 }, mas: [] },
      stopEntry: { price: 150.3, zoneLabel: 'R1', distancePips: 30, rr: 2.1, breakPct: 60 } },
    { tf: '1h', rr: rr({ rr: 1.5, qualifies: false }), breakout: null },
    { tf: '4h', rr: null, breakout: null },
  ],
});

describe('cardsFromMtf', () => {
  it('TF分析の RR・損切り・目標をそのまま使い、RR 成立=好機・RR≥2.0=準好機・それ未満は出さない', () => {
    const cards = cardsFromMtf(mtf());
    expect(cards.map((c) => [c.tf, c.tier])).toEqual([['15m', 'prime'], ['30m', 'near']]);
    expect(cards[0]).toMatchObject({ entry: 150, stop: 149.5, target: 151.5, rr: 3, jevProb: 60, stopReasons: ['押し安値'] });
  });

  it('入りどき・指値/逆指値の目安を TF分析と同じに載せ、スコアに反映する', () => {
    const [ok, avoid] = cardsFromMtf(mtf());
    expect(ok.timing).toEqual({ verdict: 'ok', label: '入りどき', limitPrice: null, stopEntryPrice: null });
    expect(avoid.timing).toEqual({ verdict: 'avoid', label: '高値掴み注意', limitPrice: 149.8, stopEntryPrice: 150.3 });
    expect(ok.scoreItems?.map((i) => i.label)).toContain('入りどき（伸び切っていない位置）');
    expect(avoid.scoreItems?.map((i) => i.label)).toContain('高値掴み注意（伸び切った位置）');
    expect(ok.score!).toBeGreaterThan(avoid.score!);
  });
});
