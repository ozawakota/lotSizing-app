// 資金管理（MAXBET 型・収支記録）ページ。Google サインイン → fund-worker(Turso) と連携。
// 1件 = 日付 + 投資 + 回収 + タグ。損益=回収−投資、回収率=回収÷投資。
// 月間損益カレンダー・エクイティ曲線・タグ絞り込みに対応。
// VITE_GOOGLE_CLIENT_ID / VITE_FUND_URL 未設定時は案内のみ表示。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Popup } from '@mobiscroll/react';
import { Menu } from 'lucide-react';
import { aggregateByTag, computeSummary, pnlOf, type Cashflow, type FundSettings, type Trade } from '@/lib/fund';
import TradeCalendar from './TradeCalendar';

const CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined;
const FUND_URL = import.meta.env.VITE_FUND_URL as string | undefined;

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
    return JSON.parse(atob(idToken.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).email ?? '';
  } catch {
    return '';
  }
};

const today = () => new Date().toISOString().slice(0, 10);
const yen = (n: number) => n.toLocaleString();

function EquityCurve({ startingBalance, balances }: { startingBalance: number; balances: number[] }) {
  const points = [startingBalance, ...balances];
  if (points.length < 2) return null;
  const w = 300;
  const h = 60;
  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = max - min || 1;
  const d = points
    .map((b, i) => `${i === 0 ? 'M' : 'L'}${((i / (points.length - 1)) * w).toFixed(1)},${(h - ((b - min) / span) * h).toFixed(1)}`)
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
  const [settings, setSettings] = useState<FundSettings>({ startingBalance: 0, currency: 'JPY' });
  const [trades, setTrades] = useState<Trade[]>([]);
  const [cashflows, setCashflows] = useState<Cashflow[]>([]);
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [selectedTag, setSelectedTag] = useState<string | null>(null);
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
      const [s, t, c] = await Promise.all([api('/settings'), api('/trades'), api('/cashflows')]);
      setSettings(s);
      setTrades(t);
      setCashflows(c);
    } catch (e) {
      setError(e instanceof Error ? e.message : '取得に失敗しました');
    }
  }, [api]);

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

  // タグ絞り込み中はそのタグを含むトレードだけを対象にする。
  const viewTrades = useMemo(
    () => (selectedTag ? trades.filter((t) => t.tags.includes(selectedTag)) : trades),
    [trades, selectedTag],
  );
  const summary = useMemo(() => computeSummary(settings, viewTrades, cashflows), [settings, viewTrades, cashflows]);
  const tagAggs = useMemo(() => aggregateByTag(trades).sort((a, b) => b.count - a.count), [trades]);

  const parseTags = (raw: string): string[] =>
    raw
      .split(/[,、\s]+/)
      .map((s) => s.trim())
      .filter(Boolean);

  const addTrade = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!selectedDate) return;
    const form = e.currentTarget;
    const f = new FormData(form);
    try {
      await api('/trades', {
        method: 'POST',
        body: JSON.stringify({
          date: selectedDate,
          invested: Number(f.get('invested')),
          recovered: Number(f.get('recovered')),
          tags: parseTags(String(f.get('tags') ?? '')),
          note: f.get('note') || undefined,
        }),
      });
      form.reset();
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
  const dayTrades = selectedDate ? trades.filter((t) => t.date === selectedDate) : [];

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

          {/* タグフィルタ */}
          {tagAggs.length > 0 && (
            <div className="flex flex-wrap gap-1">
              <button
                type="button"
                onClick={() => setSelectedTag(null)}
                className={`text-xs px-2 py-0.5 rounded-full border ${selectedTag === null ? 'bg-orange-500 text-white border-orange-500' : 'bg-white text-gray-600 border-gray-300'}`}
              >
                すべて
              </button>
              {tagAggs.map((a) => (
                <button
                  key={a.tag}
                  type="button"
                  onClick={() => setSelectedTag(a.tag === selectedTag ? null : a.tag)}
                  className={`text-xs px-2 py-0.5 rounded-full border ${selectedTag === a.tag ? 'bg-orange-500 text-white border-orange-500' : 'bg-white text-gray-600 border-gray-300'}`}
                >
                  {a.tag}
                </button>
              ))}
            </div>
          )}

          {/* サマリー */}
          <div className="bg-blue-50 rounded-md p-3 border border-blue-200">
            <div className="flex justify-between items-baseline">
              <p className="text-sm text-gray-600">{selectedTag ? `「${selectedTag}」収支` : '残高'}</p>
              <p className="text-2xl font-bold text-blue-700">
                {selectedTag ? (
                  <span className={summary.cumulativePnl >= 0 ? 'text-green-600' : 'text-red-600'}>
                    {summary.cumulativePnl >= 0 ? '+' : ''}
                    {yen(summary.cumulativePnl)}
                  </span>
                ) : (
                  <>{yen(summary.balance)} {summary.currency}</>
                )}
              </p>
            </div>
            {!selectedTag && <EquityCurve startingBalance={summary.startingBalance} balances={summary.equityCurve.map((p) => p.balance)} />}
            <div className="grid grid-cols-3 gap-2 text-center text-xs mt-1">
              <div>
                <p className="text-gray-500">回収率</p>
                <p className={`font-bold ${summary.recoveryRate >= 1 ? 'text-green-600' : 'text-red-600'}`}>
                  {(summary.recoveryRate * 100).toFixed(0)}%
                </p>
              </div>
              <div>
                <p className="text-gray-500">勝率</p>
                <p className="font-bold">
                  {(summary.winRate * 100).toFixed(0)}%（{summary.wins}/{summary.wins + summary.losses}）
                </p>
              </div>
              <div>
                <p className="text-gray-500">投資/回収</p>
                <p className="font-bold">{yen(summary.totalInvested)}→{yen(summary.totalRecovered)}</p>
              </div>
            </div>
          </div>

          {/* 月間損益カレンダー */}
          <TradeCalendar trades={viewTrades} selectedDate={selectedDate} onSelectDate={setSelectedDate} />

          {/* 日付タップで開くモーダル: その日の記録を閲覧＋入力 */}
          <Popup
            isOpen={selectedDate !== null}
            onClose={() => setSelectedDate(null)}
            headerText={selectedDate ?? ''}
            buttons={[{ text: '閉じる', handler: () => setSelectedDate(null) }]}
          >
            <div className="p-3 space-y-3 min-w-[260px]">
              {/* その日の記録 */}
              {dayTrades.length === 0 ? (
                <p className="text-xs text-gray-400">まだ記録がありません</p>
              ) : (
                <div className="border border-gray-200 rounded divide-y">
                  {dayTrades.map((t) => (
                    <div key={t.id} className="flex items-center justify-between px-2 py-1.5 text-xs gap-2">
                      <span className="text-gray-500 shrink-0">投{yen(t.invested)}→回{yen(t.recovered)}</span>
                      <span className="flex-1 truncate text-gray-400">{t.tags.join(' ')}</span>
                      <span className={pnlOf(t) >= 0 ? 'text-green-600 font-bold' : 'text-red-600 font-bold'}>
                        {pnlOf(t) >= 0 ? '+' : ''}
                        {yen(pnlOf(t))}
                      </span>
                      <button onClick={() => del('trades', t.id)} className="text-gray-400 hover:text-red-500">×</button>
                    </div>
                  ))}
                </div>
              )}

              {/* 追加フォーム（日付はこの日に固定） */}
              <form key={selectedDate ?? 'none'} onSubmit={addTrade} className="space-y-2">
                <div className="grid grid-cols-2 gap-2">
                  <input name="invested" inputMode="decimal" placeholder="投資金額" className={inputCls} required />
                  <input name="recovered" inputMode="decimal" placeholder="回収金額" className={inputCls} required />
                  <input name="tags" placeholder="タグ（例: 店A 20スロ）" list="tag-suggest" className={`${inputCls} col-span-2`} />
                  <input name="note" placeholder="メモ(任意)" className={`${inputCls} col-span-2`} />
                </div>
                <datalist id="tag-suggest">
                  {tagAggs.map((a) => (
                    <option key={a.tag} value={a.tag} />
                  ))}
                </datalist>
                <button className="w-full rounded bg-orange-500 text-white py-2 text-sm">この日に追加</button>
              </form>
            </div>
          </Popup>

          {/* 設定 */}
          <form onSubmit={saveSettings} className="bg-gray-50 rounded-md p-3 border border-gray-200">
            <p className="text-sm font-bold text-gray-700 mb-1">初期設定</p>
            <div className="grid grid-cols-3 gap-2 items-end">
              <label className="text-xs text-gray-600">
                初期残高
                <input name="startingBalance" inputMode="decimal" defaultValue={settings.startingBalance} className={inputCls} />
              </label>
              <label className="text-xs text-gray-600">
                通貨
                <select name="currency" defaultValue={settings.currency} className={inputCls}>
                  <option>JPY</option>
                  <option>USD</option>
                </select>
              </label>
              <button className="rounded bg-gray-600 text-white py-1.5 text-sm">保存</button>
            </div>
          </form>

          {/* 入出金 */}
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
                  <span className="font-bold">{yen(c.amount)}</span>
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
