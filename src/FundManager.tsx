// 資金管理（MAXBET 型・収支記録）ページ。Google サインイン → fund-worker(Turso) と連携。
// 1件 = 日付 + 投資 + 回収 + タグ。損益=回収−投資、回収率=回収÷投資。
// 月間損益カレンダー・エクイティ曲線・タグ絞り込みに対応。
// VITE_GOOGLE_CLIENT_ID / VITE_FUND_URL 未設定時は案内のみ表示。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Popup } from '@mobiscroll/react';
import {
  aggregateByTag,
  computeSummary,
  growthDetail,
  pnlOf,
  simulateGrowth,
  type Cashflow,
  type FundSettings,
  type GrowthResult,
  type Trade,
} from '@/lib/fund';
import TradeCalendar from './TradeCalendar';

const CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined;
const FUND_URL = import.meta.env.VITE_FUND_URL as string | undefined;

interface GoogleId {
  accounts: {
    id: {
      initialize: (cfg: { client_id: string; callback: (r: { credential: string }) => void; auto_select?: boolean }) => void;
      renderButton: (el: HTMLElement, opts: Record<string, unknown>) => void;
    };
  };
}
declare global {
  interface Window {
    google?: GoogleId;
  }
}

const STORAGE_KEY = 'fund_id_token';

