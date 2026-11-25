// 推定オーダーブック（自作の板情報: 注文の分布・ポジションの分布）を描くチャート（TF分析のエントリー判断）。
// 注文は1時間足の構造（未到達のスイング高安・キリ番）＋個人の建玉の偏りから、ポジションは個人の建玉の毎時の記録から推定（Worker /orderbook）。
// 価格帯ごとの横棒（中央の軸から 右=買い（緑）・左=売り（赤））を、ローソク足の背景に半透明で重ねる。
// エントリー・損切り・目標・現在値の線を全幅に引き、厚い価格帯（平均の 1.8 倍以上）は濃く・枠つきで描く。
// 文字を減らして一目で判断できるように:
//   - 見出しに結論（↑上に動きやすい / ↓下に動きやすい / ↔拮抗。bookLean）
//   - 現在値のすぐ上・すぐ下の厚い価格帯（nearestWalls）を、チャートに全幅の線＋価格のタグで、
//     下に「上の壁 / 下の壁」のカード（価格・現在値からの pips・止まりやすい / 抜けると加速）で示す
//     🛡（青）＝指値の壁＝止まりやすい / ⚡（紫）＝逆指値の溜まり＝抜けると加速（買い・売りの緑/赤と区別）
//   - 下に2本のゲージ（上下どちらへ走りやすいか / 支えと重しのどちらが厚いか）
//   - RR のプランと照らした注意点は一言のチップ。くわしい説明・見方は「見方」を開いたときだけ
import { useState } from 'react';
import type { OhlcCandle } from '@/lib/edge';
import {
  bookClusters,
  bookLean,
  bookPressure,
  CLUSTER_EFFECT,
  CLUSTER_LABEL,
  nearestWalls,
  planNotes,
  positionSkew,
  type BookCluster,
  type BookSide,
  type OrderBookPayload,
  type PlanLevels,
} from '@/lib/orderBook';
import { LIST_ITEM_RESET, LIST_RESET } from '@/lib/listReset';

