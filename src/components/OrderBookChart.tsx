// 推定オーダーブック（自作の板情報: 注文の分布・ポジションの分布）を描くチャート（TF分析のエントリー判断）。
// 注文は1時間足の構造（未到達のスイング高安・キリ番）＋個人の建玉の偏りから、ポジションは個人の建玉の毎時の記録から推定（Worker /orderbook）。
// 価格帯ごとの横棒（中央の軸から 右=買い（緑）・左=売り（赤））を、ローソク足の背景に半透明で重ねる。
// エントリー・損切り・目標・現在値の線を全幅に引き、厚い価格帯（平均の 1.8 倍以上）は濃く・枠つきで描く。
// 下に、厚いところの一覧（支え・重し・逆指値の溜まり）と、RR のプランと照らした注意点を出す。
import { useState } from 'react';
import type { OhlcCandle } from '@/lib/edge';
import {
  bookClusters,
  CLUSTER_LABEL,
  planNotes,
  positionSkew,
  type BookSide,
  type OrderBookPayload,
  type PlanLevels,
} from '@/lib/orderBook';
import { LIST_ITEM_RESET, LIST_RESET } from '@/lib/listReset';

const UP = '#16a34a';
const DOWN = '#dc2626';
const NOW = '#f97316';
const ENTRY = '#111827';

type Mode = 'orders' | 'positions';

