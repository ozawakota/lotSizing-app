// 資金管理（MAXBET 型・収支記録）の純ドメインロジック。副作用なし・テスト可能。
// fund-worker（/summary）とフロントで共有する（単一の計算定義）。
//
// 1件 = 日付 + 投資金額(invested) + 回収金額(recovered) + タグ。
// 損益 = 回収 − 投資、回収率 = 回収 ÷ 投資。

export type CashflowType = 'deposit' | 'withdrawal';

export interface Trade {
  id: string;
  date: string; // "YYYY-MM-DD"
  invested: number; // 投資金額
  recovered: number; // 回収金額
  tags: string[]; // 店舗/機種/レート等（自由）
  note?: string;
}

// 1件の損益（回収 − 投資）。
export const pnlOf = (t: Trade): number => t.recovered - t.invested;

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
  totalInvested: number;
  totalRecovered: number;
  recoveryRate: number; // 総回収 ÷ 総投資（投資0なら0）
  deposits: number;
  withdrawals: number;
  tradeCount: number;
  wins: number;
  losses: number;
  winRate: number; // 0..1（損益≠0のトレード基準。該当なしは0）
  maxDrawdown: number; // 口座通貨の絶対額
  equityCurve: EquityPoint[];
}

export interface TagAggregate {
  tag: string;
  pnl: number;
  invested: number;
  recovered: number;
  recoveryRate: number;
  count: number;
}

// 日付ごとの合計損益（"YYYY-MM-DD" → 損益合計）。月間損益カレンダー用。
export function dailyPnl(trades: Trade[]): Record<string, number> {
  const map: Record<string, number> = {};
  for (const t of trades) map[t.date] = (map[t.date] ?? 0) + pnlOf(t);
  return map;
}

// タグ別の収支・回収率・件数。1件が複数タグを持つ場合は各タグに加算。
export function aggregateByTag(trades: Trade[]): TagAggregate[] {
  const map = new Map<string, { pnl: number; invested: number; recovered: number; count: number }>();
  for (const t of trades) {
    for (const tag of t.tags) {
      const a = map.get(tag) ?? { pnl: 0, invested: 0, recovered: 0, count: 0 };
      a.pnl += pnlOf(t);
      a.invested += t.invested;
      a.recovered += t.recovered;
      a.count += 1;
      map.set(tag, a);
    }
  }
  return [...map.entries()].map(([tag, a]) => ({
    tag,
    pnl: a.pnl,
    invested: a.invested,
    recovered: a.recovered,
    recoveryRate: a.invested > 0 ? a.recovered / a.invested : 0,
    count: a.count,
  }));
}

// year・month(1-12) の月カレンダー（日曜始まり）。各セルは "YYYY-MM-DD" か null（空白）。
export function monthGrid(year: number, month: number): (string | null)[][] {
  const startDow = new Date(Date.UTC(year, month - 1, 1)).getUTCDay(); // 0=日
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const cells: (string | null)[] = [];
  for (let i = 0; i < startDow; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) {
    cells.push(`${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`);
  }
  while (cells.length % 7 !== 0) cells.push(null);
  const weeks: (string | null)[][] = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return weeks;
}

interface DatedDelta {
  date: string;
  delta: number;
  order: number; // 同日タイブレーク用（入力順を保持）
}

// 残高・損益・回収率・勝率・最大ドローダウン・エクイティカーブを算出する。
export function computeSummary(
  settings: FundSettings,
  trades: Trade[],
  cashflows: Cashflow[],
): FundSummary {
  const cumulativePnl = trades.reduce((s, t) => s + pnlOf(t), 0);
  const totalInvested = trades.reduce((s, t) => s + t.invested, 0);
  const totalRecovered = trades.reduce((s, t) => s + t.recovered, 0);
  const deposits = cashflows.filter((c) => c.type === 'deposit').reduce((s, c) => s + c.amount, 0);
  const withdrawals = cashflows.filter((c) => c.type === 'withdrawal').reduce((s, c) => s + c.amount, 0);
  const balance = settings.startingBalance + deposits - withdrawals + cumulativePnl;

  const wins = trades.filter((t) => pnlOf(t) > 0).length;
  const losses = trades.filter((t) => pnlOf(t) < 0).length;
  const closed = wins + losses;
  const winRate = closed > 0 ? wins / closed : 0;

  let order = 0;
  const events: DatedDelta[] = [
    ...trades.map((t) => ({ date: t.date, delta: pnlOf(t), order: order++ })),
    ...cashflows.map((c) => ({ date: c.date, delta: c.type === 'deposit' ? c.amount : -c.amount, order: order++ })),
  ].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.order - b.order));

  let running = settings.startingBalance;
  const equityCurve: EquityPoint[] = [];
  for (const e of events) {
    running += e.delta;
    equityCurve.push({ date: e.date, balance: running });
  }

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
    totalInvested,
    totalRecovered,
    recoveryRate: totalInvested > 0 ? totalRecovered / totalInvested : 0,
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
