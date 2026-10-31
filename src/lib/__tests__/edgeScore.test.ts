import { describe, it, expect } from 'vitest';
import { edgeScore, fitSetupToZones, type EdgeInputs } from '../edgeScore';
import type { RrSetup } from '../stoploss';
import type { SrZone } from '../srZones';
import type { DowAnalysis } from '../dow';

// USD/JPY（1pip=0.01）。ATR=0.2。
const zone = (low: number, high: number, side: 'res' | 'sup', stars: 1 | 2 | 3 = 2, cur = 150): SrZone => ({
  low,
  high,
  center: (low + high) / 2,
  side,
  contains: cur >= low && cur <= high,
  stars,
  score: stars === 3 ? 4 : 2.5,
  swingTouches: 1,
  lastTouchBarsAgo: 5,
  sources: ['スイング'],
  distancePips: Math.round((cur >= low && cur <= high ? 0 : side === 'res' ? low - cur : cur - high) * 1000) / 10,
});
const longSetup = (over: Partial<RrSetup> = {}): RrSetup => ({
  direction: 'long',
  entry: 150,
  stop: 149.8,
  target: 150.8,
  riskPips: 20.3, // 20pips + スプレッド0.3
  rewardPips: 79.7,
  spreadPips: 0.3,
  rr: 3.9,
  qualifies: true,
  ...over,
});

describe('fitSetupToZones', () => {
  it('帯が無ければそのまま（RR も同じ計算）', () => {
    const f = fitSetupToZones(longSetup(), { res: [], sup: [] }, 0.2, 'USD_JPY');
    expect(f.setup.stop).toBe(149.8);
    expect(f.setup.target).toBe(150.8);
    expect(f.setup.rr).toBe(3.9);
    expect(f.stopNote).toBeNull();
    expect(f.targetNote).toBeNull();
  });

  it('ロング: 損切りが支持帯の中なら帯の下限 − 0.1ATR へ。リスクはずらした分だけ増える', () => {
    const f = fitSetupToZones(longSetup(), { res: [], sup: [zone(149.75, 149.85, 'sup', 3)] }, 0.2, 'USD_JPY');
    expect(f.setup.stop).toBeCloseTo(149.73, 6);
    expect(f.setup.riskPips).toBeCloseTo(27.3, 6);
    expect(f.stopNote).toBe('損切りを支持帯★3の外へ');
  });

  it('ロング: 損切りが支持帯の上端のすぐ上（0.25ATR 以内）でも外へずらす', () => {
    const f = fitSetupToZones(longSetup(), { res: [], sup: [zone(149.7, 149.76, 'sup')] }, 0.2, 'USD_JPY');
    expect(f.setup.stop).toBeCloseTo(149.68, 6);
  });

  it('ロング: 目標までの途中の抵抗帯の手前（下限）に目標を縮め、RR を計算し直す', () => {
    const f = fitSetupToZones(longSetup(), { res: [zone(150.6, 150.65, 'res'), zone(150.4, 150.45, 'res')], sup: [] }, 0.2, 'USD_JPY');
    expect(f.setup.target).toBe(150.4); // 近い方の帯
    expect(f.setup.rewardPips).toBeCloseTo(39.7, 6);
    expect(f.setup.rr).toBe(2);
    expect(f.targetNote).toBe('目標を抵抗帯★2の手前に');
  });

  it('現在値を含む帯や目標より先の帯は使わない', () => {
    const f = fitSetupToZones(longSetup(), { res: [zone(149.95, 150.05, 'res'), zone(151, 151.1, 'res')], sup: [] }, 0.2, 'USD_JPY');
    expect(f.setup.target).toBe(150.8);
  });

  it('ショートは逆（損切りは抵抗帯の上へ、目標は支持帯の上限まで）', () => {
    const short = longSetup({ direction: 'short', stop: 150.2, target: 149.2, riskPips: 20.3, rewardPips: 79.7 });
    const f = fitSetupToZones(short, { res: [zone(150.15, 150.25, 'res')], sup: [zone(149.5, 149.6, 'sup')] }, 0.2, 'USD_JPY');
    expect(f.setup.stop).toBeCloseTo(150.27, 6);
    expect(f.setup.target).toBe(149.6);
    expect(f.stopNote).toBe('損切りを抵抗帯★2の外へ');
    expect(f.targetNote).toBe('目標を支持帯★2の手前に');
  });
});