export function OrderBookChart({
  bars,
  forming,
  data,
  currentRate,
  digits,
  plan,
  onStep,
  isLatest = true,
}: {
  bars: OhlcCandle[];
  forming: OhlcCandle | null;
  data: OrderBookPayload;
  currentRate: number;
  digits: number;
  plan: PlanLevels | null;
  /** 20 分ごとのスナップショットを前後に移動（OANDA と同じ。無ければボタンを出さない）。-1=20分前 / 1=20分後 / 0=最新 */
  onStep?: (dir: -1 | 0 | 1) => void;
  isLatest?: boolean;
}) {
  const [mode, setMode] = useState<Mode>('orders');
  const book: BookSide | null = mode === 'orders' ? data.orderBook : data.positionBook;
  const all = forming ? [...bars, forming] : bars;
  if (all.length < 2) return null;
  const fmt = (p: number) => p.toFixed(digits);

  const W = 320;
  const H = 170;
  const padL = 4;
  const padR = 66; // 右端の価格ラベル（「エントリー 151.628」が入る幅）
  const padY = 8;
  const plotW = W - padL - padR;
  const candleW = plotW; // ローソク足は全幅。横棒はその背景に重ねる
  const axis = padL + plotW / 2; // 横棒の中央の軸（右=買い・左=売り）
  const half = (plotW / 2) * 0.96;

  // 縦軸: ローソク足・現在値・エントリー・損切り。目標は近ければ含め、遠ければ端に寄せる。
  const core = [currentRate, ...(plan ? [plan.entry, plan.stop] : [])];
  const lo0 = Math.min(...all.map((b) => b.low), ...core);
  const hi0 = Math.max(...all.map((b) => b.high), ...core);
  const span0 = hi0 - lo0 || 1;
  const ext = span0 * 0.6;
  const hi = plan && plan.target > hi0 ? Math.min(plan.target, hi0 + ext) : hi0 + span0 * 0.05;
  const lo = plan && plan.target < lo0 ? Math.max(plan.target, lo0 - ext) : lo0 - span0 * 0.05;
  const span = hi - lo || 1;
  const yRaw = (p: number) => padY + ((hi - p) / span) * (H - padY * 2);
  const y = (p: number) => Math.min(H - padY, Math.max(padY, yRaw(p)));
  const slot = candleW / all.length;
  const cx = (i: number) => padL + slot * (i + 0.5);
  const bodyW = Math.max(1.2, slot * 0.6);

  const width = book?.bucketWidth ?? 0;
  const visible = book ? book.buckets.filter(([p]) => p + width >= lo && p <= hi) : [];
  const maxPct = Math.max(0.01, ...visible.flatMap(([, l, s]) => [l, s]));
  const clusters = book && mode === 'orders' ? bookClusters(book, currentRate, 2) : [];
  // 厚いバケツ（買い側=l / 売り側=s ＋価格）。買い指値・買いの逆指値は買い側、売り指値・売りの逆指値は売り側。
  const thick = new Set(clusters.map((c) => `${c.kind.startsWith('buy') ? 'l' : 's'}${c.price}`));
  const barH = Math.max(1, Math.abs(yRaw(0) - yRaw(width)) - 0.6);

  const lines: { key: string; price: number; color: string; label: string; dash?: string }[] = [
    ...(plan
      ? [
          { key: 'target', price: plan.target, color: UP, label: '目標', dash: '4 2' },
          { key: 'entry', price: plan.entry, color: ENTRY, label: 'エントリー' },
          { key: 'stop', price: plan.stop, color: DOWN, label: '損切り', dash: '4 2' },
        ]
      : []),
    { key: 'now', price: currentRate, color: NOW, label: '現在', dash: '1.5 2' },
  ];
  // 成行（エントリー＝現在値）のときは、現在値のラベルは省く（線は引く）
  const sameAsEntry = !!plan && Math.abs(plan.entry - currentRate) < (book?.bucketWidth ?? 0) / 2;
  // 右端ラベルの重なりを避ける
  const labels = lines
    .filter((l) => !(l.key === 'now' && sameAsEntry))
    .map((l) => ({ ...l, ly: y(l.price) }))
    .sort((a, b) => a.ly - b.ly);
  for (let k = 1; k < labels.length; k++) if (labels[k].ly - labels[k - 1].ly < 11) labels[k].ly = labels[k - 1].ly + 11;
  for (let k = labels.length - 1; k >= 0; k--) {
    const limit = k === labels.length - 1 ? H - 6 : labels[k + 1].ly - 11;
    if (labels[k].ly > limit) labels[k].ly = limit;
  }

  const notes = plan ? planNotes(plan, data.orderBook, data.positionBook, currentRate, fmt) : [];
  const skew = data.positionBook ? positionSkew(data.positionBook, currentRate) : null;
  const snap = book ? new Date(book.time).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' }) : null;

  return (
    <div className="mt-2 rounded-lg bg-gray-50 px-2 py-1.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] font-semibold text-gray-600">
          推定オーダーブック<span className="ml-1 rounded bg-gray-200 px-1 text-[9px] font-normal text-gray-500">自作</span>
        </span>
        <div className="flex gap-1">
          {(
            [
              ['orders', '注文'],
              ['positions', 'ポジション'],
            ] as const
          ).map(([m, label]) => (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              aria-pressed={mode === m}
              disabled={m === 'orders' && !data.orderBook}
              className={`rounded-full border text-[10px] font-semibold disabled:opacity-40 ${
                mode === m ? 'border-gray-800 bg-gray-800 text-white' : 'border-gray-200 bg-white text-gray-600'
              }`}
            >
              <span className="block px-2 py-0.5">{label}</span>
            </button>
          ))}
        </div>
      </div>

      {!book ? (
        <div className="mt-1 text-[10px] text-gray-500">{mode === 'orders' ? '注文の推定に必要な足が足りません。' : positionReason(data.positionStatus)}</div>
      ) : (
        <svg viewBox={`0 0 ${W} ${H}`} className="mt-1 h-auto w-full" role="img" aria-label={`ローソク足と板情報（${mode === 'orders' ? '注文' : 'ポジション'}）`}>
          {/* 横棒の中央の軸（ローソク足の背景） */}
          <line x1={axis} x2={axis} y1={padY} y2={H - padY} stroke="#d1d5db" strokeWidth="0.6" strokeDasharray="2 2" />
          <text x={axis - 2} y={padY - 1.5} textAnchor="end" className="text-[6px]" fill={DOWN}>
            ← 売り
          </text>
          <text x={axis + 2} y={padY - 1.5} className="text-[6px]" fill={UP}>
            買い →
          </text>
          {/* 価格帯ごとの横棒（右=買い・左=売り）。厚いところは濃く・枠つき */}
          {visible.map(([p, l, s]) => {
            const top = yRaw(p + width);
            const lw = (l / maxPct) * half;
            const sw = (s / maxPct) * half;
            const lThick = thick.has(`l${p}`);
            const sThick = thick.has(`s${p}`);
            return (
              <g key={p}>
                <rect x={axis} y={top + 0.3} width={lw} height={barH} fill={UP} opacity={lThick ? 0.38 : 0.16} stroke={lThick ? UP : 'none'} strokeOpacity="0.6" strokeWidth="0.6" />
                <rect x={axis - sw} y={top + 0.3} width={sw} height={barH} fill={DOWN} opacity={sThick ? 0.38 : 0.16} stroke={sThick ? DOWN : 'none'} strokeOpacity="0.6" strokeWidth="0.6" />
              </g>
            );
          })}
          {/* ローソク足（形成中の足は薄く） */}
          {all.map((b, i) => {
            const up = b.close >= b.open;
            const color = up ? UP : DOWN;
            const top = y(Math.max(b.open, b.close));
            const bh = Math.max(0.8, y(Math.min(b.open, b.close)) - top);
            return (
              <g key={i} opacity={forming && i === all.length - 1 ? 0.4 : 1}>
                <line x1={cx(i)} x2={cx(i)} y1={y(b.high)} y2={y(b.low)} stroke={color} strokeWidth="0.9" />
                <rect x={cx(i) - bodyW / 2} y={top} width={bodyW} height={bh} fill={up ? 'white' : color} stroke={color} strokeWidth="0.8" />
              </g>
            );
          })}
          {/* エントリー・損切り・目標・現在値（全幅） */}
          {lines.map((l) => (
            <line key={l.key} x1={padL} x2={W - padR} y1={y(l.price)} y2={y(l.price)} stroke={l.color} strokeWidth="1" strokeDasharray={l.dash} opacity="0.85" />
          ))}
          {labels.map((l) => (
            <g key={`lb-${l.key}`}>
              <rect x={W - padR + 1} y={l.ly - 5} width={padR - 1} height="10" rx="2" fill={l.color} />
              <text x={W - padR + 3} y={l.ly + 2.5} className="text-[6.5px] font-bold" fill="white">
                {l.key === 'target' && (plan!.target > hi || plan!.target < lo) ? (plan!.target > hi ? '↑' : '↓') : ''}
                {l.label} {fmt(l.price)}
              </text>
            </g>
          ))}
        </svg>
      )}

      {/* 凡例・時刻 */}
      <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[9px] text-gray-500">
        {mode === 'orders' ? (
          <span>現在値より下: 緑=買い指値（支え）・赤=売りの逆指値／上: 赤=売り指値（重し）・緑=買いの逆指値。濃い=厚い</span>
        ) : (
          <span>
            緑=買いポジション・赤=売りポジション
            {skew && (
              <span className="ml-1 font-semibold text-gray-700">
                （全体 買い{skew.longPct}% / 売り{skew.shortPct}%）
              </span>
            )}
          </span>
        )}
        {snap && (
          <span className="ml-auto flex items-center gap-1 text-gray-400">
            {onStep && (
              <button type="button" onClick={() => onStep(-1)} className="rounded border border-gray-200 bg-white text-gray-600" aria-label="20分前のスナップショット">
                <span className="block px-1">◀</span>
              </button>
            )}
            <span className={isLatest ? '' : 'font-semibold text-amber-700'}>
              {snap} 時点の推定（20分ごと）{isLatest ? '' : '・過去'}
            </span>
            {onStep && !isLatest && (
              <>
                <button type="button" onClick={() => onStep(1)} className="rounded border border-gray-200 bg-white text-gray-600" aria-label="20分後のスナップショット">
                  <span className="block px-1">▶</span>
                </button>
                <button type="button" onClick={() => onStep(0)} className="rounded border border-gray-200 bg-white text-gray-600">
                  <span className="block px-1">最新</span>
                </button>
              </>
            )}
          </span>
        )}
      </div>

      {/* 厚いところの一覧（注文） */}
      {mode === 'orders' && clusters.length > 0 && (
        <ul className="mt-1 flex flex-wrap gap-1" style={LIST_RESET}>
          {clusters.map((c) => (
            <li
              key={`${c.kind}-${c.price}`}
              style={LIST_ITEM_RESET}
              className={`rounded border px-1.5 py-0.5 text-[10px] ${
                c.kind === 'buy_limit' || c.kind === 'buy_stop' ? 'border-green-200 bg-green-50 text-green-800' : 'border-red-200 bg-red-50 text-red-800'
              }`}
            >
              {CLUSTER_LABEL[c.kind]} <span className="font-bold tabular-nums">{fmt(c.price)}</span>
              <span className="text-gray-500">（{c.pct.toFixed(2)}%・平均の{c.ratio}倍）</span>
            </li>
          ))}
        </ul>
      )}

      {/* RR のプランと照らした注意点 */}
      {notes.length > 0 && (
        <ul className="mt-1.5 space-y-0.5" style={LIST_RESET}>
          {notes.map((n) => (
            <li key={n.text} style={LIST_ITEM_RESET} className="flex items-start gap-1.5 text-[11px]">
              <span className={n.tone === 'warn' ? 'text-amber-600' : n.tone === 'good' ? 'text-green-600' : 'text-blue-600'}>
                {n.tone === 'warn' ? '⚠' : n.tone === 'good' ? '✓' : 'ℹ'}
              </span>
              <span className="text-gray-700">{n.text}</span>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-1 text-[9px] text-gray-400">
        実際の注文ではなく推定です。注文＝1時間足のスイング高安（抜けると逆指値が動く）・キリ番＋個人の建玉の偏り、ポジション＝個人（Myfxbook）の平均取得価格の毎時の記録から。※投資助言ではありません。
      </div>
    </div>
  );
}

/** ポジションの分布が出せない理由（ポジションのボタンを押したときに出す）。 */
function positionReason(st: OrderBookPayload['positionStatus']): string {
  if (st?.reason === 'no_db') {
    return 'ポジションの分布には記録先（Turso）の設定が必要です。Worker に TURSO_DATABASE_URL と TURSO_AUTH_TOKEN を登録すると、個人の建玉の記録が始まります。';
  }
  if (st?.reason === 'collecting') {
    const n = st.records ?? 0;
    const need = st.needed ?? 3;
    return `個人の建玉の記録を集めています（${n}/${need} 件。毎時15分に1件ずつ記録）。あと約${Math.max(1, need - n)}時間で表示されます。`;
  }
  if (st?.reason === 'error') return '個人の建玉の記録を読み込めませんでした。少し待って再読み込みしてください。';
  return 'ポジションの分布は、個人の建玉の記録（毎時）がたまると表示されます。';
}
