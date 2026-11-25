// エッジページのカードに出す「推奨ロット数」。計算ページと同じ考え方:
//   ロット = 許容損失（証拠金 × リスク%）÷（損切り幅 pips × 1ロットあたりの1pipの価値）
// 1ロットあたりの1pipの価値（計算ページと同じ）:
//   XXX/JPY … 0.01円 × 100,000通貨 = 1,000円
//   XXX/USD … 0.0001ドル × 100,000通貨 = 10ドル
//   XAU/USD … 0.1ドル × 100オンス = 10ドル
// 証拠金（円/ドル）とペアの通貨が違うときは USD/JPY で換算する。許容損失を超えないよう 0.01 ロット単位で切り捨てる。

export type BalanceCurrency = 'JPY' | 'USD';

export interface LotSettings {
  balance: number; // 証拠金（balanceCurrency 建て）
  balanceCurrency: BalanceCurrency;
  riskPct: number; // 1回のトレードで許す損失（証拠金に対する %）
}

export interface CardLot {
  lots: number; // 推奨ロット（0.01 単位で切り捨て）
  riskAmount: number; // 許容損失（balanceCurrency 建て）
  lossAtLots: number; // そのロットで損切りになったときの損失（balanceCurrency 建て）
}

/** 1ロットあたりの1pipの価値（ペアの決済通貨建て）と、その通貨。 */
export function pipValuePerLot(instrument: string): { value: number; currency: 'JPY' | 'USD' } {
  if (instrument.endsWith('JPY')) return { value: 1000, currency: 'JPY' };
  return { value: 10, currency: 'USD' }; // EUR/USD・GBP/USD・AUD/USD・XAU/USD
}

/** 推奨ロット。証拠金・リスク%・損切り幅が無い、または換算に必要な USD/JPY が無いときは null。 */
export function recommendedLot(instrument: string, riskPips: number, s: LotSettings, usdJpy: number | null): CardLot | null {
  if (!(s.balance > 0) || !(s.riskPct > 0) || !(riskPips > 0)) return null;
  const pv = pipValuePerLot(instrument);
  let pipValue = pv.value; // balanceCurrency 建てに直す
  if (pv.currency !== s.balanceCurrency) {
    if (!(usdJpy && usdJpy > 0)) return null;
    pipValue = pv.currency === 'USD' ? pv.value * usdJpy : pv.value / usdJpy;
  }
  const riskAmount = s.balance * (s.riskPct / 100);
  const lots = Math.floor((riskAmount / (riskPips * pipValue)) * 100 + 1e-9) / 100;
  return { lots, riskAmount, lossAtLots: lots * riskPips * pipValue };
}

/** 計算ページが保存した設定（localStorage）を読む。読めなければ null。 */
export function loadLotSettings(storage: Pick<Storage, 'getItem'> | null): LotSettings | null {
  if (!storage) return null;
  try {
    const balance = parseFloat((storage.getItem('accountBalance') ?? '0').replace(/,/g, ''));
    const cur = storage.getItem('balanceCurrency');
    const riskPct = parseFloat(storage.getItem('riskPercentage') ?? '');
    return {
      balance: Number.isFinite(balance) ? balance : 0,
      balanceCurrency: cur === 'USD' ? 'USD' : 'JPY',
      riskPct: Number.isFinite(riskPct) ? riskPct : 2.5, // 計算ページの既定値と同じ
    };
  } catch {
    return null;
  }
}
