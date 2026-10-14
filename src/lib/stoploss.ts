// 損切り提案の純粋ドメインロジック。Worker とクライアントで共有する。
// ロウソク足(OHLC)から構造（直近スイング高安・トレンド）を機械的に求め、方向に応じた
// 損切り価格を算出する。プライスアクション分類(反転/戻り売り/押し目買い/レンジ)は
// Jev(Choice) もしくは Workers AI(JSON) に投げるためのリクエスト生成・応答パースを提供する。

export type SlTimeframe = '15m' | '30m' | '1h' | '4h';
export const SL_TIMEFRAMES: SlTimeframe[] = ['15m', '30m', '1h', '4h'];
export type SlDirection = 'long' | 'short';

// 表示ペア(instrument, 例 'GBP_USD') → Yahoo Finance のシンボル。XAU/USD は金先物(GC=F)を代理に。
export const YAHOO_SYMBOL: Record<string, string> = {
  USD_JPY: 'USDJPY=X',
  EUR_JPY: 'EURJPY=X',
  GBP_JPY: 'GBPJPY=X',
  AUD_JPY: 'AUDJPY=X',
  EUR_USD: 'EURUSD=X',
  GBP_USD: 'GBPUSD=X',
  AUD_USD: 'AUDUSD=X',
  XAU_USD: 'GC=F',
};
// 出来高の節目用の代替シンボル。FXスポット(=X)は出来高が無いため、CME通貨先物から取得する。
// invert=true は先物が逆数クォート(例 6J=F は USD/JPY の逆数)。クロス円は単一先物が無く対象外。
export const VOLUME_SYMBOL: Record<string, { symbol: string; invert: boolean }> = {
  USD_JPY: { symbol: '6J=F', invert: true },
  EUR_USD: { symbol: '6E=F', invert: false },
  GBP_USD: { symbol: '6B=F', invert: false },
  AUD_USD: { symbol: '6A=F', invert: false },
};

/**
 * 先物由来の価格をスポット目盛りへ変換する。invert のときは逆数化し、現在値の差（ベーシス）で
 * 平行移動してスポットに合わせる。（例 USD/JPY: spot ≈ 1/先物 − ((1/先物現在値) − スポット現在値)）
 */
export function futuresLevelToSpot(futLevel: number, futCurrent: number, spotCurrent: number, invert: boolean): number {
  const mapLvl = invert ? 1 / futLevel : futLevel;
  const mapCur = invert ? 1 / futCurrent : futCurrent;
  return mapLvl - (mapCur - spotCurrent);
}

// アプリの足 → Yahoo の interval。
export const YAHOO_INTERVAL: Record<SlTimeframe, string> = {
  '15m': '15m',
  '30m': '30m',
  '1h': '60m',
  '4h': '4h',
};

export interface Candle {
  open?: number; // 始値（ローソク足パターン判定用。Yahoo から取得。無い足は判定スキップ）
  high: number;
  low: number;
  close: number;
  volume?: number; // 出来高（Yahoo。FXスポット=Xは0/欠損のことが多い）
  t?: number; // ロウソク足の時刻（UNIX秒）
}

/**
 * 指定の過去時点(nowMs − agoMs)付近(±windowMs)で最も出来高が多かったロウソク足の終値を返す。
 * 「過去にその時間帯で商いが膨らんだ価格＝レジサポの節目」を1本取り出す用途。
 * 出来高データが無い/全て0（FXスポット等）、または窓内に足が無ければ null。
 */
export function volumeAnchoredLevel(
  candles: Candle[],
  nowMs: number,
  agoMs: number,
  windowMs: number,
): number | null {
  const center = nowMs - agoMs;
  const lo = center - windowMs;
  const hi = center + windowMs;
  let best: Candle | null = null;
  for (const c of candles) {
    if (c.t == null || !(c.volume && c.volume > 0)) continue;
    const tMs = c.t * 1000;
    if (tMs < lo || tMs > hi) continue;
    if (!best || (c.volume ?? 0) > (best.volume ?? 0)) best = c;
  }
  return best ? best.close : null;
}

// プライスアクション分類。
export type PaClass = 'reversal' | 'sell_rally' | 'buy_dip' | 'range';
export const PA_CRITERIA: Record<PaClass, string> = {
  reversal: '直近トレンドの反転が起きている/起きやすい局面',
  sell_rally: '下降トレンド中の戻り(上昇)で、戻り売りが有効な局面',
  buy_dip: '上昇トレンド中の押し目(下落)で、押し目買いが有効な局面',
  range: '明確な方向感の無いレンジ/中立',
};

// レンジ(直近スイング高安)を次の数本でどう抜けるかの3択。/mtf のブレイク確率判定に使用。
export type BreakoutClass = 'break_up' | 'break_down' | 'stay_range';
export const BREAKOUT_CRITERIA: Record<BreakoutClass, string> = {
  break_up: '現在のレンジ上限(直近スイング高値)を次の数本で上抜ける',
  break_down: '現在のレンジ下限(直近スイング安値)を次の数本で下抜ける',
  stay_range: 'スイング高安の内側に留まりレンジ継続',
};

export interface SlStructure {
  trend: 'up' | 'down' | 'range';
  swingHigh: number;
  swingLow: number;
  currentRate: number;
}

export interface SlSuggestion {
  price: number; // 損切り価格
  distancePips: number; // エントリー(無ければ現在値)からの距離(pips)
  basis: 'swing_low' | 'swing_high';
  reference: number; // 基準にしたスイング価格
}

export interface PaResult {
  pa: PaClass;
  paPct: number; // 0-100 その分類の確からしさ
  confidence: number; // 0-1
}

const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, n));

