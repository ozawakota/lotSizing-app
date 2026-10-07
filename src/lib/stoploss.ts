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
/** あるTFの「狙える setup」。リスク=構造的損切りまで, リワード=上位TFスイングまで。 */
export interface RrSetup {
  direction: SlDirection;
  entry: number;
  stop: number; // 損切り価格
  target: number; // 利確目標価格（上位TFスイング）
  riskPips: number;
  rewardPips: number;
  rr: number; // リワード/リスク（小数1桁）
  qualifies: boolean; // rr>=minRr かつ 方向のブレイク確率>=minProb
}

/**
 * 上位TFのスイングを利確目標として RR を評価する。
 * - リスク: computeStopLoss（ロング=スイング安値の下 / ショート=高値の上＋バッファ）までの距離。
 * - リワード: 進行方向で現在値より先にある最も近い上位TFスイング（ロング=上の最も近い高値 /
 *   ショート=下の最も近い安値）までの距離。候補が無ければ null。
 * - 「狙える」= rr>=minRr かつ その方向のブレイク確率>=minProb。
 */
export function assessRiskReward(
  structure: SlStructure,
  direction: SlDirection,
  directionProb: number, // その方向のブレイク確率(0-100)
  higherSwings: { swingHigh: number; swingLow: number }[],
  instrument: string,
  minRr = 3,
  minProb = 50,
): RrSetup | null {
  const entry = structure.currentRate;
  const pip = pipSize(instrument);
  const sl = computeStopLoss(structure, direction, null, instrument);
  const riskPips = sl.distancePips;
  if (riskPips <= 0) return null;

  let target: number | null = null;
  if (direction === 'long') {
    const cands = higherSwings.map((h) => h.swingHigh).filter((h) => h > entry);
    if (cands.length) target = Math.min(...cands);
  } else {
    const cands = higherSwings.map((h) => h.swingLow).filter((l) => l < entry);
    if (cands.length) target = Math.max(...cands);
  }
  if (target == null) return null; // 上位TFに進行方向の目標が無い

  const rewardPips = Math.round((Math.abs(target - entry) / pip) * 10) / 10;
  const rr = Math.round((rewardPips / riskPips) * 10) / 10;
  return {
    direction,
    entry,
    stop: sl.price,
    target,
    riskPips,
    rewardPips,
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
 * 目標に RR を評価して rr>=minRr を満たす最良 setup を返す。確率フィルタは使わない。
 * tfStructures は短い足→長い足の順で渡す（上位TF＝後方）。無ければ null。
 */
export function scanStructuralRr(
  tfStructures: { tf: SlTimeframe; structure: SlStructure }[],
  instrument: string,
  minRr = 3,
): RrScanResult | null {
  let best: RrScanResult | null = null;
  tfStructures.forEach(({ tf, structure }, i) => {
    const direction: SlDirection | null = structure.trend === 'up' ? 'long' : structure.trend === 'down' ? 'short' : null;
    if (!direction) return; // レンジは方向なし＝対象外
    const higherSwings = tfStructures.slice(i + 1).map((h) => ({ swingHigh: h.structure.swingHigh, swingLow: h.structure.swingLow }));
    // directionProb=100 / minProb=0 で確率条件を無効化（構造的 RR のみで qualifies）。
    const rr = assessRiskReward(structure, direction, 100, higherSwings, instrument, minRr, 0);
    if (rr?.qualifies && (!best || rr.rr > best.rr)) best = { ...rr, tf };
  });
  return best;
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
  const note = sessionNote + volumeNote + stochNote;
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
