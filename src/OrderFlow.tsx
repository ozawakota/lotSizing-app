// 取引量・センチメント ページ。
// 個人投資家（Myfxbook Community Outlook の建玉）と大口投機筋（CFTC COT）の偏りを、ペアごとに1行で並べる。
// 各カードは「個人」「大口」の2本のバーと、両者が逆向きかどうかのバッジだけを常に見せ、
// 取引量の実数・前回比・最大取引量はタップで開く詳細にまとめる。
// 並びは「自分の順（ドラッグで並び替え・localStorage に保存）」「偏りが大きい順」「逆行のみ」から選ぶ。
// Cloudflare Worker(Cron+KV) がキャッシュした /flow を読むだけ。
import { FC, useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, ChevronDown, GripVertical, Info, Minus, RefreshCw, TrendingDown, TrendingUp, type LucideIcon } from 'lucide-react';
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import { SortableContext, arrayMove, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  FLOW_ORDER_STORAGE_KEY,
  FLOW_PAIRS,
  FLOW_SORT_STORAGE_KEY,
  FlowDelta,
  FlowPair,
  FlowSnapshot,
  FlowSortMode,
  Lean,
  PairCot,
  PairFlow,
  SpecStrength,
  applyPairOrder,
  flowContrast,
  retailSkew,
  sortFlowPairs,
  specStrength,
} from '@/lib/flow';
import FlowInfoModal from './FlowInfoModal';
import { LIST_ITEM_RESET, LIST_RESET } from '@/lib/listReset';

const REFRESH_MS = 60 * 60 * 1000; // 1時間

const fetchFlow = async (): Promise<FlowSnapshot> => {
  const url = import.meta.env.VITE_FLOW_URL as string | undefined;
  if (!url) throw new Error('取引量エンドポイント(VITE_FLOW_URL)が未設定です');
  const res = await fetch(url);
  if (!res.ok) throw new Error(`取引量API HTTP ${res.status}`);
  const data = (await res.json()) as FlowSnapshot | { error: string };
  if ('error' in data) throw new Error(data.error);
  return data;
};

// localStorage から保存済みの表示順を読み、現在の対象ペアに適用して返す。
const loadOrder = (): FlowPair[] => {
  try {
    const raw = localStorage.getItem(FLOW_ORDER_STORAGE_KEY);
    const saved = raw ? (JSON.parse(raw) as unknown) : [];
    return applyPairOrder(Array.isArray(saved) ? (saved as string[]) : [], FLOW_PAIRS);
  } catch {
    return [...FLOW_PAIRS];
  }
};

const SORT_OPTIONS: { mode: FlowSortMode; label: string }[] = [
  { mode: 'custom', label: '自分の順' },
  { mode: 'skew', label: '偏りが大きい順' },
  { mode: 'opposite', label: '逆行のみ' },
];

const loadSortMode = (): FlowSortMode => {
  try {
    const v = localStorage.getItem(FLOW_SORT_STORAGE_KEY);
    return SORT_OPTIONS.some((o) => o.mode === v) ? (v as FlowSortMode) : 'custom';
  } catch {
    return 'custom';
  }
};

const saveLocal = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value);
  } catch {
    // 保存できなくても表示はそのまま使える（セッション内で維持）。
  }
};

const LEAN_TEXT: Record<Lean, string> = { buy: 'text-green-600', sell: 'text-red-600', neutral: 'text-gray-400' };
const RETAIL_LABEL: Record<Lean, string> = { buy: '買い', sell: '売り', neutral: '拮抗' };
const SPEC_LABEL: Record<Lean, string> = { buy: '買い越し', sell: '売り越し', neutral: '中立' };
const STRENGTH_LABEL: Record<SpecStrength, string> = { weak: '弱', mid: '中', strong: '強' };

// 前回（1時間前）からの合計建玉の増減。
const DELTA_STYLE: Record<FlowDelta['direction'], { cls: string; Icon: LucideIcon; label: string }> = {
  entry: { cls: 'text-green-700', Icon: TrendingUp, label: '建玉 増' },
  settlement: { cls: 'text-red-700', Icon: TrendingDown, label: '建玉 減' },
  flat: { cls: 'text-gray-400', Icon: Minus, label: '横ばい' },
};

