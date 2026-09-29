/// <reference types="@cloudflare/workers-types" />
// 通貨強弱 Cloudflare Worker（Cron + KV キャッシュ）
// 設計: docs/adr/0004-currency-strength-intraday-on-cloudflare-workers.md
//
// - scheduled(): 毎時 Cron。Twelve Data の 1h 時系列（7ペア一括）を取得し、
//   直前の確定クロックアワーで8通貨の強弱を算出して KV にキャッシュする。
// - fetch(): クライアントに KV のスナップショットを JSON(+CORS) で返すだけ。
//
// 計算式はフロントと共有（単一実装）: ../../src/lib/strength.ts
import {
  computeStrengthScores,
  type JpyPairCloses,
  type JpyPairCurrency,
  type StrengthSnapshot,
} from '../../src/lib/strength';

interface Env {
  TWELVE_DATA_API_KEY: string;
  STRENGTH_KV: KVNamespace;
}

const PAIRS: JpyPairCurrency[] = ['USD', 'EUR', 'GBP', 'AUD', 'NZD', 'CAD', 'CHF'];
const KV_KEY = 'snapshot';

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

const toHhmm = (datetime: string): string => datetime.match(/(\d{2}:\d{2})/)?.[1] ?? datetime;

// Twelve Data から7ペアの1時間足（直近2本）を一括取得し、スナップショットを組み立てる。
const computeSnapshot = async (env: Env): Promise<StrengthSnapshot> => {
  const symbols = PAIRS.map((c) => `${c}/JPY`);
  const url =
    'https://api.twelvedata.com/time_series' +
    `?symbol=${encodeURIComponent(symbols.join(','))}` +
    '&interval=1h&outputsize=2&timezone=Asia/Tokyo' +
    `&apikey=${encodeURIComponent(env.TWELVE_DATA_API_KEY)}`;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Twelve Data HTTP ${res.status}`);
  const data = (await res.json()) as Record<string, TwelveDataNode>;

  const start: JpyPairCloses = {};
  const end: JpyPairCloses = {};
  let windowStart = '';
  let windowEnd = '';

  for (const c of PAIRS) {
    const node = data[`${c}/JPY`];
    if (!node || node.status !== 'ok' || !node.values || node.values.length < 2) {
      throw new Error(`系列不足: ${c}/JPY (${node?.message ?? 'no data'})`);
    }
    const e = parseFloat(node.values[0].close); // 最新＝窓終了
    const s = parseFloat(node.values[1].close); // 1本前＝窓開始
    if (Number.isNaN(e) || Number.isNaN(s) || s <= 0) throw new Error(`終値異常: ${c}/JPY`);
    end[c] = e;
    start[c] = s;
    if (!windowStart) {
      windowStart = toHhmm(node.values[1].datetime);
      windowEnd = toHhmm(node.values[0].datetime);
    }
  }

  return { windowStart, windowEnd, computedAt: Date.now(), scores: computeStrengthScores(start, end) };
};

export default {
  // 毎時 Cron。失敗時は前回の KV スナップショットを保持（上書きしない）。
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      (async () => {
        try {
          const snapshot = await computeSnapshot(env);
          await env.STRENGTH_KV.put(KV_KEY, JSON.stringify(snapshot));
        } catch (e) {
          console.error('通貨強弱 Cron 失敗（前回値を保持）:', e);
        }
      })(),
    );
  },

  // クライアント向け: KV のスナップショットを返すだけ。
  async fetch(_req: Request, env: Env): Promise<Response> {
    const cached = await env.STRENGTH_KV.get(KV_KEY);
    const body = cached ?? JSON.stringify({ error: 'no snapshot' });
    return new Response(body, { headers: CORS_HEADERS });
  },
};