/** 複数タイムフレームのトレンド整合を判定するラベル（マルチTF分析用）。 */
export function alignmentLabel(trends: ('up' | 'down' | 'range')[]): string {
  if (trends.length === 0) return '—';
  const n = trends.length;
  const up = trends.filter((t) => t === 'up').length;
  const down = trends.filter((t) => t === 'down').length;
  if (up === n) return '全TF上向き（強い上昇トレンド）';
  if (down === n) return '全TF下向き（強い下降トレンド）';
  if (up === 0 && down === 0) return '全TFレンジ（方向感なし）';
  if (down === 0 && up > 0) return '上向き優勢';
  if (up === 0 && down > 0) return '下向き優勢';
  return '不一致（TF間で方向が対立）';
}

/**
 * ロウソク足からスロー・ストキャスティクス(%K/%D)を算出する（Twelve Data の既定 14-3-3 相当）。
 * rawK = (終値 − 期間kPeriodの安値) / (期間の高値 − 安値) × 100、
 * slowK = rawK の kSlowing本SMA、%D = slowK の dPeriod本SMA。最新値を返す。
 * 足数不足や値幅ゼロで算出できなければ null。API不要（取得済みの足から計算）。
 */
export function computeStochastic(
  candles: Candle[],
  kPeriod = 14,
  kSlowing = 3,
  dPeriod = 3,
): { k: number; d: number } | null {
  const need = kPeriod + kSlowing + dPeriod;
  if (candles.length < need) return null;
  // 各時点の rawK を、計算に必要な分だけ後ろから求める。
  const rawK: number[] = [];
  for (let i = kPeriod - 1; i < candles.length; i++) {
    const win = candles.slice(i - kPeriod + 1, i + 1);
    const hh = Math.max(...win.map((c) => c.high));
    const ll = Math.min(...win.map((c) => c.low));
    if (hh === ll) return null;
    rawK.push(((candles[i].close - ll) / (hh - ll)) * 100);
  }
  const sma = (arr: number[], period: number): number[] => {
    const out: number[] = [];
    for (let i = period - 1; i < arr.length; i++) {
      out.push(arr.slice(i - period + 1, i + 1).reduce((s, v) => s + v, 0) / period);
    }
    return out;
  };
  const slowK = sma(rawK, kSlowing);
  const slowD = sma(slowK, dPeriod);
  if (slowK.length === 0 || slowD.length === 0) return null;
  const clampPct = (n: number) => Math.round(clamp(n, 0, 100) * 10) / 10;
  return { k: clampPct(slowK[slowK.length - 1]), d: clampPct(slowD[slowD.length - 1]) };
}

/** instrument の pip サイズ（XAU=0.1ドル, 対円=0.01, その他=0.0001）。 */
export function pipSize(instrument: string): number {
  if (instrument.startsWith('XAU')) return 0.1;
  if (instrument.endsWith('JPY')) return 0.01;
  return 0.0001;
}

/** ロウソク足から直近 lookback 本の構造（スイング高安・トレンド）を求める。 */
export function computeStructure(candles: Candle[], currentRate: number, lookback = 24): SlStructure {
  const recent = candles.slice(-lookback);
  if (recent.length === 0) {
    return { trend: 'range', swingHigh: currentRate, swingLow: currentRate, currentRate };
  }
  const swingHigh = Math.max(...recent.map((c) => c.high));
  const swingLow = Math.min(...recent.map((c) => c.low));
  const closes = recent.map((c) => c.close);
  const changePct = (closes[closes.length - 1] / closes[0] - 1) * 100;
  const trend: SlStructure['trend'] = changePct > 0.1 ? 'up' : changePct < -0.1 ? 'down' : 'range';
  return { trend, swingHigh, swingLow, currentRate };
}

/** 方向とエントリー(任意)から損切り価格・距離を算出。long=スイング安値の下、short=スイング高値の上。 */
export function computeStopLoss(
  structure: SlStructure,
  direction: SlDirection,
  entry: number | null,
  instrument: string,
): SlSuggestion {
  const pip = pipSize(instrument);
  const range = Math.max(structure.swingHigh - structure.swingLow, 0);
  const buffer = Math.max(range * 0.05, pip * 2); // 直近レンジの5% か 最低2pips
  const ref = direction === 'long' ? structure.swingLow : structure.swingHigh;
  const price = direction === 'long' ? ref - buffer : ref + buffer;
  const from = entry != null && entry > 0 ? entry : structure.currentRate;
  const distancePips = Math.round((Math.abs(from - price) / pip) * 10) / 10;
  return {
    price,
    distancePips,
    basis: direction === 'long' ? 'swing_low' : 'swing_high',
    reference: ref,
  };
}

// ---------------------------------------------------------------------------
// リスクリワード（RR）評価: 上位TFのスイングを利確目標にした 1:N 判定（/mtf 用）
// ---------------------------------------------------------------------------
// ペアごとの一般的なスプレッドの目安（pips。国内FX業者の通常時の水準を保守的に丸めた値）。
// RR 通知で「エントリー時に払うコスト」として、リスクに足しリワードから引く。未登録ペアは 1.0。
export const TYPICAL_SPREAD_PIPS: Record<string, number> = {
  USD_JPY: 0.3,
  EUR_JPY: 0.5,
  GBP_JPY: 1.0,
  AUD_JPY: 0.6,
  EUR_USD: 0.3,
  GBP_USD: 0.8,
  AUD_USD: 0.5,
  XAU_USD: 4.0, // 0.4ドル（XAU の pip=0.1ドル）
};
export const typicalSpreadPips = (instrument: string): number => TYPICAL_SPREAD_PIPS[instrument] ?? 1.0;

// RR 好機の共通基準（TF分析ページと RR好機通知で同じ値を使う）。スプレッド込みの実質 RR で判定する。
export const RR_MIN = 2.5;
// TF分析ページで、Jev のブレイク確率が取れたときに追加で課す「トレンド方向の確率」の下限（%）。
export const RR_MIN_DIRECTION_PROB = 50;