// 符号付きの差分を "+1,234" / "−567" / "±0"（全角マイナス）で表す。
const formatDeltaValue = (value: number): string => {
  if (value === 0) return '±0';
  return `${value > 0 ? '+' : '−'}${Math.abs(value).toLocaleString()}`;
};

// ISO8601 → "MM/DD"（CFTC 報告日・週次）。
const formatReportDate = (iso: string): string => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('ja-JP', { month: '2-digit', day: '2-digit' });
};

// ISO8601 → "MM/DD HH:mm"。
const formatDateTime = (iso: string): string => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('ja-JP', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
};

// ISO8601 → "たった今" / "12分前" / "3時間前" / "MM/DD HH:mm"。
const formatAgo = (iso: string, now: number): string => {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return iso;
  const min = Math.floor((now - t) / 60_000);
  if (min < 1) return 'たった今';
  if (min < 60) return `${min}分前`;
  if (min < 24 * 60) return `${Math.floor(min / 60)}時間前`;
  return formatDateTime(iso);
};

// 行の左端のラベル（個人 / 大口）。幅をそろえてバーの開始位置を合わせる。
const RowLabel: FC<{ children: string }> = ({ children }) => (
  <span className="w-7 shrink-0 text-[11px] font-semibold text-gray-500">{children}</span>
);

// 個人投資家: 買い(緑)｜売り(赤) の割合バー。多い側の割合を右に大きく出す。
const RetailRow: FC<{ flow: PairFlow }> = ({ flow }) => {
  const skew = retailSkew(flow);
  const delta = flow.delta ? DELTA_STYLE[flow.delta.direction] : null;
  return (
    <div className="flex items-center gap-2">
      <RowLabel>個人</RowLabel>
      <div className="relative flex h-3 flex-1 overflow-hidden rounded-full bg-gray-200" aria-hidden="true">
        <div className="bg-green-500" style={{ width: `${flow.longPct}%` }} />
        <div className="bg-red-500" style={{ width: `${flow.shortPct}%` }} />
        <div className="absolute left-1/2 top-0 h-full w-px bg-white/80" />
      </div>
      <span className={`w-[5.75rem] shrink-0 whitespace-nowrap text-right text-sm font-bold tabular-nums ${LEAN_TEXT[skew.side]}`}>
        {RETAIL_LABEL[skew.side]} {skew.pct.toFixed(0)}%
      </span>
      <span className="sr-only">
        個人投資家 買い{flow.longPct.toFixed(0)}% 売り{flow.shortPct.toFixed(0)}%{skew.crowded ? '（偏り大）' : ''}
        {delta ? `、前回から${delta.label}` : ''}
      </span>
      {/* 偏り大 / 前回比は1行に収まる小さな印で示す */}
      <span className="flex w-11 shrink-0 flex-col items-end gap-0.5 whitespace-nowrap leading-none" aria-hidden="true">
        {skew.crowded && <span className="rounded bg-amber-100 px-1 py-0.5 text-[9px] font-bold text-amber-700">偏り大</span>}
        {delta && (
          <span className={`flex items-center gap-0.5 text-[9px] ${delta.cls}`}>
            <delta.Icon className="h-2.5 w-2.5" />
            {delta.label.replace('建玉 ', '')}
          </span>
        )}
      </span>
    </div>
  );
};

