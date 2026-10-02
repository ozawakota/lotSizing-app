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
import type { JpyPairCurrency, RateSeries } from '../../src/lib/strength';
// 取引量・センチメント(/flow)のロジック/型もフロントと共有: ../../src/lib/flow.ts
import { FLOW_PAIRS, computeDelta, toPairFlow, updatePeak, type FlowPair, type PairFlow, type VolumePeak } from '../../src/lib/flow';

interface Env {
  TWELVE_DATA_API_KEY: string;
  STRENGTH_KV: KVNamespace;
  // /flow のリテールセンチメント用（Myfxbook 無料アカウント）。wrangler secret で登録。
  MYFXBOOK_EMAIL: string;
  MYFXBOOK_PASSWORD: string;
}

const PAIRS: JpyPairCurrency[] = ['USD', 'EUR', 'GBP', 'AUD', 'NZD', 'CAD', 'CHF'];

const KV_INTRADAY = 'intraday';
const KV_DAILY = 'daily';
// /flow 用のキャッシュキー。
const KV_FLOW = 'flow';
const KV_MFB_SESSION = 'mfb_session';
const KV_FLOW_PEAKS = 'flow_peaks'; // ペアごとの合計取引量ピーク（記録開始以降・自前蓄積）

// 1回の /flow 更新で取得するスポットレートの上限（Twelve Data 8 credits/分 制限の回避）。
const MAX_RATE_FETCH = 7;

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
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

// Twelve Data から7ペアの時系列を一括取得し、datetime で揃えた RateSeries を作る。
const fetchSeries = async (env: Env, interval: string, outputsize: number): Promise<RateSeries> => {
  const symbols = PAIRS.map((c) => `${c}/JPY`);
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

  const rates: Record<JpyPairCurrency, number[]> = {} as Record<JpyPairCurrency, number[]>;
  for (const c of PAIRS) rates[c] = datetimes.map((dt) => maps[c].get(dt) as number);

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

// /flow のレスポンスを組み立てる。未取得なら初回のみ lazy 取得。
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
  const body = `{"updatedAt":"${new Date().toISOString()}","pairs":${pairsRaw}}`;
  return new Response(body, { headers: CORS_HEADERS });
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
        job = updateFlow; // /flow の建玉情報（Myfxbook）、毎時
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
  // Twelve Data は 8 credits/分の制限があり、7ペア一括=7 credits のため、
  // 1リクエストで取得するデータセットは最大1つに絞る（intraday優先）。
  async fetch(req: Request, env: Env): Promise<Response> {
    // /flow は取引量・センチメント。それ以外は従来どおり通貨強弱を返す。
    if (new URL(req.url).pathname === '/flow') return handleFlow(env);

    let intradayRaw = await env.STRENGTH_KV.get(KV_INTRADAY);
    let dailyRaw = await env.STRENGTH_KV.get(KV_DAILY);

    try {
      if (!intradayRaw) {
        intradayRaw = JSON.stringify(await updateIntraday(env)); // 7 credits
      } else if (!dailyRaw) {
        dailyRaw = JSON.stringify(await updateDaily(env)); // 7 credits（別リクエストで）
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