const TF_JA: Record<SlTimeframe, string> = { '15m': '15分足', '30m': '30分足', '1h': '1時間足', '4h': '4時間足' };

/** 上位足のスイングを損切りラインの一致判定用に並べる（ロング=安値 / ショート=高値）。 */
export function higherStopLevels(
  higher: { tf: SlTimeframe; structure: Pick<SlStructure, 'swingHigh' | 'swingLow'> }[],
  direction: SlDirection,
): StopLevelRef[] {
  return higher.map((h) =>
    direction === 'long'
      ? { price: h.structure.swingLow, label: `${TF_JA[h.tf]}の安値` }
      : { price: h.structure.swingHigh, label: `${TF_JA[h.tf]}の高値` },
  );
}

/** RR の方向はトレンドで決める（上昇=ロング / 下降=ショート / レンジ=対象外）。ページと通知で共通。 */
export function trendToDirection(trend: SlStructure['trend']): SlDirection | null {
  return trend === 'up' ? 'long' : trend === 'down' ? 'short' : null;
}

/** あるTFの「狙える setup」。リスク=構造的損切りまで, リワード=上位TFスイングまで。 */
export interface RrSetup {
  direction: SlDirection;
  entry: number;
  stop: number; // 損切り価格
  target: number; // 利確目標価格（上位TFスイング）
  riskPips: number; // spreadPips 込み
  rewardPips: number; // spreadPips 控除後
  spreadPips: number; // 計算に含めたスプレッド（0=考慮なし）
  stopReasons?: string[]; // 構造的損切りの根拠（computeStructuralStop を使ったときのみ）
  stopStrength?: number; // 損切りラインの強さ 0–100（同上）
  rr: number; // リワード/リスク（小数1桁）
  qualifies: boolean; // rr>=minRr かつ 方向のブレイク確率>=minProb
}

/**
 * 上位TFのスイングを利確目標として RR を評価する。
 * - リスク: computeStopLoss（ロング=スイング安値の下 / ショート=高値の上＋バッファ）までの距離。
 * - リワード: 進行方向で現在値より先にある最も近い上位TFスイング（ロング=上の最も近い高値 /
 *   ショート=下の最も近い安値）までの距離。候補が無ければ null。
 * - 「狙える」= rr>=minRr かつ その方向のブレイク確率>=minProb。
 * - spreadPips（>0 のとき）: エントリー時のスプレッドをリスクに足し、リワードから引く（保守的な実質 RR）。
 * - stop（任意）: computeStructuralStop の結果を渡すと、旧方式の損切りの代わりにそれを使う。
 */
export function assessRiskReward(
  structure: SlStructure,
  direction: SlDirection,
  directionProb: number, // その方向のブレイク確率(0-100)
  higherSwings: { swingHigh: number; swingLow: number }[],
  instrument: string,
  minRr = 3,
  minProb = 50,
  spreadPips = 0,
  stop: StopPlan | null = null,
): RrSetup | null {
  const entry = structure.currentRate;
  const pip = pipSize(instrument);
  const sl = stop ?? computeStopLoss(structure, direction, null, instrument);
  if (sl.distancePips <= 0) return null;
  const round1 = (n: number) => Math.round(n * 10) / 10;
  const riskPips = round1(sl.distancePips + spreadPips);

  let target: number | null = null;
  if (direction === 'long') {
    const cands = higherSwings.map((h) => h.swingHigh).filter((h) => h > entry);
    if (cands.length) target = Math.min(...cands);
  } else {
    const cands = higherSwings.map((h) => h.swingLow).filter((l) => l < entry);
    if (cands.length) target = Math.max(...cands);
  }
  if (target == null) return null; // 上位TFに進行方向の目標が無い

  const rewardPips = round1(Math.max(Math.abs(target - entry) / pip - spreadPips, 0));
  const rr = round1(rewardPips / riskPips);
  return {
    direction,
    entry,
    stop: sl.price,
    target,
    riskPips,
    rewardPips,
    spreadPips,
    ...(stop ? { stopReasons: stop.reasons, stopStrength: stop.strength } : {}),
    rr,
    qualifies: rr >= minRr && directionProb >= minProb,
  };
}

/** scanStructuralRr の結果（どのTFの setup か付き）。 */
export interface RrScanResult extends RrSetup {
  tf: SlTimeframe;
}

/**
 * Jev を使わない構造的 RR スキャン（バックグラウンド通知用・完全無料）。
 * 各TFで方向をトレンドから決め（up=ロング/down=ショート/range=除外）、上位TFスイングを
 * 目標に RR を評価し、rr>=minRr を満たす setup を「TFごとに全件」返す。確率フィルタは使わない。
 * tfStructures は短い足→長い足の順で渡す（上位TF＝後方）。渡した順（短い足→長い足）で返す。
 * 最も長い足は上位TF（利確目標）が無いため setup にならず、目標の供給元としてだけ使われる。
 * spreadPips を渡すとスプレッド込みの実質 RR で判定する（assessRiskReward 参照）。
 * 各要素に candles があれば、損切りは構造的損切り（computeStructuralStop）で決める（無ければ旧方式）。
 */
