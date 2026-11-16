// 東京・ロンドン・NY の動きの予想カード（TF分析ページ）。材料は Worker の /sessions、予想は forecastSessions（純関数）。
// 一目で分かるように:
//   - 見出しの右: 流れ（↑↓→）とストキャスのゲージ（0〜100、20/80 の帯）。全セッション共通の材料なので行には繰り返さない
//   - SVG: 横=時間（開催中/次のセッションから順に3列）、縦=価格。抵抗線（出来高・高値/安値）を横線で引き、
//     近くに重なる線は1本にまとめる（出来高と高値/安値が重なる＝「強い線」は太線＋★）。
//     各セッションの「動きそうな範囲」を箱、予想の動きを矢印で描く（上=緑・下=赤・止まる=琥珀・往復=灰）
//   - 下に1行ずつ: 予想の向きのバッジ（上抜け/止まる/往復…）・セッション・状態・一言・理由のチップ・出来高の割合
//     いちばん近いセッション（開催中/次）は大きく目立たせる
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
// バッジの短い言葉（記号だけだと分かりにくいので添える）
const SCENARIO_WORD: Record<SessionScenarioKind, string> = {
  break_up: '上抜け',
  drift_up: '上へ',
  break_down: '下抜け',
  drift_down: '下へ',
  stall_up: '上で止まる',
  stall_down: '下で止まる',
  range: '往復',
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

// 理由のタグを、種類ごとの色つきチップに（「A と B が重なる」→「強い線 A＋B」）。ストキャスは見出しにまとめるので除く。
function reasonChips(reasons: string[]): { text: string; tone: 'strong' | 'other' }[] {
  return reasons
    .filter((t) => !t.startsWith('ストキャス'))
    .map((t) => {
      const m = /^(.+)と(.+)が重なる$/.exec(t);
      return m ? { text: `強い線 ${m[1]}＋${m[2]}`, tone: 'strong' as const } : { text: t, tone: 'other' as const };
    });
}

// 予想が「強い線」と判断した線の名前（チャートの★と行のチップを一致させる）
function strongNames(rows: SessionForecast[]): Set<string> {
  const out = new Set<string>();
  for (const r of rows)
    for (const t of r.reasons) {
      const m = /^(.+)と(.+)が重なる$/.exec(t);
      if (m) {
        out.add(m[1]);
        out.add(m[2]);
      }
    }
  return out;
}

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
      <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
        <span className="flex items-center gap-1.5 text-sm font-bold text-gray-800">
          <span aria-hidden className="inline-block h-3.5 w-1 rounded-full bg-orange-400" />
          セッション別の動きの予想
        </span>
        <span className="flex items-center gap-2">
          <BiasPill bias={bias} />
          {stoch && <StochGauge k={stoch.k} d={stoch.d} />}
        </span>
      </div>

      <ForecastChart rows={rows} levels={allLevels} price={price} fmt={fmt} strongNames={strongNames(rows)} />

      {/* 1行ずつ: 向きのバッジ・セッション・状態・一言・理由・出来高の割合。先頭（開催中/次）は大きく */}
      <ul className="mt-2 space-y-1.5" style={LIST_RESET}>
        {rows.map((r, idx) => {
          const color = SCENARIO_COLOR[r.scenario];
          const lead = idx === 0;
          const chips = reasonChips(r.reasons);
          return (
            <li
              key={r.key}
              style={{ ...LIST_ITEM_RESET, borderLeftColor: color, background: lead ? `${color}0f` : undefined }}
              className={`flex items-start gap-2 rounded-md border-l-4 px-2 ${lead ? 'py-2' : 'py-1'}`}
            >
              <span className="w-[4.6rem] shrink-0">
                <span className="block text-[12px] font-bold text-gray-800">{r.label}</span>
                <span className={`block text-[10px] ${r.status === 'open' ? 'font-semibold text-green-700' : 'text-gray-400'}`}>
                  {r.status === 'open' ? '● 開催中' : r.status === 'next' ? `次・あと${r.startsInH}時間` : `あと${r.startsInH}時間`}
                </span>
                <VolumeShare r={r} />
              </span>
              <span className="min-w-0 flex-1">
                <span
                  className="inline-flex items-center gap-0.5 rounded-full px-1.5 py-px text-[10px] font-bold text-white"
                  style={{ background: color }}
                >
                  <span aria-hidden>{SCENARIO_ICON[r.scenario]}</span>
                  {SCENARIO_WORD[r.scenario]}
                </span>
                <span className={`mt-0.5 block font-bold leading-snug ${lead ? 'text-[14px]' : 'text-[12.5px]'}`} style={{ color, wordBreak: 'keep-all', overflowWrap: 'anywhere' }}>
                  {r.headline}
                </span>
                {chips.length > 0 && (
                  <span className="mt-0.5 flex flex-wrap gap-1">
                    {chips.map((c) => (
                      <span
                        key={c.text}
                        className={
                          c.tone === 'strong'
                            ? 'rounded border border-sky-200 bg-sky-50 px-1 text-[10px] font-semibold text-sky-800'
                            : 'rounded bg-gray-100 px-1 text-[10px] text-gray-600'
                        }
                      >
                        {c.tone === 'strong' ? '★ ' : ''}
                        {c.text}
                      </span>
                    ))}
                  </span>
                )}
                {aiChips?.[r.key] && <span className="mt-0.5 block text-[10px] text-gray-400">AI: {aiChips[r.key]}</span>}
              </span>
            </li>
          );
        })}
      </ul>

      <button type="button" onClick={() => setHelpOpen((o) => !o)} aria-expanded={helpOpen} className="mt-1.5 text-[10px] text-gray-400">
        <span className="block">{helpOpen ? '見方を閉じる ▴' : '見方 ▾'}</span>
      </button>
      {helpOpen && (
        <div className="mt-0.5 space-y-1 rounded-md bg-gray-50 px-2 py-1.5 text-[10px] leading-relaxed text-gray-600">
          <div>
            横線＝{data.levelSource === 'volume' ? '出来高' : '滞在時間（このペアは出来高が無いため）'}の多い価格（抵抗線）:
            <span className="font-semibold text-orange-600"> POC</span>＝最も多い／
            <span className="font-semibold text-violet-600">VAH・VAL</span>＝70%が集まる範囲の上限・下限／
            <span className="font-semibold text-gray-500">山</span>＝ほかの山。
            <span className="font-semibold text-sky-700">青い線</span>＝前日・今日・直前のセッションの高値/安値。
            <span className="font-semibold text-sky-800">★太線</span>＝出来高の線と高値/安値が重なる、抜けにくい「強い線」。
          </div>
          <div>ストキャス（1時間足）が流れの向きに行き過ぎ（上昇で 80 以上・下降で 20 以下）なら、抜けるシナリオを「止まる」に弱めます。</div>
          <div>
            箱＝そのセッションで動きそうな範囲（直近1か月の平均値幅を、1時間足の流れの向きに寄せたもの）。矢印＝予想の動き。
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

function BiasPill({ bias }: { bias: TrendBias }) {
  const [txt, cls] =
    bias === 'up' ? ['↑ 上昇', 'bg-green-50 text-green-700'] : bias === 'down' ? ['↓ 下降', 'bg-red-50 text-red-700'] : ['→ レンジ', 'bg-gray-100 text-gray-600'];
  return (
    <span className={`rounded-full px-1.5 py-px text-[10px] font-semibold ${cls}`} title="1時間足の流れ">
      流れ {txt}
    </span>
  );
}

// ストキャスのゲージ: 0〜100 のバーに 20 以下（売られすぎ）/80 以上（買われすぎ）の帯と %K の位置
function StochGauge({ k, d }: { k: number; d: number }) {
  const v = Math.max(0, Math.min(100, k));
  const hot = k >= 80;
  const cold = k <= 20;
  const word = hot ? '買われすぎ' : cold ? '売られすぎ' : k < d && k >= 60 ? '下向きに交差' : k > d && k <= 40 ? '上向きに交差' : '';
  return (
    <span className="flex items-center gap-1 text-[10px]" title="1時間足のストキャス（%K）">
      <span className="text-gray-400">ストキャス</span>
      <span className="relative block h-1.5 w-14 overflow-hidden rounded-full bg-gray-100">
        <span className="absolute inset-y-0 left-0 w-[20%] bg-green-200" />
        <span className="absolute inset-y-0 right-0 w-[20%] bg-red-200" />
        <span
          className="absolute top-1/2 h-2.5 w-1 -translate-y-1/2 rounded-sm"
          style={{ left: `calc(${v}% - 2px)`, background: hot ? DOWN : cold ? UP : '#374151' }}
        />
      </span>
      <span className={`font-bold ${hot ? 'text-red-600' : cold ? 'text-green-600' : 'text-gray-700'}`}>{Math.round(k)}</span>
      {word && <span className={`font-semibold ${hot ? 'text-red-600' : cold ? 'text-green-600' : 'text-gray-500'}`}>{word}</span>}
    </span>
  );
}

function VolumeShare({ r }: { r: SessionForecast }) {
  if (r.stat.volumeShare == null) return null;
  return (
    <span className="mt-1 block text-[9px] text-gray-400" title="3セッションの出来高に占める割合">
      出来高 {r.stat.volumeShare}%
      <span className="mt-0.5 block h-1 w-14 overflow-hidden rounded-full bg-gray-100">
        <span className="block h-full bg-gray-400" style={{ width: `${Math.min(100, r.stat.volumeShare * 2)}%` }} />
      </span>
    </span>
  );
}

// 近くに重なる線を1本にまとめる。出来高の線と高値/安値が混ざっていれば「強い線」
interface LevelGroup {
  price: number;
  members: VolumeLevel[];
  strong: boolean;
  main: VolumeLevel; // 線の色・太さの元（出来高の線を優先）
}
function groupLevels(levels: VolumeLevel[], gap: number): LevelGroup[] {
  const sorted = [...levels].sort((a, b) => b.price - a.price);
  const groups: VolumeLevel[][] = [];
  for (const l of sorted) {
    const g = groups[groups.length - 1];
    if (g && Math.abs(g[0].price - l.price) <= gap) g.push(l);
    else groups.push([l]);
  }
  const rank: VolumeLevel['kind'][] = ['poc', 'vah', 'val', 'pdh', 'pdl', 'ssh', 'ssl', 'tdh', 'tdl', 'hvn'];
  return groups.map((members) => {
    const main = [...members].sort((a, b) => rank.indexOf(a.kind) - rank.indexOf(b.kind))[0];
    const strong = members.some((m) => isVolumeKind(m.kind)) && members.some((m) => !isVolumeKind(m.kind));
    return { price: main.price, members, strong, main };
  });
}

// 横=時間（3列のセッション）、縦=価格。抵抗線の横線・各セッションの範囲の箱・予想の矢印。
function ForecastChart({
  rows,
  levels,
  price,
  fmt,
  strongNames,
}: {
  rows: SessionForecast[];
  levels: VolumeLevel[];
  price: number;
  fmt: (p: number) => string;
  strongNames: Set<string>;
}) {
  const W = 320;
  const H = 160;
  const padL = 10;
  const padR = 90; // 「★東京高値＋VAH 151.420」が入る幅
  const padTop = 15;
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
  // 縦 6px 以内に入る線は1本にまとめる
  const groups = groupLevels(shown, ((hi - lo) * 6) / (H - padTop - padBottom)).map((g) => ({
    ...g,
    strong: g.strong || g.members.some((m) => strongNames.has(levelName(m))),
  }));

  // 右端ラベル（現在値も入れて、重なりを避ける）
  type Lab = { ly: number; text: string; color: string; strong: boolean; now?: boolean };
  const labels: Lab[] = [
    ...groups.map((g) => {
      const names = g.members.map(levelName);
      const name = names.length > 2 ? `${names[0]}ほか${names.length - 1}` : names.join('＋');
      return { ly: y(g.price), text: `${g.strong ? '★' : ''}${name} ${fmt(g.price)}`, color: g.strong ? '#075985' : LEVEL_STYLE[g.main.kind].color, strong: g.strong };
    }),
    { ly: y(price), text: `いま ${fmt(price)}`, color: NOW, strong: false, now: true },
  ].sort((a, b) => a.ly - b.ly);
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
    <svg viewBox={`0 0 ${W} ${H}`} className="mt-1.5 h-auto w-full" role="img" aria-label="セッションごとの動きの予想と抵抗線">
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
            <rect x={x0 + 1} y={padTop - 13} width={colW - 2} height={H - padTop + 11} rx="3" fill={r.status === 'open' ? '#f0fdf4' : '#f9fafb'} />
            <text x={x0 + colW / 2} y={padTop - 4} textAnchor="middle" className="text-[8px] font-bold" fill={r.status === 'open' ? '#15803d' : '#4b5563'}>
              {r.label}
              {r.status === 'open' ? '（今）' : ''}
            </text>
          </g>
        );
      })}
      {/* 抵抗線（強い線は下に薄い帯＋太線） */}
      {groups.map((g, k) => {
        const st = LEVEL_STYLE[g.main.kind];
        const ly = y(g.price);
        return (
          <g key={`lv-${k}`}>
            {g.strong && <rect x={padL} y={ly - 2.5} width={W - padR - padL} height="5" fill="#0ea5e9" opacity="0.15" />}
            <line
              x1={padL}
              x2={W - padR}
              y1={ly}
              y2={ly}
              stroke={g.strong ? '#0369a1' : st.color}
              strokeWidth={g.strong ? 1.8 : st.width}
              strokeDasharray={g.strong ? undefined : st.dash}
              opacity="0.85"
            />
          </g>
        );
      })}
      {/* 各セッションの動きそうな範囲（箱）と予想の動き（矢印） */}
      {rows.map((r, k) => {
        const x0 = padL + colW * k + 5;
        const x1 = padL + colW * (k + 1) - 5;
        const color = SCENARIO_COLOR[r.scenario];
        const marker = color === UP ? 'up' : color === DOWN ? 'down' : color === STALL ? 'stall' : 'range';
        return (
          <g key={`fc-${r.key}`}>
            <rect x={x0} y={y(r.high)} width={x1 - x0} height={Math.max(2, y(r.low) - y(r.high))} rx="2" fill={color} opacity="0.1" stroke={color} strokeOpacity="0.3" strokeWidth="0.6" />
            <path d={path(r, x0 + 3, x1 - 3)} fill="none" stroke={color} strokeWidth="1.8" strokeLinejoin="round" markerEnd={`url(#sf-arrow-${marker})`} />
          </g>
        );
      })}
      {/* 現在値 */}
      <line x1={padL} x2={W - padR} y1={y(price)} y2={y(price)} stroke={NOW} strokeWidth="0.8" strokeDasharray="1.5 2" />
      <circle cx={padL + 2} cy={y(price)} r="2.8" fill={NOW} />
      {/* 右端: 抵抗線のラベル＋現在値 */}
      {labels.map((lb, k) => (
        <g key={`lb-${k}`}>
          <rect
            x={W - padR + 2}
            y={lb.ly - 4.8}
            width={padR - 2}
            height="9.6"
            rx="2"
            fill={lb.now ? NOW : lb.strong ? '#e0f2fe' : 'white'}
            stroke={lb.color}
            strokeWidth={lb.strong ? 1 : 0.7}
          />
          <text x={W - padR + 4} y={lb.ly + 2.4} className="text-[6.8px] font-bold" fill={lb.now ? 'white' : lb.color}>
            {lb.text}
          </text>
        </g>
      ))}
    </svg>
  );
}
