import { describe, it, expect } from 'vitest';
import { PROVERBS, dailyProverb, dailyProverbIndex, jstDayNumber } from '../proverbs';

const jst = (s: string) => new Date(`${s}+09:00`);

describe('jstDayNumber', () => {
  it('JST の 0 時で日付が切り替わる', () => {
    expect(jstDayNumber(jst('2026-10-25T23:59:59'))).toBe(jstDayNumber(jst('2026-10-25T00:00:00')));
    expect(jstDayNumber(jst('2026-10-26T00:00:00'))).toBe(jstDayNumber(jst('2026-10-25T00:00:00')) + 1);
    // UTC では前日の 15:00〜でも、JST の同じ日として扱う
    expect(jstDayNumber(new Date('2026-10-25T15:00:00Z'))).toBe(jstDayNumber(jst('2026-10-26T08:00:00')));
  });
});

describe('dailyProverb', () => {
  it('同じ日は何度呼んでも同じ格言', () => {
    expect(dailyProverb(jst('2026-10-25T07:00:00'))).toBe(dailyProverb(jst('2026-10-25T22:30:00')));
  });

  it('一覧を一巡するまで同じ格言は出ず、連続した日でも番号が飛び飛びになる', () => {
    const n = PROVERBS.length;
    const start = jst('2026-01-01T12:00:00').getTime();
    const seen = new Set<number>();
    let adjacent = 0;
    let prev = -1;
    for (let d = 0; d < n; d++) {
      const i = dailyProverbIndex(new Date(start + d * 86_400_000));
      seen.add(i);
      if (prev >= 0 && Math.abs(i - prev) === 1) adjacent++;
      prev = i;
    }
    expect(seen.size).toBe(n);
    expect(adjacent).toBe(0); // 前日の隣の格言にはならない
  });

  it('件数が少なくても範囲内に収まる', () => {
    for (const n of [1, 2, 3, 7, 10]) {
      for (let d = 0; d < 30; d++) {
        const i = dailyProverbIndex(new Date(Date.UTC(2026, 0, 1 + d)), n);
        expect(i).toBeGreaterThanOrEqual(0);
        expect(i).toBeLessThan(n);
      }
    }
  });

  it('格言はすべて本文・意味・出典がそろっている', () => {
    expect(PROVERBS.length).toBeGreaterThanOrEqual(30);
    for (const p of PROVERBS) {
      expect(p.text.length).toBeGreaterThan(0);
      expect(p.meaning.length).toBeGreaterThan(0);
      expect(p.source.length).toBeGreaterThan(0);
    }
    expect(new Set(PROVERBS.map((p) => p.text)).size).toBe(PROVERBS.length); // 重複なし
  });
});