export function scanStructuralRrAll(
  tfStructures: { tf: SlTimeframe; structure: SlStructure; candles?: Candle[] }[],
  instrument: string,
  minRr = 3,
  spreadPips = 0,
): RrScanResult[] {
  const results: RrScanResult[] = [];
  tfStructures.forEach(({ tf, structure, candles }, i) => {
    const direction = trendToDirection(structure.trend);
    if (!direction) return; // レンジは方向なし＝対象外
    const higher = tfStructures.slice(i + 1);
    const higherSwings = higher.map((h) => ({ swingHigh: h.structure.swingHigh, swingLow: h.structure.swingLow }));
    const stop = candles
      ? computeStructuralStop(candles, direction, structure.currentRate, {
          instrument,
          spreadPips,
          higherLevels: higherStopLevels(higher, direction),
        })
      : null;
    // directionProb=100 / minProb=0 で確率条件を無効化（構造的 RR のみで qualifies）。
    const rr = assessRiskReward(structure, direction, 100, higherSwings, instrument, minRr, 0, spreadPips, stop);
    if (rr?.qualifies) results.push({ ...rr, tf });
  });
  return results;
}

/**
 * 上記のうち rr が最大の1件のみを返す（従来API・互換維持）。該当なしは null。
 */
export function scanStructuralRr(
  tfStructures: { tf: SlTimeframe; structure: SlStructure }[],
  instrument: string,
  minRr = 3,
): RrScanResult | null {
  return scanStructuralRrAll(tfStructures, instrument, minRr).reduce<RrScanResult | null>(
    (best, r) => (!best || r.rr > best.rr ? r : best),
    null,
  );
}

// ---------------------------------------------------------------------------
// ロールリバーサル・ブレイク信用度（0–100）
// ---------------------------------------------------------------------------
// 「旧レジサポラインがブレイク→役割転換→リテスト保持」として機能する確度をスコア化する。
// 構成: ブレイク確認(30) + リテスト保持(25) + トレンド/モメンタム整合(15) + 出来高急増(15) +
//       ラインの質(15)。出来高が無い(FXスポット=0/欠損)場合は出来高配点を外して再正規化する。

export type RoleReversalState = 'none' | 'broken' | 'retest' | 'confirmed';
export interface RoleReversal {
  score: number; // 0–100
  state: RoleReversalState; // 未ブレイク / ブレイク直後 / リテスト中 / 転換確認
  side: 'resistance' | 'support'; // 評価したライン（上抜け=resistance / 下抜け=support）
  level: number; // 評価したラインの価格（ブレイク済み=抜けたピボット / 未ブレイク=スイング高値・安値）
}

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);

// 平均レンジ(高安幅)。ボラティリティの基準に使う。
function avgRange(candles: Candle[]): number {
  if (candles.length === 0) return 0;
  const sum = candles.reduce((a, c) => a + Math.max(c.high - c.low, 0), 0);
  return sum / candles.length;
}

// 前後 k 本の中で極大(high)/極小(low)になる足のインデックス（ピボット）。
export function pivotIndices(candles: Candle[], kind: 'high' | 'low', k = 2): number[] {
  const out: number[] = [];
  for (let i = k; i < candles.length - k; i++) {
    const v = kind === 'high' ? candles[i].high : candles[i].low;
    let piv = true;
    for (let j = i - k; j <= i + k && piv; j++) {
      if (j === i) continue;
      const w = kind === 'high' ? candles[j].high : candles[j].low;
      if (kind === 'high' ? w > v : w < v) piv = false;
    }
    if (piv) out.push(i);
  }
  return out;
}

/**
 * 1TFのロールリバーサル・ブレイク信用度を算出する（純関数）。
 * bias（trend／breakout）で評価する側(resistance/support)を1つ選び、直近で close がそのラインを
 * 抜けたか（ブレイク）、戻って保持したか（リテスト）を candles から判定してスコア化する。
 * candles 不足や極小レンジで評価不能なら null。
 */
