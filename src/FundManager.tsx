// 資金管理（トレードジャーナル）ページ。Google サインイン → fund-worker(Turso) と連携。
// VITE_GOOGLE_CLIENT_ID / VITE_FUND_URL 未設定時は案内のみ表示。
import { useCallback, useEffect, useRef, useState } from 'react';
import { Menu } from 'lucide-react';
import type { Cashflow, FundSummary, Trade } from '@/lib/fund';

const CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined;
const FUND_URL = import.meta.env.VITE_FUND_URL as string | undefined;

// GIS の最小型。
interface GoogleId {
  accounts: {
    id: {
      initialize: (cfg: { client_id: string; callback: (r: { credential: string }) => void }) => void;
      renderButton: (el: HTMLElement, opts: Record<string, unknown>) => void;
    };
  };
}
declare global {
  interface Window {
    google?: GoogleId;
  }
}

const decodeEmail = (idToken: string): string => {
  try {
    const payload = JSON.parse(atob(idToken.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    return payload.email ?? '';
  } catch {
    return '';
  }
};

const today = () => new Date().toISOString().slice(0, 10);

function EquityCurve({ summary }: { summary: FundSummary }) {
  const points = [summary.startingBalance, ...summary.equityCurve.map((p) => p.balance)];
  if (points.length < 2) return null;
  const w = 300;
  const h = 60;
  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = max - min || 1;
  const d = points
    .map((b, i) => {
      const x = (i / (points.length - 1)) * w;
      const y = h - ((b - min) / span) * h;
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
  const up = points[points.length - 1] >= points[0];
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="w-full h-16">
      <path d={d} fill="none" stroke={up ? '#16a34a' : '#dc2626'} strokeWidth="2" />
    </svg>
  );
}

export default function FundManager({ onOpenMenu }: { onOpenMenu: () => void }) {
  const [idToken, setIdToken] = useState('');
  const [email, setEmail] = useState('');
  const [summary, setSummary] = useState<FundSummary | null>(null);
  const [trades, setTrades] = useState<Trade[]>([]);
  const [cashflows, setCashflows] = useState<Cashflow[]>([]);
  const [error, setError] = useState('');
  const btnRef = useRef<HTMLDivElement>(null);

  const configured = Boolean(CLIENT_ID && FUND_URL);

  const api = useCallback(
    async (path: string, init?: RequestInit) => {
      const res = await fetch(`${FUND_URL}${path}`, {
        ...init,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}`, ...(init?.headers ?? {}) },
      });
      if (res.status === 401 || res.status === 403) {
        setIdToken('');
        setEmail('');
        throw new Error('ログインが必要です（再度サインインしてください）');
      }
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
      return res.json();
    },
    [idToken],
  );

  const reload = useCallback(async () => {
    setError('');
    try {
      const [s, t, c] = await Promise.all([api('/summary'), api('/trades'), api('/cashflows')]);
      setSummary(s);
      setTrades(t);
      setCashflows(c);
    } catch (e) {
      setError(e instanceof Error ? e.message : '取得に失敗しました');
    }
  }, [api]);

  // GIS 初期化・ボタン描画（未ログイン時）。
  useEffect(() => {
    if (!configured || idToken) return;
    const init = () => {
      if (!window.google || !btnRef.current) return;
      window.google.accounts.id.initialize({
        client_id: CLIENT_ID as string,
        callback: (r) => {
          setIdToken(r.credential);
          setEmail(decodeEmail(r.credential));
        },
      });
      window.google.accounts.id.renderButton(btnRef.current, { theme: 'outline', size: 'large' });
    };
    if (window.google) {
      init();
      return;
    }
    const script = document.createElement('script');
    script.src = 'https://accounts.google.com/gsi/client';
    script.async = true;
    script.onload = init;
    document.head.appendChild(script);
  }, [configured, idToken]);

  useEffect(() => {
    if (idToken) reload();
  }, [idToken, reload]);

  const addTrade = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    try {
      await api('/trades', {
        method: 'POST',
        body: JSON.stringify({
          date: f.get('date'),
          instrument: f.get('instrument'),
          direction: f.get('direction'),
          lot: Number(f.get('lot')),
          pnl: Number(f.get('pnl')),
          note: f.get('note') || undefined,
        }),
      });
      (e.target as HTMLFormElement).reset();
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : '追加に失敗しました');
    }
  };

  const addCashflow = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    try {
      await api('/cashflows', {
        method: 'POST',
        body: JSON.stringify({ date: f.get('date'), type: f.get('type'), amount: Number(f.get('amount')) }),
      });
      (e.target as HTMLFormElement).reset();
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : '追加に失敗しました');
    }
  };

  const saveSettings = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    try {
      await api('/settings', {
        method: 'PUT',
        body: JSON.stringify({ startingBalance: Number(f.get('startingBalance')), currency: f.get('currency') }),
      });
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存に失敗しました');
    }
  };

  const del = async (kind: 'trades' | 'cashflows', id: string) => {
    try {
      await api(`/${kind}/${id}`, { method: 'DELETE' });
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : '削除に失敗しました');
    }
  };

  const inputCls = 'rounded border border-gray-300 px-2 py-1 text-sm bg-white w-full';

  return (
    <>
      <div className="relative">
        <h1 className="text-center text-base! font-bold lh-base">資金管理</h1>
        <button
          type="button"
          aria-label="メニュー"
          className="absolute top-0 right-3 text-gray-600 rounded-full h-8 w-8 flex items-center justify-center border border-gray-300"
          onClick={onOpenMenu}
        >
          <Menu className="h-4 w-4" />
        </button>
      </div>

      {!configured ? (
        <div className="mx-3 my-3 p-3 bg-amber-50 border border-amber-200 rounded text-sm text-amber-700">
          未設定です。<code>VITE_GOOGLE_CLIENT_ID</code> と <code>VITE_FUND_URL</code> を設定すると使えます。
        </div>
      ) : !idToken ? (
        <div className="mx-3 my-4 flex flex-col items-center gap-2">
          <p className="text-sm text-gray-600">Google でログインしてください</p>
          <div ref={btnRef} />
          {error && <p className="text-xs text-red-600">{error}</p>}
        </div>
      ) : (
        <div className="mx-3 my-2 space-y-3">
          <p className="text-[11px] text-gray-400 text-right">{email}</p>
          {error && <p className="text-sm text-red-600">{error}</p>}

          {/* サマリー */}
          {summary && (
            <div className="bg-blue-50 rounded-md p-3 border border-blue-200">
              <div className="flex justify-between items-baseline">
                <p className="text-sm text-gray-600">残高</p>
                <p className="text-2xl font-bold text-blue-700">
                  {summary.balance.toLocaleString()} {summary.currency}
                </p>
              </div>
              <EquityCurve summary={summary} />
              <div className="grid grid-cols-3 gap-2 text-center text-xs mt-1">
                <div>
                  <p className="text-gray-500">累計損益</p>
                  <p className={`font-bold ${summary.cumulativePnl >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                    {summary.cumulativePnl.toLocaleString()}
                  </p>
                </div>
                <div>
                  <p className="text-gray-500">勝率</p>
                  <p className="font-bold">{(summary.winRate * 100).toFixed(0)}%（{summary.wins}/{summary.wins + summary.losses}）</p>
                </div>
                <div>
                  <p className="text-gray-500">最大DD</p>
                  <p className="font-bold text-red-600">{summary.maxDrawdown.toLocaleString()}</p>
                </div>
              </div>
            </div>
          )}

          {/* 設定 */}
          <form onSubmit={saveSettings} className="bg-gray-50 rounded-md p-3 border border-gray-200">
            <p className="text-sm font-bold text-gray-700 mb-1">初期設定</p>
            <div className="grid grid-cols-3 gap-2 items-end">
              <label className="text-xs text-gray-600 col-span-1">
                初期残高
                <input name="startingBalance" inputMode="decimal" defaultValue={summary?.startingBalance ?? 0} className={inputCls} />
              </label>
              <label className="text-xs text-gray-600">
                通貨
                <select name="currency" defaultValue={summary?.currency ?? 'JPY'} className={inputCls}>
                  <option>JPY</option>
                  <option>USD</option>
                </select>
              </label>
              <button className="rounded bg-gray-600 text-white py-1.5 text-sm">保存</button>
            </div>
          </form>

          {/* トレード追加 */}
          <form onSubmit={addTrade} className="bg-white rounded-md p-3 border border-gray-200 space-y-2">
            <p className="text-sm font-bold text-gray-700">トレード追加</p>
            <div className="grid grid-cols-2 gap-2">
              <input name="date" type="date" defaultValue={today()} className={inputCls} required />
              <input name="instrument" placeholder="USD_JPY" className={inputCls} required />
              <select name="direction" className={inputCls}>
                <option value="long">買い</option>
                <option value="short">売り</option>
              </select>
              <input name="lot" inputMode="decimal" placeholder="ロット" className={inputCls} required />
              <input name="pnl" inputMode="decimal" placeholder="損益(±)" className={inputCls} required />
              <input name="note" placeholder="メモ(任意)" className={inputCls} />
            </div>
            <button className="w-full rounded bg-orange-500 text-white py-1.5 text-sm">追加</button>
          </form>

          {/* トレード一覧 */}
          {trades.length > 0 && (
            <div className="bg-white rounded-md border border-gray-200 divide-y">
              {trades.map((t) => (
                <div key={t.id} className="flex items-center justify-between px-3 py-1.5 text-xs">
                  <span className="text-gray-500">{t.date}</span>
                  <span>{t.instrument} {t.direction === 'long' ? '買' : '売'} {t.lot}</span>
                  <span className={t.pnl >= 0 ? 'text-green-600 font-bold' : 'text-red-600 font-bold'}>
                    {t.pnl.toLocaleString()}
                  </span>
                  <button onClick={() => del('trades', t.id)} className="text-gray-400 hover:text-red-500">×</button>
                </div>
              ))}
            </div>
          )}

          {/* 入出金追加 */}
          <form onSubmit={addCashflow} className="bg-white rounded-md p-3 border border-gray-200 space-y-2">
            <p className="text-sm font-bold text-gray-700">入出金</p>
            <div className="grid grid-cols-3 gap-2">
              <input name="date" type="date" defaultValue={today()} className={inputCls} required />
              <select name="type" className={inputCls}>
                <option value="deposit">入金</option>
                <option value="withdrawal">出金</option>
              </select>
              <input name="amount" inputMode="decimal" placeholder="金額" className={inputCls} required />
            </div>
            <button className="w-full rounded bg-orange-500 text-white py-1.5 text-sm">追加</button>
          </form>

          {cashflows.length > 0 && (
            <div className="bg-white rounded-md border border-gray-200 divide-y">
              {cashflows.map((c) => (
                <div key={c.id} className="flex items-center justify-between px-3 py-1.5 text-xs">
                  <span className="text-gray-500">{c.date}</span>
                  <span>{c.type === 'deposit' ? '入金' : '出金'}</span>
                  <span className="font-bold">{c.amount.toLocaleString()}</span>
                  <button onClick={() => del('cashflows', c.id)} className="text-gray-400 hover:text-red-500">×</button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </>
  );
}
