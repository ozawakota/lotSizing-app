import { describe, it, expect } from 'vitest';
import { buildSrZones, starsFor } from '../srZones';
import type { Candle } from '../stoploss';

// 折り返し点を直線でつないだ足（高安は終値±w）。
const zigzag = (turns: number[], step = 5, w = 0.02): Candle[] => {
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

describe('starsFor', () => {
  it('4以上=★3、2.5以上=★2、それ未満=★1', () => {
    expect(starsFor(4)).toBe(3);
    expect(starsFor(2.5)).toBe(2);
    expect(starsFor(1)).toBe(1);
  });
});

describe('buildSrZones', () => {
  // 150.6 付近で3回止められ、150.0 付近で3回支えられたレンジ。現在値 150.3。
  const candles = zigzag([150.0, 150.6, 150.0, 150.6, 150.02, 150.58, 150.3]);
  const z = buildSrZones(candles, 150.3, { instrument: 'USD_JPY', tolAtr: 0.5, maxAtr: 20 });

  it('何度も止められた価格が上の帯（レジ）・下の帯（サポ）になり、近い順に並ぶ', () => {
    expect(z.res.length).toBeGreaterThan(0);
    expect(z.sup.length).toBeGreaterThan(0);
    const r = z.res[0];
    const s = z.sup[0];
    expect(r.low).toBeLessThan(150.7);
    expect(r.high).toBeGreaterThan(150.5);
    expect(r.swingTouches).toBeGreaterThanOrEqual(3);
    expect(s.center).toBeGreaterThan(149.9);
    expect(s.center).toBeLessThan(150.1);
    expect(s.distancePips).toBeGreaterThan(0);
    for (const list of [z.res, z.sup]) {
      for (let i = 1; i < list.length; i++) expect(list[i].distancePips).toBeGreaterThanOrEqual(list[i - 1].distancePips);
    }
  });

  it('スイング3回＋キリ番＋外部のラインが重なる帯は★3、根拠のラベルも付く', () => {
    // ATR≒0.113。1 ATR なら 150.50 のキリ番・150.58 の上位足・150.60〜150.62 のスイングが1つの帯になる。
    const withExtra = buildSrZones(candles, 150.3, {
      instrument: 'USD_JPY',
      tolAtr: 1.0,
      maxAtr: 20,
      extra: [{ price: 150.58, kind: 'higher_tf', label: '4時間足の高値' }],
    });
    const r = withExtra.res[0];
    expect(r.stars).toBe(3);
    expect(r.sources).toContain('4時間足の高値');
    expect(r.sources.some((l) => l.startsWith('スイング×'))).toBe(true);
    expect(r.sources).toContain('キリ番'); // 150.50 が帯に入る
  });

  it('キリ番だけの帯は出さない', () => {
    const all = [...z.res, ...z.sup];
    expect(all.every((zz) => !(zz.sources.length === 1 && zz.sources[0] === 'キリ番'))).toBe(true);
  });

  it('現在値が帯の中なら contains・距離0', () => {
    const inside = buildSrZones(candles, 150.61, { instrument: 'USD_JPY', tolAtr: 0.5, maxAtr: 20 });
    const all = [...inside.res, ...inside.sup];
    const hit = all.find((zz) => zz.contains);
    expect(hit).toBeDefined();
    expect(hit!.distancePips).toBe(0);
  });

  it('足が足りなければ空', () => {
    expect(buildSrZones([], 150, { instrument: 'USD_JPY' })).toEqual({ res: [], sup: [], atr: 0 });
  });
});

describe('buildSrZones の絞り込み', () => {
  it('根拠が1つだけの帯は、同じ側に根拠が2つ以上の帯があれば出さない', () => {
    // 150.6 付近で3回止められた強い帯の手前（150.45）に、1回だけのスイングがある
    const c = zigzag([150.0, 150.6, 150.1, 150.6, 150.2, 150.45, 150.25, 150.6, 150.3]);
    const z = buildSrZones(c, 150.3, { instrument: 'USD_JPY', tolAtr: 0.3, maxAtr: 20 });
    expect(z.res.every((r) => r.score >= 2)).toBe(true);
  });

  it('その側に弱い帯しか無ければ、最も近い1つだけ残す', () => {
    const c = zigzag([150.0, 150.4, 150.1, 150.3]); // 上側のスイングは 150.4 の1回だけ
    const z = buildSrZones(c, 150.3, { instrument: 'USD_JPY', tolAtr: 0.2, maxAtr: 20 });
    expect(z.res.length).toBe(1);
  });
});
