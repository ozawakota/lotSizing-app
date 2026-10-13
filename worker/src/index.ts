/// <reference types="@cloudflare/workers-types" />
// 通貨強弱 Cloudflare Worker（Cron + KV キャッシュ / OANDA式・累積対数）
// 設計: docs/adr/0005-currency-strength-oanda-cumulative-log.md
//
// - scheduled(): 2つの Cron。
//     "0 0 * * *"    → 日足シリーズ(daily)を更新（年初起点用、1日1回）
//     "0 *\/2 * * *" → 15分足シリーズ(intraday)を更新（4時間前/当日用、2時間ごと）
//   いずれも Twelve Data から7ペアの時系列を取得し KV に保存。失敗時は前回値を保持。
// - fetch(): KV の intraday/daily を返すだけ（無ければ初回のみ算出）。クライアントが
//   起点を選んで累積対数強弱を計算・折れ線表示する。
//
// 強弱の計算式はフロントと共有: ../../src/lib/strength.ts（computeCumulativeStrength）
import { type JpyPairCurrency, type RateSeries } from '../../src/lib/strength';
import { sessionStatusText } from '../../src/lib/session';
// 取引量・センチメント(/flow)のロジック/型もフロントと共有: ../../src/lib/flow.ts
import {
  FLOW_PAIRS,
  computeDelta,
  normalizeNet,
  toPairCot,
  toPairFlow,
  updatePeak,
  type CotCurrency,
  type FlowPair,
  type FlowSnapshot,
  type PairFlow,
  type VolumePeak,
} from '../../src/lib/flow';
// /news の為替ニュース＋売買シグナルのロジック/型もフロントと共有。
import { filterEconEvents, formatEconDigest, parseRssItems, type EconEvent, type NewsItem } from '../../src/lib/news';
import {
  SIGNAL_PAIRS,
  buildJevRequest,
  buildSignalPrompt,
  computeRecentTrend,
  parseJevAnswers,
  parseSignalResponse,
  type PairSignal,
  type PairTrend,
} from '../../src/lib/signal';
// 損切り提案のロジック/型もフロントと共有。
import {
  SL_TIMEFRAMES,
  YAHOO_INTERVAL,
  YAHOO_SYMBOL,
  alignmentLabel,
  assessRiskReward,
  buildPaJevRequest,
  buildPaPrompt,
  buildSessionJevRequest,
  computeStopLoss,
  computeStructure,
  parseBreakoutJev,
  parsePaAi,
  parsePaJev,
  parseSessionJev,
  volumeAnchoredLevel,
  futuresLevelToSpot,
  computeStochastic,
  scoreRoleReversal,
  VOLUME_SYMBOL,
  type BreakoutProb,
  type RoleReversal,
  type PaContext,
  type StochReading,
  type Candle,
  type PaResult,
  type RrSetup,
  type SessionOutlook,
  type SessionState,
  type SlDirection,
  type SlStructure,
  type SlSuggestion,
  type SlTimeframe,
} from '../../src/lib/stoploss';

interface Env {
  TWELVE_DATA_API_KEY: string;
  STRENGTH_KV: KVNamespace;
  // /flow のリテールセンチメント用（Myfxbook 無料アカウント）。wrangler secret で登録。
  MYFXBOOK_EMAIL: string;
  MYFXBOOK_PASSWORD: string;
  // /news の要約・シグナル用。Workers AI バインディング（無料枠 10k Neurons/日）。
  AI: Ai;
  // シグナル算出エンジン切替: 未設定/"workers-ai" で Workers AI、"jev" で Jev(typesafe.ai)。
  SIGNAL_ENGINE?: string;
  TYPESAFE_API_KEY?: string; // Jev 利用時のみ（wrangler secret）
}

const PAIRS: JpyPairCurrency[] = ['USD', 'EUR', 'GBP', 'AUD', 'NZD', 'CAD', 'CHF'];

const KV_INTRADAY = 'intraday';
const KV_DAILY = 'daily';
// /flow 用のキャッシュキー。
const KV_FLOW = 'flow';
const KV_MFB_SESSION = 'mfb_session';
const KV_FLOW_PEAKS = 'flow_peaks'; // ペアごとの合計取引量ピーク（記録開始以降・自前蓄積）
const KV_COT = 'cot'; // 投機筋（CFTC COT）の通貨別ネット（週次・自前キャッシュ）

// 1回の /flow 更新で取得するスポットレートの上限（Twelve Data 8 credits/分 制限の回避）。
const MAX_RATE_FETCH = 7;

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
};

interface TwelveDataValue {
  datetime: string;
  close: string;
}
interface TwelveDataNode {
  status?: string;
  message?: string;
  values?: TwelveDataValue[];
}

// Twelve Data から7ペア＋XAU/USD の時系列を一括取得し、datetime で揃えた RateSeries を作る。
// ゴールドは XAU/JPY = XAU/USD × USD/JPY で合成し rates.XAU に格納（独立したゴールド線用）。
// 7ペアが揃えば成立とし、XAU/USD の欠落時は rates.XAU を省略（7通貨の強弱には影響させない）。
const fetchSeries = async (env: Env, interval: string, outputsize: number): Promise<RateSeries> => {
  const symbols = [...PAIRS.map((c) => `${c}/JPY`), 'XAU/USD'];
  const url =
    'https://api.twelvedata.com/time_series' +
    `?symbol=${encodeURIComponent(symbols.join(','))}` +
    `&interval=${encodeURIComponent(interval)}` +
    `&outputsize=${outputsize}` +
    '&timezone=Asia/Tokyo' +
    `&apikey=${encodeURIComponent(env.TWELVE_DATA_API_KEY)}`;

  const res = await fetch(url);
  const text = await res.text();
  if (!res.ok) throw new Error(`Twelve Data HTTP ${res.status}: ${text.slice(0, 200)}`);
  const parsed = JSON.parse(text) as Record<string, TwelveDataNode> & { code?: number; message?: string };
  if (typeof parsed.code === 'number' && parsed.message) {
    throw new Error(`Twelve Data ${parsed.code}: ${parsed.message}`);
  }

  // シンボルごとに datetime→close のマップを作る
  const maps: Record<JpyPairCurrency, Map<string, number>> = {} as Record<JpyPairCurrency, Map<string, number>>;
  for (const c of PAIRS) {
    const node = parsed[`${c}/JPY`];
    if (!node || node.status !== 'ok' || !node.values || node.values.length < 2) {
      throw new Error(`系列不足: ${c}/JPY (${node?.message ?? 'no data'})`);
    }
    const m = new Map<string, number>();
    for (const v of node.values) {
      const close = parseFloat(v.close);
      if (!Number.isNaN(close) && close > 0) m.set(v.datetime, close);
    }
    maps[c] = m;
  }

  // 全ペアに存在する datetime のみ（昇順）を採用して整列
  const first = maps[PAIRS[0]];
  const datetimes = [...first.keys()]
    .filter((dt) => PAIRS.every((c) => maps[c].has(dt)))
    .sort();
  if (datetimes.length < 2) throw new Error('共通の時系列が不足');

  const rates: Record<JpyPairCurrency, number[]> & { XAU?: number[] } = {} as Record<
    JpyPairCurrency,
    number[]
  >;
  for (const c of PAIRS) rates[c] = datetimes.map((dt) => maps[c].get(dt) as number);

  // ゴールド: XAU/USD を取得できていれば XAU/JPY = XAU/USD × USD/JPY を合成し rates.XAU に格納。
  // ゴールドと為替は休場日がずれ datetime が完全一致しないため、採用済み datetimes に対して
  // 前方補完（欠損は直近の既知値、先頭欠損は最初の既知値）して整列する。1つも無ければ省略。
  const xauNode = parsed['XAU/USD'];
  if (xauNode && xauNode.status === 'ok' && xauNode.values && xauNode.values.length >= 2) {
    const xauMap = new Map<string, number>();
    for (const v of xauNode.values) {
      const close = parseFloat(v.close);
      if (!Number.isNaN(close) && close > 0) xauMap.set(v.datetime, close);
    }
    // 前方補完：各 datetime に XAU/USD があれば採用、無ければ直近の既知値を引き継ぐ。
    const xauUsd: (number | null)[] = [];
    let last: number | null = null;
    for (const dt of datetimes) {
      const v = xauMap.get(dt);
      if (v != null) last = v;
      xauUsd.push(last);
    }
    // 先頭の未確定（最初の既知値より前）を最初の既知値でバックフィル。
    const firstKnown = xauUsd.find((v) => v != null) ?? null;
    if (firstKnown != null) {
      rates.XAU = datetimes.map((_, i) => (xauUsd[i] ?? firstKnown) * rates.USD[i]);
    }
  }

  return { interval, datetimes, rates };
};

