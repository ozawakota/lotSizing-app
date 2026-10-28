// TF分析カードの「プライスアクション」。直近の確定足をローソク足で描き、
// ピンバー/包み足の位置（番号つき）・確定待ちのパターンの確定ライン/否定ライン・抵抗帯・移動平均線・現在値を重ねる。
// 下に、番号と対応するパターンの一覧（確定/未確定/否定・形の質・出た場所）を並べる。
import { useId } from 'react';
import type { OhlcCandle } from '@/lib/edge';
import { PATTERN_DIRECTION } from '@/lib/edge';
import {
  CONFIRMATION_LABEL,
  isValidPattern,
  patternTriggerLevels,
  priceActionHeadline,
  type PatternRead,
  type PriceActionTone,
} from '@/lib/candleRead';
import type { SrZone } from '@/lib/srZones';
import { LIST_ITEM_RESET, LIST_RESET } from '@/lib/listReset';
import type { MaLines } from '@/lib/entrySignal';

const UP = '#16a34a';
const DOWN = '#dc2626';
const NOW = '#f97316';
const CONFIRM = '#2563eb';
const INVALIDATE = '#6b7280';

// 移動平均線（ローソク足の緑/赤・確定ラインの青と見分けやすい色）。
const MA_STYLE: { key: keyof MaLines; label: string; color: string; width: number }[] = [
  { key: 'sma21', label: '21SMA', color: '#0891b2', width: 1.1 },
  { key: 'ema75', label: '75EMA', color: '#9333ea', width: 1.1 },
  { key: 'ema200', label: '200EMA', color: '#374151', width: 1.3 },
];

const TONE_CHIP: Record<PriceActionTone, string> = {
  bull: 'bg-green-100 text-green-700',
  bear: 'bg-red-100 text-red-700',
  neutral: 'bg-gray-100 text-gray-600',
};
const CONF_STYLE: Record<PatternRead['confirmation'], string> = {
  confirmed: 'bg-blue-50 text-blue-700',
  pending: 'bg-amber-50 text-amber-700',
  invalidated: 'bg-gray-100 text-gray-400 line-through',
};

const isBull = (r: PatternRead) => PATTERN_DIRECTION[r.key] === 1;

