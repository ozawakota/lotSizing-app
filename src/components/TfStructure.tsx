// TF分析カードの「ダウ理論」と「抵抗帯」の表示部品。
// - DowHeader: トレンド（上昇/下降/レンジ）・局面・強さ（そろったスイングの数）を1行で
// - SwingChart: 直近のスイングを折れ線で描き、HH/HL/LH/LL・押し安値/戻り高値・現在値を重ねる
// - KeyLevelRow: 押し安値（戻り高値）までの距離と「割れたら（超えたら）トレンド終了」
// - ZoneLadder: 上の抵抗帯（遠い→近い）→ 現在値 → 下の支持帯（近い→遠い）。★・幅・距離・根拠
import type { DowAnalysis, DowPhase, SwingLabel } from '@/lib/dow';
import { dowSummary } from '@/lib/dow';
import type { SrZone } from '@/lib/srZones';

const TREND_CHIP: Record<DowAnalysis['trend'], string> = {
  up: 'bg-green-100 text-green-700',
  down: 'bg-red-100 text-red-700',
  range: 'bg-gray-100 text-gray-600',
};
const TREND_JA: Record<DowAnalysis['trend'], string> = { up: '上昇', down: '下降', range: 'レンジ' };
const PHASE_CLS: Record<DowPhase, string> = {
  extending: 'text-gray-700',
  pullback: 'text-gray-700',
  continuing: 'text-gray-700',
  broken: 'text-amber-700 font-bold',
  none: 'text-gray-500',
};
const LABEL_CLS: Record<SwingLabel, string> = {
  HH: 'fill-green-600',
  HL: 'fill-green-600',
  LH: 'fill-red-600',
  LL: 'fill-red-600',
  EH: 'fill-gray-400',
  EL: 'fill-gray-400',
};

