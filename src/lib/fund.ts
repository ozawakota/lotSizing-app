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

// ── 資金推移シミュレーション（複利・期待値） ─────────────────────────────
// 毎トレード「その時点の残高 × リスク%」を賭け、勝ちで +リスク×RR、負けで −リスク。
// 勝敗を平均化した1トレードあたりの幾何平均成長率で滑らかに複利する。

export interface GrowthParams {
  startingBalance: number; // 起点資金
  targetBalance: number; // 目標金額
  winRate: number; // 勝率 0..1
  tradesPerMonth: number; // 毎月のトレード回数
  rewardRatio: number; // リスクリワードの R（1:3 なら 3）
  riskPercents: number[]; // 比較するリスク%（例: [2,3,4,5]）
}

export interface GrowthLine {
  riskPercent: number; // リスク%（2,3,4,5…）
  growthPerTrade: number; // 1トレードあたりの幾何平均成長率 g
  monthsToTarget: number | null; // 目標到達までの月数（厳密値・未到達は null）
  points: { month: number; balance: number }[]; // 月ごとの残高（目標でクランプ）
}

export interface GrowthResult {
  lines: GrowthLine[];
  maxMonths: number; // 横軸の上限（到達した中で最長、全未到達なら既定）
}

const GROWTH_MONTH_CAP = 120; // 横軸の上限（10年）。これを超える到達も表示月数は返す。
const GROWTH_DEFAULT_MONTHS = 24; // 全リスク%が未到達のときの既定横軸。

// 1トレードあたりの幾何平均成長率 g = (1 + RR·r)^勝率 × (1 − r)^(1−勝率)。
export function growthPerTrade(winRate: number, rewardRatio: number, riskFraction: number): number {
  return Math.pow(1 + rewardRatio * riskFraction, winRate) * Math.pow(1 - riskFraction, 1 - winRate);
}

// 起点が目標以上・不正値、または g≤1（期待値マイナス）なら到達しない（null）。
function monthsToReach(startingBalance: number, targetBalance: number, tradesPerMonth: number, g: number): number | null {
  const valid = startingBalance > 0 && targetBalance > startingBalance && tradesPerMonth > 0;
  return valid && g > 1 ? Math.log(targetBalance / startingBalance) / (tradesPerMonth * Math.log(g)) : null;
}

export function simulateGrowth(params: GrowthParams): GrowthResult {
  const { startingBalance, targetBalance, winRate, tradesPerMonth, rewardRatio, riskPercents } = params;

  // 起点が目標以上、または不正値なら推移を描かない。
  const valid = startingBalance > 0 && targetBalance > startingBalance && tradesPerMonth > 0;

  const raw = riskPercents.map((riskPercent) => {
    const r = riskPercent / 100;
    const g = growthPerTrade(winRate, rewardRatio, r);
    const monthsToTarget = monthsToReach(startingBalance, targetBalance, tradesPerMonth, g);
    return { riskPercent, g, monthsToTarget };
  });

  // 横軸: 到達する中で最長の月数（切り上げ・上限 CAP）。全未到達なら既定。
  const reachable = raw.map((l) => l.monthsToTarget).filter((m): m is number => m !== null);
  const maxMonths = reachable.length
    ? Math.min(GROWTH_MONTH_CAP, Math.max(1, Math.ceil(Math.max(...reachable))))
    : GROWTH_DEFAULT_MONTHS;

  const lines: GrowthLine[] = raw.map(({ riskPercent, g, monthsToTarget }) => {
    const points: { month: number; balance: number }[] = [];
    for (let month = 0; month <= maxMonths; month++) {
      const grown = valid ? startingBalance * Math.pow(g, tradesPerMonth * month) : startingBalance;
      // 目標に達したら以降は目標でクランプ（縦軸を 起点〜目標 に収める）。
      points.push({ month, balance: Math.min(grown, targetBalance) });
    }
    return { riskPercent, growthPerTrade: g, monthsToTarget, points };
  });

  return { lines, maxMonths };
}

// 選択したリスク%1本の詳細。期待値の内訳（1トレードの平均＝算術）と、
// 複利の推移（月利・初月の増加額・到達回数＝幾何平均 g ベース）を返す。
export interface GrowthDetail {
  riskPercent: number;
  // 1トレードの内訳（%は小数ではなくパーセント値。金額は初回＝起点ベース）
  winPct: number; // 勝ち時の増加率（+RR×r）… 例 6
  lossPct: number; // 負け時の減少率の大きさ（r）… 例 2
  expectancyPct: number; // 1トレード期待値（算術平均）r×(p×RR−(1−p))… 例 2.8
  initialRiskAmount: number; // 初回リスク額 B×r
  initialWinAmount: number; // 初回の勝ち利益 B×RR×r
  initialExpectancyAmount: number; // 初回の期待損益 B×expectancy
  // 複利の推移（幾何平均 g）
  growthPerTrade: number; // g
  monthlyRatePct: number; // 月利 (g^毎月回数 − 1)×100
  firstMonthGain: number; // 初月の期待増加額 B×(g^毎月回数 − 1)
  monthsToTarget: number | null; // 目標到達までの月数（厳密値・未到達は null）
  tradesToTarget: number | null; // 目標到達までの総トレード回数（切り上げ・未到達は null）
}

export function growthDetail(params: GrowthParams, riskPercent: number): GrowthDetail {
  const { startingBalance: B, targetBalance, winRate: p, tradesPerMonth: m, rewardRatio: RR } = params;
  const r = riskPercent / 100;
  const expectancyFrac = r * (p * RR - (1 - p));
  const g = growthPerTrade(p, RR, r);
  const monthlyFactor = Math.pow(g, m); // 1ヶ月（m回）の複利係数
  const monthsToTarget = monthsToReach(B, targetBalance, m, g);
  return {
    riskPercent,
    winPct: RR * r * 100,
    lossPct: r * 100,
    expectancyPct: expectancyFrac * 100,
    initialRiskAmount: B * r,
    initialWinAmount: B * RR * r,
    initialExpectancyAmount: B * expectancyFrac,
    growthPerTrade: g,
    monthlyRatePct: (monthlyFactor - 1) * 100,
    firstMonthGain: B * (monthlyFactor - 1),
    monthsToTarget,
    tradesToTarget: monthsToTarget === null ? null : Math.ceil(monthsToTarget * m),
  };
}
