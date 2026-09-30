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

interface Env {
  TWELVE_DATA_API_KEY: string;
  STRENGTH_KV: KVNamespace;
}

const PAIRS: JpyPairCurrency[] = ['USD', 'EUR', 'GBP', 'AUD', 'NZD', 'CAD', 'CHF'];

const KV_INTRADAY = 'intraday';
const KV_DAILY = 'daily';

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

export default {
  // Cron: event.cron で日足/15分足を出し分け。失敗時は前回値を保持。
  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const job = event.cron === '0 0 * * *' ? updateDaily : updateIntraday;
    ctx.waitUntil(
      job(env).catch((e) => {
        console.error('通貨強弱 Cron 失敗（前回値を保持）:', e);
      }),
    );
  },

  // クライアント向け: KV の intraday/daily を返す。無ければ初回のみ算出（cold-start解消）。
  async fetch(_req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      let intradayRaw = await env.STRENGTH_KV.get(KV_INTRADAY);
      let dailyRaw = await env.STRENGTH_KV.get(KV_DAILY);
      if (!intradayRaw) {
        const s = await updateIntraday(env);
        intradayRaw = JSON.stringify(s);
      }
      if (!dailyRaw) {
        const s = await updateDaily(env);
        dailyRaw = JSON.stringify(s);
      }
      ctx.waitUntil(Promise.resolve());
      const body = `{"computedAt":${Date.now()},"intraday":${intradayRaw},"daily":${dailyRaw}}`;
      return new Response(body, { headers: CORS_HEADERS });
    } catch (e) {
      const error = e instanceof Error ? e.message : 'compute failed';
      return new Response(JSON.stringify({ error }), { headers: CORS_HEADERS });
    }
  },
};