export function scoreRoleReversal(
  candles: Candle[],
  structure: SlStructure,
  opts: {
    instrument: string;
    breakout?: BreakoutProb | null;
    stoch?: StochReading | null;
    volumeLevel?: number | null;
    higherLevels?: number[]; // 上位足のスイング価格（コンフルエンス加点）
  },
): RoleReversal | null {
  const win = candles.slice(-80); // 評価窓（直近最大80本）
  if (win.length < 12) return null;
  const atr = avgRange(win);
  if (!(atr > 0)) return null;

  const pip = pipSize(opts.instrument);
  const buffer = Math.max(atr * 0.25, pip * 3);
  const cr = structure.currentRate;
  const b = opts.breakout ?? null;

  // 評価する側（上抜け=resistance / 下抜け=support）を bias で選ぶ。
  let side: 'resistance' | 'support';
  if (structure.trend === 'up') side = 'resistance';
  else if (structure.trend === 'down') side = 'support';
  else if (b && b.up > b.down && b.up >= b.range) side = 'resistance';
  else if (b && b.down > b.up && b.down >= b.range) side = 'support';
  else side = Math.abs(structure.swingHigh - cr) <= Math.abs(cr - structure.swingLow) ? 'resistance' : 'support';

  const isRes = side === 'resistance';
  const lastClose = win[win.length - 1].close;

  // 「close が抜けたピボット」のうち、抜けた側で現在値に最も近いもの（resistance=最も高い /
  // support=最も低い）を役割転換ラインとして採用する。未ブレイクなら表示ラインを保留対象に。
  const pivs = pivotIndices(win, isRes ? 'high' : 'low');
  let level = isRes ? structure.swingHigh : structure.swingLow; // 未ブレイク時の保留ライン
  let breakIdx = -1;
  let bestL = isRes ? -Infinity : Infinity;
  for (const p of pivs) {
    const L = isRes ? win[p].high : win[p].low;
    let bi = -1;
    for (let i = p + 1; i < win.length; i++) {
      if (isRes ? win[i].close > L : win[i].close < L) {
        bi = i;
        break;
      }
    }
    if (bi < 0) continue; // このピボットは未ブレイク
    if (isRes ? L > bestL : L < bestL) {
      bestL = L;
      level = L;
      breakIdx = bi;
    }
  }

  // --- 各サブスコア（0..1） ---
  let breakConf = 0;
  let retestConf = 0;
  let volumeConf: number | null = null;
  let state: RoleReversalState = 'none';

  if (breakIdx >= 0) {
    const bc = win[breakIdx];
    // ブレイク確認: ラインからの貫通幅 + 足のレンジ拡大。
    const pen = isRes ? bc.close - level : level - bc.close;
    const penNorm = clamp01(pen / (atr * 0.75));
    const rngNorm = clamp01((bc.high - bc.low) / (atr * 1.2));
    breakConf = clamp01(0.6 * penNorm + 0.4 * rngNorm);

    // リテスト: ブレイク後にラインまで戻ったか／現在も抜け側を保持しているか。
    let retestTouched = false;
    for (let i = breakIdx + 1; i < win.length; i++) {
      const back = isRes ? win[i].low <= level + buffer : win[i].high >= level - buffer;
      if (back) {
        retestTouched = true;
        break;
      }
    }
    const stillBeyond = isRes ? lastClose > level : lastClose < level;
    if (!retestTouched) {
      state = 'broken';
      retestConf = 0;
    } else if (stillBeyond) {
      state = 'confirmed';
      retestConf = 1;
    } else {
      state = 'retest';
      retestConf = 0.5;
    }

    // 出来高急増: ブレイク足の出来高 ÷ 窓平均。volume 欠損(FXスポット)なら配点から除外。
    const vols = win.map((c) => c.volume ?? 0).filter((v) => v > 0);
    if ((bc.volume ?? 0) > 0 && vols.length >= win.length / 2) {
      const avgVol = vols.reduce((a, v) => a + v, 0) / vols.length;
      if (avgVol > 0) volumeConf = clamp01((bc.volume! / avgVol - 1) / 1.0); // 2倍で満点
    }
  }

  // トレンド/モメンタム整合（常時）。
  const trendAlign = structure.trend === (isRes ? 'up' : 'down') ? 1 : structure.trend === 'range' ? 0.5 : 0;
  let stochComp = 0.5;
  if (opts.stoch) {
    const k = opts.stoch.k;
    stochComp = isRes ? (k >= 85 ? 0.4 : k >= 50 ? 0.9 : 0.6) : k <= 15 ? 0.4 : k <= 50 ? 0.9 : 0.6;
  }
  const momentum = clamp01(0.6 * trendAlign + 0.4 * stochComp);

  // ラインの質: タッチ回数 + volumeLevel/上位足とのコンフルエンス（常時）。
  const touches = win.filter((c) =>
    isRes ? Math.abs(c.high - level) <= buffer : Math.abs(c.low - level) <= buffer,
  ).length;
  const touchScore = clamp01(touches / 3);
  let conf = 0;
  if (opts.volumeLevel != null && Math.abs(opts.volumeLevel - level) <= buffer * 2) conf += 0.5;
  if ((opts.higherLevels ?? []).some((h) => Math.abs(h - level) <= buffer * 2)) conf += 0.5;
  const quality = clamp01(0.5 * touchScore + 0.5 * Math.min(1, conf));

  // 重み付き合算（volume は取得できたときだけ）。
  const parts: { w: number; v: number }[] = [
    { w: 0.3, v: breakConf },
    { w: 0.25, v: retestConf },
    { w: 0.15, v: momentum },
    { w: 0.15, v: quality },
  ];
  if (volumeConf !== null) parts.push({ w: 0.15, v: volumeConf });
  const wsum = parts.reduce((a, p) => a + p.w, 0);
  const score = Math.round((100 * parts.reduce((a, p) => a + p.w * p.v, 0)) / wsum);

  return { score, state, side, level };
}

// ---------------------------------------------------------------------------
// プライスアクション分類: Jev(Choice) / Workers AI(JSON)
// ---------------------------------------------------------------------------
export interface JevBody {
  state: unknown;
  questions: Record<string, unknown>;
}

/** ストキャスティクスの読み取り値（%K/%D、0-100）。 */
export interface StochReading {
  k: number;
  d: number;
}

/** プライスアクション判定に追加で渡す文脈（すべて任意）。 */
export interface PaContext {
  sessionStatus?: string; // 東京/ロンドン/NY の開閉状況
  volumeLevel?: number | null; // 過去の高出来高の節目価格
  stoch?: StochReading | null; // ストキャスティクス(%K/%D)
  candlePattern?: { label: string; barsAgo: number } | null; // 直近のローソク足パターン(ピンバー/包み足)
}

const paState = (structure: SlStructure, recentCloses: number[], ctx: PaContext = {}): unknown => ({
  trend: structure.trend,
  currentRate: structure.currentRate,
  swingHigh: structure.swingHigh,
  swingLow: structure.swingLow,
  recentCloses: recentCloses.slice(-12),
  // 以下はいずれも任意。渡されたときだけ判定の材料にする。
  ...(ctx.sessionStatus ? { sessionStatus: ctx.sessionStatus } : {}),
  ...(ctx.volumeLevel != null ? { volumeLevel: ctx.volumeLevel } : {}),
  ...(ctx.stoch ? { stochastic: { k: ctx.stoch.k, d: ctx.stoch.d } } : {}),
  ...(ctx.candlePattern ? { candlePattern: { pattern: ctx.candlePattern.label, barsAgo: ctx.candlePattern.barsAgo } } : {}),
});

/** Jev systemone リクエスト body（model 以外）。1問の Choice でプライスアクションを分類。
 *  ctx でセッション状況・過去の高出来高の節目・ストキャスティクスも考慮させられる。 */