const updateIntraday = async (env: Env): Promise<RateSeries> => {
  const series = await fetchSeries(env, '15min', 130); // 約32時間分（当日＋4時間前をカバー）
  await env.STRENGTH_KV.put(KV_INTRADAY, JSON.stringify(series));
  return series;
};

const updateDaily = async (env: Env): Promise<RateSeries> => {
  const series = await fetchSeries(env, '1day', 300); // 約1年分（年初起点をカバー）
  await env.STRENGTH_KV.put(KV_DAILY, JSON.stringify(series));
  return series;
};

// ---------------------------------------------------------------------------
// /flow: 取引量・センチメント（Myfxbook Community Outlook の実建玉 volume に一本化）
// ---------------------------------------------------------------------------
// Twelve Data の tick volume は FX では常に 0 で使えなかったため、取引量は
// Myfxbook の longVolume / shortVolume（買い量 / 売り量）を用いる。

// FlowPair('USD/JPY') → Myfxbook のシンボル名('USDJPY')。
const MFB_SYMBOL: Record<FlowPair, string> = {
  'USD/JPY': 'USDJPY',
  'EUR/JPY': 'EURJPY',
  'GBP/JPY': 'GBPJPY',
  'AUD/JPY': 'AUDJPY',
  'NZD/JPY': 'NZDJPY',
  'CAD/JPY': 'CADJPY',
  'CHF/JPY': 'CHFJPY',
  'EUR/USD': 'EURUSD',
  'GBP/USD': 'GBPUSD',
  'AUD/USD': 'AUDUSD',
  'XAU/USD': 'XAUUSD',
};

interface MfbOutlookSymbol {
  name: string;
  longPercentage: number | string;
  shortPercentage: number | string;
  longVolume: number | string;
  shortVolume: number | string;
}

// Myfxbook にログインして session を取得し KV にキャッシュする。
const myfxbookLogin = async (env: Env): Promise<string> => {
  const url =
    'https://www.myfxbook.com/api/login.json' +
    `?email=${encodeURIComponent(env.MYFXBOOK_EMAIL)}` +
    `&password=${encodeURIComponent(env.MYFXBOOK_PASSWORD)}`;
  const res = await fetch(url);
  const data = (await res.json()) as { error: boolean; message: string; session?: string };
  if (data.error || !data.session) throw new Error(`Myfxbook login失敗: ${data.message}`);
  await env.STRENGTH_KV.put(KV_MFB_SESSION, data.session);
  return data.session;
};

// Community Outlook（全シンボルの long/short % と volume）を取得する。
const fetchOutlook = async (session: string): Promise<MfbOutlookSymbol[]> => {
  const url = `https://www.myfxbook.com/api/get-community-outlook.json?session=${encodeURIComponent(session)}`;
  const res = await fetch(url);
  const data = (await res.json()) as { error: boolean; message: string; symbols?: MfbOutlookSymbol[] };
  if (data.error) throw new Error(`Myfxbook outlook失敗: ${data.message}`);
  return data.symbols ?? [];
};

// 指定ペアの現在スポットレートを Twelve Data から取得する（1ペア=1クレジット）。
// レスポンスは複数シンボルで { "USD/JPY": { price }, ... }、単一で { price }。
const fetchSpotRates = async (env: Env, pairs: FlowPair[]): Promise<Partial<Record<FlowPair, number>>> => {
  const out: Partial<Record<FlowPair, number>> = {};
  if (pairs.length === 0) return out;
  const url =
    'https://api.twelvedata.com/price' +
    `?symbol=${encodeURIComponent(pairs.join(','))}` +
    `&apikey=${encodeURIComponent(env.TWELVE_DATA_API_KEY)}`;
  const res = await fetch(url);
  const text = await res.text();
  if (!res.ok) throw new Error(`Twelve Data price HTTP ${res.status}: ${text.slice(0, 200)}`);
  const parsed = JSON.parse(text) as Record<string, unknown>;
  if (pairs.length === 1) {
    const p = Number((parsed as { price?: string }).price);
    if (!Number.isNaN(p)) out[pairs[0]] = p;
    return out;
  }
  for (const pair of pairs) {
    const node = parsed[pair] as { price?: string } | undefined;
    const p = Number(node?.price);
    if (!Number.isNaN(p)) out[pair] = p;
  }
  return out;
};

