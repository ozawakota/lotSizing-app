import { describe, it, expect } from 'vitest';
import { analyzeDow, dowSummary, fibLevels } from '../dow';
import { computeRsi } from '../stoploss';
import type { Candle } from '../stoploss';

// 折り返し点の価格を直線でつないだ足（各区間 step 本）。高安は終値±w。
const zigzag = (turns: number[], step = 6, w = 0.02): Candle[] => {
  const out: Candle[] = [];
  for (let s = 0; s < turns.length - 1; s++) {
    for (let i = 0; i < step; i++) {
      const p = turns[s] + ((turns[s + 1] - turns[s]) * i) / step;
      out.push({ high: p + w, low: p - w, close: p });
    }
  }
  const last = turns[turns.length - 1];
  out.push({ high: last + w, low: last - w, close: last });
  return out;
};

describe('analyzeDow', () => {
  it('高値・安値の切り上げ（HH・HL）で上昇、押し安値は最後の HL', () => {
    // 安値100 → 高値102 → 安値101 → 高値103 → 安値102 → 高値104 → 押し目中 103.5
    const d = analyzeDow(zigzag([100, 102, 101, 103, 102, 104, 103.5]), { pivotK: 2 })!;
    expect(d.trend).toBe('up');
    expect(d.keyLevel?.kind).toBe('pullback_low');
    expect(d.keyLevel?.price).toBeCloseTo(102 - 0.02, 6);
    expect(d.extremeLevel?.price).toBeCloseTo(104 + 0.02, 6);
    expect(d.phase).toBe('pullback'); // 直近のスイングは高値で、その後は下げている
    expect(d.strength).toBeGreaterThanOrEqual(3);
    expect(d.swings.at(-1)?.label).toBe('HH');
    expect(dowSummary(d)).toBe('上昇・押し目を形成中');
  });

  it('切り下げ（LH・LL）で下降、戻り高値は最後の LH。安値を割り込めば更新中', () => {
    const d = analyzeDow(zigzag([104, 102, 103, 101, 102, 100, 99]), { pivotK: 2 })!;
    expect(d.trend).toBe('down');
    expect(d.keyLevel?.kind).toBe('rally_high');
    expect(d.keyLevel?.price).toBeCloseTo(102 + 0.02, 6);
    expect(d.phase).toBe('extending');
    expect(dowSummary(d)).toBe('下降・安値を更新中');
  });

  it('上昇中に押し安値を終値で割ると broken（転換の兆し）', () => {
    const d = analyzeDow(zigzag([100, 102, 101, 103, 102, 104, 101.5]), { pivotK: 2 })!;
    expect(d.trend).toBe('up'); // 新しい安値スイングが確定するまでは構造上は上昇
    expect(d.phase).toBe('broken');
    expect(dowSummary(d)).toContain('転換の兆し');
  });

  it('高値切り上げ・安値切り下げ（拡散）や同値圏はレンジで、上限・下限を返す', () => {
    const d = analyzeDow(zigzag([101, 103, 100, 104, 99, 102]), { pivotK: 2 })!;
    expect(d.trend).toBe('range');
    expect(d.phase).toBe('none');
    expect(d.rangeHigh).not.toBeNull();
    expect(d.rangeLow).not.toBeNull();
    expect(d.keyLevel).toBeNull();
  });

  it('ATR の1割以内の差は同値（EH/EL）とみなし、トレンドにしない', () => {
    // 高値 103 と 103.001 はほぼ同値
    const d = analyzeDow(zigzag([100, 103, 101, 103.001, 101.5, 102]), { pivotK: 2 })!;
    const highs = d.swings.filter((s) => s.kind === 'high');
    expect(highs.at(-1)?.label).toBe('EH');
    expect(d.trend).toBe('range');
  });

  it('スイングが足りなければ null', () => {
    expect(analyzeDow(zigzag([100, 101]), { pivotK: 2 })).toBeNull();
    expect(analyzeDow([])).toBeNull();
  });

  it('スイングは高値・安値が交互で、barsAgo は最新足からの本数', () => {
    const c = zigzag([100, 102, 101, 103, 102, 104, 103.5]);
    const d = analyzeDow(c, { pivotK: 2 })!;
    for (let i = 1; i < d.swings.length; i++) expect(d.swings[i].kind).not.toBe(d.swings[i - 1].kind);
    const s = d.swings.at(-1)!;
    expect(s.barsAgo).toBe(c.length - 1 - s.index);
  });
});

describe('fibLevels', () => {
  it('安値→高値の値幅に対し、高値から 38.2/50/61.8% 下の押しの水準', () => {
    const d = analyzeDow(zigzag([100, 102, 101, 103, 102, 104, 103.5]), { pivotK: 2 })!;
    const [a, b] = d.swings.slice(-2); // 安値 → 高値
    const f = fibLevels(d);
    expect(f.map((x) => x.label)).toEqual(['フィボ38.2%', 'フィボ50.0%', 'フィボ61.8%']);
    expect(f[1].price).toBeCloseTo((a.price + b.price) / 2, 6);
    expect(f.every((x) => x.price < b.price && x.price > a.price)).toBe(true);
  });
});

describe('computeRsi', () => {
  const series = (closes: number[]) => closes.map((c) => ({ high: c, low: c, close: c }));
  it('上がり続ければ100、下がり続ければ0、横ばいは50、足りなければ null', () => {
    expect(computeRsi(series(Array.from({ length: 20 }, (_, i) => 100 + i)))).toBe(100);
    expect(computeRsi(series(Array.from({ length: 20 }, (_, i) => 100 - i)))).toBe(0);
    expect(computeRsi(series(Array.from({ length: 20 }, () => 100)))).toBe(50);
    expect(computeRsi(series([1, 2, 3]))).toBeNull();
  });
  it('上げ下げが半々なら 50 前後', () => {
    const closes = Array.from({ length: 40 }, (_, i) => 100 + (i % 2 === 0 ? 0 : 1));
    const r = computeRsi(series(closes))!;
    expect(r).toBeGreaterThan(40);
    expect(r).toBeLessThan(60);
  });
});
