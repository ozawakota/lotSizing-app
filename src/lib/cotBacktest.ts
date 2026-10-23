// 投機筋（CFTC COT）の偏りと、その後の値動きの関係を調べるバックテスト（純関数）。
// edge-server/backtest/cot.ts から CFTC と Dukascopy の実データで呼ぶ。
//
// 取引量・センチメントページの「大口」と同じ計算をする:
//   通貨ごとの正規化ネット = (買い − 売り) ÷ (買い + 売り)、ペア X/Y = net(X) − net(Y)、
//   中立/弱/中/強は specLean・specStrength（src/lib/flow.ts）と同じ閾値。
// 先読みを避けるため、火曜時点の報告が公表される金曜（報告日＋3日）の日足終値でエントリーしたとみなし、
// そこから h 週後の終値までの騰落率を「大口の向きに乗った場合のリターン」として集計する。
// 週ごとのサンプルは保有期間が重なる（4週先なら隣り合う4サンプルがほぼ同じ値動きを共有する）ため、
// t 値は実効サンプル数 n ÷ h 週で割り引いて出す（重なりの補正としては粗い近似）。
import { normalizeNet, specLean, specStrength, type CotCurrency, type FlowPair, type Lean, type SpecStrength } from './flow';

/** CFTC Legacy（先物のみ）の1行。date は報告日（火曜時点）の YYYY-MM-DD。 */
export interface CotRow {
  date: string;
  currency: CotCurrency;
  long: number; // 非商業（投機筋）の買い建玉
  short: number; // 非商業（投機筋）の売り建玉
}

/** 日足の終値。date は YYYY-MM-DD（UTC）。古い→新しい順。 */
export interface DailyClose {
  date: string;
  close: number;
}

export interface PairNetPoint {
  date: string; // 報告日
  net: number; // net(base) − net(quote)。−2〜+2
}

export interface CotSample {
  reportDate: string;
  entryDate: string; // 実際にエントリーした日足の日付
  net: number;
  lean: Lean;
  strength: SpecStrength | null; // 中立は null
  deltaNet: number | null; // 前週比（最初の週は null）
  cotIndex: number | null; // 直近 indexWeeks 週の中での位置 0〜100（100=期間内で最も買い越し）。履歴不足は null
  fwd: Record<number, number | null>; // h 週後までのペアの騰落率 %（買い持ちした場合）。データ不足は null
}

export interface CotBacktestOptions {
  releaseLagDays?: number; // 報告日から公表までの日数（既定 3＝金曜）
  horizonsWeeks?: number[]; // 何週先を見るか（既定 [1, 4, 12]）
  indexWeeks?: number; // COT インデックスの期間（既定 156 週＝3年）
  maxGapDays?: number; // エントリー/決済日に足が見つからないときに許す最大のずれ（既定 5 日）
}

export const COT_DEFAULTS: Required<CotBacktestOptions> = {
  releaseLagDays: 3,
  horizonsWeeks: [1, 4, 12],
  indexWeeks: 156,
  maxGapDays: 5,
};

/** COT インデックスで「極端」とみなす境界（上位/下位 10%）。 */
export const COT_EXTREME_HIGH = 90;
export const COT_EXTREME_LOW = 10;

const DAY_MS = 86_400_000;
const addDays = (date: string, days: number): string => new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
const daysBetween = (a: string, b: string): number => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY_MS);

/** "FLOW_PAIRS の 'USD/JPY'" → ['USD', 'JPY']。XAU/USD は ['XAU', 'USD']。 */
export function pairCurrencies(pair: FlowPair): [CotCurrency, CotCurrency] {
  const [base, quote] = pair.split('/') as [CotCurrency, CotCurrency];
  return [base, quote];
}

/** 通貨ごとの行から、ペアの週次ネット系列（両通貨がそろった報告日のみ・古い→新しい）を作る。 */
export function buildPairNetSeries(rows: CotRow[], pair: FlowPair): PairNetPoint[] {
  const [base, quote] = pairCurrencies(pair);
  const byCur = (cur: CotCurrency) => {
    const m = new Map<string, number>();
    for (const r of rows) if (r.currency === cur && r.long + r.short > 0) m.set(r.date, normalizeNet(r.long, r.short));
    return m;
  };
  const b = byCur(base);
  const q = byCur(quote);
  return [...b.keys()]
    .filter((d) => q.has(d))
    .sort()
    .map((date) => ({ date, net: (b.get(date) as number) - (q.get(date) as number) }));
}

/** date 以降で最初の足の位置（二分探索）。無ければ -1。 */
function firstOnOrAfter(closes: DailyClose[], date: string): number {
  let lo = 0;
  let hi = closes.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (closes[mid].date < date) lo = mid + 1;
    else hi = mid;
  }
  return lo < closes.length ? lo : -1;
}

/** 0〜100 の位置。期間内の値がすべて同じなら 50。 */
function percentRank(window: number[], x: number): number {
  const min = Math.min(...window);
  const max = Math.max(...window);
  return max > min ? ((x - min) / (max - min)) * 100 : 50;
}

