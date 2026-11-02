// 下位足（1分足・5分足）で入るタイミングを確かめるパネル（TF分析ページのエントリー判断の下）。
// 開いたときだけ Worker /ltf から下位足を取り、60 秒ごとに更新する。判定は ltfTrigger（純関数）。
// 表示: 状態のバッジ → チェックリスト（入る場所に来たか・下位足で向きが変わったか）→ 下位足のチャート
// （転換のライン・押し安値・下位足の損切り・入る価格）→ 上位足のまま入る場合との比較（損切り・RR）。
import { useEffect, useState } from 'react';
import type { OhlcCandle } from '@/lib/edge';
import { assessLtfTrigger, type LtfPlanArea, type LtfResult, type LtfState } from '@/lib/ltfTrigger';
import { pipSize, type SlDirection } from '@/lib/stoploss';
import { LIST_ITEM_RESET, LIST_RESET } from '@/lib/listReset';

type LtfTf = '1m' | '5m';
interface LtfPayload {
  instrument: string;
  currentRate: number;
  tfs: { tf: LtfTf; bars: OhlcCandle[]; forming: OhlcCandle | null }[];
  generatedAt: number;
}

const STATE_STYLE: Record<LtfState, { label: string; cls: string; icon: string }> = {
  triggered: { label: 'トリガー点灯', cls: 'bg-green-600 text-white', icon: '🟢' },
  wait_turn: { label: '転換待ち', cls: 'bg-amber-100 text-amber-800', icon: '🟡' },
  wait_area: { label: '場所待ち', cls: 'bg-gray-100 text-gray-600', icon: '⏳' },
  invalid: { label: 'プラン無効', cls: 'bg-red-100 text-red-700', icon: '⛔' },
};
const TF_LABEL: Record<LtfTf, string> = { '1m': '1分足', '5m': '5分足' };