// 大口投機筋: 中央から左右に伸びるバー（右=買い越し緑 / 左=売り越し赤）。
const SpecRow: FC<{ cot?: PairCot }> = ({ cot }) => {
  if (!cot) {
    return (
      <div className="flex items-center gap-2">
        <RowLabel>大口</RowLabel>
        <span className="text-[11px] text-gray-400">データなし</span>
      </div>
    );
  }
  const mag = Math.min(Math.abs(cot.net) / 2, 1) * 50; // 片側最大50%
  const buy = cot.net > 0;
  const strength = cot.lean === 'neutral' ? '' : `・${STRENGTH_LABEL[specStrength(cot.net)]}`;
  // 前週比: ネットが今の向きへ進めば「強まる」、戻せば「弱まる」。
  const wow = (() => {
    if (cot.deltaNet === undefined || cot.deltaNet === 0) return null;
    const towardBuy = cot.deltaNet > 0;
    if (cot.lean === 'neutral') return { up: towardBuy, text: towardBuy ? '買い寄り' : '売り寄り' };
    const stronger = cot.net > 0 === towardBuy;
    return { up: towardBuy, text: stronger ? '強まる' : '弱まる' };
  })();
  return (
    <div className="flex items-center gap-2">
      <RowLabel>大口</RowLabel>
      <div className="relative h-3 flex-1 overflow-hidden rounded-full bg-gray-200" aria-hidden="true">
        <div className="absolute left-1/2 top-0 h-full w-px -translate-x-1/2 bg-gray-400" />
        <div
          className={`absolute top-0 h-full ${buy ? 'bg-green-500' : 'bg-red-500'}`}
          style={buy ? { left: '50%', width: `${mag}%` } : { right: '50%', width: `${mag}%` }}
        />
      </div>
      <span className={`w-[5.75rem] shrink-0 whitespace-nowrap text-right text-sm font-bold ${LEAN_TEXT[cot.lean]}`}>
        {SPEC_LABEL[cot.lean]}
        <span className="text-[11px]">{strength}</span>
      </span>
      <span className="w-11 shrink-0 whitespace-nowrap text-right text-[9px] leading-none text-gray-500">
        {wow && (
          <span className="inline-flex items-center gap-0.5">
            {wow.up ? <TrendingUp className="h-2.5 w-2.5" aria-hidden="true" /> : <TrendingDown className="h-2.5 w-2.5" aria-hidden="true" />}
            {wow.text}
          </span>
        )}
      </span>
    </div>
  );
};

// タップで開く詳細（実数）。
const Details: FC<{ flow: PairFlow }> = ({ flow }) => (
  <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 rounded-md bg-gray-50 px-2.5 py-2 text-[11px] tabular-nums">
    <dt className="text-gray-500">買い量</dt>
    <dd className="text-right text-green-700">{flow.longVolume.toLocaleString()}</dd>
    <dt className="text-gray-500">売り量</dt>
    <dd className="text-right text-red-700">{flow.shortVolume.toLocaleString()}</dd>
    <dt className="text-gray-500">前回比（合計）</dt>
    <dd className="text-right text-gray-700">{flow.delta ? formatDeltaValue(flow.delta.value) : '—'}</dd>
    {flow.peak && (
      <>
        <dt className="text-gray-500">記録上の最大</dt>
        <dd className="text-right text-gray-700">{flow.peak.volume.toLocaleString()}</dd>
        <dt className="text-gray-500">その日時・レート</dt>
        <dd className="text-right text-gray-700">
          {formatDateTime(flow.peak.datetime)}
          {flow.peak.rate != null && ` / ${flow.peak.rate.toLocaleString('ja-JP', { maximumFractionDigits: 5 })}`}
        </dd>
      </>
    )}
    {flow.cot && (
      <>
        <dt className="text-gray-500">大口のネット</dt>
        <dd className="text-right text-gray-700">
          {flow.cot.net > 0 ? '+' : ''}
          {flow.cot.net.toFixed(2)}
          {flow.cot.deltaNet !== undefined && `（前週比 ${flow.cot.deltaNet > 0 ? '+' : ''}${flow.cot.deltaNet.toFixed(2)}）`}
        </dd>
      </>
    )}
  </dl>
);