export function buildPaJevRequest(structure: SlStructure, recentCloses: number[], ctx: PaContext = {}): JevBody {
  const sessionNote = ctx.sessionStatus
    ? '。また現在のセッション状況(sessionStatus: どの市場が開いているか)も踏まえ、その時間帯に動きやすい方向を考慮してください'
    : '';
  const volumeNote = ctx.volumeLevel != null ? '。過去に出来高が膨らんだ価格(volumeLevel)は重要なレジサポ(節目)として考慮してください' : '';
  const stochNote = ctx.stoch
    ? '。ストキャスティクス(stochastic.k/%K, stochastic.d/%D)の買われすぎ(80以上)/売られすぎ(20以下)や%Kと%Dのクロスも考慮してください'
    : '';
  const candleNote = ctx.candlePattern
    ? `。直近のローソク足パターン(candlePattern.pattern=${ctx.candlePattern.label}、${ctx.candlePattern.barsAgo}本前)は反転/継続の手がかりとして重視してください`
    : '';
  const note = sessionNote + volumeNote + stochNote + candleNote;
  return {
    state: paState(structure, recentCloses, ctx),
    questions: {
      price_action: {
        type: 'choice',
        instructions:
          '直近のトレンド・スイング高安・現在値・最近の終値列から、現在の相場のプライスアクションを分類してください' + note + '。',
        criteria: PA_CRITERIA,
      },
      breakout: {
        type: 'choice',
        instructions:
          '現在値・スイング高安・トレンド・最近の終値列から、現在のレンジ(スイング高安)を次の数本でどう抜けるかを判定してください' + note + '。',
        criteria: BREAKOUT_CRITERIA,
      },
    },
  };
}

/** 各方向のブレイク確率(0-100, 合計100)。/mtf で各TFの判定に使う。 */
export interface BreakoutProb {
  up: number; // 上抜け
  down: number; // 下抜け
  range: number; // レンジ継続
}

/** Jev の answers からブレイク確率を取り出す。設問欠損/確率なしは null（＝判定不可）。 */
export function parseBreakoutJev(answers: Record<string, JevChoiceAnswer> | undefined): BreakoutProb | null {
  const probs = (answers ?? {}).breakout?.probabilities;
  if (!probs) return null;
  const rawUp = Number(probs.break_up) || 0;
  const rawDown = Number(probs.break_down) || 0;
  const rawRange = Number(probs.stay_range) || 0;
  const sum = rawUp + rawDown + rawRange;
  if (sum <= 0) return null;
  const up = Math.round((rawUp / sum) * 100);
  const down = Math.round((rawDown / sum) * 100);
  const range = Math.max(0, 100 - up - down); // 丸め誤差を継続側に寄せ合計100を保証
  return { up, down, range };
}

interface JevChoiceAnswer {
  choice?: string;
  probabilities?: Record<string, number>;
  confidence?: number;
}

/** Jev の answers を PaResult に整形（欠損はレンジ/中立）。 */
export function parsePaJev(answers: Record<string, JevChoiceAnswer> | undefined): PaResult {
  const q = (answers ?? {}).price_action;
  const valid: PaClass[] = ['reversal', 'sell_rally', 'buy_dip', 'range'];
  const pa = valid.includes(q?.choice as PaClass) ? (q!.choice as PaClass) : 'range';
  const p = q?.probabilities?.[pa];
  const paPct = typeof p === 'number' ? Math.round(clamp(p * 100, 0, 100)) : 50;
  const confidence = typeof q?.confidence === 'number' ? clamp(q.confidence, 0, 1) : 0.5;
  return { pa, paPct, confidence };
}

// ---------------------------------------------------------------------------
// セッション別シナリオ予測（東京/ロンドン/NY で 反転/ブレイク/押し目/戻り/レンジ）
// ---------------------------------------------------------------------------
export type SessionScenario = 'reversal' | 'breakout' | 'buy_dip' | 'sell_rally' | 'range';
export const SESSION_SCENARIO_CRITERIA: Record<SessionScenario, string> = {
  reversal: '直近トレンドが反転する（転換）',
  breakout: '直近レンジ(スイング高安)を抜けて新たな方向へ動く',
  buy_dip: '上昇基調の押し目（一旦下げてから上昇再開）',
  sell_rally: '下降基調の戻り（一旦上げてから下落再開）',
  range: '方向感なくレンジ/動意薄',
};

/** セッション予測 Jev に渡す集約状態（各TFを統合した相場観）。 */
export interface SessionState {
  trend: 'up' | 'down' | 'range'; // 上位TFの方向
  currentRate: number;
  swingHigh: number;
  swingLow: number;
  alignment: string; // 複数TFの整合ラベル
  breakoutBias: string; // 各TFのブレイク優勢サマリ（例 "15m:上 30m:継続 ..."）
  recentCloses: number[];
  sessionStatus: string; // 現在の各セッション開閉テキスト
}

/** 1回の Jev 呼び出しで 東京/ロンドン/NY の3問を判定するリクエスト body（model 以外）。 */
export function buildSessionJevRequest(state: SessionState): JevBody {
  const mkQ = (session: string) => ({
    type: 'choice',
    instructions: `上位足の相場観と現在のセッション状況から、${session}セッションで最も起きやすい値動きのシナリオを判定してください。`,
    criteria: SESSION_SCENARIO_CRITERIA,
  });
  return {
    state: {
      trend: state.trend,
      currentRate: state.currentRate,
      swingHigh: state.swingHigh,
      swingLow: state.swingLow,
      alignment: state.alignment,
      breakoutBias: state.breakoutBias,
      recentCloses: state.recentCloses.slice(-12),
      sessionStatus: state.sessionStatus,
    },
    questions: {
      tokyo: mkQ('東京'),
      london: mkQ('ロンドン'),
      ny: mkQ('ニューヨーク'),
    },
  };
}

/** 1セッションの予測。 */
export interface SessionPrediction {
  scenario: SessionScenario;
  pct: number; // 0-100 そのシナリオの確からしさ
  confidence: number; // 0-1
}
/** 東京/ロンドン/NY のセッション別予測。 */
export interface SessionOutlook {
  tokyo: SessionPrediction;
  london: SessionPrediction;
  ny: SessionPrediction;
}