export function LtfEntryPanel({
  url,
  instrument,
  currentRate,
  digits,
  direction,
  area,
  htfStop,
  target,
  spreadPips,
}: {
  url: string; // Worker /ltf の URL
  instrument: string;
  currentRate: number; // 画面の現在値（XAU は現物基準）
  digits: number;
  direction: SlDirection;
  area: LtfPlanArea;
  htfStop: number;
  target: number;
  spreadPips: number;
}) {
  const [open, setOpen] = useState(false);
  const [tf, setTf] = useState<LtfTf>('5m');
  const [data, setData] = useState<LtfPayload | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch(`${url}?instrument=${encodeURIComponent(instrument)}`);
        const body = (await res.json()) as LtfPayload | { error: string };
        if ('error' in body) throw new Error(body.error);
        if (!cancelled) {
          setData(body);
          setError('');
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : '取得に失敗しました');
      }
    };
    void load();
    const timer = setInterval(load, 60_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [open, url, instrument]);

  // XAU は Worker が金先物（GC=F）基準なので、画面の現物価格との差だけ平行移動する。
  const off = data && instrument.startsWith('XAU') ? currentRate - data.currentRate : 0;
  const shift = (b: OhlcCandle): OhlcCandle => ({ ...b, open: b.open + off, high: b.high + off, low: b.low + off, close: b.close + off });
  const series = data?.tfs.find((t) => t.tf === tf);
  const bars = series ? series.bars.map(shift) : [];
  const forming = series?.forming ? shift(series.forming) : null;
  const price = forming?.close ?? currentRate;
  const result = bars.length ? assessLtfTrigger({ direction, bars, price, instrument, area, htfStop, target, spreadPips }) : null;
  const fmt = (p: number) => p.toFixed(digits);
  const long = direction === 'long';

  return (
    <div className="mt-2 rounded-lg border border-gray-200 bg-white">
      {/* 余白は内側の span に付ける（Mobiscroll のボタン用 CSS に打ち消されないように） */}
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="block w-full text-left">
        <span className="flex items-center justify-between gap-2 px-2.5 py-2 text-[11px]">
          <span className="font-bold text-gray-700">下位足（1分・5分）で入りどきを確かめる</span>
          <span className="flex items-center gap-1.5">
            {open && result && (
              <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${STATE_STYLE[result.state].cls}`}>
                {STATE_STYLE[result.state].icon}
                {STATE_STYLE[result.state].label}
              </span>
            )}
            <span className={`text-gray-400 transition-transform ${open ? 'rotate-180' : ''}`} aria-hidden>
              ▾
            </span>
          </span>
        </span>
      </button>

      {open && (
        <div className="border-t border-gray-100 px-2.5 pb-2.5 pt-2 text-[11px]">
          <div className="flex items-center justify-between gap-2">
            <div className="flex gap-1">
              {(['1m', '5m'] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setTf(t)}
                  aria-pressed={tf === t}
                  className={`rounded-full border text-[11px] font-semibold ${tf === t ? 'border-gray-800 bg-gray-800 text-white' : 'border-gray-200 bg-white text-gray-600'}`}
                >
                  <span className="block px-2.5 py-0.5">{TF_LABEL[t]}</span>
                </button>
              ))}
            </div>
            <span className="text-[10px] text-gray-400">
              {data ? `${new Date(data.generatedAt).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })} 時点・1分ごとに更新` : '読み込み中…'}
            </span>
          </div>

          {error && <div className="mt-1.5 text-[10px] text-red-600">{error}</div>}
          {data && !result && <div className="mt-1.5 text-[10px] text-gray-500">下位足の本数が足りません（市場が閉まっている時間など）。</div>}

          {result && (
            <>
              <div className="mt-2 flex items-center gap-1.5">
                <span className={`rounded px-1.5 py-0.5 text-[11px] font-bold ${STATE_STYLE[result.state].cls}`}>
                  {STATE_STYLE[result.state].icon}
                  {STATE_STYLE[result.state].label}
                </span>
                <span className="text-[10px] text-gray-500">{TF_LABEL[tf]}で判定</span>
              </div>
              {result.checks.length > 0 && (
                <ul className="mt-1 space-y-0.5" style={LIST_RESET}>
                  {result.checks.map((c, k) => (
                    <li style={LIST_ITEM_RESET} key={c.label} className="flex items-start gap-1.5">
                      <span className={`font-bold ${c.ok ? 'text-green-600' : 'text-gray-300'}`}>{c.ok ? '✓' : `${k + 1}`}</span>
                      <span className={c.ok ? 'text-gray-800' : 'text-gray-500'}>{c.label}</span>
                    </li>
                  ))}
                </ul>
              )}
              <div className="mt-1 text-[10px] leading-relaxed text-gray-600">{result.note}</div>

              <LtfChart bars={bars} forming={forming} result={result} long={long} digits={digits} htfStop={htfStop} />

              {/* 上位足のまま入る場合と、下位足で入る場合の比較 */}
              <div className="mt-2 grid grid-cols-[auto_1fr_1fr] gap-x-2 gap-y-0.5 rounded-md bg-gray-50 px-2 py-1.5 text-[10px]">
                <span />
                <span className="font-semibold text-gray-500">上位足のまま</span>
                <span className="font-semibold text-gray-700">下位足で入る</span>
                <span className="text-gray-500">入り方</span>
                <span className="text-gray-600">
                  {area.kind === 'market' ? '成行' : area.kind === 'limit' ? '指値' : '逆指値'} {fmt(area.price)}
                </span>
                <span className="font-semibold text-gray-800">
                  {result.refined ? `${result.refined.entryType === 'market' ? '成行' : '逆指値'} ${fmt(result.refined.entry)}` : '—'}
                </span>
                <span className="text-gray-500">損切り</span>
                <span className="text-gray-600">
                  {fmt(htfStop)}
                  <span className="block text-gray-400">−{((Math.abs(area.price - htfStop)) / pipSize(instrument)).toFixed(1)}pips</span>
                </span>
                <span className="font-semibold text-red-700">
                  {result.refined ? (
                    <>
                      {fmt(result.refined.stop)}
                      <span className="block font-normal text-gray-400">
                        −{result.refined.riskPips.toFixed(1)}pips・{result.refined.stopBasis}
                      </span>
                    </>
                  ) : (
                    '—'
                  )}
                </span>
                <span className="text-gray-500">RR</span>
                <span className="text-gray-600">1:{result.htfRr.toFixed(1)}</span>
                <span className={`font-bold ${result.refined && result.refined.rr > result.htfRr ? 'text-orange-600' : 'text-gray-800'}`}>
                  {result.refined ? `1:${result.refined.rr.toFixed(1)}` : '—'}
                </span>
              </div>
              <div className="mt-1 text-[10px] text-gray-400">
                目標は上位足と同じ {fmt(target)}。下位足の損切りは狭いぶん、だましで刈られやすくなります。ロットは損切り幅に合わせて計算してください。
                {result.refined && result.refined.rr >= 5 && (
                  <span className="block text-amber-700">
                    RR が大きく見えるのは損切りが狭いためで、目標まで届く確率はそのぶん下がります。途中の抵抗帯で一部利確するなど、出口も考えておきましょう。
                  </span>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// 下位足のチャート: ローソク足 ＋ 転換のライン（戻り高値/押し安値）・損切り・入る価格。目標は遠いので値幅に含めない。
function LtfChart({
  bars,
  forming,
  result,
  long,
  digits,
  htfStop,
}: {
  bars: OhlcCandle[];
  forming: OhlcCandle | null;
  result: LtfResult;
  long: boolean;
  digits: number;
  htfStop: number;
}) {
  const all = forming ? [...bars, forming] : bars;
  if (all.length < 2) return null;
  const W = 320;
  const H = 120;
  const padL = 4;
  const padR = 74;
  const padY = 8;
  const lines: { key: string; price: number; color: string; label: string; dash?: string }[] = [];
  if (result.swingHigh) lines.push({ key: 'turn', price: result.swingHigh.price, color: '#2563eb', label: long ? '転換ライン' : '転換ライン', dash: '3 2' });
  if (result.refined) {
    lines.push({ key: 'entry', price: result.refined.entry, color: '#111827', label: result.refined.entryType === 'market' ? '成行' : '逆指値' });
    lines.push({ key: 'stop', price: result.refined.stop, color: '#dc2626', label: '損切り', dash: '4 2' });
  }
  // 上位足の損切りは、値幅の近くにあるときだけ描く（遠いと足が潰れるので）。
  const lo0 = Math.min(...all.map((b) => b.low));
  const hi0 = Math.max(...all.map((b) => b.high));
  if (htfStop >= lo0 - (hi0 - lo0) * 0.5 && htfStop <= hi0 + (hi0 - lo0) * 0.5) {
    lines.push({ key: 'htf', price: htfStop, color: '#9ca3af', label: '上位足の損切り', dash: '1.5 2' });
  }
  const lo = Math.min(lo0, ...lines.map((l) => l.price));
  const hi = Math.max(hi0, ...lines.map((l) => l.price));
  const span = hi - lo || 1;
  const y = (p: number) => padY + ((hi - p) / span) * (H - padY * 2);
  const slot = (W - padL - padR) / all.length;
  const cx = (k: number) => padL + slot * (k + 0.5);
  const bodyW = Math.max(1, slot * 0.6);
  // ラベルの重なりを避ける
  const labels = lines.map((l) => ({ ...l, ly: y(l.price) })).sort((a, b) => a.ly - b.ly);
  for (let k = 1; k < labels.length; k++) if (labels[k].ly - labels[k - 1].ly < 12) labels[k].ly = labels[k - 1].ly + 12;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="mt-1.5 h-auto w-full rounded bg-gray-50" role="img" aria-label="下位足のローソク足と転換ライン・損切り・入る価格">
      {all.map((b, k) => {
        const up = b.close >= b.open;
        const color = up ? '#16a34a' : '#dc2626';
        const top = y(Math.max(b.open, b.close));
        const bh = Math.max(0.8, y(Math.min(b.open, b.close)) - top);
        return (
          <g key={k} opacity={forming && k === all.length - 1 ? 0.4 : 1}>
            <line x1={cx(k)} x2={cx(k)} y1={y(b.high)} y2={y(b.low)} stroke={color} strokeWidth="0.8" />
            <rect x={cx(k) - bodyW / 2} y={top} width={bodyW} height={bh} fill={up ? 'white' : color} stroke={color} strokeWidth="0.7" />
          </g>
        );
      })}
      {lines.map((l) => (
        <line key={l.key} x1={padL} x2={W - padR} y1={y(l.price)} y2={y(l.price)} stroke={l.color} strokeWidth="1.1" strokeDasharray={l.dash} />
      ))}
      {labels.map((l) => (
        <g key={`lb-${l.key}`}>
          <rect x={W - padR + 1} y={l.ly - 5.5} width={padR - 1} height="11" rx="2" fill={l.color} />
          <text x={W - padR + 3} y={l.ly + 2.6} className="text-[7px] font-bold" fill="white">
            {l.label} {l.price.toFixed(digits)}
          </text>
        </g>
      ))}
    </svg>
  );
}