const dow = (over: Partial<DowAnalysis> = {}): DowAnalysis =>
  ({
    swings: [],
    trend: 'up',
    phase: 'pullback',
    strength: 3,
    keyLevel: null,
    extremeLevel: null,
    rangeHigh: null,
    rangeLow: null,
    ...over,
  }) as DowAnalysis;
const inputs = (over: Partial<EdgeInputs> = {}): EdgeInputs => ({
  direction: 'long',
  rr: 2.5,
  stopStrength: 50,
  dow: null,
  higherDows: [],
  timing: 'wait',
  pattern: null,
  jevProb: null,
  ...over,
});

describe('edgeScore', () => {
  it('材料が中立なら 50・内訳なし（押し目待ちは加減点なし）', () => {
    expect(edgeScore(inputs())).toEqual({ score: 50, items: [] });
  });

  it('ダウ・上位足・RR・入りどき・パターン・AI がそろうと高く、内訳は点数の大きい順', () => {
    const r = edgeScore(
      inputs({
        rr: 4,
        stopStrength: 100,
        dow: dow(),
        higherDows: [
          { tf: '1h', dow: dow() },
          { tf: '4h', dow: dow({ phase: 'extending' }) },
        ],
        timing: 'ok',
        pattern: { label: '下ヒゲピンバー', dir: 1 },
        jevProb: 70,
      }),
    );
    // 6+4 (ダウ) +15 (上位足) +8 (RR) +6 (損切り) +8 (入りどき) +8 (パターン) +6 (AI) = +61
    // → 50 + 50·tanh(61/50) ≈ 92（100 に張り付かない）
    expect(r.score).toBe(92);
    expect(r.items[0]).toEqual({ label: '上位足も上昇（1時間足・4時間足）', points: 15 });
    expect(r.items.map((x) => x.label)).toContain('入りどき（伸び切っていない位置）');
  });

  it('上位足が逆向き・高値掴み注意・逆向きパターンは減点', () => {
    const r = edgeScore(
      inputs({
        higherDows: [
          { tf: '1h', dow: dow({ trend: 'down' }) },
          { tf: '4h', dow: dow({ trend: 'range' }) },
        ],
        timing: 'avoid',
        pattern: { label: '上ヒゲピンバー', dir: -1 },
      }),
    );
    expect(r.items).toEqual([
      { label: '逆向きの上ヒゲピンバー', points: -12 },
      { label: '高値掴み注意（伸び切った位置）', points: -10 },
      { label: '上位足が逆向き（1時間足）', points: -8 },
    ]);
    expect(r.score).toBe(23); // −30 → 50 + 50·tanh(−30/50)
  });

  it('準好機（RR 2.5 未満）は RR で減点', () => {
    const r = edgeScore(inputs({ rr: 2.1 }));
    expect(r.items).toEqual([{ label: 'RR 1:2.1', points: -4 }]);
    expect(r.score).toBe(46);
  });

  it('SMC のタグは加減点するが、値幅の位置（入りどきと重なる）は数えない', () => {
    const r = edgeScore(
      inputs({
        paTags: [
          { label: '安値スイープ（2本前・149.80）', tone: 'with', points: 7 },
          { label: 'OTE（61.8〜79%押し・30%）', tone: 'with', points: 6, group: 'pd' },
          { label: '値幅の中間（50%）', tone: 'info', points: 0, group: 'pd' },
        ],
      }),
    );
    expect(r.items).toEqual([{ label: 'PA: 安値スイープ（2本前・149.80）', points: 7 }]);
    expect(r.score).toBe(57);
  });

  it('ショートの安値売り注意は減点', () => {
    const r = edgeScore(inputs({ direction: 'short', timing: 'avoid' }));
    expect(r.items).toEqual([{ label: '安値売り注意（伸び切った位置）', points: -10 }]);
    expect(r.score).toBe(40);
  });
});