// 建玉情報(PairFlow)を取得して KV にキャッシュする。あわせて合計取引量のピーク
// （記録開始以降の最大 + その日時 + スポットレート）を自前で蓄積する。
// session 切れ時は再ログインして一度だけ再試行。
const updateFlow = async (env: Env): Promise<PairFlow[]> => {
  let symbols: MfbOutlookSymbol[];
  try {
    const cached = await env.STRENGTH_KV.get(KV_MFB_SESSION);
    const session = cached ?? (await myfxbookLogin(env));
    symbols = await fetchOutlook(session);
  } catch {
    // session 無効 or 失効 → 再ログインしてリトライ
    const session = await myfxbookLogin(env);
    symbols = await fetchOutlook(session);
  }

  const byName = new Map(symbols.map((s) => [s.name, s]));

  // 現在の建玉と合計取引量を集計。
  const base: { pair: FlowPair; longPct: number; shortPct: number; longVolume: number; shortVolume: number; total: number }[] =
    [];
  for (const pair of FLOW_PAIRS) {
    const s = byName.get(MFB_SYMBOL[pair]);
    if (!s) continue;
    const longPct = Number(s.longPercentage);
    const shortPct = Number(s.shortPercentage);
    const longVolume = Number(s.longVolume);
    const shortVolume = Number(s.shortVolume);
    if ([longPct, shortPct, longVolume, shortVolume].some((n) => Number.isNaN(n))) continue;
    base.push({ pair, longPct, shortPct, longVolume, shortVolume, total: longVolume + shortVolume });
  }
  if (base.length === 0) throw new Error('建玉データが取得できませんでした');

  // 前回スナップショット(KV_FLOW)を読み、ペアごとの前回合計取引量をマップ化（前回比デルタ用）。
  // 上書き前に読むことで「今回 − 前回」を算出できる。初回は空マップ＝delta無し。
  const prevFlow = JSON.parse((await env.STRENGTH_KV.get(KV_FLOW)) ?? '[]') as PairFlow[];
  const prevTotals = new Map<FlowPair, number>(prevFlow.map((p) => [p.pair, p.longVolume + p.shortVolume]));

  // 既存ピークを読み込み、新ピーク候補を抽出。
  const prevPeaks = JSON.parse((await env.STRENGTH_KV.get(KV_FLOW_PEAKS)) ?? '{}') as Partial<Record<FlowPair, VolumePeak>>;
  const candidates = base
    .filter((b) => b.total > (prevPeaks[b.pair]?.volume ?? -Infinity))
    .sort((a, b) => b.total - a.total)
    .slice(0, MAX_RATE_FETCH); // 分次クレジット制限を超えないよう上限。残りは次回更新で処理。

  // 新ピークのペアだけスポットレートを取得（失敗しても致命的にしない）。
  let rates: Partial<Record<FlowPair, number>> = {};
  if (candidates.length > 0) {
    try {
      rates = await fetchSpotRates(env, candidates.map((c) => c.pair));
    } catch (e) {
      console.error('/flow スポットレート取得 失敗（rate=null で記録）:', e);
    }
  }

  const now = new Date().toISOString();
  const candidateSet = new Set(candidates.map((c) => c.pair));
  const peaks: Partial<Record<FlowPair, VolumePeak>> = { ...prevPeaks };
  for (const c of candidates) {
    peaks[c.pair] = updatePeak(prevPeaks[c.pair], c.total, now, rates[c.pair] ?? null);
  }
  await env.STRENGTH_KV.put(KV_FLOW_PEAKS, JSON.stringify(peaks));

  const result: PairFlow[] = base.map((b) => ({
    ...toPairFlow(b.pair, b.longPct, b.shortPct, b.longVolume, b.shortVolume),
    // 上限超過で今回スキップしたペアも、前回ピークがあれば表示する。
    peak: candidateSet.has(b.pair) ? peaks[b.pair] : prevPeaks[b.pair],
    // 前回スナップショット比の合計取引量の動き（初回は undefined）。
    delta: computeDelta(prevTotals.get(b.pair), b.total),
  }));

  await env.STRENGTH_KV.put(KV_FLOW, JSON.stringify(result));
  return result;
};

// ---------------------------------------------------------------------------
// 投機筋（CFTC COT / Legacy 非商業 Non-Commercial）を取得・キャッシュする
// ---------------------------------------------------------------------------
// CFTC Socrata Open Data API（Legacy Futures-only, resource 6dca-aqww）から
// 各通貨先物＋金＋USDインデックスの非商業ネットを取得し、正規化して KV に保存。
// 週次データ（毎週金曜に火曜時点を発表）のため、毎時 /flow cron では「6h超古い時だけ」更新する。
const CFTC_URL = 'https://publicreporting.cftc.gov/resource/6dca-aqww.json';
const COT_STALE_MS = 6 * 60 * 60 * 1000; // 6時間
const COT_UA = 'Mozilla/5.0 (compatible; lotsizing-cot/1.0)';

// CFTC Legacy コントラクトコード（通貨先物は対USD / 金はCOMEX / USDはICEドル指数）。
const COT_CODE: Record<CotCurrency, string> = {
  JPY: '097741', // JAPANESE YEN - CME
  EUR: '099741', // EURO FX - CME
  GBP: '096742', // BRITISH POUND - CME
  AUD: '232741', // AUSTRALIAN DOLLAR - CME
  NZD: '112741', // NZ DOLLAR - CME
  CAD: '090741', // CANADIAN DOLLAR - CME
  CHF: '092741', // SWISS FRANC - CME
  XAU: '088691', // GOLD - COMEX
  USD: '098662', // USD INDEX - ICE FUTURES U.S.
};

interface CftcRow {
  cftc_contract_market_code: string;
  report_date_as_yyyy_mm_dd: string;
  noncomm_positions_long_all: string;
  noncomm_positions_short_all: string;
  change_in_noncomm_long_all: string;
  change_in_noncomm_short_all: string;
}

// KV に保存する投機筋キャッシュ（通貨別の正規化ネット・当週/前週）。
interface CotCache {
  reportDate: string; // CFTC 報告日（ISO8601・火曜時点）
  updatedAt: string; // Worker が取得した時刻（ISO8601）
  net: Partial<Record<CotCurrency, number>>; // 当週の正規化ネット
  prevNet: Partial<Record<CotCurrency, number>>; // 前週の正規化ネット（change列から復元）
}

// CFTC から対象コントラクトの最新行を取得し、通貨別の正規化ネットに変換する。
const fetchCot = async (): Promise<CotCache> => {
  const codes = Object.values(COT_CODE)
    .map((c) => `'${c}'`)
    .join(',');
  const params = new URLSearchParams({
    $select:
      'cftc_contract_market_code,report_date_as_yyyy_mm_dd,noncomm_positions_long_all,noncomm_positions_short_all,change_in_noncomm_long_all,change_in_noncomm_short_all',
    $where: `cftc_contract_market_code in(${codes})`,
    $order: 'report_date_as_yyyy_mm_dd DESC',
    $limit: '60',
  });
  const res = await fetch(`${CFTC_URL}?${params.toString()}`, { headers: { 'User-Agent': COT_UA } });
  if (!res.ok) throw new Error(`CFTC HTTP ${res.status}`);
  const rows = (await res.json()) as CftcRow[];

  // コードごとに最新行（DESC 並びの先頭）を採用。
  const latest = new Map<string, CftcRow>();
  for (const r of rows) {
    if (!latest.has(r.cftc_contract_market_code)) latest.set(r.cftc_contract_market_code, r);
  }

  const net: Partial<Record<CotCurrency, number>> = {};
  const prevNet: Partial<Record<CotCurrency, number>> = {};
  let reportDate = '';
  for (const [cur, code] of Object.entries(COT_CODE) as [CotCurrency, string][]) {
    const r = latest.get(code);
    if (!r) continue;
    const long = Number(r.noncomm_positions_long_all);
    const short = Number(r.noncomm_positions_short_all);
    if (Number.isNaN(long) || Number.isNaN(short)) continue;
    net[cur] = normalizeNet(long, short);
    const chLong = Number(r.change_in_noncomm_long_all);
    const chShort = Number(r.change_in_noncomm_short_all);
    if (!Number.isNaN(chLong) && !Number.isNaN(chShort)) {
      // 前週 = 当週 − 週次変化（change列）。
      prevNet[cur] = normalizeNet(long - chLong, short - chShort);
    }
    if (!reportDate && r.report_date_as_yyyy_mm_dd) reportDate = r.report_date_as_yyyy_mm_dd;
  }
  if (Object.keys(net).length === 0) throw new Error('CFTC データが取得できませんでした');
  return { reportDate, updatedAt: new Date().toISOString(), net, prevNet };
};

