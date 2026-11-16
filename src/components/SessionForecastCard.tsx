// 東京・ロンドン・NY の動きの予想カード（TF分析ページ）。材料は Worker の /sessions、予想は forecastSessions（純関数）。
// 文字を減らして一目で分かるように:
//   - SVG: 横=時間（開催中/次のセッションから順に3列）、縦=価格。出来高の抵抗線（POC・VAH・VAL・山）を横線で引き、
//     各セッションの「動きそうな範囲」を箱、予想の動きを矢印で描く（上抜け=緑・下抜け=赤・止まる=琥珀・往復=灰）
//   - 下に1行ずつ: セッション・状態（開催中/次/あと◯時間）・一言・出来高の割合のミニバー
//   - 見方（抵抗線の意味・材料）は開いたときだけ
import { useState } from 'react';
import {
  forecastSessions,
  isVolumeKind,
  levelName,
  type SessionForecast,
  type SessionKey,
  type SessionScenarioKind,
  type SessionsPayload,
  type TrendBias,
  type VolumeLevel,
} from '@/lib/sessionForecast';
import { pipSize } from '@/lib/stoploss';
import { LIST_ITEM_RESET, LIST_RESET } from '@/lib/listReset';

const UP = '#16a34a';
const DOWN = '#dc2626';
const STALL = '#d97706';
const RANGE = '#6b7280';
const NOW = '#f97316';

const SCENARIO_COLOR: Record<SessionScenarioKind, string> = {
  break_up: UP,
  drift_up: UP,
  break_down: DOWN,
  drift_down: DOWN,
  stall_up: STALL,
  stall_down: STALL,
  range: RANGE,
};
const SCENARIO_ICON: Record<SessionScenarioKind, string> = {
  break_up: '⇑',
  drift_up: '↗',
  break_down: '⇓',
  drift_down: '↘',
  stall_up: '⤒',
  stall_down: '⤓',
  range: '⇅',
};
const HILO = '#0369a1'; // 高値・安値の線（青）
const LEVEL_STYLE: Record<VolumeLevel['kind'], { color: string; width: number; dash?: string }> = {
  poc: { color: '#ea580c', width: 1.6 },
  vah: { color: '#7c3aed', width: 1, dash: '4 2' },
  val: { color: '#7c3aed', width: 1, dash: '4 2' },
  hvn: { color: '#9ca3af', width: 0.8, dash: '2 2' },
  pdh: { color: HILO, width: 1.1 },
  pdl: { color: HILO, width: 1.1 },
  tdh: { color: HILO, width: 0.8, dash: '1 1.5' },
  tdl: { color: HILO, width: 0.8, dash: '1 1.5' },
  ssh: { color: '#0891b2', width: 0.8, dash: '3 1.5' },
  ssl: { color: '#0891b2', width: 0.8, dash: '3 1.5' },
};

