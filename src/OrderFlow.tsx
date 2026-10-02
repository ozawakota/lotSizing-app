// 取引量・センチメント ページ。
// 取引量は Myfxbook Community Outlook の実建玉 volume（buy/sell）に一本化。
// Cloudflare Worker(Cron+KV) がキャッシュした建玉情報を /flow から取得して一覧表示する。
// 行はドラッグ&ドロップで並び替え可能（@dnd-kit）。順序は localStorage に保存し、
// ページ遷移・リロード後も維持する。クライアントはKVキャッシュを読むだけ。
import { FC, useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronRight, GripVertical, Info, Menu, Minus, TrendingDown, TrendingUp, type LucideIcon } from 'lucide-react';
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  rectSortingStrategy,
  sortableKeyboardCoordinates,
  useSortable,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { FLOW_ORDER_STORAGE_KEY, FLOW_PAIRS, FlowDelta, FlowPair, FlowSnapshot, Lean, PairFlow, applyPairOrder } from '@/lib/flow';
import FlowInfoModal from './FlowInfoModal';

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

// 優勢の色分け：買い=緑 / 売り=赤 / 中立=グレー。
const ACCENT: Record<Lean, string> = { buy: 'border-l-green-500', sell: 'border-l-red-500', neutral: 'border-l-gray-300' };
const DOM_TEXT: Record<Lean, string> = { buy: 'text-green-600', sell: 'text-red-600', neutral: 'text-gray-400' };
const DOM_LABEL: Record<Lean, string> = { buy: '買い', sell: '売り', neutral: '中立' };

// 前回比デルタの表示設定（向きごとの塗りバッジ色・アイコン・ラベル）。
// entry=積み増し（新規優勢）緑↗ / settlement=巻き戻し（決済優勢）赤↘ / flat=変化なし グレー。
// 背景色で意味を一目で伝え、上段の取引量（灰色）とはっきり分離する。
const DELTA_STYLE: Record<FlowDelta['direction'], { badge: string; Icon: LucideIcon; label: string }> = {
  entry: { badge: 'bg-green-50 text-green-700', Icon: TrendingUp, label: '積み増し' },
  settlement: { badge: 'bg-red-50 text-red-700', Icon: TrendingDown, label: '巻き戻し' },
  flat: { badge: 'bg-gray-100 text-gray-500', Icon: Minus, label: '変化なし' },
};

// 符号付きの差分を "+1,234" / "−567" / "±0"（全角マイナス）で表す。
const formatDeltaValue = (value: number): string => {
  if (value === 0) return '±0';
  const sign = value > 0 ? '+' : '−';
  return `${sign}${Math.abs(value).toLocaleString()}`;
};

// ISO8601 → "MM/DD HH:mm"（ローカル表示）。
const formatPeakDate = (iso: string): string => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('ja-JP', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
};

// 1枚＝ドラッグ可能なカード（2カラムグリッドの1セル）。ドラッグは左上グリップから。
const SortablePairRow: FC<{ pair: FlowPair; flow?: PairFlow }> = ({ pair, flow }) => {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: pair });
  const [peakOpen, setPeakOpen] = useState<boolean>(false); // ピーク詳細（日時・レート）の開閉
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.6 : 1,
    zIndex: isDragging ? 10 : undefined,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`rounded-lg border border-gray-200 border-l-4 bg-white p-2.5 ${flow ? ACCENT[flow.dominant] : 'border-l-gray-200'}`}
    >
      <div className="mb-1.5 flex items-center gap-1">
        <button
          type="button"
          aria-label={`${pair} を並び替え`}
          className="touch-none cursor-grab text-gray-300 active:cursor-grabbing"
          {...attributes}
          {...listeners}
        >
          <GripVertical className="h-3.5 w-3.5" />
        </button>
        <span className="font-mono text-sm font-bold text-gray-800">{pair}</span>
        {flow && <span className={`ml-auto text-xs font-bold ${DOM_TEXT[flow.dominant]}`}>{DOM_LABEL[flow.dominant]}</span>}
      </div>

      {flow ? (
        <>
          {/* 建玉割合バー（緑=買い / 赤=売り） */}
          <div className="flex h-2.5 overflow-hidden rounded-full bg-gray-200" aria-hidden="true">
            <div className="bg-green-500" style={{ width: `${flow.longPct}%` }} />
            <div className="bg-red-500" style={{ width: `${flow.shortPct}%` }} />
          </div>
          {/* 割合（主役）→ 取引量（補助） */}
          <div className="mt-1 flex items-baseline justify-between tabular-nums">
            <span className="text-sm font-semibold text-green-700">{flow.longPct.toFixed(0)}%</span>
            <span className="text-sm font-semibold text-red-700">{flow.shortPct.toFixed(0)}%</span>
          </div>
          <div className="flex justify-between text-[10px] text-gray-400 tabular-nums">
            <span>{flow.longVolume.toLocaleString()}</span>
            <span>{flow.shortVolume.toLocaleString()}</span>
          </div>
          {/* 前回比の合計取引量の動き（積み増し＝新規優勢 / 巻き戻し＝決済優勢）。初回は非表示 */}
          {flow.delta && (() => {
            const { badge, Icon, label } = DELTA_STYLE[flow.delta.direction];
            return (
              <div className={`mt-1.5 flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-semibold ${badge}`}>
                <Icon className="h-3 w-3 shrink-0" aria-hidden="true" />
                <span>{label}</span>
                <span className="ml-auto tabular-nums">{formatDeltaValue(flow.delta.value)}</span>
              </div>
            );
          })()}
          {/* 記録開始以降で合計取引量が最大だった時点。ヘッダー常時表示＋詳細はアコーディオン */}
          {flow.peak && (
            <div className="mt-1 border-t border-gray-100 pt-1 text-[10px] text-gray-500">
              <button
                type="button"
                onClick={() => setPeakOpen((v) => !v)}
                aria-expanded={peakOpen}
                aria-label={`${pair} の最大取引量の詳細`}
                className="flex w-full items-center gap-1 text-left tabular-nums"
              >
                <ChevronRight className={`h-3 w-3 shrink-0 transition-transform ${peakOpen ? 'rotate-90' : ''}`} />
                <span>最大 {flow.peak.volume.toLocaleString()}</span>
                <span className="ml-auto text-gray-400">{formatPeakDate(flow.peak.datetime)}</span>
              </button>
              {peakOpen && (
                <div className="mt-1 pl-4 tabular-nums text-gray-400">
                  <div className="flex items-center justify-between">
                    <span>レート</span>
                    <span>{flow.peak.rate != null ? flow.peak.rate.toLocaleString('ja-JP', { maximumFractionDigits: 5 }) : '—'}</span>
                  </div>
                </div>
              )}
            </div>
          )}
        </>
      ) : (
        <span className="text-xs text-gray-400">—</span>
      )}
    </div>
  );
};

