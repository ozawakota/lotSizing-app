// 下位足（1分足・5分足）のエントリーポイント（TF分析ページ。全時間足のまとめのすぐ下に常に表示）。
// Worker /ltf から下位足を取り、60 秒ごとに更新する。判定は ltfTrigger（純関数）。
//   - 上位足のプラン（方向・入る場所・損切り・目標）があるとき: 1分足・5分足それぞれで
//     状態（場所待ち/転換待ち/トリガー点灯）と、具体的な入り方（成行/逆指値の価格）・損切り・目標・RR を横並びで出す。
//   - 上位足のプランが無いとき: 下位足の値幅（直近の高値・安値）を抜けた方向について行く場合の
//     買い/売りの逆指値・損切り・目標（RR 1:2）を参考として出す（流れの向きの方を「本命」）。
// 下のタブで選んだ足のチャート（転換ライン・入る価格・損切り）とチェックリストを出す。
import { useCallback, useEffect, useState } from 'react';
import type { OhlcCandle } from '@/lib/edge';
import {
  assessLtfTrigger,
  ltfStructure,
  LTF_BREAKOUT_RR,
  type LtfPlanArea,
  type LtfResult,
  type LtfState,
  type LtfStructure,
  type LtfTrend,
} from '@/lib/ltfTrigger';
import type { SlDirection } from '@/lib/stoploss';
import { LIST_ITEM_RESET, LIST_RESET } from '@/lib/listReset';

type LtfTf = '1m' | '5m';
const LTF_TFS: LtfTf[] = ['1m', '5m'];
interface LtfPayload {
  instrument: string;
  currentRate: number;
  tfs: { tf: LtfTf; bars: OhlcCandle[]; forming: OhlcCandle | null }[];
  generatedAt: number;
}

/** 上位足のプラン（TF分析で選んだ時間足、または RR が出ている時間足）。 */
export interface HtfPlan {
  tfLabel: string; // 「1時間足」など
  direction: SlDirection;
  area: LtfPlanArea;
  htfStop: number;
  target: number;
  spreadPips: number;
}

const STATE_STYLE: Record<LtfState, { label: string; cls: string; icon: string }> = {
  triggered: { label: 'トリガー点灯', cls: 'bg-green-600 text-white', icon: '🟢' },
  wait_turn: { label: '転換待ち', cls: 'bg-amber-100 text-amber-800', icon: '🟡' },
  wait_area: { label: '場所待ち', cls: 'bg-gray-100 text-gray-600', icon: '⏳' },
  invalid: { label: 'プラン無効', cls: 'bg-red-100 text-red-700', icon: '⛔' },
};
const TREND_STYLE: Record<LtfTrend, { label: string; cls: string }> = {
  up: { label: '上昇（高値・安値を切り上げ）', cls: 'text-green-700' },
  down: { label: '下降（高値・安値を切り下げ）', cls: 'text-red-700' },
  range: { label: 'もみ合い', cls: 'text-gray-500' },
};
const TF_LABEL: Record<LtfTf, string> = { '1m': '1分足', '5m': '5分足' };
const AREA_LABEL: Record<LtfPlanArea['kind'], string> = { market: '成行', limit: '指値', stop: '逆指値' };