// 1ペア＝1カード。draggable のときだけ左端にグリップを出す。
const PairCard: FC<{ pair: FlowPair; flow?: PairFlow; draggable: boolean }> = ({ pair, flow, draggable }) => {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: pair, disabled: !draggable });
  const [open, setOpen] = useState<boolean>(false);
  const contrast = flow ? flowContrast(flow) : 'none';
  const style: React.CSSProperties = {
    ...LIST_ITEM_RESET,
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.6 : 1,
    zIndex: isDragging ? 10 : undefined,
  };

  return (
    <li
      ref={setNodeRef}
      style={style}
      className={`list-none rounded-xl border bg-white px-3 py-2.5 shadow-sm ${contrast === 'opposite' ? 'border-amber-300' : 'border-gray-200'}`}
    >
      <div className="mb-2 flex items-center gap-1.5">
        {draggable && (
          <button
            type="button"
            aria-label={`${pair} を並び替え`}
            className="-ml-1 touch-none cursor-grab p-0.5 text-gray-300 active:cursor-grabbing"
            {...attributes}
            {...listeners}
          >
            <GripVertical className="h-4 w-4" />
          </button>
        )}
        <span className="font-mono text-[15px] font-bold text-gray-800">{pair}</span>
        {contrast === 'opposite' && (
          <span className="ml-auto flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-bold text-amber-700">
            <AlertTriangle className="h-3 w-3" aria-hidden="true" />
            個人と大口が逆
          </span>
        )}
        {contrast === 'same' && (
          <span className="ml-auto rounded-full bg-gray-100 px-2 py-0.5 text-[11px] font-semibold text-gray-500">同じ向き</span>
        )}
        {flow && (
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            aria-label={`${pair} の詳細を${open ? '閉じる' : '開く'}`}
            className={`${contrast === 'none' ? 'ml-auto' : ''} -mr-1 p-0.5 text-gray-400`}
          >
            <ChevronDown className={`h-4 w-4 transition-transform ${open ? 'rotate-180' : ''}`} aria-hidden="true" />
          </button>
        )}
      </div>

      {flow ? (
        <>
          {/* 行のどこをタップしても詳細が開閉する（読み上げは見出しの開閉ボタンで行う） */}
          <div onClick={() => setOpen((v) => !v)} className="cursor-pointer space-y-2">
            <RetailRow flow={flow} />
            <SpecRow cot={flow.cot} />
          </div>
          {open && <Details flow={flow} />}
        </>
      ) : (
        <p className="text-xs text-gray-400">データを取得できませんでした</p>
      )}
    </li>
  );
};

const SkeletonCard: FC = () => (
  <li style={LIST_ITEM_RESET} className="list-none animate-pulse rounded-xl border border-gray-200 bg-white px-3 py-3">
    <div className="mb-3 h-4 w-20 rounded bg-gray-200" />
    <div className="mb-2 h-3 rounded-full bg-gray-200" />
    <div className="h-3 rounded-full bg-gray-200" />
  </li>
);