export function SessionForecastCard({
  data,
  error,
  price,
  digits,
  bias,
  stoch,
  aiChips,
}: {
  data: SessionsPayload | null;
  error?: string;
  price: number;
  digits: number;
  bias: TrendBias;
  stoch?: { k: number; d: number } | null; // 1時間足のストキャス
  aiChips?: Partial<Record<SessionKey, string>> | null; // AI（Jev）のシナリオがあれば小さく添える
}) {
  const [helpOpen, setHelpOpen] = useState(false);
  if (!data) {
    return (
      <div className="rounded-xl border border-gray-200 bg-white p-3 shadow-sm">
        <p className="text-sm font-bold text-gray-800">セッション別の動きの予想</p>
        <p className="mt-1 text-[11px] text-gray-400">{error || '読み込み中…'}</p>
      </div>
    );
  }
  const pip = pipSize(data.instrument);
  // 出来高の線＋高値・安値の線（古い Worker では高値・安値は無い）
  const allLevels = [...data.levels, ...(data.refs ?? [])];
  const rows = forecastSessions({ price, pip, digits, stats: data.stats, levels: allLevels, bias, stoch });
  if (!rows.length) return null;
  const fmt = (p: number) => p.toFixed(digits);

  return (
    <div className="rounded-xl border border-gray-200 bg-white p-3 shadow-sm">
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 text-sm font-bold text-gray-800">
          <span aria-hidden className="inline-block h-3.5 w-1 rounded-full bg-orange-400" />
          セッション別の動きの予想
        </span>
        <span className="text-[10px] text-gray-400">
          流れ {bias === 'up' ? '↑上昇' : bias === 'down' ? '↓下降' : '→レンジ'}
          {stoch && (
            <span className={stoch.k >= 80 ? 'ml-1 font-semibold text-red-600' : stoch.k <= 20 ? 'ml-1 font-semibold text-green-600' : 'ml-1'}>
              ・ストキャス {Math.round(stoch.k)}
            </span>
          )}
        </span>
      </div>

      <ForecastChart rows={rows} levels={allLevels} price={price} fmt={fmt} />

      {/* 1行ずつ: セッション・状態・一言・出来高の割合 */}
      <ul className="mt-1.5 space-y-1" style={LIST_RESET}>
        {rows.map((r) => (
          <li key={r.key} style={LIST_ITEM_RESET} className="flex items-center gap-1.5 text-[11px]">
            <span
              className="w-6 shrink-0 text-center text-[13px] font-bold leading-none"
              style={{ color: SCENARIO_COLOR[r.scenario] }}
              aria-hidden
            >
              {SCENARIO_ICON[r.scenario]}
            </span>
            <span className="w-[4.2rem] shrink-0">
              <span className="block font-bold text-gray-800">{r.label}</span>
              <span className={`block text-[9px] ${r.status === 'open' ? 'font-semibold text-green-700' : 'text-gray-400'}`}>
                {r.status === 'open' ? '● 開催中' : r.status === 'next' ? `次・あと${r.startsInH}時間` : `あと${r.startsInH}時間`}
              </span>
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate font-semibold" style={{ color: SCENARIO_COLOR[r.scenario] }}>
                {r.headline}
              </span>
              {r.reasons.length > 0 && (
                <span className="mt-0.5 flex flex-wrap gap-0.5">
                  {r.reasons.map((t) => (
                    <span key={t} className="rounded bg-gray-100 px-1 text-[9px] text-gray-600">
                      {t}
                    </span>
                  ))}
                </span>
              )}
              {aiChips?.[r.key] && <span className="block text-[9px] text-gray-400">AI: {aiChips[r.key]}</span>}
            </span>
            <VolumeShare r={r} />
          </li>
        ))}
      </ul>

      <button type="button" onClick={() => setHelpOpen((o) => !o)} aria-expanded={helpOpen} className="mt-1 text-[10px] text-gray-400">
        <span className="block">{helpOpen ? '見方を閉じる ▴' : '見方 ▾'}</span>
      </button>
      {helpOpen && (
        <div className="mt-0.5 space-y-1 rounded-md bg-gray-50 px-2 py-1.5 text-[10px] leading-relaxed text-gray-600">
          <div>
            横線＝{data.levelSource === 'volume' ? '出来高' : '滞在時間（このペアは出来高が無いため）'}の多い価格（抵抗線）:
            <span className="font-semibold text-orange-600"> POC</span>＝最も多い／
            <span className="font-semibold text-violet-600">VAH・VAL</span>＝70%が集まる範囲の上限・下限／
            <span className="font-semibold text-gray-500">山</span>＝ほかの山。
            <span className="font-semibold text-sky-700">青い線</span>＝前日・今日・直前のセッションの高値/安値。出来高の線と重なる線は抜けにくい「強い線」。
          </div>
          <div>ストキャス（1時間足）が流れの向きに行き過ぎ（上昇で 80 以上・下降で 20 以下）なら、抜けるシナリオを「止まる」に弱めます。</div>
          <div>
            箱＝そのセッションで動きそうな範囲（直近1か月の平均値幅を、1時間足の流れの向きに寄せたもの）。矢印＝予想の動き。
            {SCENARIO_ICON.break_up}抜けて次へ／{SCENARIO_ICON.stall_up}試して止まる／{SCENARIO_ICON.range}往復／{SCENARIO_ICON.drift_up}抵抗線なしで流れの向きへ。
          </div>
          <ul className="space-y-0.5" style={LIST_RESET}>
            {rows.map((r) => (
              <li key={`d-${r.key}`} style={LIST_ITEM_RESET}>
                {r.label}: 平均値幅 {r.stat.avgRangePips.toFixed(0)}pips・上げで終わる {r.stat.upPct}%・前のセッションの高安を抜ける {r.stat.breakPrevPct}%
                {r.stat.volumeShare != null ? `・出来高 ${r.stat.volumeShare}%` : ''}（{r.stat.samples}日）
              </li>
            ))}
          </ul>
          <div className="text-gray-400">※過去のくせと出来高からの推定です。投資助言ではありません。</div>
        </div>
      )}
    </div>
  );
}

