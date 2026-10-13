// 自動売買（MT5）監視ページ。mt5-worker(/state・VITE_MT5_URL) から口座状態・建玉・直近約定を取得。
// 認証は資金管理ページと同じ Google ログインを共用（localStorage の fund_id_token を Bearer で送る）。
// ※ 表示のみ。発注はしない。約30秒ポーリング＋手動更新。
import { FC, useCallback, useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { summarizeDeals, totalOpenProfit, type Mt5Deal, type Mt5Position, type Mt5State } from '@/lib/mt5';

const MT5_URL = import.meta.env.VITE_MT5_URL as string | undefined;
const FUND_TOKEN_KEY = 'fund_id_token'; // 資金管理ページが保存する Google IDトークン
const POLL_MS = 30_000;

const storedToken = (): string => localStorage.getItem(FUND_TOKEN_KEY) ?? '';

const num = (n: number, d = 2): string => n.toLocaleString('ja-JP', { minimumFractionDigits: d, maximumFractionDigits: d });
const signed = (n: number, d = 2): string => `${n >= 0 ? '+' : '−'}${num(Math.abs(n), d)}`;
const pnlCls = (n: number): string => (n > 0 ? 'text-green-600' : n < 0 ? 'text-red-600' : 'text-gray-500');
const fmtTime = (ms: number): string =>
  ms > 0 ? new Date(ms).toLocaleString('ja-JP', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—';

const SideBadge: FC<{ side: string }> = ({ side }) => {
  const buy = side === 'buy';
  return (
    <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${buy ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>
      {buy ? '買' : side === 'sell' ? '売' : side}
    </span>
  );
};

const PositionRow: FC<{ p: Mt5Position }> = ({ p }) => (
  <div className="flex items-center gap-2 rounded-lg border border-gray-200 p-2 text-xs">
    <SideBadge side={p.type} />
    <span className="font-mono font-bold text-gray-800">{p.symbol}</span>
    <span className="text-gray-400">{num(p.volume, 2)} lot</span>
    <span className="ml-auto tabular-nums text-gray-500">{num(p.price_current, 3)}</span>
    <span className={`w-20 text-right font-semibold tabular-nums ${pnlCls(p.profit + p.swap)}`}>{signed(p.profit + p.swap)}</span>
  </div>
);

const DealRow: FC<{ d: Mt5Deal }> = ({ d }) => (
  <div className="flex items-center gap-2 rounded border border-gray-100 px-2 py-1 text-[11px]">
    <SideBadge side={d.type} />
    <span className="font-mono text-gray-700">{d.symbol || '—'}</span>
    <span className="text-gray-400">{fmtTime(d.time)}</span>
    <span className={`ml-auto font-semibold tabular-nums ${pnlCls(d.profit)}`}>{signed(d.profit)}</span>
  </div>
);

const Mt5Monitor: FC = () => {
  const [state, setState] = useState<Mt5State | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [needLogin, setNeedLogin] = useState(false);

  const load = useCallback(async () => {
    if (!MT5_URL) return;
    const token = storedToken();
    if (!token) {
      setNeedLogin(true);
      return;
    }
    setLoading(true);
    setError('');
    try {
      const res = await fetch(`${MT5_URL}/state`, { headers: { Authorization: `Bearer ${token}` } });
      if (res.status === 401 || res.status === 403) {
        setNeedLogin(true);
        return;
      }
      const data = (await res.json()) as Mt5State | { error: string };
      if ('error' in data) throw new Error(data.error);
      setNeedLogin(false);
      setState(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : '取得に失敗しました');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!MT5_URL) return;
    load();
    const id = setInterval(load, POLL_MS);
    return () => clearInterval(id);
  }, [load]);

  if (!MT5_URL) {
    return (
      <div className="mx-3 my-3 rounded border border-amber-200 bg-amber-50 p-3 text-sm text-amber-700">
        自動売買監視は未設定です。<code>VITE_MT5_URL</code> を設定すると使えます。
      </div>
    );
  }

  const acc = state?.account ?? null;
  const open = state?.positions ?? [];
  const deals = state?.deals ?? [];
  const ds = summarizeDeals(deals);

  return (
    <div className="mx-auto max-w-md px-3 my-2 text-sm">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[11px] text-gray-400">
          {acc ? `更新 ${fmtTime(acc.updated_at)}` : ''}
        </span>
        <button
          type="button"
          onClick={load}
          disabled={loading}
          className="flex items-center gap-1 rounded-full border border-orange-500 px-3 py-1 text-xs text-orange-600 disabled:opacity-50"
        >
          <RefreshCw className={`h-3 w-3 ${loading ? 'animate-spin' : ''}`} />
          {loading ? '取得中…' : '更新'}
        </button>
      </div>

      {error && <p className="mb-2 text-center text-red-600">{error}</p>}

      {needLogin ? (
        <div className="mx-1 my-6 rounded border border-gray-200 bg-gray-50 p-4 text-center text-gray-600">
          口座データの表示にはログインが必要です。<br />
          <span className="text-xs text-gray-500">「資金管理」ページで Google ログインすると、この画面も表示できます。</span>
        </div>
      ) : (
        <>
          {/* 口座サマリー */}
          <div className="rounded-lg border border-gray-200 bg-white p-3">
            {acc ? (
              <>
                <div className="flex items-baseline justify-between">
                  <span className="text-xs text-gray-500">有効証拠金</span>
                  <span className="text-2xl font-bold text-gray-800 tabular-nums">
                    {num(acc.equity)} <span className="text-sm font-normal text-gray-500">{acc.currency}</span>
                  </span>
                </div>
                <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs tabular-nums">
                  <div className="flex justify-between"><span className="text-gray-500">残高</span><span>{num(acc.balance)}</span></div>
                  <div className="flex justify-between"><span className="text-gray-500">評価損益</span><span className={pnlCls(acc.profit)}>{signed(acc.profit)}</span></div>
                  <div className="flex justify-between"><span className="text-gray-500">証拠金</span><span>{num(acc.margin)}</span></div>
                  <div className="flex justify-between"><span className="text-gray-500">余剰証拠金</span><span>{num(acc.margin_free)}</span></div>
                  <div className="flex justify-between"><span className="text-gray-500">維持率</span><span>{acc.margin_level > 0 ? `${num(acc.margin_level, 1)}%` : '—'}</span></div>
                  <div className="flex justify-between"><span className="text-gray-500">レバレッジ</span><span>1:{acc.leverage}</span></div>
                </div>
                <p className="mt-1 text-[10px] text-gray-400">#{acc.login} {acc.broker}</p>
              </>
            ) : (
              <p className="text-center text-gray-400">口座データがまだありません（同期待ち）。</p>
            )}
          </div>

          {/* 建玉 */}
          <div className="mt-3 flex items-center justify-between">
            <h3 className="font-bold text-gray-700">建玉（{open.length}）</h3>
            {open.length > 0 && (
              <span className={`text-xs font-semibold tabular-nums ${pnlCls(totalOpenProfit(open))}`}>
                合計 {signed(totalOpenProfit(open))}
              </span>
            )}
          </div>
          <div className="mt-1 space-y-1">
            {open.length > 0 ? open.map((p) => <PositionRow key={p.ticket} p={p} />) : <p className="text-xs text-gray-400">建玉なし</p>}
          </div>

          {/* 直近約定 */}
          <div className="mt-4 flex items-center justify-between">
            <h3 className="font-bold text-gray-700">直近約定</h3>
            {ds.count > 0 && (
              <span className="text-[11px] text-gray-500 tabular-nums">
                勝率 {(ds.winRate * 100).toFixed(0)}%（{ds.wins}/{ds.count}）・確定 <span className={pnlCls(ds.realized)}>{signed(ds.realized)}</span>
              </span>
            )}
          </div>
          <div className="mt-1 space-y-1">
            {deals.length > 0 ? deals.slice(0, 30).map((d) => <DealRow key={d.deal_id} d={d} />) : <p className="text-xs text-gray-400">約定履歴なし</p>}
          </div>

          <p className="mt-4 text-center text-[10px] text-gray-400">
            ※ MT5 口座の同期データ（表示のみ）。発注は行いません。
          </p>
        </>
      )}
    </div>
  );
};

export default Mt5Monitor;
