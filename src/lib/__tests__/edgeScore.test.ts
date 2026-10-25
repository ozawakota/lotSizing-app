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
  zones: { res: [], sup: [] },
  atr: 0.2,
  instrument: 'USD_JPY',
  pattern: null,
  entryKind: 'tentative',
  rsi: 50,
  stochK: 50,
  jevProb: null,
  ...over,
});

describe('edgeScore', () => {
  it('材料が中立なら 50・内訳なし', () => {
    expect(edgeScore(inputs())).toEqual({ score: 50, items: [] });
  });

  it('ダウ・上位足・帯・パターン・押し目・AI がそろうと高く、内訳は点数の大きい順', () => {
    const r = edgeScore(
      inputs({
        rr: 4,
        stopStrength: 100,
        dow: dow(),
        higherDows: [
          { tf: '1h', dow: dow() },
          { tf: '4h', dow: dow({ phase: 'extending' }) },
        ],
        zones: { res: [], sup: [zone(149.9, 149.95, 'sup', 3)] },
        pattern: { label: '下ヒゲピンバー', dir: 1 },
        entryKind: 'pullback',
        jevProb: 70,
      }),
    );
    // 6+4 (ダウ) +15 (上位足) +8 (RR) +6 (損切り) +6 (支持帯) +8 (パターン) +6 (押し目) +6 (AI) = +65 → 100 で頭打ち
    expect(r.score).toBe(100);
    expect(r.items[0]).toEqual({ label: '上位足も上昇（1時間足・4時間足）', points: 15 });
    expect(r.items.map((x) => x.label)).toContain('支持帯★3の上で入れる');
  });

  it('上位足が逆向き・すぐ上に抵抗帯・逆向きパターン・反転警戒は減点', () => {
    const r = edgeScore(
      inputs({
        higherDows: [
          { tf: '1h', dow: dow({ trend: 'down' }) },
          { tf: '4h', dow: dow({ trend: 'range' }) },
        ],
        zones: { res: [zone(150.05, 150.1, 'res')], sup: [] },
        pattern: { label: '上ヒゲピンバー', dir: -1 },
        entryKind: 'caution',
        rsi: 75, // 反転警戒があるので、買われすぎの減点は重ねない
      }),
    );
    expect(r.items).toEqual([
      { label: '逆向きの上ヒゲピンバー', points: -12 },
      { label: 'タイミング: 反転警戒', points: -10 },
      { label: '上位足が逆向き（1時間足）', points: -8 },
      { label: 'すぐ上に抵抗帯★2', points: -6 },
    ]);
    expect(r.score).toBe(14);
  });

  it('準好機（RR 2.5 未満）は RR で減点、買われすぎも減点', () => {
    const r = edgeScore(inputs({ rr: 2.1, rsi: 72 }));
    expect(r.items).toEqual([
      { label: 'RSI/ストキャスが買われすぎ', points: -6 },
      { label: 'RR 1:2.1', points: -4 },
    ]);
    expect(r.score).toBe(40);
  });

  it('ショートは売られすぎで減点・抵抗帯の下で入れると加点', () => {
    const r = edgeScore(inputs({ direction: 'short', stochK: 10, rsi: 45, zones: { res: [zone(150.02, 150.08, 'res')], sup: [] } }));
    expect(r.items.map((x) => x.label)).toEqual(['抵抗帯★2の下で入れる', 'RSI/ストキャスが売られすぎ']);
    expect(r.score).toBe(50);
  });
});
