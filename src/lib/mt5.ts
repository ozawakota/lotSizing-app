// MT5 監視（mt5-sync Turso）の共有ドメイン。Worker と React で型・集計を共有する。
// スキーマは infra/db/schema.sql（accounts / positions / deals）。時刻は epoch ミリ秒。

export interface Mt5Account {
  login: number;
  broker: string;
  currency: string;
  leverage: number;
  balance: number;
  equity: number;
  margin: number;
  margin_free: number;
  margin_level: number;
  profit: number; // 保有ポジションの合計評価損益
  updated_at: number; // epoch ms
}

export interface Mt5Position {
  ticket: number;
  login: number;
  symbol: string;
  type: string; // 'buy' | 'sell'
  volume: number;
  price_open: number;
  sl: number;
  tp: number;
  price_current: number;
  profit: number;
  swap: number;
  time_open: number; // epoch ms
  updated_at: number;
}

export interface Mt5Deal {
  deal_id: number;
  login: number;
  order_id: number;
  position_id: number;
  symbol: string;
  type: string; // 'buy' | 'sell' | 'balance' ...
  entry: string; // 'in' | 'out' | 'inout' | 'out_by'
  volume: number;
  price: number;
  profit: number;
  commission: number;
  swap: number;
  time: number; // epoch ms
  comment: string;
}

// Worker /state のレスポンス。
export interface Mt5State {
  account: Mt5Account | null;
  positions: Mt5Position[];
  deals: Mt5Deal[];
}

/** 建玉の合計評価損益（profit + swap）。 */
export function totalOpenProfit(positions: Mt5Position[]): number {
  return positions.reduce((a, p) => a + p.profit + p.swap, 0);
}

export interface DealsSummary {
  count: number; // 損益の出た約定（entry=out/inout、type=buy/sell）の件数
  wins: number;
  losses: number;
  winRate: number; // 0..1（count=0 は 0）
  realized: number; // 確定損益の合計（profit + commission + swap）
}

/**
 * 約定履歴から確定損益サマリを出す。残高調整(type=balance 等)や建玉(entry=in)は勝敗から除外し、
 * 損益が発生する決済系(entry が out/inout、type が buy/sell)のみを勝敗カウント対象にする。
 * realized は全約定の profit+commission+swap の合計。
 */
export function summarizeDeals(deals: Mt5Deal[]): DealsSummary {
  let wins = 0;
  let losses = 0;
  let count = 0;
  let realized = 0;
  for (const d of deals) {
    realized += d.profit + d.commission + d.swap;
    const isTrade = (d.type === 'buy' || d.type === 'sell') && (d.entry === 'out' || d.entry === 'inout' || d.entry === 'out_by');
    if (!isTrade) continue;
    count += 1;
    if (d.profit >= 0) wins += 1;
    else losses += 1;
  }
  return { count, wins, losses, winRate: count > 0 ? wins / count : 0, realized };
}
