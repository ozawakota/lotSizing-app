// 資金管理（MAXBET 型・収支記録）ページ。Google サインイン → fund-worker(Turso) と連携。
// 1件 = 日付 + 投資 + 回収 + タグ。損益=回収−投資、回収率=回収÷投資。
// 記録タブ: 残高と成績（エクイティ曲線・累計損益・勝率・PF・タグ絞り込み）→ 月間カレンダー → 口座の設定・入出金（折りたたみ）。
// ボタンの余白は内側の span に付ける（ボタン要素の余白は外部の CSS に打ち消されることがある）。
// VITE_GOOGLE_CLIENT_ID / VITE_FUND_URL 未設定時は案内のみ表示。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Popup } from '@mobiscroll/react';
import {
  aggregateByTag,
  computeSummary,
  dualGrowthPoints,
  growthDetail,
  pnlOf,
  simpleDetail,
  type Cashflow,
  type DualGrowthPoints,
  type FundSettings,
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
// リストの既定の余白（左インデント）を確実に消す（外部の CSS に Tailwind の基本スタイルが負けることがあるため）。
const LIST_RESET: React.CSSProperties = { margin: 0, padding: 0, listStyle: 'none' };
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
  const color = up ? '#16a34a' : '#dc2626';
  return (
    <div>
      <svg viewBox={`0 0 ${w} ${h}`} className="h-16 w-full" preserveAspectRatio="none" aria-label="残高の推移">
        <path d={`${d} L${w},${h} L0,${h} Z`} fill={color} opacity="0.08" />
        <path d={d} fill="none" stroke={color} strokeWidth="2" vectorEffect="non-scaling-stroke" />
      </svg>
      <div className="flex justify-between text-[10px] text-gray-400">
        <span>開始 {yenCompact(points[0])}</span>
        <span>現在 {yenCompact(points[points.length - 1])}</span>
      </div>
    </div>
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

// 複利 vs 単利の色（凡例・線・カードで共通）。
const COMPOUND_COLOR = '#2563eb'; // 複利＝加速（青）
const SIMPLE_COLOR = '#f59e0b'; // 単利＝直線（アンバー）

// 1兆未満をコンパクト表記（軸ラベル用）。例: 1,000,000→100万 / 50,000→5万。
const yenCompact = (n: number): string => {
  if (n >= 1_0000_0000) return `${(n / 1_0000_0000).toFixed(n % 1_0000_0000 ? 1 : 0)}億`;
  if (n >= 1_0000) return `${(n / 1_0000).toFixed(n % 1_0000 ? 1 : 0)}万`;
  return n.toLocaleString();
};

// 複利・単利の資金推移を同一軸に重ね描き。縦軸=起点〜目標・横軸=0〜maxMonths。
// 左に金額ラベル（起点/目標）、下に月マーカー（0/中間/最大）を添える。
function DualGrowthChart({ points, startingBalance, targetBalance, currency }: { points: DualGrowthPoints; startingBalance: number; targetBalance: number; currency: string }) {
  const w = 300;
  const h = 150;
  const span = targetBalance - startingBalance || 1;
  const mm = points.maxMonths;
  const xOf = (month: number) => (mm > 0 ? (month / mm) * w : 0);
  const yOf = (balance: number) => h - ((balance - startingBalance) / span) * h;
  const path = (pts: { month: number; balance: number }[]) =>
    pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${xOf(p.month).toFixed(1)},${yOf(p.balance).toFixed(1)}`).join(' ');
  const midMonth = Math.round(mm / 2);
  return (
    <div className="flex gap-1">
      {/* 金額ラベル */}
      <div className="flex flex-col justify-between text-right text-[10px] text-gray-500 py-px w-10 shrink-0">
        <span>{yenCompact(targetBalance)}</span>
        <span>{yenCompact(startingBalance)}</span>
      </div>
      <div className="flex-1 min-w-0">
        <svg viewBox={`0 0 ${w} ${h}`} className="w-full h-40" preserveAspectRatio="none">
          {/* 目標ライン（上端） */}
          <line x1="0" y1={yOf(targetBalance)} x2={w} y2={yOf(targetBalance)} stroke="#9ca3af" strokeWidth="1" strokeDasharray="4 3" />
          {/* 単利（先に描いて複利を前面に） */}
          <path d={path(points.simple)} fill="none" stroke={SIMPLE_COLOR} strokeWidth="2.5" />
          <path d={path(points.compound)} fill="none" stroke={COMPOUND_COLOR} strokeWidth="2.5" />
        </svg>
        {/* 月マーカー */}
        <div className="flex justify-between text-[10px] text-gray-500 mt-0.5">
          <span>0</span>
          <span>{midMonth}ヶ月</span>
          <span>{mm}ヶ月</span>
        </div>
        {/* 凡例 */}
        <div className="flex gap-3 justify-center text-[11px] mt-1">
          <span className="flex items-center gap-1"><span className="inline-block w-3 h-0.75 rounded" style={{ backgroundColor: COMPOUND_COLOR }} />複利</span>
          <span className="flex items-center gap-1"><span className="inline-block w-3 h-0.75 rounded" style={{ backgroundColor: SIMPLE_COLOR }} />単利</span>
          <span className="text-gray-400">単位: {currency}</span>
        </div>
      </div>
    </div>
  );
}

// 数値入力。編集中は空欄を許す（type=number の制御だと空文字が即 0 に戻り、
// スマホで先頭の 0 を消せない問題を避ける）。空欄のあいだは onChange を発火せず、
// 親の数値は直前の値を保持する。外部から値が変わった時だけ表示を同期。
function NumberField({
  value,
  onChange,
  className,
  min,
  max,
  step,
}: {
  value: number;
  onChange: (n: number) => void;
  className?: string;
  min?: number;
  max?: number;
  step?: number;
}) {
  const [text, setText] = useState(String(value));
  useEffect(() => {
    if (Number(text) !== value) setText(String(value)); // 入力中（パース一致）は上書きしない
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  return (
    <input
      type="number"
      inputMode="decimal"
      min={min}
      max={max}
      step={step}
      value={text}
      onChange={(e) => {
        const t = e.target.value;
        setText(t);
        if (t !== '') {
          const n = Number(t);
          if (Number.isFinite(n)) onChange(n);
        }
      }}
      className={className}
    />
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
  const points = useMemo(() => dualGrowthPoints(simParams, selectedRisk), [simParams, selectedRisk]);
  const detail = useMemo(() => growthDetail(simParams, selectedRisk), [simParams, selectedRisk]);
  const simple = useMemo(() => simpleDetail(simParams, selectedRisk), [simParams, selectedRisk]);

  const inputCls = 'rounded border border-gray-300 px-2 py-1 text-sm bg-white w-full';
  const valid = startingBalance > 0 && targetBalance > startingBalance && tradesPerMonth > 0;

  return (
    <div className="space-y-3">
      {/* 入力 */}
      <div className="space-y-2 rounded-xl bg-white p-3 shadow-sm">
        <p className="text-sm font-bold text-gray-700">条件</p>
        <div className="grid grid-cols-2 gap-2">
          <label className="text-xs text-gray-600">
            勝率（%）
            <NumberField min={0} max={100} value={winRatePct} onChange={(n) => setField({ winRatePct: n })} className={inputCls} />
          </label>
          <label className="text-xs text-gray-600">
            毎月トレード回数
            <NumberField min={1} value={tradesPerMonth} onChange={(n) => setField({ tradesPerMonth: n })} className={inputCls} />
          </label>
          <label className="text-xs text-gray-600">
            リスクリワード（1:X）
            <NumberField min={0.1} step={0.1} value={rewardRatio} onChange={(n) => setField({ rewardRatio: n })} className={inputCls} />
          </label>
          <label className="text-xs text-gray-600">
            目標金額
            <NumberField min={1} value={targetBalance} onChange={(n) => setField({ targetBalance: n })} className={inputCls} />
          </label>
        </div>
        <p className="text-[11px] text-gray-500">
          起点資金（記録タブの初期残高）: <span className="font-bold text-gray-700">{yen(startingBalance)} {currency}</span>
        </p>
        {/* リスク%（1トレードで賭ける割合）を選択 */}
        <div>
          <p className="text-xs text-gray-600 mb-1">1トレードのリスク（%）</p>
          <div className="flex gap-1.5">
            {RISK_PERCENTS.map((rp) => {
              const active = rp === selectedRisk;
              return (
                <button
                  key={rp}
                  type="button"
                  onClick={() => onSelectRisk(rp)}
                  className={`flex-1 rounded-md text-sm font-bold border transition-colors ${active ? 'text-white' : 'bg-white text-gray-600 border-gray-300'}`}
                  style={active ? { backgroundColor: RISK_COLORS[rp], borderColor: RISK_COLORS[rp] } : undefined}
                >
                  <span className="block py-1.5">{rp}%</span>
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {!valid ? (
        <div className="bg-amber-50 border border-amber-200 rounded p-3 text-sm text-amber-700">
          {startingBalance <= 0
            ? '記録タブの「初期残高」を設定すると資金推移を表示できます。'
            : '目標金額は起点資金より大きい値にしてください。'}
        </div>
      ) : (
        <>
          {/* 資金推移グラフ（複利 vs 単利） */}
          <div className="rounded-xl bg-white p-3 shadow-sm">
            <div className="flex justify-between items-baseline mb-2">
              <p className="text-sm font-bold text-gray-700">資金推移（リスク{selectedRisk}%）</p>
              <p className="text-xs text-gray-500">目標 {yen(targetBalance)} {currency}</p>
            </div>
            <DualGrowthChart points={points} startingBalance={startingBalance} targetBalance={targetBalance} currency={currency} />
          </div>

          {/* 到達比較カード（パターン1 複利 / パターン2 単利） */}
          <div className="grid grid-cols-2 gap-2">
            {/* パターン1 複利 */}
            <div className="space-y-1.5 rounded-xl border-2 bg-white p-3" style={{ borderColor: COMPOUND_COLOR }}>
              <div className="flex items-center justify-between">
                <p className="text-xs font-bold" style={{ color: COMPOUND_COLOR }}>パターン1 複利</p>
                {detail.monthsToTarget !== null && simple.monthsToTarget !== null && detail.monthsToTarget <= simple.monthsToTarget && (
                  <span className="text-[10px] font-bold text-white px-1.5 py-0.5 rounded" style={{ backgroundColor: COMPOUND_COLOR }}>最速</span>
                )}
              </div>
              <p className="text-lg font-bold text-gray-800 leading-tight">
                {detail.monthsToTarget === null ? '未到達' : formatMonths(detail.monthsToTarget)}
              </p>
              <p className="text-[11px] text-gray-500">
                {detail.tradesToTarget === null ? '期待値マイナス' : `約${detail.tradesToTarget}回のトレード`}
              </p>
              <p className="text-[11px] text-gray-500">
                月利 <span className={`font-bold ${detail.monthlyRatePct >= 0 ? 'text-green-600' : 'text-red-600'}`}>{detail.monthlyRatePct >= 0 ? '+' : ''}{detail.monthlyRatePct.toFixed(1)}%</span>
              </p>
            </div>
            {/* パターン2 単利 */}
            <div className="space-y-1.5 rounded-xl border-2 bg-white p-3" style={{ borderColor: SIMPLE_COLOR }}>
              <div className="flex items-center justify-between">
                <p className="text-xs font-bold" style={{ color: SIMPLE_COLOR }}>パターン2 単利</p>
                {simple.monthsToTarget !== null && (detail.monthsToTarget === null || simple.monthsToTarget < detail.monthsToTarget) && (
                  <span className="text-[10px] font-bold text-white px-1.5 py-0.5 rounded" style={{ backgroundColor: SIMPLE_COLOR }}>最速</span>
                )}
              </div>
              <p className="text-lg font-bold text-gray-800 leading-tight">
                {simple.monthsToTarget === null ? '未到達' : formatMonths(simple.monthsToTarget)}
              </p>
              <p className="text-[11px] text-gray-500">
                {simple.tradesToTarget === null ? '期待値マイナス' : `約${simple.tradesToTarget}回のトレード`}
              </p>
              <p className="text-[11px] text-gray-500">
                月間 <span className={`font-bold ${simple.monthlyGain >= 0 ? 'text-green-600' : 'text-red-600'}`}>{simple.monthlyGain >= 0 ? '+' : ''}{yen(Math.round(simple.monthlyGain))}</span>
              </p>
            </div>
          </div>

          {/* 1トレードの内訳（複利・単利で共通の期待値） */}
          <div className="rounded-xl bg-white p-3 shadow-sm">
            <p className="text-xs font-bold text-gray-600 mb-1">
              1トレードの内訳（平均）
              <span className="font-normal text-gray-400"> ・初回リスク額 {yen(Math.round(detail.initialRiskAmount))} {currency}</span>
            </p>
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

          {/* アクションプラン（入力から自動生成） */}
          <div className="rounded-xl border border-indigo-200 bg-indigo-50 p-3">
            <p className="text-xs font-bold text-indigo-700 mb-1">▸ アクションプラン</p>
            {detail.expectancyPct < 0 ? (
              <p className="text-xs text-gray-700 leading-relaxed">
                現在の条件（勝率{winRatePct}%・RRR1:{rewardRatio}）では1トレードの期待値がマイナスのため、資金は目標に向かいません。勝率かリスクリワードの改善が必要です。
              </p>
            ) : (
              <p className="text-xs text-gray-700 leading-relaxed">
                月{tradesPerMonth}回・リスク{selectedRisk}%・RRR1:{rewardRatio}・勝率{winRatePct}%を継続すると、
                <span className="font-bold" style={{ color: COMPOUND_COLOR }}>複利で約{formatMonths(detail.monthsToTarget)}（{detail.tradesToTarget}回）</span>、
                <span className="font-bold" style={{ color: SIMPLE_COLOR }}>単利で約{formatMonths(simple.monthsToTarget)}（{simple.tradesToTarget}回）</span>
                で目標{yen(targetBalance)}{currency}に到達する見込みです。1トレードの期待値は+{detail.expectancyPct.toFixed(2)}%（+{yen(Math.round(detail.initialExpectancyAmount))}{currency}）。まずは手法の優位性（勝率・RRR）を実績で検証しながら、毎月のトレード回数を安定させましょう。
              </p>
            )}
          </div>

          <p className="text-[11px] text-gray-400">
            ※ 複利＝毎トレード「その時点の残高×リスク%」、単利＝毎トレード「起点残高×リスク%」の固定額を賭けるモデル。複利の到達月は幾何平均（典型値）ベース。実際の成績を保証するものではありません。
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
        <div key="unconfigured" className="mx-3 my-3 p-3 bg-amber-50 border border-amber-200 rounded text-sm text-amber-700">
          未設定です。<code>VITE_GOOGLE_CLIENT_ID</code> と <code>VITE_FUND_URL</code> を設定すると使えます。
        </div>
      ) : !idToken ? (
        // key を付けて本体UIの div と区別し、React が div を使い回して GIS ボタンの iframe を残さないようにする。
        <div key="login" className="mx-3 my-4 flex flex-col items-center gap-2">
          <p className="text-sm text-gray-600">Google でログインしてください</p>
          <div ref={btnRef} />
          {error && <p className="text-xs text-red-600">{error}</p>}
        </div>
      ) : (
        <div key="app" className="mx-auto my-2 max-w-md space-y-3 px-3">
          {/* タブ（記録 / シミュレーション）とログイン中のアカウント */}
          <div className="flex items-center gap-2">
            <div role="tablist" aria-label="表示の切り替え" className="flex flex-1 rounded-lg bg-gray-100 p-0.5">
              {(['record', 'sim'] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  role="tab"
                  aria-selected={tab === t}
                  onClick={() => setTab(t)}
                  className={`flex-1 rounded-md text-xs font-semibold ${tab === t ? 'bg-white text-gray-800 shadow-sm' : 'text-gray-500'}`}
                >
                  <span className="block py-1.5">{t === 'record' ? '記録' : 'シミュレーション'}</span>
                </button>
              ))}
            </div>
          </div>
          <p className="-mt-2 truncate text-right text-[10px] text-gray-400">{email}</p>

          {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">{error}</p>}

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
          {/* 残高と成績 */}
          <section className="rounded-xl bg-white p-3 shadow-sm">
            <div className="flex items-baseline justify-between">
              <p className="text-xs text-gray-500">{selectedTag ? `「${selectedTag}」の収支` : '現在の残高'}</p>
              {!selectedTag && (
                <p className={`text-xs font-semibold ${summary.cumulativePnl >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                  {summary.cumulativePnl >= 0 ? '+' : ''}
                  {yen(summary.cumulativePnl)}
                </p>
              )}
            </div>
            <p className="mt-0.5 text-3xl font-bold tabular-nums text-gray-900">
              {selectedTag ? (
                <span className={summary.cumulativePnl >= 0 ? 'text-green-600' : 'text-red-600'}>
                  {summary.cumulativePnl >= 0 ? '+' : ''}
                  {yen(summary.cumulativePnl)}
                </span>
              ) : (
                <>
                  {yen(summary.balance)}
                  <span className="ml-1 text-sm font-semibold text-gray-500">{summary.currency}</span>
                </>
              )}
            </p>
            {!selectedTag && <EquityCurve startingBalance={summary.startingBalance} balances={summary.equityCurve.map((p) => p.balance)} />}
            <div className="mt-2 grid grid-cols-3 divide-x divide-gray-100 rounded-lg bg-gray-50 text-center">
              <div className="py-2">
                <p className="text-[10px] text-gray-500">累計損益</p>
                <p className={`text-sm font-bold tabular-nums ${summary.cumulativePnl >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                  {summary.cumulativePnl >= 0 ? '+' : ''}
                  {yen(summary.cumulativePnl)}
                </p>
              </div>
              <div className="py-2">
                <p className="text-[10px] text-gray-500">勝率</p>
                <p className="text-sm font-bold tabular-nums text-gray-800">{(summary.winRate * 100).toFixed(0)}%</p>
                <p className="text-[10px] tabular-nums text-gray-400">
                  {summary.wins}勝{summary.losses}敗
                </p>
              </div>
              <div className="py-2">
                <p className="text-[10px] text-gray-500">PF（損益比）</p>
                <p className={`text-sm font-bold tabular-nums ${pf === null || pf >= 1 ? 'text-green-600' : 'text-red-600'}`}>
                  {pf === null ? '—' : pf.toFixed(2)}
                </p>
              </div>
            </div>

            {/* タグで絞り込み */}
            {tagAggs.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1">
                {[null, ...tagAggs.map((a) => a.tag)].map((tag) => {
                  const on = selectedTag === tag;
                  return (
                    <button
                      key={tag ?? '__all'}
                      type="button"
                      onClick={() => setSelectedTag(tag === null || tag === selectedTag ? null : tag)}
                      className={`rounded-full border text-[11px] ${on ? 'border-orange-500 bg-orange-500 text-white' : 'border-gray-200 bg-white text-gray-600'}`}
                    >
                      <span className="block px-2 py-0.5">{tag ?? 'すべて'}</span>
                    </button>
                  );
                })}
              </div>
            )}
          </section>

          {/* 月間損益カレンダー */}
          <section>
            <p className="mb-1 flex items-baseline justify-between px-1 text-xs font-bold text-gray-700">
              月間カレンダー<span className="text-[10px] font-normal text-gray-400">日付をタップして記録</span>
            </p>
            <TradeCalendar trades={viewTrades} selectedDate={selectedDate} onSelectDate={setSelectedDate} />
          </section>

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
                      <button type="button" onClick={() => del('trades', t.id)} aria-label="この記録を削除" className="text-gray-400 hover:text-red-500">
                        <span className="block px-1.5 text-base leading-none">×</span>
                      </button>
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
                      className={`flex-1 font-bold ${
                        tradeResult === r
                          ? r === 'win'
                            ? 'bg-green-500 text-white'
                            : 'bg-red-500 text-white'
                          : 'bg-white text-gray-500'
                      }`}
                    >
                      <span className="block py-2">{r === 'win' ? '勝ち' : '負け'}</span>
                    </button>
                  ))}
                </div>
                <input name="amount" inputMode="decimal" placeholder="損益額（円）" className={inputCls} required />
                <button className="w-full rounded-lg bg-orange-500 text-sm font-semibold text-white">
                  <span className="block py-2">この日に追加</span>
                </button>
              </form>
            </div>
          </Popup>

          {/* 口座の設定と入出金（使う頻度が低いので折りたたみ） */}
          <details className="rounded-xl bg-white shadow-sm" open={settings.startingBalance <= 0}>
            <summary className="flex cursor-pointer list-none items-baseline px-3 py-2.5 text-xs font-bold text-gray-700">
              口座の設定・入出金
              <span className="ml-1.5 font-normal text-gray-400">
                初期残高 {yen(settings.startingBalance)} {settings.currency}・入出金 {cashflows.length}件
              </span>
              <span aria-hidden className="ml-auto text-gray-400">▾</span>
            </summary>
            <div className="space-y-3 border-t border-gray-100 p-3">
              {/* 設定: 非制御入力(defaultValue)はマウント時のみ値を読むため、settings が非同期ロードされたら key でフォームを再マウントして反映する。 */}
              <form key={`${settings.startingBalance}-${settings.currency}`} onSubmit={saveSettings}>
                <p className="mb-1 text-xs font-semibold text-gray-600">初期設定</p>
                <div className="grid grid-cols-[1fr_5rem_4rem] items-end gap-2">
                  <label className="text-[11px] text-gray-500">
                    初期残高
                    <input name="startingBalance" inputMode="decimal" defaultValue={settings.startingBalance} className={inputCls} />
                  </label>
                  <label className="text-[11px] text-gray-500">
                    通貨
                    <select name="currency" defaultValue={settings.currency} className={inputCls}>
                      <option>JPY</option>
                      <option>USD</option>
                    </select>
                  </label>
                  <button className="rounded bg-gray-700 text-sm text-white">
                    <span className="block py-1.5">保存</span>
                  </button>
                </div>
              </form>

              <form onSubmit={addCashflow}>
                <p className="mb-1 text-xs font-semibold text-gray-600">入出金を追加</p>
                <div className="grid grid-cols-[1fr_4.5rem_1fr] gap-2">
                  <input name="date" type="date" defaultValue={today()} className={inputCls} required />
                  <select name="type" className={inputCls}>
                    <option value="deposit">入金</option>
                    <option value="withdrawal">出金</option>
                  </select>
                  <input name="amount" inputMode="decimal" placeholder="金額" className={inputCls} required />
                </div>
                <button className="mt-2 w-full rounded-lg bg-orange-500 text-sm font-semibold text-white">
                  <span className="block py-1.5">追加</span>
                </button>
              </form>

              {cashflows.length > 0 && (
                <ul className="divide-y divide-gray-100 rounded-lg border border-gray-100" style={LIST_RESET}>
                  {cashflows.map((c) => (
                    <li key={c.id} className="flex items-center gap-2 px-3 py-1.5 text-xs">
                      <span className="w-20 shrink-0 tabular-nums text-gray-500">{c.date}</span>
                      <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${c.type === 'deposit' ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'}`}>
                        {c.type === 'deposit' ? '入金' : '出金'}
                      </span>
                      <span className={`ml-auto font-bold tabular-nums ${c.type === 'deposit' ? 'text-green-700' : 'text-red-700'}`}>
                        {c.type === 'deposit' ? '+' : '−'}
                        {yen(c.amount)}
                      </span>
                      <button type="button" onClick={() => del('cashflows', c.id)} aria-label="この入出金を削除" className="text-gray-400 hover:text-red-500">
                        <span className="block px-1.5 text-base leading-none">×</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </details>
          </>
          )}
        </div>
      )}
    </>
  );
}