export function PriceActionChart({
  bars,
  forming,
  reads,
  zones,
  currentRate,
  digits,
  periodLabel,
  maLines,
}: {
  bars: OhlcCandle[];
  forming: OhlcCandle | null;
  reads: PatternRead[];
  zones: { res: SrZone[]; sup: SrZone[] } | null | undefined;
  currentRate: number;
  digits: number;
  periodLabel: string; // 例「直近6時間」
  maLines?: MaLines | null; // 移動平均線（bars と同じ長さ）。無ければ描かない
}) {
  const clipId = useId().replace(/:/g, '');
  if (bars.length < 2) return null;
  const head = priceActionHeadline(reads);
  const all = forming ? [...bars, forming] : bars;

  const W = 320;
  const H = 132;
  const padL = 4;
  const padR = 46; // 右端の価格ラベル
  const padY = 14; // 上下の番号マーカーが収まる余白
  const lo = Math.min(...all.map((b) => b.low), currentRate);
  const hi = Math.max(...all.map((b) => b.high), currentRate);
  const span = hi - lo || 1;
  const y = (p: number) => padY + ((hi - p) / span) * (H - padY * 2);
  const slot = (W - padL - padR) / all.length;
  const cx = (i: number) => padL + slot * (i + 0.5);
  const bodyW = Math.max(1.5, slot * 0.62);
  const idxOf = (barsAgo: number) => bars.length - 1 - barsAgo;

  // 番号つきのパターン（一覧と同じ順。チャートの範囲外は番号だけ一覧に残る）。
  const marked = reads.map((r, n) => ({ r, n: n + 1, i: idxOf(r.barsAgo) })).filter((m) => m.i >= 0);
  // 確定ライン/否定ラインは、いちばん新しい「確定待ち」のパターンだけ（線が増えすぎないように）。
  const pending = marked.find((m) => m.r.confirmation === 'pending');
  const trig = pending ? patternTriggerLevels(bars[pending.i], pending.r.key) : null;

  const labels = priceLabels(
    [
      { price: currentRate, kind: 'now' as const },
      ...(trig ? [{ price: trig.confirm, kind: 'confirm' as const }, { price: trig.invalidate, kind: 'invalidate' as const }] : []),
    ],
    [hi, lo],
    y,
    H,
  );

  // 移動平均線: 値幅はローソク足に合わせたまま（遠い MA で足が潰れないように）、はみ出た部分は切り取る。
  // 線の末尾が値幅の外なら、凡例に「上/下（範囲外）」と出す。
  const maDrawn = MA_STYLE.flatMap((st) => {
    const vals = maLines?.[st.key];
    if (!vals || vals.length !== bars.length) return [];
    const segs: string[] = [];
    let cur: string[] = [];
    vals.forEach((v, i) => {
      if (v == null) {
        if (cur.length > 1) segs.push(cur.join(' '));
        cur = [];
      } else cur.push(`${cx(i).toFixed(1)},${y(v).toFixed(1)}`);
    });
    if (cur.length > 1) segs.push(cur.join(' '));
    const last = [...vals].reverse().find((v) => v != null) ?? null;
    if (last == null) return [];
    const where: 'in' | 'above' | 'below' = last > hi ? 'above' : last < lo ? 'below' : 'in';
    return [{ ...st, segs, last, where }];
  });

  const visibleZones = [...(zones?.res ?? []), ...(zones?.sup ?? [])].filter((z) => z.high >= lo && z.low <= hi);
  const fmt = (p: number) => p.toFixed(digits);

  return (
    <div className="mt-2 rounded-lg bg-gray-50 px-2 py-1.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] font-semibold text-gray-600">プライスアクション</span>
        <span className="text-[10px] text-gray-400">{periodLabel}</span>
      </div>
      <p className={`mt-0.5 inline-block rounded px-1.5 py-0.5 text-[11px] font-bold ${TONE_CHIP[head.tone]}`}>
        {head.valid && '✓ '}
        {head.text}
      </p>

      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="mt-1 h-auto w-full"
        role="img"
        aria-label={`ローソク足 ${bars.length}本。${head.text}`}
      >
        {/* 抵抗帯（チャートの値幅に入るものだけ） */}
        {visibleZones.map((z, k) => {
          const top = y(Math.min(z.high, hi));
          const bottom = y(Math.max(z.low, lo));
          return (
            <rect
              key={k}
              x={padL}
              width={W - padL - padR}
              y={top}
              height={Math.max(1, bottom - top)}
              fill={z.side === 'res' ? DOWN : UP}
              opacity={z.stars === 3 ? 0.14 : 0.08}
            />
          );
        })}

        {/* パターンの足の背景 */}
        {marked.map(({ r, i }) => (
          <rect
            key={`bg-${r.key}-${r.barsAgo}`}
            x={cx(i) - slot / 2}
            width={slot}
            y={padY / 2}
            height={H - padY}
            rx="2"
            fill={r.confirmation === 'invalidated' ? '#9ca3af' : isBull(r) ? UP : DOWN}
            opacity="0.1"
          />
        ))}

        {/* 移動平均線（チャートの枠の外は切り取る） */}
        {maDrawn.length > 0 && (
          <>
            <defs>
              <clipPath id={clipId}>
                <rect x={padL} y={0} width={W - padL - padR} height={H} />
              </clipPath>
            </defs>
            <g clipPath={`url(#${clipId})`} fill="none" strokeLinejoin="round" strokeLinecap="round">
              {maDrawn.map((m) =>
                m.segs.map((pts, k) => <polyline key={`${m.key}-${k}`} points={pts} stroke={m.color} strokeWidth={m.width} opacity="0.85" />),
              )}
            </g>
          </>
        )}

        {/* 確定待ちパターンの確定ライン（青）と否定ライン（灰） */}
        {pending && trig && (
          <>
            <line x1={cx(pending.i)} x2={W - padR} y1={y(trig.confirm)} y2={y(trig.confirm)} stroke={CONFIRM} strokeWidth="1" strokeDasharray="3 2" />
            <line x1={cx(pending.i)} x2={W - padR} y1={y(trig.invalidate)} y2={y(trig.invalidate)} stroke={INVALIDATE} strokeWidth="1" strokeDasharray="3 2" />
          </>
        )}

        {/* ローソク足（形成中の足は薄く） */}
        {all.map((b, i) => {
          const up = b.close >= b.open;
          const color = up ? UP : DOWN;
          const top = y(Math.max(b.open, b.close));
          const bodyH = Math.max(0.8, y(Math.min(b.open, b.close)) - top);
          const isForming = !!forming && i === all.length - 1;
          return (
            <g key={i} opacity={isForming ? 0.4 : 1}>
              <line x1={cx(i)} x2={cx(i)} y1={y(b.high)} y2={y(b.low)} stroke={color} strokeWidth="1" />
              <rect x={cx(i) - bodyW / 2} y={top} width={bodyW} height={bodyH} fill={up ? 'white' : color} stroke={color} strokeWidth="0.9" />
            </g>
          );
        })}

        {/* パターンの番号（強気=足の下、弱気=足の上） */}
        {marked.map(({ r, n, i }) => {
          const bull = isBull(r);
          const b = bars[i];
          const my = bull ? Math.min(y(b.low) + 8, H - 5) : Math.max(y(b.high) - 8, 5);
          const color = r.confirmation === 'invalidated' ? '#9ca3af' : bull ? UP : DOWN;
          return (
            <g key={`m-${r.key}-${r.barsAgo}`}>
              <circle cx={cx(i)} cy={my} r="5" fill={r.confirmation === 'pending' ? 'white' : color} stroke={color} strokeWidth="1" />
              <text x={cx(i)} y={my + 2.6} textAnchor="middle" className="text-[7px] font-bold" fill={r.confirmation === 'pending' ? color : 'white'}>
                {n}
              </text>
            </g>
          );
        })}

        {/* 現在値 */}
        <line x1={padL} x2={W - padR} y1={y(currentRate)} y2={y(currentRate)} stroke={NOW} strokeWidth="0.8" strokeDasharray="1.5 2" />

        {/* 右端の価格ラベル（重ならないように上下にずらす）: 現在値・確定/否定ライン・高値/安値 */}
        {labels.map((l) =>
          l.kind === 'now' ? (
            <g key="now">
              <rect x={W - padR + 1} y={l.y - 5} width={padR - 1} height="10" rx="2" fill={NOW} />
              <text x={W - padR + 3} y={l.y + 2.5} className="text-[7px] font-bold" fill="white">{fmt(l.price)}</text>
            </g>
          ) : (
            <text
              key={`${l.kind}-${l.price}`}
              x={W - padR + 3}
              y={l.y + 2.5}
              className={`text-[7px] ${l.kind === 'confirm' ? 'font-bold' : ''}`}
              fill={l.kind === 'confirm' ? CONFIRM : l.kind === 'invalidate' ? INVALIDATE : '#9ca3af'}
            >
              {l.kind === 'confirm' ? '確定 ' : l.kind === 'invalidate' ? '否定 ' : ''}
              {fmt(l.price)}
            </text>
          ),
        )}
      </svg>

      {/* 凡例 */}
      <p className="flex flex-wrap gap-x-2 text-[9px] text-gray-400">
        <span>● 確定</span>
        <span>○ 確定待ち</span>
        {trig && (
          <span>
            <span style={{ color: CONFIRM }}>‐‐</span> 確定ライン・<span style={{ color: INVALIDATE }}>‐‐</span> 否定ライン（終値で抜けたら）
          </span>
        )}
        {visibleZones.length > 0 && <span>帯 = 抵抗帯</span>}
      </p>
      {maDrawn.length > 0 && (
        <div className="mt-0.5 flex flex-wrap gap-x-2.5 gap-y-0.5 text-[9px] text-gray-500">
          {maDrawn.map((m) => (
            <span key={m.key} className="flex items-center gap-1 whitespace-nowrap">
              <span aria-hidden className="inline-block h-0.5 w-3 rounded" style={{ backgroundColor: m.color }} />
              {m.label}
              <span className="font-mono text-gray-600">{fmt(m.last)}</span>
              {m.where !== 'in' && <span className="text-gray-400">（{m.where === 'above' ? '上' : '下'}・範囲外）</span>}
            </span>
          ))}
        </div>
      )}

      {/* パターンの一覧（チャートの番号と対応） */}
      {reads.length === 0 ? (
        <p className="mt-1 text-[10px] text-gray-400">{periodLabel}にピンバー・包み足はありません</p>
      ) : (
        <ul className="mt-1 space-y-1" style={LIST_RESET}>
          {reads.map((r, n) => {
            const bull = isBull(r);
            const bar = bars[idxOf(r.barsAgo)];
            const t = bar && r.confirmation === 'pending' ? patternTriggerLevels(bar, r.key) : null;
            const valid = isValidPattern(r);
            return (
              <li style={LIST_ITEM_RESET} key={`${r.key}-${r.barsAgo}-${n}`} className="text-[11px]">
                <div className="flex flex-wrap items-center gap-x-1.5">
                  <span
                    className={`inline-flex h-3.5 w-3.5 items-center justify-center rounded-full text-[8px] font-bold ${
                      r.confirmation === 'invalidated' ? 'bg-gray-300 text-white' : bull ? 'bg-green-600 text-white' : 'bg-red-600 text-white'
                    }`}
                  >
                    {n + 1}
                  </span>
                  <span className={`font-semibold ${bull ? 'text-green-700' : 'text-red-700'}`}>{r.label}</span>
                  <span className="text-[10px] text-gray-400">{r.barsAgo === 0 ? '最新の確定足' : `${r.barsAgo}本前`}</span>
                  <span className={`rounded px-1 text-[10px] ${CONF_STYLE[r.confirmation]}`}>{CONFIRMATION_LABEL[r.confirmation]}</span>
                  {valid && <span className="rounded bg-blue-600 px-1 text-[10px] font-bold text-white">有効</span>}
                  <span className="ml-auto flex items-center gap-1 text-[10px] text-gray-500" title="形の質（ヒゲ・実体の比率と足の大きさ）">
                    質
                    <span className="inline-block h-1 w-8 overflow-hidden rounded-full bg-gray-200">
                      <span
                        className={`block h-full ${r.quality >= 60 ? 'bg-gray-700' : 'bg-gray-400'}`}
                        style={{ width: `${r.quality}%` }}
                      />
                    </span>
                    <span className="tabular-nums">{r.quality}</span>
                  </span>
                </div>
                <div className="pl-5 text-[10px] text-gray-500">
                  <span className={r.zone === 'key' ? 'text-orange-600' : 'text-gray-400'}>
                    {r.zone === 'key' ? `${r.zoneReasons.join('・')}の近く` : '意識されるラインから離れた場所'}
                  </span>
                  {t && (
                    <>
                      {' '}
                      ／ 終値で <span className="font-semibold tabular-nums text-blue-700">{fmt(t.confirm)}</span>
                      {bull ? ' を超えたら' : ' を割ったら'}確定、
                      <span className="tabular-nums">{fmt(t.invalidate)}</span>
                      {bull ? ' を割ったら' : ' を超えたら'}否定
                    </>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <p className="mt-1 text-[9px] text-gray-400">「有効」= 確定・意識されるラインの近く・質60以上。RR判定の裏付けに使います。</p>
    </div>
  );
}

type LabelKind = 'now' | 'confirm' | 'invalidate' | 'edge';
/**
 * 右端の価格ラベルの縦位置。必須のラベル（現在値・確定/否定）は 9px 以上離れるよう上下にずらし、
 * 高値/安値のラベルは必須のラベルと重なるときだけ省く。
 */
function priceLabels(
  must: { price: number; kind: LabelKind }[],
  edges: number[],
  y: (p: number) => number,
  H: number,
): { price: number; kind: LabelKind; y: number }[] {
  const GAP = 9;
  const out = must.map((m) => ({ ...m, y: y(m.price) })).sort((a, b) => a.y - b.y);
  for (let i = 1; i < out.length; i++) out[i].y = Math.max(out[i].y, out[i - 1].y + GAP);
  if (out.length) out[out.length - 1].y = Math.min(out[out.length - 1].y, H - 5);
  for (let i = out.length - 2; i >= 0; i--) out[i].y = Math.min(out[i].y, out[i + 1].y - GAP);
  if (out.length && out[0].y < 5) {
    const d = 5 - out[0].y;
    for (const l of out) l.y += d;
  }
  for (const e of edges) {
    const ey = y(e);
    if (out.every((l) => Math.abs(l.y - ey) >= GAP)) out.push({ price: e, kind: 'edge', y: ey });
  }
  return out;
}
