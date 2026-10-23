import { describe, it, expect } from 'vitest';
import { buildCotSamples, buildPairNetSeries, statsOf, summarizeCot, type CotRow, type DailyClose, type PairNetPoint } from '../cotBacktest';

const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const T0 = Date.parse('2024-01-02T00:00:00Z'); // 火曜

// 平日だけの日足（close は f(日数)）。
const dailies = (days: number, f: (d: number) => number): DailyClose[] => {
  const out: DailyClose[] = [];
  for (let d = 0; d < days; d++) {
    const t = T0 + d * DAY;
    const wd = new Date(t).getUTCDay();
    if (wd === 0 || wd === 6) continue;
    out.push({ date: iso(t), close: f(d) });
  }
  return out;
};

describe('buildPairNetSeries', () => {
  it('ペア X/Y = net(X) − net(Y)。両通貨がそろった報告日だけ', () => {
    const rows: CotRow[] = [
      { date: '2024-01-02', currency: 'USD', long: 20, short: 10 }, // +1/3
      { date: '2024-01-02', currency: 'JPY', long: 40, short: 120 }, // −0.5
      { date: '2024-01-09', currency: 'USD', long: 10, short: 10 }, // JPY が無い週
    ];
    const s = buildPairNetSeries(rows, 'USD/JPY');
    expect(s).toHaveLength(1);
    expect(s[0].net).toBeCloseTo(1 / 3 + 0.5, 6);
    expect(buildPairNetSeries(rows, 'EUR/JPY')).toEqual([]);
  });
});

describe('buildCotSamples', () => {
  it('公表日（報告日＋3日＝金曜）の終値でエントリーし、h 週後の騰落率を出す', () => {
    const closes = dailies(60, (d) => 100 + d); // 1日1ずつ上昇
    const series: PairNetPoint[] = [{ date: '2024-01-02', net: 0.5 }];
    const [s] = buildCotSamples(series, closes, { horizonsWeeks: [1, 4] });
    expect(s.entryDate).toBe('2024-01-05'); // 金曜
    expect(s.fwd[1]).toBeCloseTo((110 / 103 - 1) * 100, 6); // 1週後の金曜（d=10）
    expect(s.fwd[4]).toBeCloseTo((131 / 103 - 1) * 100, 6);
    expect(s.lean).toBe('buy');
    expect(s.strength).toBe('mid');
    expect(s.deltaNet).toBeNull();
    expect(s.cotIndex).toBeNull(); // 履歴不足
  });

  it('先のデータが無ければ null、前週比と COT インデックスを付ける', () => {
    const closes = dailies(30, () => 100);
    const series: PairNetPoint[] = [
      { date: '2024-01-02', net: 0.1 },
      { date: '2024-01-09', net: -0.3 },
      { date: '2024-01-16', net: 0.5 },
    ];
    const s = buildCotSamples(series, closes, { horizonsWeeks: [1, 12], indexWeeks: 3 });
    expect(s[0].fwd[12]).toBeNull();
    expect(s[1].deltaNet).toBeCloseTo(-0.4, 6);
    expect(s[2].cotIndex).toBe(100); // 3週の中で最も買い越し
    expect(s[1].cotIndex).toBeNull();
  });
});

describe('statsOf / summarizeCot', () => {
  it('平均・勝率・重なり補正した t 値', () => {
    const st = statsOf('x', 4, [1, 2, 3, -1]);
    expect(st.meanPct).toBe(1.25);
    expect(st.hitRate).toBe(75);
    // sd = sqrt(((−.25)²+.75²+1.75²+(−2.25)²)/3) ≈ 1.708、実効 n = 4/4 = 1 → t = 1.25/1.708
    expect(st.t).toBeCloseTo(0.73, 2);
    expect(statsOf('empty', 1, []).n).toBe(0);
  });

  it('大口の向きに動く相場では「乗る」がプラス、逆なら全体はマイナス', () => {
    // 週ごとに向きが入れ替わり、その週の向きに価格が動く相場。
    const weeks = 40;
    const series: PairNetPoint[] = Array.from({ length: weeks }, (_, w) => ({ date: iso(T0 + w * 7 * DAY), net: w % 2 === 0 ? 0.8 : -0.8 }));
    // 金曜（d=3+7w）から次の金曜まで、その週の向きに1%ずつ動く。
    const closes = dailies(weeks * 7 + 20, (d) => {
      let p = 100;
      for (let w = 0; w * 7 + 3 < d && w < weeks; w++) p *= series[w].net > 0 ? 1.01 : 0.99;
      return p;
    });
    const rows = summarizeCot(buildCotSamples(series, closes, { horizonsWeeks: [1], indexWeeks: 4 }), [1]);
    const all = rows.find((r) => r.group === '大口に乗る（全体）')!;
    expect(all.meanPct).toBeGreaterThan(0.5);
    expect(all.hitRate).toBeGreaterThan(80);
    expect(rows.find((r) => r.group === '  強')!.n).toBe(all.n); // 0.8 はすべて「強」

    // 逆に、大口と反対へ動く相場。
    const contrarian = dailies(weeks * 7 + 20, (d) => {
      let p = 100;
      for (let w = 0; w * 7 + 3 < d && w < weeks; w++) p *= series[w].net > 0 ? 0.99 : 1.01;
      return p;
    });
    const rows2 = summarizeCot(buildCotSamples(series, contrarian, { horizonsWeeks: [1], indexWeeks: 4 }), [1]);
    expect(rows2.find((r) => r.group === '大口に乗る（全体）')!.meanPct).toBeLessThan(-0.5);
  });

  it('ずっと買い越しの上昇相場では「乗る」は買い持ちと同じで、トレンド分を除くとほぼ0', () => {
    const weeks = 30;
    const series: PairNetPoint[] = Array.from({ length: weeks }, (_, w) => ({ date: iso(T0 + w * 7 * DAY), net: 0.5 + (w % 3) * 0.01 }));
    const closes = dailies(weeks * 7 + 20, (d) => 100 * 1.002 ** d); // 一定の上昇
    const rows = summarizeCot(buildCotSamples(series, closes, { horizonsWeeks: [1] }), [1]);
    const follow = rows.find((r) => r.group === '大口に乗る（全体）')!;
    const hold = rows.find((r) => r.group === '参考: 全週（買い持ち）')!;
    expect(follow.meanPct).toBeCloseTo(hold.meanPct, 6);
    expect(follow.meanPct).toBeGreaterThan(1);
    expect(Math.abs(rows.find((r) => r.group === '大口に乗る（トレンド分を除く）')!.meanPct)).toBeLessThan(0.01);
  });
});