function VolumeShare({ r }: { r: SessionForecast }) {
  if (r.stat.volumeShare == null) return null;
  return (
    <span className="flex w-12 shrink-0 flex-col items-end text-[9px] text-gray-400" title="3セッションの出来高に占める割合">
      出来高{r.stat.volumeShare}%
      <span className="mt-0.5 block h-1 w-full overflow-hidden rounded-full bg-gray-100">
        <span className="block h-full bg-gray-400" style={{ width: `${Math.min(100, r.stat.volumeShare * 2)}%` }} />
      </span>
    </span>
  );
}

// 横=時間（3列のセッション）、縦=価格。抵抗線の横線・各セッションの範囲の箱・予想の矢印。
function ForecastChart({ rows, levels, price, fmt }: { rows: SessionForecast[]; levels: VolumeLevel[]; price: number; fmt: (p: number) => string }) {
  const W = 320;
  const H = 150;
  const padL = 10;
  const padR = 74; // 「前日高値 151.850」が入る幅
  const padTop = 14;
  const padBottom = 6;
  const colW = (W - padL - padR) / rows.length;
  const lo0 = Math.min(price, ...rows.map((r) => r.low));
  const hi0 = Math.max(price, ...rows.map((r) => r.high));
  const span0 = hi0 - lo0 || 1;
  // 抵抗線は、範囲の少し外（25%）まで入れて描く
  const shown = levels.filter((l) => l.price >= lo0 - span0 * 0.25 && l.price <= hi0 + span0 * 0.25);
  const lo = Math.min(lo0, ...shown.map((l) => l.price)) - span0 * 0.04;
  const hi = Math.max(hi0, ...shown.map((l) => l.price)) + span0 * 0.04;
  const y = (p: number) => padTop + ((hi - p) / (hi - lo || 1)) * (H - padTop - padBottom);

  // 右端ラベル（重なりを避ける）
  const labels = shown
    .map((l) => ({ l, ly: y(l.price) }))
    .sort((a, b) => a.ly - b.ly);
  for (let k = 1; k < labels.length; k++) if (labels[k].ly - labels[k - 1].ly < 10) labels[k].ly = labels[k - 1].ly + 10;

  // 予想の矢印の通り道（列の左端＝現在値から）
  const path = (r: SessionForecast, x0: number, x1: number): string => {
    const mid = (x0 + x1) / 2;
    const t = r.target?.price;
    switch (r.scenario) {
      case 'break_up':
      case 'break_down':
        return `M ${x0} ${y(price)} L ${x1} ${y(t ?? (r.scenario === 'break_up' ? r.high : r.low))}`;
      case 'stall_up':
      case 'stall_down': {
        const back = price + ((t ?? price) - price) * 0.35;
        return `M ${x0} ${y(price)} L ${mid} ${y(t ?? price)} L ${x1} ${y(back)}`;
      }
      case 'drift_up':
        return `M ${x0} ${y(price)} L ${x1} ${y(r.high)}`;
      case 'drift_down':
        return `M ${x0} ${y(price)} L ${x1} ${y(r.low)}`;
      default: {
        const a = x0 + (x1 - x0) / 3;
        const b = x0 + ((x1 - x0) * 2) / 3;
        return `M ${x0} ${y(price)} L ${a} ${y(r.high - (r.high - price) * 0.2)} L ${b} ${y(r.low + (price - r.low) * 0.2)} L ${x1} ${y(price)}`;
      }
    }
  };

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="mt-1.5 h-auto w-full" role="img" aria-label="セッションごとの動きの予想と出来高の抵抗線">
      <defs>
        {(['up', 'down', 'stall', 'range'] as const).map((k) => (
          <marker key={k} id={`sf-arrow-${k}`} viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" fill={k === 'up' ? UP : k === 'down' ? DOWN : k === 'stall' ? STALL : RANGE} />
          </marker>
        ))}
      </defs>
      {/* 列（セッション）の区切りと見出し */}
      {rows.map((r, k) => {
        const x0 = padL + colW * k;
        return (
          <g key={`col-${r.key}`}>
            <rect x={x0 + 1} y={padTop - 12} width={colW - 2} height={H - padTop + 10} rx="3" fill={r.status === 'open' ? '#f0fdf4' : '#f9fafb'} />
            <text x={x0 + colW / 2} y={padTop - 4} textAnchor="middle" className="text-[7.5px] font-bold" fill={r.status === 'open' ? '#15803d' : '#4b5563'}>
              {r.label}
              {r.status === 'open' ? '（今）' : ''}
            </text>
          </g>
        );
      })}
      {/* 出来高の抵抗線 */}
      {shown.map((l, k) => (
        <line
          key={`lv-${k}`}
          x1={padL}
          x2={W - padR}
          y1={y(l.price)}
          y2={y(l.price)}
          stroke={LEVEL_STYLE[l.kind].color}
          strokeWidth={LEVEL_STYLE[l.kind].width}
          strokeDasharray={LEVEL_STYLE[l.kind].dash}
          opacity="0.8"
        />
      ))}
      {/* 各セッションの動きそうな範囲（箱）と予想の動き（矢印） */}
      {rows.map((r, k) => {
        const x0 = padL + colW * k + 5;
        const x1 = padL + colW * (k + 1) - 5;
        const color = SCENARIO_COLOR[r.scenario];
        const marker = color === UP ? 'up' : color === DOWN ? 'down' : color === STALL ? 'stall' : 'range';
        return (
          <g key={`fc-${r.key}`}>
            <rect x={x0} y={y(r.high)} width={x1 - x0} height={Math.max(2, y(r.low) - y(r.high))} rx="2" fill={color} opacity="0.12" stroke={color} strokeOpacity="0.35" strokeWidth="0.6" />
            <path d={path(r, x0 + 3, x1 - 3)} fill="none" stroke={color} strokeWidth="1.6" strokeLinejoin="round" markerEnd={`url(#sf-arrow-${marker})`} />
          </g>
        );
      })}
      {/* 現在値 */}
      <line x1={padL} x2={W - padR} y1={y(price)} y2={y(price)} stroke={NOW} strokeWidth="0.7" strokeDasharray="1.5 2" />
      <circle cx={padL + 2} cy={y(price)} r="2.5" fill={NOW} />
      {/* 右端: 抵抗線のラベル＋現在値 */}
      {labels.map(({ l, ly }, k) => (
        <g key={`lb-${k}`}>
          <rect x={W - padR + 2} y={ly - 4.5} width={padR - 2} height="9" rx="2" fill="white" stroke={LEVEL_STYLE[l.kind].color} strokeWidth="0.7" />
          <text x={W - padR + 4} y={ly + 2.3} className={`text-[6.5px] ${isVolumeKind(l.kind) ? 'font-bold' : 'font-semibold'}`} fill={LEVEL_STYLE[l.kind].color}>
            {levelName(l)} {fmt(l.price)}
          </text>
        </g>
      ))}
    </svg>
  );
}