const UP = '#16a34a';
const DOWN = '#dc2626';
const NOW = '#f97316';
const ENTRY = '#111827';
const WALL = '#2563eb'; // 🛡 指値の壁（止まりやすい）
const ACCEL = '#9333ea'; // ⚡ 逆指値の溜まり（抜けると加速）
const isStop = (c: BookCluster) => c.kind.endsWith('stop');
// 表示桁から 1pip（JPY=0.01、ドルストレート=0.0001、XAU=0.1）
const pipOf = (digits: number) => (digits >= 5 ? 0.0001 : digits === 3 ? 0.01 : digits === 2 ? 0.1 : Math.pow(10, -(digits - 1)));

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
  const [helpOpen, setHelpOpen] = useState(false);
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
  // 一目で見るゲージ（チャートに見えている範囲で集計）
  const pressure = data.orderBook ? bookPressure(data.orderBook, currentRate, Math.max(hi - currentRate, currentRate - lo)) : null;
  const skew = data.positionBook ? positionSkew(data.positionBook, currentRate) : null;
  const lean = pressure ? bookLean(pressure) : null;
  const walls = book && mode === 'orders' ? nearestWalls(book, currentRate) : {};
  const wallList = [walls.above, walls.below].filter((c): c is BookCluster => !!c);
  const pip = pipOf(digits);
  const pipsFrom = (p: number) => {
    const v = (p - currentRate) / pip;
    return `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(Math.abs(v) < 10 ? 1 : 0)}p`;
  };
  const snap = book ? new Date(book.time).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' }) : null;

  return (
    <div className="mt-2 rounded-lg bg-gray-50 px-2 py-1.5">
      {/* 見出し: タイトル・時刻（◀▶で20分ずつ）・注文/ポジションの切り替え */}
      <div className="flex items-center gap-1.5">
        <span className="text-[11px] font-semibold text-gray-600">板</span>
        <span className="rounded bg-gray-200 px-1 text-[9px] text-gray-500">推定</span>
        {snap && (
          <span className="flex items-center gap-0.5 text-[10px] tabular-nums text-gray-400">
            {onStep && (
              <button type="button" onClick={() => onStep(-1)} className="rounded text-gray-500" aria-label="20分前の板">
                <span className="block px-0.5">◀</span>
              </button>
            )}
            <span className={isLatest ? '' : 'font-bold text-amber-700'}>{snap}</span>
            {onStep && !isLatest && (
              <>
                <button type="button" onClick={() => onStep(1)} className="rounded text-gray-500" aria-label="20分後の板">
                  <span className="block px-0.5">▶</span>
                </button>
                <button type="button" onClick={() => onStep(0)} className="rounded bg-amber-100 text-[9px] font-semibold text-amber-800">
                  <span className="block px-1">最新へ</span>
                </button>
              </>
            )}
          </span>
        )}
        {mode === 'orders' && lean && (
          <span
            className={`rounded-full px-1.5 py-px text-[10px] font-bold ${
              lean.lean === 'up' ? 'bg-green-100 text-green-700' : lean.lean === 'down' ? 'bg-red-100 text-red-700' : 'bg-gray-200 text-gray-600'
            }`}
            title="上の逆指値・下の支えが多いほど上、下の逆指値・上の重しが多いほど下"
          >
            {lean.lean === 'up' ? '↑ 上に動きやすい' : lean.lean === 'down' ? '↓ 下に動きやすい' : '↔ 拮抗'}
          </span>
        )}
        <div className="ml-auto flex gap-1">
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
                <rect x={axis} y={top + 0.3} width={lw} height={barH} fill={UP} opacity={lThick ? 0.5 : 0.2} stroke={lThick ? UP : 'none'} strokeOpacity="0.6" strokeWidth="0.6" />
                <rect x={axis - sw} y={top + 0.3} width={sw} height={barH} fill={DOWN} opacity={sThick ? 0.5 : 0.2} stroke={sThick ? DOWN : 'none'} strokeOpacity="0.6" strokeWidth="0.6" />
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
          {/* すぐ上・すぐ下の厚い価格帯: 全幅の線と、左端に価格のタグ（🛡 青＝止まりやすい / ⚡ 紫＝抜けると加速） */}
          {wallList.map((c) => {
            const cy = y(c.price + width / 2);
            const color = isStop(c) ? ACCEL : WALL;
            return (
              <g key={`wall-${c.kind}-${c.price}`}>
                <title>{`${CLUSTER_LABEL[c.kind]} ${fmt(c.price)}（平均の ${c.ratio} 倍）`}</title>
                <line x1={padL} x2={W - padR} y1={cy} y2={cy} stroke={color} strokeWidth="1.1" strokeDasharray="5 2" opacity="0.9" />
                <rect x={padL + 1} y={cy - 5} width="44" height="10" rx="2" fill={color} />
                <text x={padL + 3} y={cy + 2.4} className="text-[6.5px] font-bold" fill="white">
                  {isStop(c) ? '⚡' : '🛡'} {fmt(c.price)}
                </text>
              </g>
            );
          })}
        </svg>
      )}

      {/* すぐ上・すぐ下の壁（価格・現在値からの pips・効き方） */}
      {book && mode === 'orders' && (
        <div className="mt-1 grid grid-cols-2 gap-1">
          {([
            ['上', walls.above],
            ['下', walls.below],
          ] as const).map(([pos, c]) => (
            <div
              key={pos}
              className={`rounded-md border px-1.5 py-1 ${c ? (isStop(c) ? 'border-purple-200 bg-purple-50' : 'border-blue-200 bg-blue-50') : 'border-gray-200 bg-white'}`}
            >
              <p className="text-[9px] text-gray-500">{pos === '上' ? '▲ 上の壁' : '▼ 下の壁'}</p>
              {c ? (
                <>
                  <p className={`text-[12px] font-bold tabular-nums ${isStop(c) ? 'text-purple-700' : 'text-blue-700'}`}>
                    {isStop(c) ? '⚡' : '🛡'} {fmt(c.price)}
                    <span className="ml-1 text-[10px] font-semibold text-gray-500">{pipsFrom(c.price)}</span>
                  </p>
                  <p className={`text-[10px] font-semibold ${isStop(c) ? 'text-purple-700' : 'text-blue-700'}`}>{CLUSTER_EFFECT[c.kind]}</p>
                </>
              ) : (
                <p className="text-[10px] text-gray-400">近くに厚い価格帯なし</p>
              )}
            </div>
          ))}
        </div>
      )}

      {/* 一目で見るゲージ（注文）/ 買い・売りの比率（ポジション） */}
      {book && mode === 'orders' && pressure && (
        <div className="mt-1 space-y-1">
          <Gauge
            icon="⚡"
            left={{ label: '↓加速', pct: pressure.accelDownPct, color: DOWN }}
            right={{ label: '↑加速', pct: pressure.accelUpPct, color: UP }}
          />
          <Gauge
            icon="🛡"
            left={{ label: '下の支え', pct: pressure.supportPct, color: UP }}
            right={{ label: '上の重し', pct: pressure.resistancePct, color: DOWN }}
          />
        </div>
      )}
      {book && mode === 'positions' && skew && (
        <div className="mt-1">
          <Gauge icon="👥" left={{ label: '買い', pct: skew.longPct, color: UP }} right={{ label: '売り', pct: skew.shortPct, color: DOWN }} />
        </div>
      )}

      {/* RR のプランと照らした注意点（一言のチップ） */}
      {notes.length > 0 && (
        <ul className="mt-1.5 flex flex-wrap gap-1" style={LIST_RESET}>
          {notes.map((n) => (
            <li
              key={n.short}
              style={LIST_ITEM_RESET}
              title={n.text}
              className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                n.tone === 'warn' ? 'bg-amber-100 text-amber-800' : n.tone === 'good' ? 'bg-green-100 text-green-800' : 'bg-blue-50 text-blue-700'
              }`}
            >
              {n.tone === 'warn' ? '⚠ ' : n.tone === 'good' ? '✓ ' : 'ℹ '}
              {n.short}
            </li>
          ))}
        </ul>
      )}

      {/* 見方（くわしい説明・注意点の全文・推定であることの注記）は開いたときだけ */}
      <button type="button" onClick={() => setHelpOpen((o) => !o)} aria-expanded={helpOpen} className="mt-1 text-[10px] text-gray-400">
        <span className="block">{helpOpen ? '見方を閉じる ▴' : '見方 ▾'}</span>
      </button>
      {helpOpen && (
        <div className="mt-0.5 space-y-1 rounded-md bg-white px-2 py-1.5 text-[10px] leading-relaxed text-gray-600">
          <div>
            横棒 = 価格帯ごとの注文の量（中央から 右=買い・左=売り。濃い＝厚い）。
            <br />⚡（紫の線）= 逆指値の溜まり（そこを抜けると損切り・ブレイクの注文が出て値動きが加速しやすい）
            <br />🛡（青の線）= 指値の壁（そこで止まりやすい・跳ね返されやすい）
            <br />見出しの結論 = 上の逆指値・下の支えが多いほど「上に動きやすい」、下の逆指値・上の重しが多いほど「下に動きやすい」。
          </div>
          {notes.length > 0 && (
            <ul className="space-y-0.5" style={LIST_RESET}>
              {notes.map((n) => (
                <li key={`d-${n.short}`} style={LIST_ITEM_RESET}>
                  {n.tone === 'warn' ? '⚠ ' : n.tone === 'good' ? '✓ ' : 'ℹ '}
                  {n.text}
                </li>
              ))}
            </ul>
          )}
          <div className="text-gray-400">
            実際の注文ではなく推定です（注文＝1時間足のスイング高安・キリ番＋個人の建玉の偏り、ポジション＝個人の平均取得価格の記録）。20分ごとに更新。※投資助言ではありません。
          </div>
        </div>
      )}
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

/** 左右に割れたゲージ（例: ⚡ 下へ加速 38% ━━━━ 62% 上へ加速）。多い側を太字に。 */
function Gauge({
  icon,
  left,
  right,
}: {
  icon: string;
  left: { label: string; pct: number; color: string };
  right: { label: string; pct: number; color: string };
}) {
  const leftWins = left.pct > right.pct;
  const rightWins = right.pct > left.pct;
  return (
    <div className="flex items-center gap-1.5 text-[10px]">
      <span aria-hidden className="w-4 text-center">
        {icon}
      </span>
      <span className={`w-[4.5rem] whitespace-nowrap text-right ${leftWins ? 'font-bold' : 'text-gray-400'}`} style={leftWins ? { color: left.color } : undefined}>
        {left.label} {left.pct}%
      </span>
      <span className="flex h-2 flex-1 overflow-hidden rounded-full bg-gray-100" aria-label={`${left.label} ${left.pct}% / ${right.label} ${right.pct}%`}>
        <span className="h-full" style={{ width: `${left.pct}%`, backgroundColor: left.color, opacity: leftWins ? 0.85 : 0.35 }} />
        <span className="h-full" style={{ width: `${right.pct}%`, backgroundColor: right.color, opacity: rightWins ? 0.85 : 0.35 }} />
      </span>
      <span className={`w-[4.5rem] whitespace-nowrap ${rightWins ? 'font-bold' : 'text-gray-400'}`} style={rightWins ? { color: right.color } : undefined}>
        {right.pct}% {right.label}
      </span>
    </div>
  );
}