// CFTC を取得して KV に保存する。
const updateCot = async (env: Env): Promise<CotCache> => {
  const cot = await fetchCot();
  await env.STRENGTH_KV.put(KV_COT, JSON.stringify(cot));
  return cot;
};

// COT キャッシュが無い or 6h超古い時だけ再取得する（週次データを安価に鮮度維持）。失敗は非致命的。
const refreshCotIfStale = async (env: Env): Promise<void> => {
  const raw = await env.STRENGTH_KV.get(KV_COT);
  if (raw) {
    try {
      const cur = JSON.parse(raw) as CotCache;
      if (Date.now() - new Date(cur.updatedAt).getTime() < COT_STALE_MS) return;
    } catch {
      // 壊れていれば再取得に進む
    }
  }
  try {
    await updateCot(env);
  } catch (e) {
    console.error('COT 取得 失敗（前回値を保持）:', e);
  }
};

// /flow のレスポンスを組み立てる。未取得なら初回のみ lazy 取得。投機筋(COT)も併せて返す。
const handleFlow = async (env: Env): Promise<Response> => {
  let pairsRaw = await env.STRENGTH_KV.get(KV_FLOW);
  try {
    if (!pairsRaw) pairsRaw = JSON.stringify(await updateFlow(env));
  } catch (e) {
    console.error('/flow lazy取得 失敗:', e);
  }

  if (!pairsRaw) {
    return new Response(
      JSON.stringify({ error: '準備中です。少し待って「更新」を押してください' }),
      { headers: CORS_HEADERS },
    );
  }

  // 投機筋(COT)を読み、無ければ初回のみ lazy 取得。失敗しても建玉情報だけ返す（非致命的）。
  let cot: CotCache | null = null;
  try {
    const cotRaw = (await env.STRENGTH_KV.get(KV_COT)) ?? JSON.stringify(await updateCot(env));
    cot = JSON.parse(cotRaw) as CotCache;
  } catch (e) {
    console.error('/flow COT 取得 失敗:', e);
  }

  const pairs = JSON.parse(pairsRaw) as PairFlow[];
  if (cot) {
    for (const p of pairs) {
      const c = toPairCot(cot.net, cot.prevNet, p.pair);
      if (c) p.cot = c;
    }
  }
  const snapshot: FlowSnapshot = {
    updatedAt: new Date().toISOString(),
    pairs,
    ...(cot ? { cotReportDate: cot.reportDate, cotUpdatedAt: cot.updatedAt } : {}),
  };
  return new Response(JSON.stringify(snapshot), { headers: CORS_HEADERS });
};

// ---------------------------------------------------------------------------
// /news: 為替ニュースの日本語要約＋売買シグナル%（＋反転/継続）
// ---------------------------------------------------------------------------
// FXStreet RSS（主）/ Investing.com（予備）→ Workers AI で要約＆シグナル。
// オンデマンド＋KVに TTL キャッシュ（新 Cron なし）。シグナルはエンジン切替可能。
const KV_NEWS = 'news';
const NEWS_TTL_MS = 60 * 60 * 1000; // 60分
const SUMMARY_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
const SIGNAL_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
const RSS_FEEDS = ['https://www.fxstreet.com/rss/news', 'https://www.investing.com/rss/forex.rss'];
const NEWS_UA = 'Mozilla/5.0 (compatible; lotsizing-news/1.0)';
// 経済指標カレンダー（ForexFactory 週次JSON・キー不要）。High重要度・対象8通貨を加味する。
const ECON_CALENDAR_URL = 'https://nfs.faireconomy.media/ff_calendar_thisweek.json';

interface NewsPayload {
  generatedAt: number;
  engine: string; // 'workers-ai' | 'jev'
  summary: string;
  signals: PairSignal[];
  items: { title: string; link: string; pubDate: string }[];
  calendar: EconEvent[]; // 高重要度の経済指標（今日〜今週・対象8通貨）
}

// 経済指標カレンダーを取得し、High重要度・対象通貨・今日以降に絞って返す。失敗時は空配列。
const fetchEconCalendar = async (): Promise<EconEvent[]> => {
  const res = await fetch(ECON_CALENDAR_URL, { headers: { 'User-Agent': NEWS_UA } });
  if (!res.ok) throw new Error(`経済指標API HTTP ${res.status}`);
  return filterEconEvents(await res.json(), new Date());
};

// RSS を主→予備の順に取得。最初に項目が取れたフィードを採用。
const fetchNewsItems = async (): Promise<NewsItem[]> => {
  for (const url of RSS_FEEDS) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': NEWS_UA } });
      if (!res.ok) continue;
      const items = parseRssItems(await res.text(), 10);
      if (items.length > 0) return items;
    } catch {
      // 次のフィードへ
    }
  }
  throw new Error('ニュースRSSの取得に失敗しました');
};

// Workers AI の応答 response を文字列化（string はそのまま、object は JSON 文字列に）。
const aiText = (r: unknown): string => {
  const resp = (r as { response?: unknown })?.response;
  if (typeof resp === 'string') return resp;
  if (resp == null) return '';
  try {
    return JSON.stringify(resp);
  } catch {
    return '';
  }
};

// Workers AI で日本語要約。econNote（高重要度の経済指標）があれば文脈に加える。
const summarizeNews = async (env: Env, items: NewsItem[], econNote = ''): Promise<string> => {
  const list = items.map((it, i) => `${i + 1}. ${it.title} — ${it.description}`).join('\n');
  const econSection = econNote ? `\n\n# 今週の主要経済指標（高重要度）\n${econNote}` : '';
  const r = await env.AI.run(SUMMARY_MODEL, {
    messages: [
      { role: 'system', content: 'あなたはFXアナリストです。英語の為替ニュースを日本語で簡潔に要約します。' },
      {
        role: 'user',
        content:
          '次の為替ニュースを日本語で要約してください。全体トレンドを2〜3行、続けて主要トピックを3〜5個の箇条書きで。' +
          '直近に高重要度の経済指標の発表予定があれば、その点にも触れてください。断定的な予測は避け、事実ベースで。\n\n' +
          list +
          econSection,
      },
    ],
  });
  return aiText(r).trim();
};