const OrderFlow: FC = () => {
  const [data, setData] = useState<FlowSnapshot | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string>('');
  const [order, setOrder] = useState<FlowPair[]>(loadOrder);
  const [sortMode, setSortMode] = useState<FlowSortMode>(loadSortMode);
  const [infoOpen, setInfoOpen] = useState<boolean>(false);
  const [now, setNow] = useState<number>(() => Date.now()); // 「◯分前」の表示用

  const sensors = useSensors(
    // タップとドラッグを区別するため 6px 動かしてから発火（モバイルのスクロールを妨げない）。
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const loadFlow = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      setData(await fetchFlow());
    } catch (e) {
      console.warn('取引量・センチメントの取得に失敗:', e);
      setError(e instanceof Error ? e.message : '取得に失敗しました');
    } finally {
      setLoading(false);
      setNow(Date.now());
    }
  }, []);

  useEffect(() => {
    if (!import.meta.env.VITE_FLOW_URL) return;
    loadFlow();
    const id = setInterval(loadFlow, REFRESH_MS);
    const tick = setInterval(() => setNow(Date.now()), 60_000);
    return () => {
      clearInterval(id);
      clearInterval(tick);
    };
  }, [loadFlow]);

  const byPair = useMemo(() => new Map((data?.pairs ?? []).map((p) => [p.pair, p])), [data]);
  const visible = useMemo(() => sortFlowPairs(order, byPair, sortMode), [order, byPair, sortMode]);
  const oppositeCount = useMemo(() => (data?.pairs ?? []).filter((p) => flowContrast(p) === 'opposite').length, [data]);

  const changeSort = (mode: FlowSortMode) => {
    setSortMode(mode);
    saveLocal(FLOW_SORT_STORAGE_KEY, mode);
  };

  const handleDragEnd = (e: DragEndEvent) => {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    setOrder((prev) => {
      const oldIndex = prev.indexOf(active.id as FlowPair);
      const newIndex = prev.indexOf(over.id as FlowPair);
      if (oldIndex < 0 || newIndex < 0) return prev;
      const next = arrayMove(prev, oldIndex, newIndex);
      saveLocal(FLOW_ORDER_STORAGE_KEY, JSON.stringify(next));
      return next;
    });
  };

  const draggable = sortMode === 'custom';

  return (
    <div className="px-3 pb-6">
      {/* 何を見ているページかを最初に一言で */}
      <div className="mb-3 rounded-xl bg-white px-3 py-2.5 text-[11px] leading-relaxed text-gray-600 shadow-sm">
        <div className="mb-1 flex items-center justify-between">
          <span className="text-xs font-bold text-gray-800">ポジションの偏り</span>
          <button
            type="button"
            onClick={() => setInfoOpen(true)}
            className="flex items-center gap-0.5 rounded-full border border-gray-300 px-2 py-0.5 text-[11px] text-gray-500"
          >
            <Info className="h-3 w-3" aria-hidden="true" />
            見方
          </button>
        </div>
        <p>
          <span className="font-semibold text-gray-700">個人</span>＝個人投資家（Myfxbook・毎時）、
          <span className="font-semibold text-gray-700">大口</span>＝投機筋（CFTC・週次
          {data?.cotReportDate ? `・${formatReportDate(data.cotReportDate)}時点` : ''}）。
        </p>
        <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5">
          <span className="flex items-center gap-1 whitespace-nowrap">
            <span className="inline-block h-2 w-2 rounded-full bg-green-500" />買い
          </span>
          <span className="flex items-center gap-1 whitespace-nowrap">
            <span className="inline-block h-2 w-2 rounded-full bg-red-500" />売り
          </span>
          <span className="text-gray-400">大口のバーは中央から右＝買い越し、左＝売り越し</span>
        </p>
      </div>

      {/* 並び替え・更新 */}
      <div className="mb-2 flex items-center gap-2">
        <div role="radiogroup" aria-label="並び順" className="flex flex-1 rounded-lg bg-gray-100 p-0.5">
          {SORT_OPTIONS.map((o) => (
            <button
              key={o.mode}
              type="button"
              role="radio"
              aria-checked={sortMode === o.mode}
              onClick={() => changeSort(o.mode)}
              className={`flex-1 rounded-md px-1 py-1 text-[11px] font-semibold ${
                sortMode === o.mode ? 'bg-white text-gray-800 shadow-sm' : 'text-gray-500'
              }`}
            >
              {o.label}
              {o.mode === 'opposite' && data && <span className="ml-0.5 text-amber-600">{oppositeCount}</span>}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={loadFlow}
          disabled={loading}
          aria-label="最新に更新"
          className="flex shrink-0 items-center gap-1 rounded-lg border border-gray-200 bg-white px-2 py-1 text-[11px] text-gray-500 disabled:opacity-50"
        >
          <RefreshCw className={`h-3 w-3 ${loading ? 'animate-spin' : ''}`} aria-hidden="true" />
          {loading ? '取得中' : data?.updatedAt ? formatAgo(data.updatedAt, now) : '更新'}
        </button>
      </div>

      {error && (
        <div className="mb-2 flex items-center justify-between rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">
          <span>{error}</span>
          <button type="button" onClick={loadFlow} className="font-bold underline">
            再試行
          </button>
        </div>
      )}

      {!data && loading ? (
        <ul className="space-y-2" style={LIST_RESET}>
          {FLOW_PAIRS.slice(0, 4).map((p) => (
            <SkeletonCard key={p} />
          ))}
        </ul>
      ) : visible.length === 0 ? (
        <div className="rounded-xl bg-white px-3 py-6 text-center text-xs text-gray-500">
          {sortMode === 'opposite' ? '個人と大口が逆向きのペアは、いまはありません。' : 'データがありません。'}
        </div>
      ) : (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <SortableContext items={visible} strategy={verticalListSortingStrategy}>
            <ul className="space-y-2" style={LIST_RESET}>
              {visible.map((pair) => (
                <PairCard key={pair} pair={pair} flow={byPair.get(pair)} draggable={draggable} />
              ))}
            </ul>
          </SortableContext>
        </DndContext>
      )}

      <p className="mt-3 text-[10px] leading-relaxed text-gray-400">
        {draggable ? (
          <>
            <GripVertical className="inline h-3 w-3 align-text-bottom" /> をドラッグすると並び替えでき、順序は次回以降も保持されます。
          </>
        ) : (
          '並び替えは「自分の順」で行えます。'
        )}
        カードをタップすると取引量の実数などの詳細が開きます。
      </p>

      <FlowInfoModal isOpen={infoOpen} onClose={() => setInfoOpen(false)} />
    </div>
  );
};

export default OrderFlow;
