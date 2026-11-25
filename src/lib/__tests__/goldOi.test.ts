import { describe, it, expect } from 'vitest';
import { classifyOi, goldOiLean, mergeGoldOiDay, type GoldOiDay, type OiSignal } from '../flow';

describe('classifyOi（建玉の増減 × 値動き）', () => {
  const oi = 500_000;
  it('建玉↑×値上がり=新規の買い、建玉↑×値下がり=新規の売り', () => {
    expect(classifyOi(3_000, 12.5, oi)).toBe('new_long');
    expect(classifyOi(3_000, -8, oi)).toBe('new_short');
  });
  it('建玉↓×値上がり=売りの買い戻し、建玉↓×値下がり=買いの手じまい', () => {
    expect(classifyOi(-2_000, 5, oi)).toBe('short_cover');
    expect(classifyOi(-2_000, -5, oi)).toBe('long_liq');
  });
  it('建玉の増減が 0.1% 未満、または値動きなしは様子見', () => {
    expect(classifyOi(400, 10, oi)).toBe('flat'); // 0.08%
    expect(classifyOi(5_000, 0, oi)).toBe('flat');
  });
});

const day = (date: string, signal: OiSignal, final = true): GoldOiDay => ({ date, oi: 500_000, oiChange: 1000, priceChange: 1, signal, final });

describe('goldOiLean（直近5日の傾き）', () => {
  it('新規の買いが続けば買い寄り、新規の売りが続けば売り寄り', () => {
    expect(goldOiLean([day('2026-11-18', 'new_long'), day('2026-11-19', 'short_cover'), day('2026-11-20', 'new_long')]).lean).toBe('buy');
    expect(goldOiLean([day('2026-11-19', 'new_short'), day('2026-11-20', 'long_liq'), day('2026-11-23', 'new_short')]).lean).toBe('sell');
  });
  it('1日の新規だけでは向きを決めない', () => {
    expect(goldOiLean([day('2026-11-20', 'new_long')])).toMatchObject({ lean: 'neutral', score: 2, days: 1 });
  });
  it('直近5日だけを見る', () => {
    const old = ['2026-11-10', '2026-11-11', '2026-11-12'].map((d) => day(d, 'new_short'));
    const recent = ['2026-11-17', '2026-11-18', '2026-11-19', '2026-11-20', '2026-11-23'].map((d) => day(d, 'flat'));
    expect(goldOiLean([...old, ...recent])).toMatchObject({ lean: 'neutral', score: 0, days: 5 });
  });
});

describe('mergeGoldOiDay', () => {
  it('新しい日を古い順に足し、同じ日は置き換える（速報→確定）。変わらなければ changed=false', () => {
    const a = mergeGoldOiDay([day('2026-11-20', 'new_long')], day('2026-11-23', 'new_short', false));
    expect(a.changed).toBe(true);
    expect(a.days.map((d) => d.date)).toEqual(['2026-11-20', '2026-11-23']);
    const b = mergeGoldOiDay(a.days, day('2026-11-23', 'new_short', true));
    expect(b.changed).toBe(true);
    expect(b.days[1].final).toBe(true);
    expect(mergeGoldOiDay(b.days, day('2026-11-23', 'new_short', true)).changed).toBe(false);
  });
  it('最大件数を超えたら古い日から落とす', () => {
    const days = ['2026-11-18', '2026-11-19', '2026-11-20'].map((d) => day(d, 'flat'));
    expect(mergeGoldOiDay(days, day('2026-11-23', 'flat'), 3).days.map((d) => d.date)).toEqual(['2026-11-19', '2026-11-20', '2026-11-23']);
  });
});
