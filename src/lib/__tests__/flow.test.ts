import { describe, it, expect } from 'vitest';
import {
  applyPairOrder,
  computeDelta,
  dominantByVolume,
  flowDirection,
  toPairFlow,
  updatePeak,
  type FlowPair,
  type VolumePeak,
} from '../flow';

describe('dominantByVolume', () => {
  it('買い量が多ければ buy、売り量が多ければ sell、同量は neutral', () => {
    expect(dominantByVolume(100, 40)).toBe('buy');
    expect(dominantByVolume(40, 100)).toBe('sell');
    expect(dominantByVolume(50, 50)).toBe('neutral');
  });
});

describe('applyPairOrder', () => {
  const all: FlowPair[] = ['USD/JPY', 'EUR/JPY', 'GBP/JPY'];

  it('保存が空なら既定順そのまま', () => {
    expect(applyPairOrder([], all)).toEqual(['USD/JPY', 'EUR/JPY', 'GBP/JPY']);
  });

  it('保存順を適用する', () => {
    expect(applyPairOrder(['GBP/JPY', 'USD/JPY', 'EUR/JPY'], all)).toEqual(['GBP/JPY', 'USD/JPY', 'EUR/JPY']);
  });

  it('保存順に無い新規ペアは末尾に既定順で追加', () => {
    expect(applyPairOrder(['GBP/JPY'], all)).toEqual(['GBP/JPY', 'USD/JPY', 'EUR/JPY']);
  });

  it('対象外ペアは除外し、重複は無視する', () => {
    expect(applyPairOrder(['EUR/JPY', 'XXX', 'EUR/JPY', 'USD/JPY'], all)).toEqual(['EUR/JPY', 'USD/JPY', 'GBP/JPY']);
  });
});

describe('updatePeak', () => {
  const prev: VolumePeak = { volume: 1000, datetime: '2026-10-01T00:00:00.000Z', rate: 150 };

  it('前回が無ければ今回で作る', () => {
    expect(updatePeak(undefined, 500, '2026-10-02T00:00:00.000Z', 151)).toEqual({
      volume: 500,
      datetime: '2026-10-02T00:00:00.000Z',
      rate: 151,
    });
  });

  it('今回が大きければ更新する', () => {
    expect(updatePeak(prev, 1500, '2026-10-02T00:00:00.000Z', 152)).toEqual({
      volume: 1500,
      datetime: '2026-10-02T00:00:00.000Z',
      rate: 152,
    });
  });

  it('今回が同じor小さければ前回を維持する', () => {
    expect(updatePeak(prev, 1000, '2026-10-02T00:00:00.000Z', 152)).toBe(prev);
    expect(updatePeak(prev, 800, '2026-10-02T00:00:00.000Z', 152)).toBe(prev);
  });

  it('レート取得失敗(null)でも記録できる', () => {
    expect(updatePeak(undefined, 500, '2026-10-02T00:00:00.000Z', null).rate).toBeNull();
  });
});

describe('flowDirection', () => {
  it('正=積み増し(entry)、負=巻き戻し(settlement)、0=変化なし(flat)', () => {
    expect(flowDirection(120)).toBe('entry');
    expect(flowDirection(-80)).toBe('settlement');
    expect(flowDirection(0)).toBe('flat');
  });
});

describe('computeDelta', () => {
  it('前回が無ければ undefined（初回は比較できない）', () => {
    expect(computeDelta(undefined, 2000)).toBeUndefined();
  });

  it('増加は entry、符号付きの差分を返す', () => {
    expect(computeDelta(1800, 2000)).toEqual({ value: 200, direction: 'entry' });
  });

  it('減少は settlement、符号付きの差分を返す', () => {
    expect(computeDelta(2000, 1750)).toEqual({ value: -250, direction: 'settlement' });
  });

  it('同量は flat（差分0）', () => {
    expect(computeDelta(2000, 2000)).toEqual({ value: 0, direction: 'flat' });
  });
});

describe('toPairFlow', () => {
  it('dominant を取引量基準で付けて組み立てる', () => {
    expect(toPairFlow('USD/JPY', 55, 45, 1200, 800)).toEqual({
      pair: 'USD/JPY',
      longPct: 55,
      shortPct: 45,
      longVolume: 1200,
      shortVolume: 800,
      dominant: 'buy',
    });
  });

  it('割合と取引量で優勢側がずれる場合も dominant は取引量基準', () => {
    // 建玉数は買いが多い(60%)が、売りの方が大口で volume は売り優勢。
    const flow = toPairFlow('EUR/JPY', 60, 40, 500, 900);
    expect(flow.dominant).toBe('sell');
  });
});