export function LtfEntryCard({
  url,
  instrument,
  currentRate,
  digits,
  plan,
}: {
  url: string; // Worker /ltf の URL
  instrument: string;
  currentRate: number; // 画面の現在値（XAU は現物基準）
  digits: number;
  plan: HtfPlan | null;
}) {
  const [tf, setTf] = useState<LtfTf>('5m');
  const [data, setData] = useState<LtfPayload | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const reload = useCallback(() => setReloadKey((k) => k + 1), []);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    const load = async () => {
      setLoading(true);
      try {
        const res = await fetch(`${url}?instrument=${encodeURIComponent(instrument)}`);
        if (!res.ok) throw new Error(`サーバーの応答が HTTP ${res.status} でした`);
        const body = (await res.json().catch(() => {
          throw new Error('サーバーの応答を読めませんでした（Worker が古い可能性があります）');
        })) as LtfPayload | { error: string };
        if ('error' in body) throw new Error(body.error);
        if (!Array.isArray(body.tfs)) throw new Error('下位足のデータが含まれていません（Worker が古い可能性があります）');
        if (!cancelled) {
          setData(body);
          setError('');
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : '取得に失敗しました');
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    const timer = setInterval(load, 60_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [url, instrument, reloadKey]);

  // XAU は Worker が金先物（GC=F）基準なので、画面の現物価格との差だけ平行移動する。
  const off = data && instrument.startsWith('XAU') ? currentRate - data.currentRate : 0;
  const shift = (b: OhlcCandle): OhlcCandle => ({ ...b, open: b.open + off, high: b.high + off, low: b.low + off, close: b.close + off });
  const series = (t: LtfTf) => {
    const s = data?.tfs.find((x) => x.tf === t);
    const bars = s ? s.bars.map(shift) : [];
    const forming = s?.forming ? shift(s.forming) : null;
    return { bars, forming, price: forming?.close ?? currentRate };
  };
  const evals = LTF_TFS.map((t) => {
    const s = series(t);
    const trig = plan && s.bars.length ? assessLtfTrigger({ ...plan, bars: s.bars, price: s.price, instrument }) : null;
    const struct = s.bars.length ? ltfStructure(s.bars, instrument, s.price, digits) : null;
    return { tf: t, ...s, trig, struct };
  });
  const sel = evals.find((e) => e.tf === tf)!;
  const fmt = (p: number) => p.toFixed(digits);
  const noBars = !!data && evals.every((e) => e.bars.length < 20);

  return (
    <div className="rounded-xl border border-gray-200 bg-white p-3 shadow-sm">
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 text-sm font-bold text-gray-800">
          <span aria-hidden className="inline-block h-3.5 w-1 rounded-full bg-orange-400" />
          下位足のエントリーポイント
        </span>
        <span className="flex items-center gap-2 text-[10px] text-gray-400">
          {data
            ? `${new Date(data.generatedAt).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })} 時点`
            : loading
              ? '読み込み中…'
              : ''}
          <button type="button" onClick={reload} disabled={loading} className="rounded border border-gray-200 bg-white text-[10px] text-gray-600">
            <span className="block px-1.5 py-0.5">{loading ? '更新中' : '更新'}</span>
          </button>
        </span>
      </div>

      {/* どの計画を下位足で詰めているか */}
      <div className="mt-1.5 rounded-md bg-gray-50 px-2 py-1.5 text-[11px] leading-relaxed text-gray-600">
        {plan ? (
          <>
            上位足（<span className="font-semibold text-gray-800">{plan.tfLabel}</span>）の計画:{' '}
            <span className={`font-bold ${plan.direction === 'long' ? 'text-green-700' : 'text-red-700'}`}>
              {plan.direction === 'long' ? '買い' : '売り'}
            </span>
            ・{AREA_LABEL[plan.area.kind]} {fmt(plan.area.price)}・損切り {fmt(plan.htfStop)}・目標 {fmt(plan.target)}
            <span className="block text-[10px] text-gray-400">これを1分足・5分足で詰めて、入る価格と損切りを絞り込みます。</span>
          </>
        ) : (
          <>
            上位足に RR の計画がありません。参考として、下位足の値幅（直近の高値・安値）を抜けた方向について行く場合の入り方を出します。
            <span className="block text-[10px] text-amber-700">上位足の裏付けがないぶん、だましに注意してください。</span>
          </>
        )}
      </div>

      {error && (
        <div className="mt-2 flex items-start justify-between gap-2 rounded-md bg-red-50 px-2 py-1.5 text-[11px] text-red-700">
          <span>下位足を取得できませんでした: {error}</span>
          <button type="button" onClick={reload} className="shrink-0 rounded border border-red-200 bg-white text-[10px] text-red-700">
            <span className="block px-1.5 py-0.5">再試行</span>
          </button>
        </div>
      )}
      {noBars && <div className="mt-2 text-[11px] text-gray-500">下位足の本数が足りません（市場が閉まっている時間など）。</div>}

      {/* 1分足・5分足のエントリーポイントを横並びで */}
      {data && !noBars && (
        <div className="mt-2 grid grid-cols-[auto_1fr_1fr] gap-x-2 gap-y-1 text-[11px]">
          <span />
          {evals.map((e) => (
            <span key={e.tf} className="font-bold text-gray-700">{TF_LABEL[e.tf]}</span>
          ))}
          {plan ? (
            <>
              <span className="text-gray-500">状態</span>
              {evals.map((e) => (
                <span key={e.tf}>
                  {e.trig ? (
                    <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${STATE_STYLE[e.trig.state].cls}`}>
                      {STATE_STYLE[e.trig.state].icon}
                      {STATE_STYLE[e.trig.state].label}
                    </span>
                  ) : (
                    <span className="text-gray-400">足が不足</span>
                  )}
                </span>
              ))}
              <span className="text-gray-500">入り方</span>
              {evals.map((e) => (
                <span key={e.tf} className="font-semibold tabular-nums text-gray-900">
                  {e.trig?.refined ? (
                    <>
                      {e.trig.refined.entryType === 'market' ? '成行' : '逆指値'} {fmt(e.trig.refined.entry)}
                      <span className="block text-[10px] font-normal text-gray-500">
                        {e.trig.refined.entryType === 'market'
                          ? '今の価格で入れる'
                          : `${plan.direction === 'long' ? '戻り高値の上抜け' : '押し安値の下抜け'}で入る`}
                      </span>
                    </>
                  ) : e.trig?.state === 'wait_area' ? (
                    <span className="font-normal text-gray-500">
                      {AREA_LABEL[plan.area.kind]} {fmt(plan.area.price)} まで待つ
                    </span>
                  ) : (
                    '—'
                  )}
                </span>
              ))}
              <span className="text-gray-500">損切り</span>
              {evals.map((e) => (
                <span key={e.tf} className="font-semibold tabular-nums text-red-700">
                  {e.trig?.refined ? (
                    <>
                      {fmt(e.trig.refined.stop)}
                      <span className="block text-[10px] font-normal text-gray-500">−{e.trig.refined.riskPips.toFixed(1)}pips</span>
                    </>
                  ) : (
                    '—'
                  )}
                </span>
              ))}
              <span className="text-gray-500">目標</span>
              {evals.map((e) => (
                <span key={e.tf} className="tabular-nums text-green-700">{e.trig?.refined ? fmt(e.trig.refined.target) : '—'}</span>
              ))}
              <span className="text-gray-500">RR</span>
              {evals.map((e) => (
                <span key={e.tf} className="font-bold text-orange-600">
                  {e.trig?.refined ? `1:${e.trig.refined.rr.toFixed(1)}` : '—'}
                  {e.trig && <span className="ml-1 text-[10px] font-normal text-gray-400">（上位足のまま 1:{e.trig.htfRr.toFixed(1)}）</span>}
                </span>
              ))}
            </>
          ) : (
            <>
              <span className="text-gray-500">流れ</span>
              {evals.map((e) => (
                <span key={e.tf} className={`text-[10px] font-semibold ${e.struct ? TREND_STYLE[e.struct.trend].cls : 'text-gray-400'}`}>
                  {e.struct ? TREND_STYLE[e.struct.trend].label : '足が不足'}
                </span>
              ))}
              {(['long', 'short'] as const).map((d) => (
                <BreakoutRows key={d} dir={d} evals={evals} fmt={fmt} />
              ))}
            </>
          )}
        </div>
      )}

      {/* 選んだ足のチャートと根拠 */}
      {data && !noBars && (
        <div className="mt-3 border-t border-gray-100 pt-2">
          <div className="flex items-center gap-1">
            {LTF_TFS.map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setTf(t)}
                aria-pressed={tf === t}
                className={`rounded-full border text-[11px] font-semibold ${tf === t ? 'border-gray-800 bg-gray-800 text-white' : 'border-gray-200 bg-white text-gray-600'}`}
              >
                <span className="block px-2.5 py-0.5">{TF_LABEL[t]}のチャート</span>
              </button>
            ))}
          </div>
          {plan && sel.trig ? (
            <TriggerDetail result={sel.trig} />
          ) : !plan && sel.struct ? (
            <div className="mt-1 text-[10px] leading-relaxed text-gray-600">
              直近の高値 {fmt(sel.struct.swingHigh)} を上抜ければ買い、直近の安値 {fmt(sel.struct.swingLow)} を下抜ければ売り（もう抜けていれば成行）。
              損切りは反対側の高値・安値の少し外、目標は損切り幅の {LTF_BREAKOUT_RR} 倍です。
            </div>
          ) : null}
          <LtfChart bars={sel.bars} forming={sel.forming} lines={chartLines(plan, sel.trig, sel.struct)} digits={digits} />
        </div>
      )}

      <div className="mt-2 text-[10px] leading-relaxed text-gray-400">
        1分ごとに自動更新。下位足の損切りは狭いぶん、だましで刈られやすくなります。ロットは損切り幅に合わせて計算してください。
        {plan && evals.some((e) => e.trig?.refined && e.trig.refined.rr >= 5) && (
          <span className="block text-amber-700">
            RR が大きく見えるのは損切りが狭いためで、目標まで届く確率はそのぶん下がります。途中の抵抗帯で一部利確するなど、出口も考えておきましょう。
          </span>
        )}
        <span className="block">※投資助言ではない参考情報です。</span>
      </div>
    </div>
  );
}

function BreakoutRows({
  dir,
  evals,
  fmt,
}: {
  dir: SlDirection;
  evals: { tf: LtfTf; struct: LtfStructure | null }[];
  fmt: (p: number) => string;
}) {
  const long = dir === 'long';
  const side = (s: LtfStructure) => (long ? s.buy : s.sell);
  const main = (s: LtfStructure) => (long ? s.trend === 'up' : s.trend === 'down');
  return (
    <>
      <span className={`font-semibold ${long ? 'text-green-700' : 'text-red-700'}`}>{long ? '買い' : '売り'}</span>
      {evals.map((e) => (
        <span key={e.tf} className="tabular-nums">
          {e.struct ? (
            <>
              <span className="font-semibold text-gray-900">
                {side(e.struct).entryType === 'market' ? '成行' : '逆指値'} {fmt(side(e.struct).entry)}
              </span>
              {main(e.struct) && <span className="ml-1 rounded bg-orange-100 px-1 text-[9px] font-bold text-orange-700">本命</span>}
              {side(e.struct).entryType === 'market' && <span className="block text-[10px] text-gray-500">抜け済み・飛び乗りに注意</span>}
              <span className="block text-[10px] text-gray-500">
                損切り <span className="text-red-700">{fmt(side(e.struct).stop)}</span>（−{side(e.struct).riskPips.toFixed(1)}pips）
              </span>
              <span className="block text-[10px] text-gray-500">
                目標 <span className="text-green-700">{fmt(side(e.struct).target)}</span>（1:{LTF_BREAKOUT_RR}）
              </span>
            </>
          ) : (
            '—'
          )}
        </span>
      ))}
    </>
  );
}

function TriggerDetail({ result }: { result: LtfResult }) {
  return (
    <>
      {result.checks.length > 0 && (
        <ul className="mt-1.5 space-y-0.5 text-[11px]" style={LIST_RESET}>
          {result.checks.map((c, k) => (
            <li style={LIST_ITEM_RESET} key={c.label} className="flex items-start gap-1.5">
              <span className={`font-bold ${c.ok ? 'text-green-600' : 'text-gray-300'}`}>{c.ok ? '✓' : `${k + 1}`}</span>
              <span className={c.ok ? 'text-gray-800' : 'text-gray-500'}>{c.label}</span>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-1 text-[10px] leading-relaxed text-gray-600">{result.note}</div>
    </>
  );
}

interface ChartLine {
  key: string;
  price: number;
  color: string;
  label: string;
  dash?: string;
}

// チャートに引く線: 計画あり=転換ライン・入る価格・損切り（上位足の損切りは近いときだけ）/ 計画なし=買い・売りの逆指値。
function chartLines(plan: HtfPlan | null, trig: LtfResult | null, struct: LtfStructure | null): ChartLine[] {
  const lines: ChartLine[] = [];
  if (plan && trig) {
    if (trig.swingHigh) lines.push({ key: 'turn', price: trig.swingHigh.price, color: '#2563eb', label: '転換ライン', dash: '3 2' });
    if (trig.refined) {
      lines.push({ key: 'entry', price: trig.refined.entry, color: '#111827', label: trig.refined.entryType === 'market' ? '成行' : '逆指値' });
      lines.push({ key: 'stop', price: trig.refined.stop, color: '#dc2626', label: '損切り', dash: '4 2' });
    }
    lines.push({ key: 'htf', price: plan.htfStop, color: '#9ca3af', label: '上位足SL', dash: '1.5 2' });
  } else if (struct) {
    for (const sd of [struct.buy, struct.sell]) {
      const long = sd.direction === 'long';
      lines.push({
        key: long ? 'buy' : 'sell',
        price: sd.entry,
        color: long ? '#16a34a' : '#dc2626',
        label: `${long ? '買い' : '売り'}${sd.entryType === 'market' ? '成行' : '逆指値'}`,
      });
    }
  }
  return lines;
}

// 下位足のチャート: ローソク足 ＋ 線。値幅から大きく外れた線（遠い上位足の損切りなど）は描かない（足が潰れるので）。
function LtfChart({
  bars,
  forming,
  lines: lines0,
  digits,
}: {
  bars: OhlcCandle[];
  forming: OhlcCandle | null;
  lines: ChartLine[];
  digits: number;
}) {
  const all = forming ? [...bars, forming] : bars;
  if (all.length < 2) return null;
  const W = 320;
  const H = 130;
  const padL = 4;
  const padR = 74;
  const padY = 8;
  const lo0 = Math.min(...all.map((b) => b.low));
  const hi0 = Math.max(...all.map((b) => b.high));
  const lines = lines0.filter((l) => l.price >= lo0 - (hi0 - lo0) * 0.5 && l.price <= hi0 + (hi0 - lo0) * 0.5);
  const lo = Math.min(lo0, ...lines.map((l) => l.price));
  const hi = Math.max(hi0, ...lines.map((l) => l.price));
  const span = hi - lo || 1;
  const y = (p: number) => padY + ((hi - p) / span) * (H - padY * 2);
  const slot = (W - padL - padR) / all.length;
  const cx = (k: number) => padL + slot * (k + 0.5);
  const bodyW = Math.max(1, slot * 0.6);
  // ラベルの重なりを避ける（上から順に最小間隔ずつずらし、下にはみ出したら押し戻す）
  const labels = lines.map((l) => ({ ...l, ly: y(l.price) })).sort((a, b) => a.ly - b.ly);
  for (let k = 1; k < labels.length; k++) if (labels[k].ly - labels[k - 1].ly < 12) labels[k].ly = labels[k - 1].ly + 12;
  for (let k = labels.length - 1; k >= 0; k--) {
    const limit = k === labels.length - 1 ? H - 6 : labels[k + 1].ly - 12;
    if (labels[k].ly > limit) labels[k].ly = limit;
  }
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="mt-1.5 h-auto w-full rounded bg-gray-50" role="img" aria-label="下位足のローソク足と入る価格・損切り">
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
