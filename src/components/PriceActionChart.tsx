// TF分析カードの「プライスアクション」。直近の確定足をローソク足で描き、
// ピンバー/包み足の位置（番号つき）・確定待ちのパターンの確定ライン/否定ライン・抵抗帯・移動平均線・現在値を重ねる。
// 抵抗帯（R=上の抵抗帯・S=下の支持帯。番号は下の「抵抗帯」のはしごと同じ R1=いちばん近い）は、
// 帯の上下の境界線つきで、★が多いほど濃く・実線で描き、右端に「R1 価格」のラベルを付ける。
// いちばん近い R1/S1 がチャートの少し外にあるときは値幅を広げて入れ、遠すぎるときは上下の端に向きと距離を出す。
// 出来高節目（過去に出来高が膨らんだ価格）は、オレンジの太線をゆっくり点滅させて目立たせる（動きを減らす設定では点滅しない）。
// 値幅の少し外なら値幅を広げ、遠ければ上下の端に向きと距離を出す。チャートの下にも1行で価格・距離・役割を出す。
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
const RES = '#dc2626';
const SUP = '#16a34a';
const VOL = '#d97706'; // 出来高節目（オレンジ）

// 出来高節目の点滅（動きを減らす設定では止めて、少し濃いめで固定）。
const VOL_BLINK_CSS = `
@keyframes pa-vol-blink { 0%, 100% { opacity: 0.12; } 50% { opacity: 0.6; } }
.pa-vol-glow { animation: pa-vol-blink 1.4s ease-in-out infinite; }
@media (prefers-reduced-motion: reduce) { .pa-vol-glow { animation: none; opacity: 0.35; } }
`;

// 帯の濃さ・境界線（★が多いほど濃く、★3 は実線）。
const ZONE_FILL: Record<1 | 2 | 3, number> = { 1: 0.08, 2: 0.14, 3: 0.22 };
const ZONE_EDGE: Record<1 | 2 | 3, { opacity: number; dash?: string; width: number }> = {
  1: { opacity: 0.45, dash: '2 2', width: 0.7 },
  2: { opacity: 0.65, dash: '4 2', width: 0.9 },
  3: { opacity: 0.9, width: 1.1 },
};
// いちばん近い帯が値幅の外でも、この割合（値幅に対して）までなら値幅を広げて描く。
const ZONE_EXTEND = 0.6;

