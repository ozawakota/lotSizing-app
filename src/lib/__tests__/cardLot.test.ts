import { describe, it, expect } from 'vitest';
import { loadLotSettings, recommendedLot } from '../cardLot';

const jpy = { balance: 1_000_000, balanceCurrency: 'JPY' as const, riskPct: 2 }; // 許容損失 20,000円

describe('recommendedLot（計算ページと同じ式）', () => {
  it('XXX/JPY・円口座: 20,000円 ÷（40pips × 1,000円）= 0.50 ロット', () => {
    expect(recommendedLot('USD_JPY', 40, jpy, null)).toEqual({ lots: 0.5, riskAmount: 20_000, lossAtLots: 20_000 });
  });
  it('許容損失を超えないよう 0.01 単位で切り捨て', () => {
    expect(recommendedLot('EUR_JPY', 45, jpy, null)!.lots).toBe(0.44); // 0.444…
  });
  it('XXX/USD・円口座は USD/JPY で換算（1pip = 10ドル × 150円）', () => {
    expect(recommendedLot('EUR_USD', 20, jpy, 150)!.lots).toBe(0.66); // 20,000 ÷ (20 × 1,500) = 0.666…
    expect(recommendedLot('EUR_USD', 20, jpy, null)).toBeNull(); // 換算できない
  });
  it('ゴールド・ドル口座: $200 ÷（25pips × $10）= 0.80 ロット', () => {
    expect(recommendedLot('XAU_USD', 25, { balance: 10_000, balanceCurrency: 'USD', riskPct: 2 }, null)!.lots).toBe(0.8);
  });
  it('円ペア・ドル口座: 1pip = 1,000円 ÷ 150', () => {
    expect(recommendedLot('USD_JPY', 40, { balance: 10_000, balanceCurrency: 'USD', riskPct: 2 }, 150)!.lots).toBe(0.75);
  });
  it('証拠金が 0 なら null', () => {
    expect(recommendedLot('USD_JPY', 40, { ...jpy, balance: 0 }, null)).toBeNull();
  });
});

describe('loadLotSettings', () => {
  it('計算ページの保存値を読む（カンマ付きも可・リスク%が無ければ 2.5）', () => {
    const store = new Map([['accountBalance', '1,200,000'], ['balanceCurrency', 'JPY']]);
    expect(loadLotSettings({ getItem: (k) => store.get(k) ?? null })).toEqual({ balance: 1_200_000, balanceCurrency: 'JPY', riskPct: 2.5 });
  });
});