const OrderFlow: FC<{ onOpenMenu?: () => void }> = ({ onOpenMenu }) => {
  const [data, setData] = useState<FlowSnapshot | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string>('');
  const [order, setOrder] = useState<FlowPair[]>(loadOrder);
  const [infoOpen, setInfoOpen] = useState<boolean>(false); // 見方の説明モーダル

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
    }
  }, []);

  useEffect(() => {
    if (!import.meta.env.VITE_FLOW_URL) return;
    loadFlow();
    const id = setInterval(loadFlow, REFRESH_MS);
    return () => clearInterval(id);
  }, [loadFlow]);

  // ペアごとに PairFlow を引けるよう索引化する。
  const byPair = useMemo(() => new Map((data?.pairs ?? []).map((p) => [p.pair, p])), [data]);

  const handleDragEnd = (e: DragEndEvent) => {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    setOrder((prev) => {
      const oldIndex = prev.indexOf(active.id as FlowPair);
      const newIndex = prev.indexOf(over.id as FlowPair);
      if (oldIndex < 0 || newIndex < 0) return prev;
      const next = arrayMove(prev, oldIndex, newIndex);
      try {
        localStorage.setItem(FLOW_ORDER_STORAGE_KEY, JSON.stringify(next));
      } catch {
        // 保存に失敗しても並び替え自体は有効（セッション内で維持）。
      }
      return next;
    });
  };

  return (
    <div className="px-3 pb-6">
      <div className="mb-3 flex items-center justify-between gap-2">
        {/* mobiscroll のグローバル見出しスタイル（詳細度が高い）に font-size を奪われ 34px に
            肥大化し、nowrap でボタンを画面外へ押し出していた。text-base! で意図通り 16px に強制し、
            min-w-0 truncate で万一長くてもボタンを押し出さないようにする。 */}
        <h2 className="min-w-0 truncate text-base! font-bold">取引量・センチメント</h2>
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={loadFlow}
            disabled={loading}
            className="rounded-full border border-orange-500 px-3 py-1 text-xs text-orange-600 disabled:opacity-50"
          >
            {loading ? '取得中…' : data ? '更新' : '表示'}
          </button>
          {onOpenMenu && (
            <button
              type="button"
              aria-label="メニュー"
              onClick={onOpenMenu}
              className="rounded-full border border-gray-300 h-8 w-8 flex items-center justify-center text-gray-600"
            >
              <Menu className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>

      {error && <p className="mb-2 text-sm text-red-600">{error}</p>}

      {/* 凡例＋更新時刻 */}
      <div className="mb-2 flex items-center justify-between text-[11px] text-gray-500">
        <span className="flex items-center gap-2">
          <span className="flex items-center gap-1">
            <span className="inline-block h-2 w-2 rounded-full bg-green-500" />買い
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block h-2 w-2 rounded-full bg-red-500" />売り
          </span>
          <button
            type="button"
            onClick={() => setInfoOpen(true)}
            className="flex items-center gap-0.5 rounded-full border border-gray-300 px-2 py-0.5 text-gray-500"
          >
            <Info className="h-3 w-3" />
            見方
          </button>
        </span>
        {data?.updatedAt && <span className="text-gray-400">{new Date(data.updatedAt).toLocaleString('ja-JP')}</span>}
      </div>

      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext items={order} strategy={rectSortingStrategy}>
          <div className="grid grid-cols-2 gap-2">
            {order.map((pair) => (
              <SortablePairRow key={pair} pair={pair} flow={byPair.get(pair)} />
            ))}
          </div>
        </SortableContext>
      </DndContext>

      <p className="mt-3 text-[10px] leading-relaxed text-gray-400">
        ※ 左上の <GripVertical className="inline h-3 w-3 align-text-bottom" /> をドラッグすると並び替えでき、順序は次回以降も保持されます。
        各指標の見方は右上の「見方」からご確認ください。
      </p>

      <FlowInfoModal isOpen={infoOpen} onClose={() => setInfoOpen(false)} />
    </div>
  );
};

export default OrderFlow;