/** Jev の answers を SessionOutlook に整形。3セッションのいずれか欠損なら null（判定不可）。 */
export function parseSessionJev(answers: Record<string, JevChoiceAnswer> | undefined): SessionOutlook | null {
  if (!answers) return null;
  const valid: SessionScenario[] = ['reversal', 'breakout', 'buy_dip', 'sell_rally', 'range'];
  const one = (key: string): SessionPrediction | null => {
    const q = answers[key];
    if (!q) return null;
    const scenario = valid.includes(q.choice as SessionScenario) ? (q.choice as SessionScenario) : 'range';
    const p = q.probabilities?.[scenario];
    const pct = typeof p === 'number' ? Math.round(clamp(p * 100, 0, 100)) : 50;
    const confidence = typeof q.confidence === 'number' ? clamp(q.confidence, 0, 1) : 0.5;
    return { scenario, pct, confidence };
  };
  const tokyo = one('tokyo');
  const london = one('london');
  const ny = one('ny');
  if (!tokyo || !london || !ny) return null;
  return { tokyo, london, ny };
}

/** Workers AI フォールバック用プロンプト（厳密JSONを要求）。 */
export function buildPaPrompt(structure: SlStructure, recentCloses: number[], ctx: PaContext = {}): string {
  return [
    '次の相場状態から、現在のプライスアクションを分類してください。',
    ctx.sessionStatus ? `現在のセッション状況も考慮してください: ${ctx.sessionStatus}` : '',
    ctx.volumeLevel != null ? `過去に出来高が膨らんだ価格(${ctx.volumeLevel})は重要なレジサポとして考慮してください。` : '',
    ctx.stoch ? `ストキャスティクス %K=${ctx.stoch.k} / %D=${ctx.stoch.d}（80以上=買われすぎ, 20以下=売られすぎ）も考慮してください。` : '',
    ctx.candlePattern ? `直近のローソク足パターン: ${ctx.candlePattern.label}（${ctx.candlePattern.barsAgo}本前）も反転/継続の手がかりとして考慮してください。` : '',
    JSON.stringify(paState(structure, recentCloses, ctx)),
    '分類の定義:',
    ...Object.entries(PA_CRITERIA).map(([k, v]) => `- ${k}: ${v}`),
    '次のJSONのみ返してください（説明なし）:',
    '{"pa":"reversal|sell_rally|buy_dip|range","paPct":<0-100>,"confidence":<0-1>}',
  ].join('\n');
}

function extractJson(raw: string): unknown {
  if (!raw) return null;
  const cleaned = raw.replace(/```json\s*|```/gi, '');
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return null;
  }
}

/** Workers AI の応答(JSON文字列/オブジェクト)を PaResult に整形。 */
export function parsePaAi(raw: unknown): PaResult {
  const o = (typeof raw === 'string' ? extractJson(raw) : raw) as Record<string, unknown> | null;
  const valid: PaClass[] = ['reversal', 'sell_rally', 'buy_dip', 'range'];
  const pa = valid.includes(o?.pa as PaClass) ? (o!.pa as PaClass) : 'range';
  const paRaw = Number(o?.paPct);
  const paPct = Number.isFinite(paRaw) ? Math.round(clamp(paRaw, 0, 100)) : 50;
  const confRaw = Number(o?.confidence);
  const confidence = Number.isFinite(confRaw) ? clamp(confRaw, 0, 1) : 0.5;
  return { pa, paPct, confidence };
}

// ---------------------------------------------------------------------------
// 構造的な損切りライン（ピボット＋ATR＋コンフルエンス）。TF分析・RR好機通知・ランキングで共通。
// ---------------------------------------------------------------------------
// 旧方式（computeStopLoss）は「直近24本の最安値/最高値 − 値幅の5%」で、ヒゲ1本や窓の端を拾いやすく、
// バッファもボラティリティと無関係だった。ここでは確定足のピボット（実際の押し安値/戻り高値）を
// 候補にし、ラインの強さ（タッチ回数・上位足/ロールリバーサル/出来高節目との一致・キリ番）で選び、
// バッファは ATR 基準＋スプレッドにする。

export interface StopLevelRef {
  price: number;
  label: string; // 根拠の表示名（例 '1時間足の安値'）
}

export interface StopOptions {
  instrument: string;
  higherLevels?: StopLevelRef[]; // 上位足のスイング（一致すれば加点）
  extraLevels?: StopLevelRef[]; // ロールリバーサル・出来高節目など（一致すれば加点）
  spreadPips?: number; // ショートの損切りは Ask で約定するため上側に加える
  excludeLast?: boolean; // 最終足を形成中として除外する（既定 true。バックテストでは false）
  lookback?: number; // ピボットを探す確定足の本数（既定 100）
  pivotK?: number; // ピボットの前後本数（既定 2）
  bufferAtr?: number; // ラインからのバッファ（ATR 倍, 既定 0.25）
  minDistAtr?: number; // エントリーからこれより近いラインは採らない（ATR 倍, 既定 0.5）
  maxDistAtr?: number; // これより遠いラインは採らない（ATR 倍, 既定 8）
}

export type StopBasis = 'pivot' | 'window';
export interface StopPlan {
  price: number; // 損切り価格（バッファ・スプレッド込み）
  level: number; // 守るライン（ピボット or 窓の極値）
  distancePips: number; // エントリーから損切りまで
  basis: StopBasis; // pivot=確定ピボット / window=ピボットが無く直近24本の極値で代用
  strength: number; // ラインの強さ 0–100
  reasons: string[]; // 根拠（例 ['直近の押し安値', 'タッチ3回', '1時間足の安値と一致']）
  atr: number;
}

