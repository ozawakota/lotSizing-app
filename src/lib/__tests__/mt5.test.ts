import { describe, it, expect } from 'vitest';
import { summarizeDeals, totalOpenProfit, type Mt5Deal, type Mt5Position } from '../mt5';

const pos = (profit: number, swap = 0): Mt5Position => ({
  ticket: Math.random(), login: 1, symbol: 'XAUUSD', type: 'buy', volume: 0.1,
  price_open: 0, sl: 0, tp: 0, price_current: 0, profit, swap, time_open: 0, updated_at: 0,
});

const deal = (type: string, entry: string, profit: number, commission = 0, swap = 0): Mt5Deal => ({
  deal_id: Math.floor(Math.random() * 1e9), login: 1, order_id: 0, position_id: 0, symbol: 'XAUUSD',
  type, entry, volume: 0.1, price: 0, profit, commission, swap, time: 0, comment: '',
});

describe('totalOpenProfit', () => {
  it('建玉の profit + swap を合算する', () => {
    expect(totalOpenProfit([pos(100, -2), pos(-30, -1)])).toBeCloseTo(67);
    expect(totalOpenProfit([])).toBe(0);
  });
});

describe('summarizeDeals', () => {
  it('決済系(out/inout の buy/sell)のみ勝敗カウント、残高調整や建玉は除外', () => {
    const deals = [
      deal('balance', '', 100000),      // 入金 → 勝敗外、realized には加算
      deal('buy', 'in', 0),             // 建玉 → 勝敗外
      deal('sell', 'out', 50),          // 勝ち
      deal('buy', 'out', -20),          // 負け
      deal('sell', 'inout', 10),        // 勝ち
    ];
    const s = summarizeDeals(deals);
    expect(s.count).toBe(3);
    expect(s.wins).toBe(2);
    expect(s.losses).toBe(1);
    expect(s.winRate).toBeCloseTo(2 / 3);
    // realized は全約定の profit+commission+swap
    expect(s.realized).toBeCloseTo(100000 + 0 + 50 - 20 + 10);
  });

  it('決済が無ければ winRate=0', () => {
    const s = summarizeDeals([deal('buy', 'in', 0)]);
    expect(s.count).toBe(0);
    expect(s.winRate).toBe(0);
  });
});