/** トレンドのチップ＋局面の一言＋強さ（●の数）。 */
export function DowHeader({ dow }: { dow: DowAnalysis }) {
  return (
    <div className="flex items-center gap-2">
      <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-bold ${TREND_CHIP[dow.trend]}`}>
        ダウ {TREND_JA[dow.trend]}
      </span>
      <span className={`min-w-0 flex-1 truncate text-[11px] ${PHASE_CLS[dow.phase]}`}>
        {dow.trend === 'range' ? '高値・安値の向きがそろわない' : dowSummary(dow).replace(/^(上昇|下降)・/, '')}
      </span>
      {dow.trend !== 'range' && (
        <span className="flex shrink-0 items-center gap-0.5" aria-label={`トレンドの強さ ${Math.min(dow.strength, 4)}/4`}>
          {[1, 2, 3, 4].map((i) => (
            <span
              key={i}
              className={`inline-block h-1.5 w-1.5 rounded-full ${
                i <= Math.min(dow.strength, 4) ? (dow.trend === 'up' ? 'bg-green-500' : 'bg-red-500') : 'bg-gray-200'
              }`}
            />
          ))}
        </span>
      )}
    </div>
  );
}

/** 直近のスイングの折れ線（HH/HL/LH/LL つき）＋押し安値/戻り高値の点線＋現在値。 */
export function SwingChart({ dow, currentRate, digits }: { dow: DowAnalysis; currentRate: number; digits: number }) {
  const W = 300;
  const H = 86;
  const padX = 14;
  const padTop = 14;
  const padBottom = 14;
  const swings = dow.swings;
  if (swings.length < 2) return null;
  const key = dow.keyLevel?.price ?? null;
  const prices = [...swings.map((s) => s.price), currentRate, ...(key != null ? [key] : [])];
  const lo = Math.min(...prices);
  const hi = Math.max(...prices);
  const span = hi - lo || 1;
  const y = (p: number) => padTop + ((hi - p) / span) * (H - padTop - padBottom);
  // 横軸は「何本前か」。最古のスイング〜現在（0本前）を左右いっぱいに使い、現在値の点は右端。
  const oldest = Math.max(...swings.map((s) => s.barsAgo), 1);
  const x = (barsAgo: number) => padX + ((oldest - barsAgo) / oldest) * (W - padX * 2 - 26);
  const nowX = W - padX - 4;
  const pts = swings.map((s) => `${x(s.barsAgo).toFixed(1)},${y(s.price).toFixed(1)}`).join(' ');
  const last = swings[swings.length - 1];
  const keyColor = dow.keyLevel?.kind === 'pullback_low' ? '#16a34a' : '#dc2626';

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="mt-1.5 h-auto w-full" role="img" aria-label={`スイングの推移: ${dowSummary(dow)}`}>
      {/* 押し安値 / 戻り高値（終値で割れる・超えるとトレンド終了） */}
      {key != null && (
        <>
          <line x1={padX} x2={W - padX} y1={y(key)} y2={y(key)} stroke={keyColor} strokeWidth="1" strokeDasharray="4 3" opacity="0.8" />
          <text x={W - padX - 14} y={y(key) + (y(key) > H / 2 ? -3 : 9)} textAnchor="end" className="text-[8px]" fill={keyColor}>
            {dow.keyLevel?.kind === 'pullback_low' ? '押し安値' : '戻り高値'} {key.toFixed(digits)}
          </text>
        </>
      )}
      {/* スイングの折れ線と、最後のスイングから現在値まで（点線） */}
      <polyline points={pts} fill="none" stroke="#6b7280" strokeWidth="1.5" strokeLinejoin="round" />
      <line x1={x(last.barsAgo)} y1={y(last.price)} x2={nowX} y2={y(currentRate)} stroke="#9ca3af" strokeWidth="1.2" strokeDasharray="2 2" />
      {swings.map((s, i) => (
        <g key={i}>
          <circle cx={x(s.barsAgo)} cy={y(s.price)} r="2.2" fill={s.kind === 'high' ? '#ef4444' : '#22c55e'} />
          {s.label && (
            <text
              x={x(s.barsAgo)}
              y={s.kind === 'high' ? y(s.price) - 5 : y(s.price) + 11}
              textAnchor="middle"
              className={`text-[8px] font-bold ${LABEL_CLS[s.label]}`}
            >
              {s.label}
            </text>
          )}
        </g>
      ))}
      {/* 現在値 */}
      <circle cx={nowX} cy={y(currentRate)} r="3.2" fill="#f97316" stroke="white" strokeWidth="1" />
      <text x={nowX} y={y(currentRate) + (y(currentRate) > H / 2 ? -6 : 12)} textAnchor="end" className="text-[8px] font-bold" fill="#f97316">
        現在
      </text>
    </svg>
  );
}

/** 押し安値（戻り高値）までの距離と意味。レンジなら上限・下限。 */
export function KeyLevelRow({ dow, currentRate, pip, digits }: { dow: DowAnalysis; currentRate: number; pip: number; digits: number }) {
  if (dow.keyLevel) {
    const up = dow.keyLevel.kind === 'pullback_low';
    const dist = (currentRate - dow.keyLevel.price) / pip;
    const broken = dow.phase === 'broken';
    return (
      <p className={`mt-1 flex items-center justify-between gap-2 text-[11px] ${broken ? 'text-amber-700' : 'text-gray-600'}`}>
        <span>
          <span className={`font-semibold ${up ? 'text-green-700' : 'text-red-700'}`}>{up ? '押し安値' : '戻り高値'}</span>{' '}
          <span className="font-bold tabular-nums text-gray-800">{dow.keyLevel.price.toFixed(digits)}</span>
          <span className="ml-1 tabular-nums text-gray-400">
            （{dist >= 0 ? '+' : '−'}
            {Math.abs(dist).toFixed(1)}pips）
          </span>
        </span>
        <span className="shrink-0 text-[10px]">
          {broken ? (up ? '終値で割り込み済み' : '終値で上抜け済み') : up ? '終値で割れたら上昇終了' : '終値で超えたら下降終了'}
        </span>
      </p>
    );
  }
  if (dow.rangeHigh != null && dow.rangeLow != null) {
    return (
      <p className="mt-1 text-[11px] text-gray-600">
        レンジ{' '}
        <span className="font-bold tabular-nums text-gray-800">
          {dow.rangeLow.toFixed(digits)} 〜 {dow.rangeHigh.toFixed(digits)}
        </span>
        <span className="ml-1 text-[10px] text-gray-400">どちらかを終値で抜けた方向に注目</span>
      </p>
    );
  }
  return null;
}

function Stars({ n }: { n: 1 | 2 | 3 }) {
  return (
    <span className="shrink-0 text-[10px] tracking-tighter" aria-label={`強さ ${n}/3`}>
      <span className="text-amber-500">{'★'.repeat(n)}</span>
      <span className="text-gray-200">{'★'.repeat(3 - n)}</span>
    </span>
  );
}

function ZoneRow({ z, idx, digits }: { z: SrZone; idx: number; digits: number }) {
  const res = z.side === 'res';
  return (
    <li className="flex items-center gap-2 py-1">
      <span className={`w-6 shrink-0 text-[11px] font-bold ${res ? 'text-red-600' : 'text-green-600'}`}>
        {res ? 'R' : 'S'}
        {idx + 1}
      </span>
      <span className={`h-3 w-1 shrink-0 rounded-sm ${res ? 'bg-red-400' : 'bg-green-400'}`} style={{ opacity: 0.35 + z.stars * 0.2 }} />
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-1.5">
          <span className="text-[13px] font-bold tabular-nums text-gray-800">
            {z.low.toFixed(digits)}
            <span className="font-normal text-gray-400">–</span>
            {z.high.toFixed(digits)}
          </span>
          <Stars n={z.stars} />
        </p>
        <p className="truncate text-[10px] text-gray-400">{z.sources.join('・')}</p>
      </div>
      <span className="shrink-0 text-right text-[11px] tabular-nums text-gray-500">
        {z.contains ? <span className="font-bold text-amber-600">帯の中</span> : `${res ? '+' : '−'}${z.distancePips.toFixed(1)}pips`}
      </span>
    </li>
  );
}

/** 抵抗帯のはしご: 上の帯（遠い→近い）→ 現在値 → 下の帯（近い→遠い）。 */
export function ZoneLadder({ res, sup, currentRate, digits }: { res: SrZone[]; sup: SrZone[]; currentRate: number; digits: number }) {
  return (
    <div className="border-y border-gray-100 py-1">
      <ul>
        {[...res].reverse().map((z, i) => (
          <ZoneRow key={`r${i}`} z={z} idx={res.length - 1 - i} digits={digits} />
        ))}
      </ul>
      {res.length === 0 && <p className="py-1 text-[10px] text-gray-400">近くに上の抵抗帯なし</p>}
      <div className="my-0.5 flex items-center gap-2 rounded bg-orange-50 px-1.5 py-1">
        <span className="w-6 shrink-0 text-[11px] font-bold text-orange-600">今</span>
        <span className="flex-1 text-xl font-bold tabular-nums text-gray-900">{currentRate.toFixed(digits)}</span>
      </div>
      {sup.length === 0 && <p className="py-1 text-[10px] text-gray-400">近くに下の支持帯なし</p>}
      <ul>
        {sup.map((z, i) => (
          <ZoneRow key={`s${i}`} z={z} idx={i} digits={digits} />
        ))}
      </ul>
    </div>
  );
}