export const STOP_DEFAULTS = { lookback: 100, pivotK: 2, bufferAtr: 0.25, minDistAtr: 0.5, maxDistAtr: 8 } as const;

/** 平均トゥルーレンジ（直近 period 本）。前足終値とのギャップも含めた値幅の平均。 */
export function averageTrueRange(candles: Candle[], period = 14): number {
  if (candles.length < 2) return candles.length === 1 ? Math.max(candles[0].high - candles[0].low, 0) : 0;
  const from = Math.max(1, candles.length - period);
  let sum = 0;
  let n = 0;
  for (let i = from; i < candles.length; i++) {
    const c = candles[i];
    const pc = candles[i - 1].close;
    sum += Math.max(c.high - c.low, Math.abs(c.high - pc), Math.abs(c.low - pc));
    n++;
  }
  return n > 0 ? sum / n : 0;
}

// キリ番の刻み（円絡み=0.50円, XAU=10ドル, その他=0.0050）。
function roundStep(instrument: string): number {
  if (instrument.startsWith('XAU')) return 10;
  if (instrument.endsWith('JPY')) return 0.5;
  return 0.005;
}

/** ラインの強さ（0–100）と根拠。 */
function scoreStopLevel(
  level: number,
  win: Candle[],
  isLong: boolean,
  atr: number,
  opts: StopOptions,
): { strength: number; reasons: string[] } {
  const reasons: string[] = [];
  let score = 30; // 確定ピボットであること自体の基礎点
  const tol = atr * 0.25;
  const touches = win.filter((c) => Math.abs((isLong ? c.low : c.high) - level) <= tol).length - 1; // 自身を除く
  if (touches > 0) {
    score += Math.min(touches, 3) * 10;
    reasons.push(`タッチ${touches + 1}回`);
  }
  const near = (refs: StopLevelRef[] | undefined) => (refs ?? []).filter((r) => Math.abs(r.price - level) <= atr * 0.3);
  const hi = near(opts.higherLevels);
  if (hi.length) {
    score += 20;
    reasons.push(`${hi[0].label}と一致`);
  }
  for (const r of near(opts.extraLevels).slice(0, 2)) {
    score += 10;
    reasons.push(`${r.label}と一致`);
  }
  const step = roundStep(opts.instrument);
  const roundLevel = Math.round(level / step) * step;
  if (Math.abs(level - roundLevel) <= atr * 0.2) {
    score += 10;
    reasons.push('キリ番付近');
  }
  return { strength: Math.min(100, score), reasons };
}

/**
 * 構造的な損切りを求める（純関数）。
 * 1. 確定足（既定で最終足=形成中を除外）の直近 lookback 本からピボット安値/高値を抽出。
 * 2. エントリーから minDistAtr〜maxDistAtr ATR の範囲にあるもののうち、最も近いものを基本に採る。
 *    ただし、それより遠くても距離 1.5 倍以内に強さが +20 以上高いラインがあればそちらを採る。
 * 3. 損切り = ライン − バッファ（ロング）/ ライン＋バッファ＋スプレッド（ショート）。バッファ = ATR×bufferAtr。
 * 候補が無ければ直近24本の極値で代用（basis='window'）。それも使えなければ null。
 */
export function computeStructuralStop(
  candles: Candle[],
  direction: SlDirection,
  entry: number,
  opts: StopOptions,
): StopPlan | null {
  const o = { ...STOP_DEFAULTS, ...opts };
  const closed = o.excludeLast === false ? candles : candles.slice(0, -1);
  const win = closed.slice(-o.lookback);
  if (win.length < o.pivotK * 2 + 3) return null;
  const atr = averageTrueRange(win);
  if (!(atr > 0)) return null;
  const pip = pipSize(o.instrument);
  const isLong = direction === 'long';
  const minD = atr * o.minDistAtr;
  const maxD = atr * o.maxDistAtr;

  const cands = pivotIndices(win, isLong ? 'low' : 'high', o.pivotK)
    .map((i) => (isLong ? win[i].low : win[i].high))
    .filter((L) => {
      const d = isLong ? entry - L : L - entry;
      return d >= minD && d <= maxD;
    })
    .sort((a, b) => (isLong ? b - a : a - b)); // エントリーに近い順
  const uniq = cands.filter((L, i) => i === 0 || Math.abs(L - cands[i - 1]) > atr * 0.1);

  let level: number;
  let basis: StopBasis;
  let scored: { strength: number; reasons: string[] };
  if (uniq.length > 0) {
    const all = uniq.map((L) => ({ L, ...scoreStopLevel(L, win, isLong, atr, o) }));
    let pick = all[0];
    const nearestDist = Math.abs(entry - all[0].L);
    for (const c of all.slice(1)) {
      if (Math.abs(entry - c.L) <= nearestDist * 1.5 && c.strength >= pick.strength + 20) pick = c;
    }
    level = pick.L;
    basis = 'pivot';
    scored = { strength: pick.strength, reasons: [isLong ? '直近の押し安値' : '直近の戻り高値', ...pick.reasons] };
  } else {
    const recent = win.slice(-24);
    level = isLong ? Math.min(...recent.map((c) => c.low)) : Math.max(...recent.map((c) => c.high));
    if (isLong ? level >= entry : level <= entry) return null;
    basis = 'window';
    scored = { strength: 20, reasons: [isLong ? '直近24本の安値（ピボットなし）' : '直近24本の高値（ピボットなし）'] };
  }

  const buffer = atr * o.bufferAtr;
  const spread = (o.spreadPips ?? 0) * pip;
  const price = isLong ? level - buffer : level + buffer + spread;
  const distancePips = Math.round((Math.abs(entry - price) / pip) * 10) / 10;
  return { price, level, distancePips, basis, strength: scored.strength, reasons: scored.reasons, atr };
}