const decodePayload = (idToken: string): { email?: string; exp?: number } => {
  try {
    return JSON.parse(atob(idToken.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
  } catch {
    return {};
  }
};
const decodeEmail = (idToken: string): string => decodePayload(idToken).email ?? '';
// 失効していない（exp が未来）か。
const tokenValid = (idToken: string): boolean => {
  const exp = decodePayload(idToken).exp;
  return typeof exp === 'number' && exp * 1000 > Date.now();
};
const storedToken = (): string => {
  const t = localStorage.getItem(STORAGE_KEY);
  return t && tokenValid(t) ? t : '';
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

// リスク%ごとの色（2→5% でリスク増）。
const RISK_COLORS: Record<number, string> = { 2: '#3b82f6', 3: '#16a34a', 4: '#f59e0b', 5: '#dc2626' };
const RISK_PERCENTS = [2, 3, 4, 5];

// 月数を「Nヶ月」/「X年Yヶ月」で表示（未到達は「—」）。
const formatMonths = (m: number | null): string => {
  if (m === null) return '—';
  const months = Math.ceil(m);
  if (months < 12) return `${months}ヶ月`;
  const y = Math.floor(months / 12);
  const mo = months % 12;
  return mo === 0 ? `${y}年` : `${y}年${mo}ヶ月`;
};

// リスク%別の資金推移を重ね描きする折れ線グラフ。縦軸=起点〜目標・横軸=0〜maxMonths。
function GrowthChart({ result, startingBalance, targetBalance }: { result: GrowthResult; startingBalance: number; targetBalance: number }) {
  const w = 300;
  const h = 150;
  const span = targetBalance - startingBalance || 1;
  const xOf = (month: number) => (result.maxMonths > 0 ? (month / result.maxMonths) * w : 0);
  const yOf = (balance: number) => h - ((balance - startingBalance) / span) * h;
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="w-full h-40">
      {/* 目標ライン（上端） */}
      <line x1="0" y1={yOf(targetBalance)} x2={w} y2={yOf(targetBalance)} stroke="#9ca3af" strokeWidth="1" strokeDasharray="4 3" />
      {result.lines.map((l) => (
        <path
          key={l.riskPercent}
          d={l.points.map((p, i) => `${i === 0 ? 'M' : 'L'}${xOf(p.month).toFixed(1)},${yOf(p.balance).toFixed(1)}`).join(' ')}
          fill="none"
          stroke={RISK_COLORS[l.riskPercent] ?? '#6b7280'}
          strokeWidth="2"
        />
      ))}
    </svg>
  );
}

// シミュレーション入力。タブ切り替えで失わないよう親で保持する。
interface SimInputs {
  winRatePct: number;
  tradesPerMonth: number;
  rewardRatio: number;
  targetBalance: number;
}
const DEFAULT_SIM_INPUTS: SimInputs = { winRatePct: 50, tradesPerMonth: 20, rewardRatio: 3, targetBalance: 1_000_000 };

// シミュレーション入力はページ移動・再読み込みでも失わないよう localStorage に保持する。
const SIM_INPUTS_KEY = 'fund_sim_inputs';
const SIM_RISK_KEY = 'fund_sim_risk';
const loadSimInputs = (): SimInputs => {
  try {
    const p = JSON.parse(localStorage.getItem(SIM_INPUTS_KEY) ?? '{}') as Partial<SimInputs>;
    return {
      winRatePct: Number(p.winRatePct ?? DEFAULT_SIM_INPUTS.winRatePct),
      tradesPerMonth: Number(p.tradesPerMonth ?? DEFAULT_SIM_INPUTS.tradesPerMonth),
      rewardRatio: Number(p.rewardRatio ?? DEFAULT_SIM_INPUTS.rewardRatio),
      targetBalance: Number(p.targetBalance ?? DEFAULT_SIM_INPUTS.targetBalance),
    };
  } catch {
    return DEFAULT_SIM_INPUTS;
  }
};
const loadSimRisk = (): number => {
  const n = Number(localStorage.getItem(SIM_RISK_KEY));
  return RISK_PERCENTS.includes(n) ? n : 2;
};

// 資金推移シミュレーションタブ。起点=記録タブの初期残高を流用。入力値は親が保持（制御コンポーネント）。
function SimulationTab({
  startingBalance,
  currency,
  inputs,
  onChange,
  selectedRisk,
  onSelectRisk,
}: {
  startingBalance: number;
  currency: string;
  inputs: SimInputs;
  onChange: (next: SimInputs) => void;
  selectedRisk: number;
  onSelectRisk: (r: number) => void;
}) {
  const { winRatePct, tradesPerMonth, rewardRatio, targetBalance } = inputs;
  const setField = (patch: Partial<SimInputs>) => onChange({ ...inputs, ...patch });

  const simParams = useMemo(
    () => ({
      startingBalance,
      targetBalance,
      winRate: winRatePct / 100,
      tradesPerMonth,
      rewardRatio,
      riskPercents: RISK_PERCENTS,
    }),
    [startingBalance, targetBalance, winRatePct, tradesPerMonth, rewardRatio],
  );
  const result = useMemo(() => simulateGrowth(simParams), [simParams]);
  const detail = useMemo(() => growthDetail(simParams, selectedRisk), [simParams, selectedRisk]);

  const inputCls = 'rounded border border-gray-300 px-2 py-1 text-sm bg-white w-full';
  const valid = startingBalance > 0 && targetBalance > startingBalance && tradesPerMonth > 0;

  return (
    <div className="space-y-3">
      {/* 入力 */}
      <div className="bg-gray-50 rounded-md p-3 border border-gray-200 space-y-2">
        <p className="text-sm font-bold text-gray-700">条件</p>
        <div className="grid grid-cols-2 gap-2">
          <label className="text-xs text-gray-600">
            勝率（%）
            <input type="number" min={0} max={100} value={winRatePct} onChange={(e) => setField({ winRatePct: Number(e.target.value) })} className={inputCls} />
          </label>
          <label className="text-xs text-gray-600">
            毎月トレード回数
            <input type="number" min={1} value={tradesPerMonth} onChange={(e) => setField({ tradesPerMonth: Number(e.target.value) })} className={inputCls} />
          </label>
          <label className="text-xs text-gray-600">
            リスクリワード（1:X）
            <input type="number" min={0.1} step={0.1} value={rewardRatio} onChange={(e) => setField({ rewardRatio: Number(e.target.value) })} className={inputCls} />
          </label>
          <label className="text-xs text-gray-600">
            目標金額
            <input type="number" min={1} value={targetBalance} onChange={(e) => setField({ targetBalance: Number(e.target.value) })} className={inputCls} />
          </label>
        </div>
        <p className="text-[11px] text-gray-500">
          起点資金（記録タブの初期残高）: <span className="font-bold text-gray-700">{yen(startingBalance)} {currency}</span>
        </p>
      </div>

      {!valid ? (
        <div className="bg-amber-50 border border-amber-200 rounded p-3 text-sm text-amber-700">
          {startingBalance <= 0
            ? '記録タブの「初期残高」を設定すると資金推移を表示できます。'
            : '目標金額は起点資金より大きい値にしてください。'}
        </div>
      ) : (
        <>
          {/* グラフ */}
          <div className="bg-blue-50 rounded-md p-3 border border-blue-200">
            <div className="flex justify-between items-baseline mb-1">
              <p className="text-sm text-gray-600">資金推移（複利・リスク%別）</p>
              <p className="text-xs text-gray-500">目標 {yen(targetBalance)} {currency}</p>
            </div>
            <GrowthChart result={result} startingBalance={startingBalance} targetBalance={targetBalance} />
          </div>

          {/* 到達一覧（タップで詳細表示するリスク%を選択） */}
          <div className="bg-white rounded-md border border-gray-200 divide-y">
            {result.lines.map((l) => {
              const active = l.riskPercent === selectedRisk;
              return (
                <button
                  type="button"
                  key={l.riskPercent}
                  onClick={() => onSelectRisk(l.riskPercent)}
                  className={`w-full flex items-center justify-between px-3 py-2 text-sm text-left ${active ? 'bg-orange-50' : 'bg-white'}`}
                >
                  <span className="flex items-center gap-2">
                    <span className="inline-block w-3 h-3 rounded-sm" style={{ backgroundColor: RISK_COLORS[l.riskPercent] }} />
                    <span className={active ? 'font-bold text-orange-700' : ''}>リスク {l.riskPercent}%</span>
                  </span>
                  <span className={l.monthsToTarget === null ? 'text-red-600 text-xs' : 'font-bold text-gray-800'}>
                    {l.monthsToTarget === null ? '未到達（期待値マイナス）' : `${formatMonths(l.monthsToTarget)}で到達`}
                  </span>
                </button>
              );
            })}
          </div>

          {/* 選択リスク%の詳細 */}
          <div className="rounded-md border p-3 space-y-3" style={{ borderColor: RISK_COLORS[selectedRisk] ?? '#d1d5db' }}>
            <p className="text-sm font-bold text-gray-700">
              リスク {selectedRisk}% の詳細
              <span className="font-normal text-[11px] text-gray-500"> ・初回リスク額 {yen(Math.round(detail.initialRiskAmount))} {currency}</span>
            </p>

            {/* 1トレードの内訳（算術平均） */}
            <div>
              <p className="text-xs font-bold text-gray-600 mb-1">1トレードの内訳（平均）</p>
              <div className="grid grid-cols-3 gap-2 text-center text-xs">
                <div className="bg-green-50 rounded py-1">
                  <p className="text-gray-500">勝ち（{winRatePct}%）</p>
                  <p className="font-bold text-green-600">+{detail.winPct.toFixed(1)}%</p>
                  <p className="text-[11px] text-gray-500">+{yen(Math.round(detail.initialWinAmount))}</p>
                </div>
                <div className="bg-red-50 rounded py-1">
                  <p className="text-gray-500">負け（{100 - winRatePct}%）</p>
                  <p className="font-bold text-red-600">−{detail.lossPct.toFixed(1)}%</p>
                  <p className="text-[11px] text-gray-500">−{yen(Math.round(detail.initialRiskAmount))}</p>
                </div>
                <div className="bg-blue-50 rounded py-1">
                  <p className="text-gray-500">期待値</p>
                  <p className={`font-bold ${detail.expectancyPct >= 0 ? 'text-blue-700' : 'text-red-600'}`}>
                    {detail.expectancyPct >= 0 ? '+' : ''}{detail.expectancyPct.toFixed(2)}%
                  </p>
                  <p className="text-[11px] text-gray-500">
                    {detail.initialExpectancyAmount >= 0 ? '+' : ''}{yen(Math.round(detail.initialExpectancyAmount))}
                  </p>
                </div>
              </div>
            </div>

            {/* 複利の推移（幾何平均） */}
            <div>
              <p className="text-xs font-bold text-gray-600 mb-1">複利の推移</p>
              <div className="grid grid-cols-3 gap-2 text-center text-xs">
                <div>
                  <p className="text-gray-500">月利</p>
                  <p className={`font-bold ${detail.monthlyRatePct >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                    {detail.monthlyRatePct >= 0 ? '+' : ''}{detail.monthlyRatePct.toFixed(1)}%
                  </p>
                </div>
                <div>
                  <p className="text-gray-500">初月の増加額</p>
                  <p className={`font-bold ${detail.firstMonthGain >= 0 ? 'text-gray-800' : 'text-red-600'}`}>
                    {detail.firstMonthGain >= 0 ? '+' : ''}{yen(Math.round(detail.firstMonthGain))}
                  </p>
                </div>
                <div>
                  <p className="text-gray-500">目標到達</p>
                  <p className="font-bold text-gray-800">
                    {detail.monthsToTarget === null ? '未到達' : `${formatMonths(detail.monthsToTarget)}`}
                  </p>
                  {detail.tradesToTarget !== null && <p className="text-[11px] text-gray-500">約{detail.tradesToTarget}回</p>}
                </div>
              </div>
            </div>
          </div>

          <p className="text-[11px] text-gray-400">
            ※ 毎トレード「その時点の残高×リスク%」を賭ける複利・期待値モデル。内訳は1トレードの平均（算術）、推移グラフ・到達月は幾何平均（典型値）ベース。実際の成績を保証するものではありません。
          </p>
        </>
      )}
    </div>
  );
}

export default function FundManager() {
  const [idToken, setIdToken] = useState(storedToken); // 有効な保存トークンがあれば復元
  const [email, setEmail] = useState(() => (storedToken() ? decodeEmail(storedToken()) : ''));
  const [settings, setSettings] = useState<FundSettings>({ startingBalance: 0, currency: 'JPY' });
  const [trades, setTrades] = useState<Trade[]>([]);
  const [cashflows, setCashflows] = useState<Cashflow[]>([]);
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [selectedTag, setSelectedTag] = useState<string | null>(null);
  const [tradeResult, setTradeResult] = useState<'win' | 'loss'>('win'); // 追加フォームの勝ち/負け
  const [error, setError] = useState('');
  const [tab, setTab] = useState<'record' | 'sim'>('record'); // 記録 / シミュレーション
  const [simInputs, setSimInputs] = useState<SimInputs>(loadSimInputs); // ページ移動・再読み込みでも保持（localStorage）
  const [selectedRisk, setSelectedRisk] = useState<number>(loadSimRisk); // 詳細表示するリスク%（localStorage 保持）
  const [toast, setToast] = useState(''); // 保存完了などの一時トースト
  const btnRef = useRef<HTMLDivElement>(null);

  // トーストは約2秒で自動的に消す。
  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(''), 2000);
    return () => clearTimeout(id);
  }, [toast]);

  // シミュレーション入力・選択リスク%を localStorage に保存（ページ移動後も復元）。
  useEffect(() => {
    localStorage.setItem(SIM_INPUTS_KEY, JSON.stringify(simInputs));
  }, [simInputs]);
  useEffect(() => {
    localStorage.setItem(SIM_RISK_KEY, String(selectedRisk));
  }, [selectedRisk]);

  const configured = Boolean(CLIENT_ID && FUND_URL);

  const api = useCallback(
    async (path: string, init?: RequestInit) => {
      const res = await fetch(`${FUND_URL}${path}`, {
        ...init,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}`, ...(init?.headers ?? {}) },
      });
      if (res.status === 401 || res.status === 403) {
        localStorage.removeItem(STORAGE_KEY);
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
        auto_select: true, // 前回同意済みなら再読み込み時にクリック不要で自動サインイン
        callback: (r) => {
          localStorage.setItem(STORAGE_KEY, r.credential);
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

  // モーダルを開く日が変わったら勝ち/負けを既定（勝ち）に戻す。
  useEffect(() => {
    setTradeResult('win');
  }, [selectedDate]);

  // タグ絞り込み中はそのタグを含むトレードだけを対象にする。
  const viewTrades = useMemo(
    () => (selectedTag ? trades.filter((t) => t.tags.includes(selectedTag)) : trades),
    [trades, selectedTag],
  );
  const summary = useMemo(() => computeSummary(settings, viewTrades, cashflows), [settings, viewTrades, cashflows]);
  const tagAggs = useMemo(() => aggregateByTag(trades).sort((a, b) => b.count - a.count), [trades]);

  const addTrade = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!selectedDate) return;
    const form = e.currentTarget;
    const f = new FormData(form);
    const amount = Math.abs(Number(f.get('amount')));
    // 勝ち→回収に、負け→投資に金額を入れる（損益 = 回収 − 投資 = ±金額）。
    try {
      await api('/trades', {
        method: 'POST',
        body: JSON.stringify({
          date: selectedDate,
          invested: tradeResult === 'loss' ? amount : 0,
          recovered: tradeResult === 'win' ? amount : 0,
          tags: [],
        }),
      });
      form.reset();
      setTradeResult('win');
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
      setToast('保存しました');
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
  // PF（プロフィットファクター）= 総利益 ÷ 総損失。損失ゼロ時は算出不能（—）。
  const pf = summary.totalInvested > 0 ? summary.totalRecovered / summary.totalInvested : null;

  return (
    <>
      {/* 保存完了などの一時トースト（下中央・約2秒で自動消去） */}
      {toast && (
        <div className="fixed bottom-20 left-1/2 -translate-x-1/2 z-50 bg-gray-800 text-white text-sm px-4 py-2 rounded-full shadow-lg">
          {toast}
        </div>
      )}
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

          {/* タブ: 記録 / シミュレーション */}
          <div className="flex rounded-md border border-gray-200 overflow-hidden text-sm">
            {(['record', 'sim'] as const).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setTab(t)}
                className={`flex-1 py-1.5 ${tab === t ? 'bg-orange-500 text-white' : 'bg-white text-gray-600'}`}
              >
                {t === 'record' ? '記録' : 'シミュレーション'}
              </button>
            ))}
          </div>

          {error && <p className="text-sm text-red-600">{error}</p>}

          {tab === 'sim' ? (
            <SimulationTab
              startingBalance={settings.startingBalance}
              currency={settings.currency}
              inputs={simInputs}
              onChange={setSimInputs}
              selectedRisk={selectedRisk}
              onSelectRisk={setSelectedRisk}
            />
          ) : (
          <>
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
                <p className="text-gray-500">累計損益</p>
                <p className={`font-bold ${summary.cumulativePnl >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                  {summary.cumulativePnl >= 0 ? '+' : ''}{yen(summary.cumulativePnl)}
                </p>
              </div>
              <div>
                <p className="text-gray-500">勝率</p>
                <p className="font-bold">
                  {(summary.winRate * 100).toFixed(0)}%（{summary.wins}/{summary.wins + summary.losses}）
                </p>
              </div>
              <div>
                <p className="text-gray-500">PF（損益比）</p>
                <p className={`font-bold ${pf === null || pf >= 1 ? 'text-green-600' : 'text-red-600'}`}>
                  {pf === null ? '—' : pf.toFixed(2)}
                </p>
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
                      <span className={`shrink-0 font-bold ${pnlOf(t) >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                        {pnlOf(t) >= 0 ? '勝ち' : '負け'}
                      </span>
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
                {/* 勝ち/負けトグル */}
                <div className="flex rounded-md border border-gray-200 overflow-hidden text-sm">
                  {(['win', 'loss'] as const).map((r) => (
                    <button
                      type="button"
                      key={r}
                      onClick={() => setTradeResult(r)}
                      className={`flex-1 py-1.5 font-bold ${
                        tradeResult === r
                          ? r === 'win'
                            ? 'bg-green-500 text-white'
                            : 'bg-red-500 text-white'
                          : 'bg-white text-gray-500'
                      }`}
                    >
                      {r === 'win' ? '勝ち' : '負け'}
                    </button>
                  ))}
                </div>
                <input name="amount" inputMode="decimal" placeholder="損益額（円）" className={inputCls} required />
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
          </>
          )}
        </div>
      )}
    </>
  );
}
