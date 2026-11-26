// 資金管理の口座（デモ／リアル）。フロントと fund-worker で共有する。
// - demo: これまでの記録そのもの（DB の user_id = Google の sub）。既存データは移行せずそのまま使う
// - real: 別の記録（user_id = `${sub}#real`）。トレード・入出金・初期残高（settings）がすべて分かれる
// API では ?account=real で指定する（未指定・不正値は demo）。
export type FundAccount = 'demo' | 'real';

export const FUND_ACCOUNTS: readonly FundAccount[] = ['demo', 'real'];

export const FUND_ACCOUNT_LABELS: Record<FundAccount, string> = {
  demo: 'デモ口座',
  real: 'リアル口座',
};

export const parseFundAccount = (v: unknown): FundAccount => (v === 'real' ? 'real' : 'demo');

// DB に保存する user_id（口座ごとに分ける）
export const scopedUserId = (userId: string, account: FundAccount): string =>
  account === 'real' ? `${userId}#real` : userId;

// API のパスに口座を付ける（demo は付けない＝これまでと同じ URL）
export const withAccount = (path: string, account: FundAccount): string =>
  account === 'real' ? `${path}${path.includes('?') ? '&' : '?'}account=real` : path;
