import { describe, it, expect } from 'vitest';
import { forecastSessions, sessionStats, type HourBar, type SessionStat } from '../sessionForecast';

// 2026-11-02(月)〜11-13(金) の平日の1時間足。ロンドン時間（UTC 8〜16時）は値幅を大きく、出来高も多くする。
const bars: HourBar[] = [];
let p = 150;
for (let d = 0; d < 12; d++) {
  for (let h = 0; h < 24; h++) {
    const t = Date.UTC(2026, 10, 2 + d, h) / 1000;
    const wd = new Date(t * 1000).getUTCDay();
    if (wd === 0 || wd === 6) continue;
    const london = h >= 8 && h < 16;
    const step = london ? 0.06 : 0.01;
    const o = p;
    p += h % 2 ? step : -step * 0.5;
    bars.push({ t, open: o, high: Math.max(o, p) + step, low: Math.min(o, p) - step, close: p, volume: london ? 300 : 100 });
  }
}

describe('sessionStats', () => {
  it('東京・ロンドン・NY ごとに平均値幅・上げの割合・出来高の割合を出す', () => {
    const st = sessionStats(bars, 0.01);
    expect(st.map((s) => s.key)).toEqual(['tokyo', 'london', 'ny']);
    const tokyo = st.find((s) => s.key === 'tokyo')!;
    const london = st.find((s) => s.key === 'london')!;
    expect(london.avgRangePips).toBeGreaterThan(tokyo.avgRangePips);
    expect(london.volumeShare!).toBeGreaterThan(tokyo.volumeShare!);
    expect(st.reduce((s, x) => s + (x.volumeShare ?? 0), 0)).toBeGreaterThanOrEqual(99);
    expect(tokyo.samples).toBeGreaterThan(5);
  });

  it('出来高が無ければ volumeShare は null', () => {
    const st = sessionStats(bars.map((b) => ({ ...b, volume: undefined })), 0.01);
    expect(st.every((s) => s.volumeShare === null)).toBe(true);
  });
});

describe('forecastSessions', () => {
  const stat = (key: 'tokyo' | 'london' | 'ny', range: number, breakPrevPct: number): SessionStat => ({
    key, label: key, samples: 20, avgRangePips: range, upPct: 50, breakPrevPct, volumeShare: null,
  });
  const stats = [stat('tokyo', 50, 40), stat('london', 80, 70), stat('ny', 70, 65)];
  const levels = [
    { kind: 'vah' as const, price: 150.3 },
    { kind: 'hvn' as const, price: 150.6 },
    { kind: 'val' as const, price: 149.7 },
  ];
  const now = new Date(Date.UTC(2026, 10, 16, 3)); // 月曜 12:00 JST（東京が開催中）

  it('開催中のセッションから順に並べ、次のセッションに「next」を付ける', () => {
    const f = forecastSessions({ price: 150.0, pip: 0.01, digits: 3, stats, levels, bias: 'up', now });
    expect(f[0]).toMatchObject({ key: 'tokyo', status: 'open' });
    expect(f[1]).toMatchObject({ key: 'london', status: 'next' });
  });

  it('上向き＋抜けやすいセッションは、範囲内の抵抗線を上抜けて次の抵抗線へ', () => {
    const f = forecastSessions({ price: 150.0, pip: 0.01, digits: 3, stats, levels, bias: 'up', now });
    const london = f.find((x) => x.key === 'london')!;
    expect(london.scenario).toBe('break_up');
    expect(london.headline).toContain('150.300');
    expect(london.target?.price).toBe(150.6);
    const tokyo = f.find((x) => x.key === 'tokyo')!;
    expect(tokyo.scenario).toBe('stall_up'); // 東京は抜けにくい（40%）→ 試して止まる
  });

  it('流れが無く上下に抵抗線があれば往復', () => {
    const f = forecastSessions({ price: 150.0, pip: 0.01, digits: 3, stats, levels, bias: 'range', now });
    expect(f.find((x) => x.key === 'london')!.scenario).toBe('range');
  });
});