// シグナル算出（Workers AI）: 厳密JSONを要求し、string/object どちらの応答でもパース。
const computeSignalsWorkersAI = async (
  env: Env,
  items: NewsItem[],
  trends: PairTrend[],
  econNote = '',
): Promise<PairSignal[]> => {
  const r = await env.AI.run(SIGNAL_MODEL, {
    messages: [
      { role: 'system', content: 'あなたはFXの短期シグナル推定器です。指示されたJSONのみを厳密に返します。' },
      { role: 'user', content: buildSignalPrompt(items, trends, undefined, econNote) },
    ],
  });
  // response は文字列・オブジェクトどちらでも来得るため、そのまま parse に委ねる。
  return parseSignalResponse((r as { response?: unknown }).response);
};

// シグナル算出（Jev / typesafe.ai）: 1リクエストに state と全ペア×2問(買い/反転継続)を詰める。
// 買い%=Choice{buy,sell} の buy 確率、反転継続=Choice{continuation,reversal,neutral}。
const JEV_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';

const computeSignalsJev = async (
  env: Env,
  items: NewsItem[],
  trends: PairTrend[],
  econEvents: EconEvent[] = [],
): Promise<PairSignal[]> => {
  if (!env.TYPESAFE_API_KEY) throw new Error('SIGNAL_ENGINE=jev ですが TYPESAFE_API_KEY が未設定です');
  const body = { model: 'jev-latest', ...buildJevRequest(items, trends, undefined, econEvents) };
  const res = await fetch(JEV_ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.TYPESAFE_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Jev HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = (await res.json()) as { answers?: Record<string, { choice?: string; probabilities?: Record<string, number>; confidence?: number }> };
  return parseJevAnswers(data.answers);
};

// エンジン切替。SIGNAL_ENGINE=jev のときは Jev を使い、失敗時は Workers AI にフォールバック。
const computeSignals = async (
  env: Env,
  items: NewsItem[],
  trends: PairTrend[],
  calendar: EconEvent[] = [],
): Promise<PairSignal[]> => {
  if (env.SIGNAL_ENGINE === 'jev') {
    try {
      return await computeSignalsJev(env, items, trends, calendar);
    } catch (e) {
      console.error('Jev 失敗 → Workers AI にフォールバック:', e);
    }
  }
  return computeSignalsWorkersAI(env, items, trends, formatEconDigest(calendar));
};

// ニュース取得→要約＆シグナルを算出して KV に保存。
const buildNews = async (env: Env): Promise<NewsPayload> => {
  const items = await fetchNewsItems();

  // 反転/継続判定用の直近トレンドは、強弱用に取得済みの intraday シリーズから求める。
  const intradayRaw = await env.STRENGTH_KV.get(KV_INTRADAY);
  const series = intradayRaw ? (JSON.parse(intradayRaw) as RateSeries) : null;
  const trends = SIGNAL_PAIRS.map((p) => computeRecentTrend(series, p));

  // 経済指標カレンダー（高重要度・今週）。取得失敗は非致命的（空配列）＝要約/シグナルは従来どおり。
  const calendar = await fetchEconCalendar().catch((e) => {
    console.error('/news 経済指標取得失敗:', e);
    return [] as EconEvent[];
  });
  const econNote = formatEconDigest(calendar);

  // 要約とシグナルは独立コール（シグナルだけ後で Jev に差替え可能）。失敗は安全側に倒す。
  const [summary, signals] = await Promise.all([
    summarizeNews(env, items, econNote).catch((e) => {
      console.error('/news 要約失敗:', e);
      return '';
    }),
    computeSignals(env, items, trends, calendar).catch((e) => {
      console.error('/news シグナル失敗:', e);
      return parseSignalResponse(''); // 全ペア中立で返す
    }),
  ]);

  const payload: NewsPayload = {
    generatedAt: Date.now(),
    engine: env.SIGNAL_ENGINE === 'jev' ? 'jev' : 'workers-ai',
    summary,
    signals,
    items: items.map((it) => ({ title: it.title, link: it.link, pubDate: it.pubDate })),
    calendar,
  };
  await env.STRENGTH_KV.put(KV_NEWS, JSON.stringify(payload));
  return payload;
};

// /news: KV が新しければ返す。古い/無ければ再生成。失敗時は古いキャッシュで代替。
const handleNews = async (env: Env): Promise<Response> => {
  const cached = await env.STRENGTH_KV.get(KV_NEWS);
  if (cached) {
    try {
      const p = JSON.parse(cached) as NewsPayload;
      if (Date.now() - p.generatedAt < NEWS_TTL_MS) return new Response(cached, { headers: CORS_HEADERS });
    } catch {
      // 壊れていれば作り直す
    }
  }
  try {
    const payload = await buildNews(env);
    return new Response(JSON.stringify(payload), { headers: CORS_HEADERS });
  } catch (e) {
    console.error('/news 生成失敗:', e);
    if (cached) return new Response(cached, { headers: CORS_HEADERS }); // 古くても返す
    return new Response(JSON.stringify({ error: 'ニュースを準備中です。少し待って更新してください' }), {
      headers: CORS_HEADERS,
    });
  }
};

// ---------------------------------------------------------------------------
// /stoploss: 損切り位置提案＋プライスアクション判定（Yahoo足＋Workers AI＋Jev）
// ---------------------------------------------------------------------------
// Yahoo v8/chart で OHLC ロウソク足＋現在レートを取得→構造(スイング高安/トレンド)から
// 損切り価格を機械算出。プライスアクション分類(反転/戻り売り/押し目買い/レンジ)は Jev、
// 失敗時は Workers AI。相場解説(日本語)は Workers AI。PA＋解説は (ペア,足) 単位で TTL キャッシュ。
const KV_SL_PREFIX = 'sl:';
const SL_TTL_MS = 10 * 60 * 1000; // 10分

interface StopLossPayload {
  instrument: string;
  direction: SlDirection;
  timeframe: SlTimeframe;
  currentRate: number;
  entry: number | null;
  structure: SlStructure;
  stopLoss: SlSuggestion;
  pa: PaResult;
  paEngine: string; // 'jev' | 'workers-ai'
  comment: string;
  generatedAt: number;
}

interface YahooChart {
  chart?: {
    result?: {
      meta?: { regularMarketPrice?: number };
      timestamp?: number[];
      indicators?: {
        quote?: { high?: (number | null)[]; low?: (number | null)[]; close?: (number | null)[]; volume?: (number | null)[] }[];
      };
    }[];
  };
}

const fetchYahooCandles = async (symbol: string, interval: string): Promise<{ candles: Candle[]; currentRate: number }> => {
  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
    `?interval=${encodeURIComponent(interval)}&range=1mo`;
  const res = await fetch(url, { headers: { 'User-Agent': NEWS_UA } });
  if (!res.ok) throw new Error(`Yahoo HTTP ${res.status}`);
  const r = ((await res.json()) as YahooChart).chart?.result?.[0];
  const q = r?.indicators?.quote?.[0];
  const highs = q?.high ?? [];
  const lows = q?.low ?? [];
  const closes = q?.close ?? [];
  const volumes = q?.volume ?? [];
  const times = r?.timestamp ?? [];
  const candles: Candle[] = [];
  for (let i = 0; i < closes.length; i++) {
    const h = highs[i];
    const l = lows[i];
    const c = closes[i];
    if (typeof h === 'number' && typeof l === 'number' && typeof c === 'number') {
      const v = volumes[i];
      const t = times[i];
      candles.push({ high: h, low: l, close: c, volume: typeof v === 'number' ? v : undefined, t: typeof t === 'number' ? t : undefined });
    }
  }
  const currentRate = Number(r?.meta?.regularMarketPrice);
  if (candles.length === 0 || !Number.isFinite(currentRate)) throw new Error('Yahoo: ロウソク足データが不足');
  return { candles, currentRate };
};

// プライスアクション分類（Jev 優先、失敗で Workers AI）。/stoploss と /mtf で共有。
const classifyPa = async (
  env: Env,
  structure: SlStructure,
  recentCloses: number[],
  ctx: PaContext = {}, // セッション状況・出来高の節目・ストキャスティクス等の判定材料
): Promise<{ pa: PaResult; breakout: BreakoutProb | null; paEngine: string }> => {
  try {
    if (!env.TYPESAFE_API_KEY) throw new Error('TYPESAFE_API_KEY 未設定');
    const body = { model: 'jev-latest', ...buildPaJevRequest(structure, recentCloses, ctx) };
    const res = await fetch(JEV_ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.TYPESAFE_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Jev HTTP ${res.status}: ${(await res.text()).slice(0, 150)}`);
    const data = (await res.json()) as { answers?: Record<string, { choice?: string; probabilities?: Record<string, number>; confidence?: number }> };
    // ブレイク確率は Jev のみ（失敗時は null＝判定不可）。
    return { pa: parsePaJev(data.answers), breakout: parseBreakoutJev(data.answers), paEngine: 'jev' };
  } catch (e) {
    console.error('プライスアクション Jev 失敗 → Workers AI:', e);
    const r = await env.AI.run(SIGNAL_MODEL, {
      messages: [
        { role: 'system', content: 'あなたは相場のプライスアクション分類器です。指示されたJSONのみ返します。' },
        { role: 'user', content: buildPaPrompt(structure, recentCloses, ctx) },
      ],
    });
    return { pa: parsePaAi((r as { response?: unknown }).response), breakout: null, paEngine: 'workers-ai' };
  }
};

// プライスアクション分類＋日本語の相場解説（/stoploss 用）。
const computeMarketRead = async (
  env: Env,
  structure: SlStructure,
  recentCloses: number[],
): Promise<{ pa: PaResult; paEngine: string; comment: string }> => {
  const { pa, paEngine } = await classifyPa(env, structure, recentCloses);

  let comment = '';
  try {
    const r = await env.AI.run(SUMMARY_MODEL, {
      messages: [
        { role: 'system', content: 'あなたは日本語で簡潔に相場解説するFXアナリストです。' },
        {
          role: 'user',
          content:
            `トレンド:${structure.trend} / 現在値:${structure.currentRate} / 直近高値:${structure.swingHigh} / 直近安値:${structure.swingLow} / プライスアクション:${pa.pa}。` +
            'この相場観と、損切り設定の考え方（どこまで動いたら想定が崩れ撤退すべきか）を3〜4行の日本語で解説してください。断定や投資助言は避け、参考情報として。',
        },
      ],
    });
    comment = aiText(r).trim();
  } catch (e) {
    console.error('SL 解説生成 失敗:', e);
  }
  return { pa, paEngine, comment };
};

const handleStopLoss = async (env: Env, url: URL): Promise<Response> => {
  const p = url.searchParams;
  const instrument = p.get('instrument') || 'GBP_USD';
  const direction: SlDirection = p.get('direction') === 'short' ? 'short' : 'long';
  const tfRaw = p.get('timeframe') as SlTimeframe | null;
  const timeframe: SlTimeframe = tfRaw && SL_TIMEFRAMES.includes(tfRaw) ? tfRaw : '1h';
  const entryRaw = parseFloat(p.get('entry') || '');
  const entry = Number.isFinite(entryRaw) && entryRaw > 0 ? entryRaw : null;

  const symbol = YAHOO_SYMBOL[instrument];
  if (!symbol) return new Response(JSON.stringify({ error: '未対応のペアです' }), { headers: CORS_HEADERS });

  try {
    const { candles, currentRate } = await fetchYahooCandles(symbol, YAHOO_INTERVAL[timeframe]);
    const structure = computeStructure(candles, currentRate);
    const stopLoss = computeStopLoss(structure, direction, entry, instrument);
    const recentCloses = candles.slice(-12).map((c) => c.close);

    // PA＋解説は (ペア,足) 単位でキャッシュ（Jev/AI 呼び出しを抑制）。SL・現在値は毎回新鮮。
    const key = `${KV_SL_PREFIX}${instrument}:${timeframe}`;
    let read: { pa: PaResult; paEngine: string; comment: string } | null = null;
    const cached = await env.STRENGTH_KV.get(key);
    if (cached) {
      try {
        const c = JSON.parse(cached) as { at: number; read: { pa: PaResult; paEngine: string; comment: string } };
        if (Date.now() - c.at < SL_TTL_MS) read = c.read;
      } catch {
        // 無視して作り直す
      }
    }
    if (!read) {
      read = await computeMarketRead(env, structure, recentCloses);
      await env.STRENGTH_KV.put(key, JSON.stringify({ at: Date.now(), read }));
    }

    const payload: StopLossPayload = {
      instrument,
      direction,
      timeframe,
      currentRate,
      entry,
      structure,
      stopLoss,
      pa: read.pa,
      paEngine: read.paEngine,
      comment: read.comment,
      generatedAt: Date.now(),
    };
    return new Response(JSON.stringify(payload), { headers: CORS_HEADERS });
  } catch (e) {
    console.error('/stoploss 失敗:', e);
    return new Response(JSON.stringify({ error: 'データ取得に失敗しました。少し待って再試行してください' }), {
      headers: CORS_HEADERS,
    });
  }
};

// ---------------------------------------------------------------------------
// /mtf: マルチタイムフレーム分析（15m/30m/1h/4h のトレンド＋PA＋総合）
// ---------------------------------------------------------------------------
const KV_MTF_PREFIX = 'mtf:';
const MTF_TTL_MS = 8 * 60 * 1000; // 8分
const MTF_TIMEFRAMES: SlTimeframe[] = ['15m', '30m', '1h', '4h'];

interface MtfTf {
  tf: SlTimeframe;
  trend: SlStructure['trend'];
  swingHigh: number;
  swingLow: number;
  pa: PaResult['pa'];
  paPct: number;
  confidence: number;
  breakout: BreakoutProb | null; // レンジ上抜け/下抜け/継続の確率（Jev。失敗時 null）
  rr: RrSetup | null; // 上位TFスイングを目標にした RR 評価（上位TFが無い/目標無しは null）
  volumeLevel: number | null; // 過去の高出来高の節目価格（30m/1h=2日前・4h=2週前付近。出来高無し=null）
  stoch: StochReading | null; // ストキャスティクス(%K/%D)。足から自前計算（算出不可は null）
  roleReversal: RoleReversal | null; // ロールリバーサル・ブレイク信用度（0–100・状態・側）。評価不能は null
}
interface MtfPayload {
  instrument: string;
  currentRate: number;
  timeframes: MtfTf[];
  alignment: string;
  comment: string;
  paEngine: string;
  rrOpportunity: (RrSetup & { tf: SlTimeframe }) | null; // 全TFで狙える最良 setup（ポップアップ用）
  sessionOutlook: SessionOutlook | null; // 東京/ロンドン/NY のシナリオ予測（Jev。失敗時 null）
  generatedAt: number;
}

// 各TFの出来高アンカー: 参照する過去時点と前後の窓（ミリ秒）。30m/1h=2日前±12h, 4h=2週前±2日。
const DAY_MS = 86_400_000;
const VOLUME_ANCHOR: Record<SlTimeframe, { agoMs: number; windowMs: number }> = {
  '15m': { agoMs: 2 * DAY_MS, windowMs: 12 * 3_600_000 },
  '30m': { agoMs: 2 * DAY_MS, windowMs: 12 * 3_600_000 },
  '1h': { agoMs: 2 * DAY_MS, windowMs: 12 * 3_600_000 },
  '4h': { agoMs: 14 * DAY_MS, windowMs: 2 * DAY_MS },
};

const buildMtf = async (env: Env, instrument: string): Promise<MtfPayload> => {
  const symbol = YAHOO_SYMBOL[instrument];
  const timeframes: MtfTf[] = [];
  let currentRate = 0;
  let paEngine = 'jev';
  let sessionCloses: number[] = []; // セッション予測用の代表的な終値列（1h優先）
  const sessionStatus = sessionStatusText(new Date()); // 東京/ロンドン/NY の開閉を各TF判定に反映
  const now = Date.now();
  const tfCandles: Candle[][] = []; // ロールリバーサル評価用に各TFの足を保持（index は timeframes と対応）
  for (const tf of MTF_TIMEFRAMES) {
    const { candles, currentRate: cr } = await fetchYahooCandles(symbol, YAHOO_INTERVAL[tf]);
    currentRate = cr;
    tfCandles.push(candles);
    const structure = computeStructure(candles, cr);
    const recentCloses = candles.slice(-12).map((c) => c.close);
    if (tf === '1h' || sessionCloses.length === 0) sessionCloses = recentCloses;
    // 過去時点の高出来高の節目。Jev の判定材料にも含める。
    // XAU(GC=F)はロウソク足に出来高があるのでそのまま。FXスポット(=X)は出来高が無いため、
    // 対応ペアは CME通貨先物から出来高節目を取りスポット目盛りへ変換（クロス円は null のまま）。
    const { agoMs, windowMs } = VOLUME_ANCHOR[tf];
    let volumeLevel = volumeAnchoredLevel(candles, now, agoMs, windowMs);
    if (volumeLevel == null && VOLUME_SYMBOL[instrument]) {
      try {
        const { symbol: vSym, invert } = VOLUME_SYMBOL[instrument];
        const fut = await fetchYahooCandles(vSym, YAHOO_INTERVAL[tf]);
        const futLevel = volumeAnchoredLevel(fut.candles, now, agoMs, windowMs);
        if (futLevel != null) volumeLevel = futuresLevelToSpot(futLevel, fut.currentRate, cr, invert);
      } catch (e) {
        console.error(`/mtf 出来高(先物)取得 失敗 ${instrument} ${tf}:`, e);
      }
    }
    // ストキャスティクス(%K/%D)を足から自前計算（API不要）。Jev の判定材料にも含める。
    const stoch = computeStochastic(candles);
    const { pa, breakout, paEngine: eng } = await classifyPa(env, structure, recentCloses, { sessionStatus, volumeLevel, stoch });
    paEngine = eng;
    timeframes.push({
      tf,
      trend: structure.trend,
      swingHigh: structure.swingHigh,
      swingLow: structure.swingLow,
      pa: pa.pa,
      paPct: pa.paPct,
      confidence: pa.confidence,
      breakout,
      rr: null, // 下の2パス目で算出（上位TFのスイングが必要なため）
      volumeLevel,
      stoch,
      roleReversal: null, // 下の2パス目で算出（上位TFのコンフルエンスが必要なため）
    });
  }

  // RR 評価: 各TFを上位TF（配列後方＝長い足）のスイングを目標に判定し、最良の好機を1件選ぶ。
  let rrOpportunity: (RrSetup & { tf: SlTimeframe }) | null = null;
  timeframes.forEach((t, i) => {
    const structure = { trend: t.trend, swingHigh: t.swingHigh, swingLow: t.swingLow, currentRate };
    // ロールリバーサル・ブレイク信用度（上位TFのスイングをコンフルエンス材料に渡す）。
    const higherLevels = timeframes.slice(i + 1).flatMap((h) => [h.swingHigh, h.swingLow]);
    t.roleReversal = scoreRoleReversal(tfCandles[i], structure, {
      instrument,
      breakout: t.breakout,
      stoch: t.stoch,
      volumeLevel: t.volumeLevel,
      higherLevels,
    });
    // RR 評価（従来どおり・ブレイク方向がある TF のみ）。
    const dir = dirFromBreakout(t.breakout);
    if (!dir) return;
    const higherSwings = timeframes.slice(i + 1).map((h) => ({ swingHigh: h.swingHigh, swingLow: h.swingLow }));
    t.rr = assessRiskReward(structure, dir.direction, dir.prob, higherSwings, instrument);
    if (t.rr?.qualifies && (!rrOpportunity || t.rr.rr > rrOpportunity.rr)) {
      rrOpportunity = { ...t.rr, tf: t.tf };
    }
  });

  const alignment = alignmentLabel(timeframes.map((t) => t.trend));

  // セッション別シナリオ予測: 各TFを統合した相場観で東京/ロンドン/NYを一括判定（Jev 1呼び出し）。
  const top = timeframes[timeframes.length - 1]; // 最上位TF(4h)を代表の相場観に
  const breakoutBias = timeframes
    .map((t) => {
      const d = dirFromBreakout(t.breakout);
      return `${t.tf}:${d ? (d.direction === 'long' ? '上' : '下') : '継続'}`;
    })
    .join(' ');
  const sessionOutlook = await buildSessionOutlook(env, {
    trend: top.trend,
    currentRate,
    swingHigh: top.swingHigh,
    swingLow: top.swingLow,
    alignment,
    breakoutBias,
    recentCloses: sessionCloses,
    sessionStatus: sessionStatusText(new Date()),
  });

  let comment = '';
  try {
    const table = timeframes
      .map((t) => {
        const bk = t.breakout ? ` ブレイク上${t.breakout.up}%/下${t.breakout.down}%/継続${t.breakout.range}%` : '';
        return `${t.tf}: トレンド${t.trend}/PA ${t.pa}(${t.paPct}%)${bk}`;
      })
      .join(' / ');
    const r = await env.AI.run(SUMMARY_MODEL, {
      messages: [
        { role: 'system', content: 'あなたは日本語で簡潔に相場解説するFXアナリストです。' },
        {
          role: 'user',
          content:
            `${instrument} の各タイムフレーム分析（整合:${alignment}）: ${table}。` +
            'これらを統合し、全体の方向性・どの時間軸で反転/継続しそうか・注意点を3〜4行の日本語で解説してください。断定や投資助言は避け、参考情報として。',
        },
      ],
    });
    comment = aiText(r).trim();
  } catch (e) {
    console.error('/mtf 解説生成 失敗:', e);
  }

  return { instrument, currentRate, timeframes, alignment, comment, paEngine, rrOpportunity, sessionOutlook, generatedAt: Date.now() };
};

// セッション別シナリオ予測を Jev で判定（1呼び出しに東京/ロンドン/NYの3問）。未設定/失敗は null。
const buildSessionOutlook = async (env: Env, state: SessionState): Promise<SessionOutlook | null> => {
  try {
    if (!env.TYPESAFE_API_KEY) return null;
    const body = { model: 'jev-latest', ...buildSessionJevRequest(state) };
    const res = await fetch(JEV_ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.TYPESAFE_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Jev HTTP ${res.status}: ${(await res.text()).slice(0, 150)}`);
    const data = (await res.json()) as {
      answers?: Record<string, { choice?: string; probabilities?: Record<string, number>; confidence?: number }>;
    };
    return parseSessionJev(data.answers);
  } catch (e) {
    console.error('/mtf セッション予測 Jev 失敗:', e);
    return null;
  }
};

// ブレイク確率から RR 評価の方向と確率を決める。レンジ継続優勢/未取得は null（方向なし）。
const dirFromBreakout = (bk: BreakoutProb | null): { direction: SlDirection; prob: number } | null => {
  if (!bk) return null;
  const max = Math.max(bk.up, bk.down, bk.range);
  if (max === bk.range) return null;
  return bk.up >= bk.down ? { direction: 'long', prob: bk.up } : { direction: 'short', prob: bk.down };
};

const handleMtf = async (env: Env, url: URL): Promise<Response> => {
  const instrument = url.searchParams.get('instrument') || 'USD_JPY';
  if (!YAHOO_SYMBOL[instrument]) return new Response(JSON.stringify({ error: '未対応のペアです' }), { headers: CORS_HEADERS });

  const key = `${KV_MTF_PREFIX}${instrument}`;
  const cached = await env.STRENGTH_KV.get(key);
  if (cached) {
    try {
      const p = JSON.parse(cached) as MtfPayload;
      if (Date.now() - p.generatedAt < MTF_TTL_MS) return new Response(cached, { headers: CORS_HEADERS });
    } catch {
      // 作り直す
    }
  }
  try {
    const payload = await buildMtf(env, instrument);
    await env.STRENGTH_KV.put(key, JSON.stringify(payload));
    return new Response(JSON.stringify(payload), { headers: CORS_HEADERS });
  } catch (e) {
    console.error('/mtf 失敗:', e);
    if (cached) return new Response(cached, { headers: CORS_HEADERS });
    return new Response(JSON.stringify({ error: 'データ取得に失敗しました。少し待って再試行してください' }), {
      headers: CORS_HEADERS,
    });
  }
};

export default {
  // Cron: event.cron でジョブを出し分け。失敗時は前回値を保持。
  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    let job: (env: Env) => Promise<unknown>;
    switch (event.cron) {
      case '30 0 * * *':
        job = updateDaily; // 日足（年初起点）1日1回
        break;
      case '15 * * * *':
        // /flow の建玉情報（Myfxbook）、毎時。あわせて投機筋(CFTC COT)を stale 時だけ更新。
        job = async (e: Env) => {
          await updateFlow(e);
          await refreshCotIfStale(e);
        };
        break;
      default:
        job = updateIntraday; // '0 */2 * * *' 15分足（4時間前/当日）2時間ごと
    }
    ctx.waitUntil(
      job(env).catch((e) => {
        console.error(`Cron 失敗（前回値を保持）[${event.cron}]:`, e);
      }),
    );
  },

  // クライアント向け: KV の intraday/daily を返す。無ければ初回のみ算出（cold-start解消）。
  // Twelve Data は 8 credits/分の制限があり、8シンボル一括(7ペア+XAU/USD)=8 credits のため、
  // 1リクエストで取得するデータセットは最大1つに絞る（intraday優先）。
  async fetch(req: Request, env: Env): Promise<Response> {
    // CORS プリフライト。
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS_HEADERS });
    // ルーティング: /flow=取引量、/news=ニュース、/stoploss=損切り提案、/mtf=TF分析、他=通貨強弱。
    const reqUrl = new URL(req.url);
    const pathname = reqUrl.pathname;
    if (pathname === '/flow') return handleFlow(env);
    if (pathname === '/news') return handleNews(env);
    if (pathname === '/stoploss') return handleStopLoss(env, reqUrl);
    if (pathname === '/mtf') return handleMtf(env, reqUrl);

    let intradayRaw = await env.STRENGTH_KV.get(KV_INTRADAY);
    let dailyRaw = await env.STRENGTH_KV.get(KV_DAILY);

    try {
      if (!intradayRaw) {
        intradayRaw = JSON.stringify(await updateIntraday(env)); // 8 credits
      } else if (!dailyRaw) {
        dailyRaw = JSON.stringify(await updateDaily(env)); // 8 credits（別リクエストで）
      }
    } catch (e) {
      // lazy取得の失敗（分次レート制限など）は致命的にしない。キャッシュ済み分だけ返す。
      console.error('通貨強弱 lazy取得 失敗:', e);
    }

    if (!intradayRaw && !dailyRaw) {
      return new Response(
        JSON.stringify({ error: '準備中です。少し待って「更新」を押してください' }),
        { headers: CORS_HEADERS },
      );
    }
    const body = `{"computedAt":${Date.now()},"intraday":${intradayRaw ?? 'null'},"daily":${dailyRaw ?? 'null'}}`;
    return new Response(body, { headers: CORS_HEADERS });
  },
};