/** 週次ネット系列と日足から、週ごとのサンプル（特徴量＋先行きの騰落率）を作る。 */
export function buildCotSamples(series: PairNetPoint[], closes: DailyClose[], opts: CotBacktestOptions = {}): CotSample[] {
  const o = { ...COT_DEFAULTS, ...opts };
  const out: CotSample[] = [];
  for (let i = 0; i < series.length; i++) {
    const { date, net } = series[i];
    const target = addDays(date, o.releaseLagDays);
    const ei = firstOnOrAfter(closes, target);
    if (ei < 0 || daysBetween(target, closes[ei].date) > o.maxGapDays) continue;
    const entry = closes[ei];
    const fwd: Record<number, number | null> = {};
    for (const h of o.horizonsWeeks) {
      const exitTarget = addDays(entry.date, h * 7);
      const xi = firstOnOrAfter(closes, exitTarget);
      fwd[h] = xi >= 0 && daysBetween(exitTarget, closes[xi].date) <= o.maxGapDays ? (closes[xi].close / entry.close - 1) * 100 : null;
    }
    const window = series.slice(Math.max(0, i - o.indexWeeks + 1), i + 1).map((p) => p.net);
    const lean = specLean(net);
    out.push({
      reportDate: date,
      entryDate: entry.date,
      net,
      lean,
      strength: lean === 'neutral' ? null : specStrength(net),
      deltaNet: i > 0 ? net - series[i - 1].net : null,
      cotIndex: window.length >= o.indexWeeks ? percentRank(window, net) : null,
      fwd,
    });
  }
  return out;
}

export interface GroupStats {
  group: string;
  horizonWeeks: number;
  n: number;
  meanPct: number; // 大口の向きに乗った場合の平均騰落率 %（中立グループは買い持ちの平均）
  hitRate: number; // 上の騰落率がプラスだった割合 %
  t: number; // 平均 ÷ 標準誤差（実効サンプル数 n ÷ h で補正）。|t|≥2 で偶然とは言いにくい目安
}

const round = (x: number, d: number) => Math.round(x * 10 ** d) / 10 ** d;

/** 符号付きのリターン列から統計を出す。 */
export function statsOf(group: string, horizonWeeks: number, rets: number[]): GroupStats {
  const n = rets.length;
  if (n === 0) return { group, horizonWeeks, n: 0, meanPct: 0, hitRate: 0, t: 0 };
  const mean = rets.reduce((a, b) => a + b, 0) / n;
  const sd = n > 1 ? Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1)) : 0;
  const nEff = Math.max(1, n / Math.max(1, horizonWeeks));
  const t = sd > 0 ? mean / (sd / Math.sqrt(nEff)) : 0;
  return {
    group,
    horizonWeeks,
    n,
    meanPct: round(mean, 3),
    hitRate: round((rets.filter((r) => r > 0).length / n) * 100, 1),
    t: round(t, 2),
  };
}

const sign = (lean: Lean) => (lean === 'buy' ? 1 : lean === 'sell' ? -1 : 0);
const STRENGTH_JA: Record<SpecStrength, string> = { weak: '弱', mid: '中', strong: '強' };

/**
 * サンプルをグループ分けして集計する。リターンはすべて「大口の向きに乗った場合」（買い越し=買い、売り越し=売り）。
 * - 全体（中立を除く） / 弱・中・強 / 強まる・弱まる（前週比）
 * - 極端な偏り（COT インデックス上位・下位10%）は、その偏りの側に乗った場合
 * - 参考: 中立の週の買い持ち、全週の買い持ち（期間中のトレンドの影響を見るため）
 * 平均がプラスなら「大口に乗る」と有利、マイナスなら逆張りが有利だったことを示す。
 */
export function summarizeCot(samples: CotSample[], horizonsWeeks: number[] = COT_DEFAULTS.horizonsWeeks): GroupStats[] {
  const out: GroupStats[] = [];
  for (const h of horizonsWeeks) {
    const valid = samples.filter((s) => s.fwd[h] != null);
    const follow = (s: CotSample) => sign(s.lean) * (s.fwd[h] as number);
    const directional = valid.filter((s) => s.lean !== 'neutral');
    const group = (name: string, list: CotSample[], f: (s: CotSample) => number = follow) => out.push(statsOf(name, h, list.map(f)));

    group('大口に乗る（全体）', directional);
    // 期間中ずっと上がり（下がり）続けた相場では、大口がずっと買い越しなら「乗る」は買い持ちと同じ成績になる。
    // 各週のリターンから期間平均（買い持ちの平均）を引いてから向きを掛け、トレンドの分を除いた効果を見る。
    const drift = valid.length ? valid.reduce((a, s) => a + (s.fwd[h] as number), 0) / valid.length : 0;
    group('大口に乗る（トレンド分を除く）', directional, (s) => sign(s.lean) * ((s.fwd[h] as number) - drift));
    for (const st of ['weak', 'mid', 'strong'] as SpecStrength[]) {
      group(`  ${STRENGTH_JA[st]}`, directional.filter((s) => s.strength === st));
    }
    // 前週比: ネットが今の向きにさらに進んだ週＝強まる、戻した週＝弱まる。
    group('  強まる週', directional.filter((s) => s.deltaNet != null && Math.sign(s.deltaNet) === sign(s.lean)));
    group('  弱まる週', directional.filter((s) => s.deltaNet != null && Math.sign(s.deltaNet) === -sign(s.lean)));
    // 極端: 直近3年で最も買い越し側（インデックス上位10%）なら買い、最も売り越し側（下位10%）なら売りに乗ったとみなす。
    // 平均がマイナスなら、極端な偏りの後は逆に動いた（反転しやすかった）ことを示す。
    const extremeDir = (s: CotSample) => (s.cotIndex == null ? 0 : s.cotIndex >= COT_EXTREME_HIGH ? 1 : s.cotIndex <= COT_EXTREME_LOW ? -1 : 0);
    group('極端な偏りに乗る（上位/下位10%）', valid.filter((s) => extremeDir(s) !== 0), (s) => extremeDir(s) * (s.fwd[h] as number));
    group('参考: 中立の週（買い持ち）', valid.filter((s) => s.lean === 'neutral'), (s) => s.fwd[h] as number);
    group('参考: 全週（買い持ち）', valid, (s) => s.fwd[h] as number);
  }
  return out;
}
