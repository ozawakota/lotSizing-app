import { describe, it, expect } from 'vitest';
import { sma, ema, computeMaSet, classifyEntry, smaSeries, emaSeries, computeMaLines } from '../entrySignal';

describe('sma / ema', () => {
  it('sma は直近 period 本の平均（本数不足は null）', () => {
    expect(sma([1, 2, 3, 4], 2)).toBe(3.5);
    expect(sma([1, 2], 3)).toBeNull();
  });
  it('ema は定数列ならその定数、本数不足は null', () => {
    expect(ema(Array(30).fill(5), 10)).toBeCloseTo(5, 10);
    expect(ema([1, 2, 3], 10)).toBeNull();
  });
  it('computeMaSet は本数不足の長期MAを null にする', () => {
    const s = computeMaSet(Array.from({ length: 30 }, (_, i) => 100 + i));
    expect(s.sma21).not.toBeNull();
    expect(s.ema75).toBeNull(); // 30本では EMA75/200 は算出不可
    expect(s.ema200).toBeNull();
  });
});

// 100..124 の上昇25本（SMA21 ≈ 114、EMA75/200 は null）。
const upCloses = Array.from({ length: 25 }, (_, i) => 100 + i);
// 124..100 の下降25本（SMA21 ≈ 110）。
const downCloses = Array.from({ length: 25 }, (_, i) => 124 - i);

describe('classifyEntry', () => {
  it('買い: SMA21へ押し＋ストキャス上向き → 押し目', () => {
    const r = classifyEntry({ closes: upCloses, price: 113, direction: 'long', stoch: { k: 30, d: 25 }, patternDir: 0 });
    expect(r.kind).toBe('pullback');
    expect(r.label).toBe('押し目');
  });

  it('売り: SMA21へ戻し＋ストキャス下向き → 戻り', () => {
    const r = classifyEntry({ closes: downCloses, price: 111, direction: 'short', stoch: { k: 70, d: 75 }, patternDir: 0 });
    expect(r.kind).toBe('pullback');
    expect(r.label).toBe('戻り');
  });

  it('買い: ストキャス行き過ぎ(≥85)＋SMA21から上方乖離 → 反転警戒', () => {
    const r = classifyEntry({ closes: upCloses, price: 130, direction: 'long', stoch: { k: 90, d: 85 }, patternDir: 0 });
    expect(r.kind).toBe('caution');
  });

  it('買い: 押していない（SMA21より上）＋中立ストキャス → 様子見', () => {
    const r = classifyEntry({ closes: upCloses, price: 120, direction: 'long', stoch: { k: 50, d: 50 }, patternDir: 0 });
    expect(r.kind).toBe('tentative');
  });

  it('買い: 逆向きの有効パターンが高値圏で出ている → 反転警戒', () => {
    const r = classifyEntry({ closes: upCloses, price: 118, direction: 'long', stoch: { k: 75, d: 70 }, patternDir: -1 });
    expect(r.kind).toBe('caution');
  });
});

describe('移動平均の線（smaSeries / emaSeries / computeMaLines）', () => {
  const closes = Array.from({ length: 240 }, (_, i) => 150 + Math.sin(i / 7) + i * 0.01);

  it('各位置の値が sma() / ema() をその位置までの終値で求めた値と一致する', () => {
    const s = smaSeries(closes, 21);
    const e = emaSeries(closes, 75);
    expect(s[19]).toBeNull();
    expect(e[73]).toBeNull();
    for (const i of [20, 100, 239]) expect(s[i]).toBeCloseTo(sma(closes.slice(0, i + 1), 21)!, 10);
    for (const i of [74, 150, 239]) expect(e[i]).toBeCloseTo(ema(closes.slice(0, i + 1), 75)!, 10);
  });

  it('末尾 n 本に切り出し、最後の値は computeMaSet と同じ', () => {
    const l = computeMaLines(closes, 36);
    const m = computeMaSet(closes);
    expect(l.sma21).toHaveLength(36);
    expect(l.ema200).toHaveLength(36);
    expect(l.sma21.at(-1)).toBeCloseTo(m.sma21!, 10);
    expect(l.ema75.at(-1)).toBeCloseTo(m.ema75!, 10);
    expect(l.ema200.at(-1)).toBeCloseTo(m.ema200!, 10);
  });

  it('本数が足りなければ null で埋める', () => {
    const l = computeMaLines(closes.slice(0, 36), 36);
    expect(l.ema75.every((v) => v == null)).toBe(true);
    expect(l.sma21.filter((v) => v != null)).toHaveLength(16);
  });
});
