import { describe, it, expect } from 'vitest';
import { classifyOi, estimateGoldNet, goldOiLean, goldSignal, mergeGoldOiDay, pairSpecNet, type GoldOiDay, type OiSignal } from '../flow';

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

describe('estimateGoldNet（確定ネット＋報告日より後の日次の推定）', () => {
  const gold = { reportDate: '2026-11-17T00:00:00.000', net: 200_000 };
  const d = (date: string, signal: OiSignal, oiChange: number): GoldOiDay => ({ date, oi: 500_000, oiChange, priceChange: 1, signal, final: true });
  it('新規の買い・買い戻しは足し、新規の売り・手じまいは引く（報告日当日までは確定値に含まれるので除く）', () => {
    const days = [
      d('2026-11-17', 'new_long', 9_999), // 報告日（火曜）当日 → 除く
      d('2026-11-18', 'new_long', 3_000), // +3,000
      d('2026-11-19', 'short_cover', -1_000), // 売りが減る → +1,000
      d('2026-11-20', 'long_liq', -2_000), // 買いが減る → −2,000
      d('2026-11-23', 'new_short', 500), // −500
      d('2026-11-24', 'flat', 100), // 0
    ];
    expect(estimateGoldNet(gold, days)).toEqual({ net: 201_500, delta: 1_500, through: '2026-11-24', days: 5 });
  });
  it('報告日より後の日が無ければ null', () => {
    expect(estimateGoldNet(gold, [d('2026-11-17', 'new_long', 1)])).toBeNull();
  });
});

describe('pairSpecNet（ゴールドは金先物そのもののネット）', () => {
  it('XAU/USD はドル指数を引かず、金のネットをそのまま使う', () => {
    expect(pairSpecNet({ XAU: 0.4, USD: 0.3 }, 'XAU/USD')).toBe(0.4);
    expect(pairSpecNet({ EUR: 0.2, USD: 0.3 }, 'EUR/USD')).toBeCloseTo(-0.1);
  });
});

describe('goldSignal（大口の増減＋個人の逆張りの合計）', () => {
  const net = { reportDate: '2026-11-17T00:00:00.000', long: 300_000, short: 90_000, net: 210_000, change: 8_000 };
  const d = (date: string, signal: OiSignal, oiChange: number): GoldOiDay => ({ date, oi: 500_000, oiChange, priceChange: 1, signal, final: true });
  const buyDays = { updatedAt: '', days: [d('2026-11-18', 'new_long', 5_000), d('2026-11-19', 'new_long', 4_000), d('2026-11-20', 'short_cover', -2_000)] };

  it('大口が買い増し＋個人が売りに偏っていれば強い買い（★★★）', () => {
    const s = goldSignal({ net, oi: buyDays, retail: { longPct: 28, shortPct: 72 } })!;
    expect(s).toMatchObject({ verdict: 'buy', score: 4, stars: 3 });
    expect(s.factors.map((f) => [f.key, f.dir])).toEqual([
      ['weekly', 'buy'],
      ['estimate', 'buy'],
      ['daily', 'buy'],
      ['retail', 'buy'],
    ]);
    expect(s.factors[3].label).toBe('個人 売り72%（逆張り）');
  });

  it('大口は買い増しでも、個人が買いに偏り日次が売りなら様子見', () => {
    const sellDays = { updatedAt: '', days: [d('2026-11-18', 'new_short', 5_000), d('2026-11-19', 'long_liq', -4_000), d('2026-11-20', 'new_short', 3_000)] };
    const s = goldSignal({ net, oi: sellDays, retail: { longPct: 75, shortPct: 25 } })!;
    // 前週比 +1 / 推定 −12,000 → −1 / 日次 売り寄り −1 / 個人 買い75% → −1 = −2 → 売り
    expect(s).toMatchObject({ verdict: 'sell', score: -2, stars: 1 });
  });

  it('小さな増減は材料にしない（中立）。材料が無ければ null', () => {
    const s = goldSignal({ net: { ...net, change: 300 }, retail: { longPct: 55, shortPct: 45 } })!;
    expect(s).toMatchObject({ verdict: 'neutral', score: 0, stars: 0 });
    expect(goldSignal({})).toBeNull();
  });
});