interface ZoneMark {
  z: SrZone;
  name: string; // 「R1」「S2」
}

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
  volumeLevel = null,
  volumeAgoLabel,
  pip,
}: {
  bars: OhlcCandle[];
  forming: OhlcCandle | null;
  reads: PatternRead[];
  zones: { res: SrZone[]; sup: SrZone[] } | null | undefined;
  currentRate: number;
  digits: number;
  periodLabel: string; // 例「直近6時間」
  maLines?: MaLines | null; // 移動平均線（bars と同じ長さ）。無ければ描かない
  volumeLevel?: number | null; // 出来高節目（過去に出来高が膨らんだ価格）。無ければ描かない
  volumeAgoLabel?: string; // 例「2日前」
  pip?: number; // 距離を pips で出すため
}) {
  const clipId = useId().replace(/:/g, '');
  if (bars.length < 2) return null;
  const head = priceActionHeadline(reads);
  const all = forming ? [...bars, forming] : bars;

  const W = 320;
  const H = 132;
  const padL = 4;
  const padR = 56; // 右端の価格ラベル（「R1 151.200」が入る幅）
  const padY = 14; // 上下の番号マーカーが収まる余白
  const lo0 = Math.min(...all.map((b) => b.low), currentRate);
  const hi0 = Math.max(...all.map((b) => b.high), currentRate);
  // 抵抗帯に番号を付ける（はしごと同じ: 近い順に R1, R2 / S1, S2）。
  const zoneMarks: ZoneMark[] = [
    ...(zones?.res ?? []).map((z, i) => ({ z, name: `R${i + 1}` })),
    ...(zones?.sup ?? []).map((z, i) => ({ z, name: `S${i + 1}` })),
  ];
  // いちばん近い R1/S1 の近い端が少しだけ外なら、値幅を広げて見えるようにする。
  const span0 = hi0 - lo0 || 1;
  const r1 = zones?.res[0];
  const s1 = zones?.sup[0];
  const hiZ = r1 && r1.low > hi0 && r1.low - hi0 <= span0 * ZONE_EXTEND ? Math.max(hi0, Math.min(r1.high, hi0 + span0 * ZONE_EXTEND)) : hi0;
  const loZ = s1 && s1.high < lo0 && lo0 - s1.high <= span0 * ZONE_EXTEND ? Math.min(lo0, Math.max(s1.low, lo0 - span0 * ZONE_EXTEND)) : lo0;
  // 出来高節目も、値幅の少し外なら値幅を広げて入れる。
  const vol = volumeLevel;
  const hi = vol != null && vol > hiZ && vol - hi0 <= span0 * ZONE_EXTEND ? vol : hiZ;
  const lo = vol != null && vol < loZ && lo0 - vol <= span0 * ZONE_EXTEND ? vol : loZ;
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

  // 値幅に入る帯（少しでも重なるもの）と、外れた帯（上下の端に向きと距離だけ出す。片側でいちばん近いもの）。
  const visibleZones = zoneMarks.filter(({ z }) => z.high >= lo && z.low <= hi);
  const offAbove = zoneMarks.find(({ z, name }) => name.startsWith('R') && z.low > hi);
  const offBelow = zoneMarks.find(({ z, name }) => name.startsWith('S') && z.high < lo);
  const volIn = vol != null && vol >= lo && vol <= hi;
  const volPips = vol != null && pip ? Math.abs(vol - currentRate) / pip : null;
  // 帯のラベルは、現在値に近い側の端（抵抗帯=下端・支持帯=上端。値幅の外なら端に寄せる）。
  const zoneEdge = ({ z }: ZoneMark) => (z.side === 'res' ? Math.max(z.low, lo) : Math.min(z.high, hi));
  // 帯の左端の名前（R1 など）の縦位置。帯の中央に置き、近い帯どうしは 8px 以上離す。
  const nameY = new Map<string, number>();
  visibleZones
    .map(({ z, name }) => {
      const top = y(Math.min(z.high, hi));
      const bottom = y(Math.max(z.low, lo));
      return { name, ny: Math.max((top + bottom) / 2 + 2.5, top + 7) };
    })
    .sort((a, b) => a.ny - b.ny)
    .forEach((n, k, arr) => {
      if (k > 0) n.ny = Math.max(n.ny, arr[k - 1].ny + 8);
      nameY.set(n.name, Math.min(n.ny, H - 2));
    });

  const labels = priceLabels(
    [
      { price: currentRate, kind: 'now' as const },
      ...(trig ? [{ price: trig.confirm, kind: 'confirm' as const }, { price: trig.invalidate, kind: 'invalidate' as const }] : []),
      ...visibleZones.map((m) => ({ price: zoneEdge(m), kind: 'zone' as const, zone: m })),
      ...(volIn && vol != null ? [{ price: vol, kind: 'volume' as const }] : []),
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
        {/* 抵抗帯（チャートの値幅に入るもの）: 塗り（★が多いほど濃い）＋上下の境界線（★3 は実線） */}
        {visibleZones.map(({ z, name }) => {
          const top = y(Math.min(z.high, hi));
          const bottom = y(Math.max(z.low, lo));
          const color = z.side === 'res' ? RES : SUP;
          const edge = ZONE_EDGE[z.stars];
          const x2 = W - padR;
          return (
            <g key={name}>
              <rect x={padL} width={x2 - padL} y={top} height={Math.max(1.5, bottom - top)} fill={color} opacity={ZONE_FILL[z.stars]} />
              {[z.high, z.low]
                .filter((p) => p <= hi && p >= lo)
                .map((p) => (
                  <line
                    key={p}
                    x1={padL}
                    x2={x2}
                    y1={y(p)}
                    y2={y(p)}
                    stroke={color}
                    strokeWidth={edge.width}
                    strokeDasharray={edge.dash}
                    opacity={edge.opacity}
                  />
                ))}
              {/* 帯の左端に名前（R1 など）。ローソク足と重なっても読めるよう白の縁取り */}
              <text
                x={padL + 2}
                y={nameY.get(name) ?? top + 7}
                className="text-[7px] font-bold"
                fill={color}
                stroke="white"
                strokeWidth="2"
                paintOrder="stroke"
              >
                {name}
                {z.contains ? '（今ここ）' : ''}
              </text>
            </g>
          );
        })}

        {/* 値幅の外にある、いちばん近い帯: 上下の端に向きと距離 */}
        {[offAbove, offBelow].map((m) =>
          m ? (
            <text
              key={`off-${m.name}`}
              x={W - padR - 2}
              y={m.z.side === 'res' ? 7 : H - 2}
              textAnchor="end"
              className="text-[7px] font-bold"
              fill={m.z.side === 'res' ? RES : SUP}
              stroke="white"
              strokeWidth="2"
              paintOrder="stroke"
            >
              {m.z.side === 'res' ? '▲' : '▼'} {m.name} {fmt(m.z.side === 'res' ? m.z.low : m.z.high)}（{m.z.side === 'res' ? '+' : '−'}
              {m.z.distancePips.toFixed(1)}pips）
            </text>
          ) : null,
        )}

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

        {/* 出来高節目: 点滅する太いオレンジの帯 ＋ 実線。値幅の外なら上下の端に向きと距離 */}
        {vol != null && (
          <>
            <style>{VOL_BLINK_CSS}</style>
            {volIn ? (
              <>
                <line className="pa-vol-glow" x1={padL} x2={W - padR} y1={y(vol)} y2={y(vol)} stroke={VOL} strokeWidth="6" strokeLinecap="round" />
                <line x1={padL} x2={W - padR} y1={y(vol)} y2={y(vol)} stroke={VOL} strokeWidth="1.4" />
                <text
                  x={padL + 2}
                  y={y(vol) - 3}
                  className="text-[7px] font-bold"
                  fill={VOL}
                  stroke="white"
                  strokeWidth="2"
                  paintOrder="stroke"
                >
                  ◆ 出来高節目
                </text>
              </>
            ) : (
              <text
                className="pa-vol-glow text-[7px] font-bold"
                style={{ opacity: 1 }}
                x={padL + 2}
                y={vol > hi ? 7 : H - 2}
                fill={VOL}
                stroke="white"
                strokeWidth="2"
                paintOrder="stroke"
              >
                {vol > hi ? '▲' : '▼'} 出来高節目 {fmt(vol)}
                {volPips != null ? `（${vol > currentRate ? '+' : '−'}${volPips.toFixed(1)}pips）` : ''}
              </text>
            )}
          </>
        )}

        {/* 現在値 */}
        <line x1={padL} x2={W - padR} y1={y(currentRate)} y2={y(currentRate)} stroke={NOW} strokeWidth="0.8" strokeDasharray="1.5 2" />

        {/* 右端の価格ラベル（重ならないように上下にずらす）: 現在値・確定/否定ライン・高値/安値 */}
        {labels.map((l) =>
          l.kind === 'volume' ? (
            <g key="vol">
              <rect x={W - padR + 1} y={l.y - 5} width={padR - 1} height="10" rx="2" fill={VOL} />
              <text x={W - padR + 3} y={l.y + 2.5} className="text-[7px] font-bold" fill="white">
                出来高 {fmt(l.price)}
              </text>
            </g>
          ) : l.kind === 'zone' && l.zone ? (
            <g key={`z-${l.zone.name}`}>
              <rect
                x={W - padR + 1}
                y={l.y - 5}
                width={padR - 1}
                height="10"
                rx="2"
                fill="white"
                stroke={l.zone.z.side === 'res' ? RES : SUP}
                strokeWidth="0.8"
              />
              <text x={W - padR + 3} y={l.y + 2.5} className="text-[7px] font-bold" fill={l.zone.z.side === 'res' ? RES : SUP}>
                {l.zone.name} {fmt(l.price)}
              </text>
            </g>
          ) : l.kind === 'now' ? (
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

      {/* 出来高節目の1行（価格・何日前・現在値からの距離・レジ/サポ） */}
      {vol != null && (
        <div className="mt-1 flex flex-wrap items-center gap-x-1.5 rounded-md border border-amber-200 bg-amber-50 px-2 py-1 text-[11px]">
          <span className="font-bold" style={{ color: VOL }}>
            ◆ 出来高節目
          </span>
          <span className="font-bold tabular-nums text-gray-900">{fmt(vol)}</span>
          {volumeAgoLabel && <span className="text-[10px] text-gray-500">（{volumeAgoLabel}に出来高が膨らんだ価格）</span>}
          <span className="ml-auto flex items-center gap-1.5 text-[10px]">
            {volPips != null && (
              <span className="tabular-nums text-gray-600">
                {vol >= currentRate ? '+' : '−'}
                {volPips.toFixed(1)}pips
              </span>
            )}
            <span className={`rounded px-1 font-bold ${vol >= currentRate ? 'bg-red-50 text-red-700' : 'bg-green-50 text-green-700'}`}>
              {vol >= currentRate ? '上のレジ' : '下のサポ'}
            </span>
          </span>
        </div>
      )}
      {/* 凡例（1〜2行にまとめる）: パターン・確定/否定ライン・抵抗帯 */}
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-[9px] text-gray-500">
        <span>● 確定 ○ 確定待ち</span>
        {trig && (
          <span>
            <span style={{ color: CONFIRM }}>‐‐</span>確定・<span style={{ color: INVALIDATE }}>‐‐</span>否定ライン
          </span>
        )}
        {zoneMarks.length > 0 && (
          <span className="flex items-center gap-1">
            <span aria-hidden className="inline-block h-2 w-2.5 rounded-sm border" style={{ backgroundColor: 'rgba(220,38,38,0.18)', borderColor: RES }} />
            R抵抗帯
            <span aria-hidden className="ml-1 inline-block h-2 w-2.5 rounded-sm border" style={{ backgroundColor: 'rgba(22,163,74,0.18)', borderColor: SUP }} />
            S支持帯（濃いほど強い）
          </span>
        )}
      </div>
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

type LabelKind = 'now' | 'confirm' | 'invalidate' | 'edge' | 'zone' | 'volume';
type PriceLabel = { price: number; kind: LabelKind; y: number; zone?: ZoneMark };
/**
 * 右端の価格ラベルの縦位置。必須のラベル（現在値・確定/否定・抵抗帯）は 10px 以上離れるよう上下にずらし、
 * 高値/安値のラベルは必須のラベルと重なるときだけ省く。
 */
function priceLabels(
  must: { price: number; kind: LabelKind; zone?: ZoneMark }[],
  edges: number[],
  y: (p: number) => number,
  H: number,
): PriceLabel[] {
  const GAP = 10;
  const out: PriceLabel[] = must.map((m) => ({ ...m, y: y(m.price) })).sort((a, b) => a.y - b.y);
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
