// 資金管理（トレードジャーナル）の純ドメインロジック。副作用なし・テスト可能。
// fund-worker（/summary）とフロントで共有する（単一の計算定義）。

export type TradeDirection = 'long' | 'short';
export type CashflowType = 'deposit' | 'withdrawal';

export interface Trade {
  id: string;
  date: string; // "YYYY-MM-DD"
  instrument: string;
  direction: TradeDirection;
  lot: number;
  entry?: number | null;
  exit?: number | null;
  pnl: number; // 口座通貨の符号付き損益（決済済みの結果）
  note?: string;
}

export interface Cashflow {
  id: string;
  date: string;
  type: CashflowType;
  amount: number; // 正の金額
  note?: string;
}

export interface FundSettings {
  startingBalance: number;
  currency: string;
}

export interface EquityPoint {
  date: string;
  balance: number;
}

export interface FundSummary {
  currency: string;
  balance: number;
  startingBalance: number;
  cumulativePnl: number;
  deposits: number;
  withdrawals: number;
  tradeCount: number;
  wins: number;
  losses: number;
  winRate: number; // 0..1（決済済トレード基準。該当なしは 0）
  maxDrawdown: number; // 口座通貨の絶対額
  equityCurve: EquityPoint[];
}

interface DatedDelta {
  date: string;
  delta: number;
  order: number; // 同日タイブレーク用（入力順を保持）
}

// 残高・損益・勝率・最大ドローダウン・エクイティカーブを算出する。
export function computeSummary(
  settings: FundSettings,
  trades: Trade[],
  cashflows: Cashflow[],
): FundSummary {
  const cumulativePnl = trades.reduce((s, t) => s + t.pnl, 0);
  const deposits = cashflows.filter((c) => c.type === 'deposit').reduce((s, c) => s + c.amount, 0);
  const withdrawals = cashflows.filter((c) => c.type === 'withdrawal').reduce((s, c) => s + c.amount, 0);
  const balance = settings.startingBalance + deposits - withdrawals + cumulativePnl;

  const wins = trades.filter((t) => t.pnl > 0).length;
  const losses = trades.filter((t) => t.pnl < 0).length;
  const closed = wins + losses;
  const winRate = closed > 0 ? wins / closed : 0;

  // 日付順に残高を積み上げてエクイティカーブを作る（同日は入力順）。
  let order = 0;
  const events: DatedDelta[] = [
    ...trades.map((t) => ({ date: t.date, delta: t.pnl, order: order++ })),
    ...cashflows.map((c) => ({ date: c.date, delta: c.type === 'deposit' ? c.amount : -c.amount, order: order++ })),
  ].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.order - b.order));

  let running = settings.startingBalance;
  const equityCurve: EquityPoint[] = [];
  for (const e of events) {
    running += e.delta;
    equityCurve.push({ date: e.date, balance: running });
  }

  // 最大ドローダウン（初期残高を起点に、ピークからの最大下落幅）。
  let peak = settings.startingBalance;
  let maxDrawdown = 0;
  for (const b of [settings.startingBalance, ...equityCurve.map((p) => p.balance)]) {
    if (b > peak) peak = b;
    maxDrawdown = Math.max(maxDrawdown, peak - b);
  }

  return {
    currency: settings.currency,
    balance,
    startingBalance: settings.startingBalance,
    cumulativePnl,
    deposits,
    withdrawals,
    tradeCount: trades.length,
    wins,
    losses,
    winRate,
    maxDrawdown,
    equityCurve,
  };
}
