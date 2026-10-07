/// <reference types="@cloudflare/workers-types" />
// 相場変動通知 Alert Worker（外貨ex 準拠）。
//
// - scheduled(): 毎分 Yahoo Finance(FX3ペア) と gold-api(XAU/USD) から価格を取得し、
//   ペアごとに 15分/25pips を判定（判定ロジックは ../../src/lib/alert.ts を共有）。発火したら
//   alerts に記録し、全購読へ「ペイロードレス Web Push」を送る。
// - fetch(): クライアント向け API。
//     POST /subscribe   … 購読を登録
//     POST /unsubscribe … 購読を解除
//     GET  /recent      … 直近2分のアラート（SW が push 受信時に引く）
//     GET  /alerts?limit=30 … アプリ内「最近のアラート」履歴（新しい順）
//     GET  /vapidPublicKey … VAPID 公開鍵（任意・デバッグ用）
//
// Web Push はペイロード暗号化(RFC8291)を避け、空ボディ＋VAPID署名のみで送信する。
// SW は push 受信をトリガに /recent を取得し、tag=ペア で重複を排除して通知表示する。
import {
  ALERT_PAIRS,
  evaluate,
  formatAlertBody,
  formatAlertTitle,
  type AlertPair,
  type Sample,
} from '../../src/lib/alert';
import {
  computeStructure,
  scanStructuralRr,
  YAHOO_SYMBOL as SL_YAHOO_SYMBOL,
  YAHOO_INTERVAL as SL_YAHOO_INTERVAL,
  type Candle,
  type SlStructure,
  type SlTimeframe,
} from '../../src/lib/stoploss';

interface Env {
  DB: D1Database;
  VAPID_PUBLIC_KEY: string; // var（base64url, 65バイト非圧縮点）
  VAPID_PRIVATE_KEY: string; // secret（base64url, 32バイト d 値）
  VAPID_SUBJECT: string; // var（例 mailto:you@example.com）
}

const RECENT_WINDOW_MS = 15 * 60 * 1000; // /recent が返す直近アラートの範囲（push 配信遅延を吸収）
// 価格取得がこの回数（分）連続で失敗したら「健全性通知」を一度だけ送る。
// 単発の瞬断で誤報しないよう、まとまった障害のみを対象にする。
const FEED_FAIL_ALERT_AFTER = 10;

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
};

// ---------------------------------------------------------------------------
// 価格取得（キーレス無料ソースのハイブリッド）:
//   - FX 3ペア … Yahoo Finance v8/chart の regularMarketPrice（スポット）
//   - XAU/USD  … gold-api.com のスポット金価格（USD/oz）
// OANDA の実 Bid から last/spot 価格に変わるが、しきい値（25pips/$5）は
// スプレッド誤差より十分大きく、変動検知の用途では問題ない。市場休止時は
// 価格が据え置かれ高安差≒0 となり誤発火しない。
// 1ソースでも成功すれば部分結果を返し、全滅時のみ throw（健全性通知の対象）。
// ---------------------------------------------------------------------------
// Yahoo のシンボル（FX のみ。XAU/USD は gold-api を使う）。
const YAHOO_SYMBOL: Partial<Record<AlertPair, string>> = {
  'GBP/JPY': 'GBPJPY=X',
  'AUD/USD': 'AUDUSD=X',
  'GBP/USD': 'GBPUSD=X',
};

// Yahoo は既定の fetch UA だと弾かれることがあるためブラウザ UA を付与。
const UA = 'Mozilla/5.0 (compatible; lotsizing-alert/1.0)';

const fetchYahooPrice = async (symbol: string): Promise<number> => {
  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
    `?interval=1m&range=1d`;
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`Yahoo HTTP ${res.status} (${symbol})`);
  const data = (await res.json()) as {
    chart?: { result?: { meta?: { regularMarketPrice?: number } }[] };
  };
  const price = data.chart?.result?.[0]?.meta?.regularMarketPrice;
  if (typeof price !== 'number' || !Number.isFinite(price)) {
    throw new Error(`Yahoo: price 不正 (${symbol})`);
  }
  return price;
};

const fetchGoldPrice = async (): Promise<number> => {
  const res = await fetch('https://api.gold-api.com/price/XAU');
  if (!res.ok) throw new Error(`GoldAPI HTTP ${res.status}`);
  const data = (await res.json()) as { price?: number };
  const price = Number(data.price);
  if (!Number.isFinite(price) || price <= 0) throw new Error('GoldAPI: price 不正');
  return price;
};

const fetchBids = async (_env: Env): Promise<Partial<Record<AlertPair, number>>> => {
  // 各ペアを並行取得。1つの失敗が他を巻き込まないよう allSettled で集約。
  const tasks = ALERT_PAIRS.map(async (pair): Promise<[AlertPair, number]> => {
    const price = pair === 'XAU/USD'
      ? await fetchGoldPrice()
      : await fetchYahooPrice(YAHOO_SYMBOL[pair]!);
    return [pair, price];
  });
  const results = await Promise.allSettled(tasks);

  const out: Partial<Record<AlertPair, number>> = {};
  const errors: string[] = [];
  for (const r of results) {
    if (r.status === 'fulfilled') out[r.value[0]] = r.value[1];
    else errors.push(String(r.reason));
  }

  // 全ペア失敗（ネットワーク断/全ソース障害）のみ throw → 健全性通知の対象。
  if (Object.keys(out).length === 0) {
    throw new Error(`価格取得が全滅: ${errors.join(' | ').slice(0, 200)}`);
  }
  return out;
};

// ---------------------------------------------------------------------------
// 毎分の検知。失敗したペアは状態を更新せず前回値を保持。
// ---------------------------------------------------------------------------
interface PairStateRow {
  samples: string;
  cooldown_until: number | null;
}

const runDetection = async (env: Env): Promise<void> => {
  const now = Date.now();

  // 価格取得が全滅（ネットワーク断等）した場合のみ健全性通知の対象。
  // 一部ペアのみ失敗した場合は部分結果で継続し、失敗ペアは状態維持。
  let bids: Partial<Record<AlertPair, number>>;
  try {
    bids = await fetchBids(env);
  } catch (e) {
    await recordFeedFailure(env, String(e));
    throw e;
  }
  await clearFeedFailure(env);

  let anyTriggered = false;

  for (const pair of ALERT_PAIRS) {
    const bid = bids[pair];
    if (bid == null) continue; // 取得失敗/市場休止 → 状態維持

    const row = await env.DB.prepare('SELECT samples, cooldown_until FROM pair_state WHERE pair = ?')
      .bind(pair)
      .first<PairStateRow>();
    const samples: Sample[] = row ? (JSON.parse(row.samples) as Sample[]) : [];
    const cooldownUntil = row ? row.cooldown_until : null;

    const r = evaluate({ pair, samples, newSample: { ts: now, bid }, cooldownUntil, now });

    await env.DB.prepare(
      'INSERT INTO pair_state (pair, samples, cooldown_until) VALUES (?, ?, ?) ' +
        'ON CONFLICT(pair) DO UPDATE SET samples = excluded.samples, cooldown_until = excluded.cooldown_until',
    )
      .bind(pair, JSON.stringify(r.samples), r.cooldownUntil)
      .run();

    if (r.triggered) {
      const title = formatAlertTitle(pair, r.high, r.low);
      const body = formatAlertBody(pair, r.high, r.low);
      await env.DB.prepare('INSERT INTO alerts (pair, title, body, created_at) VALUES (?, ?, ?, ?)')
        .bind(pair, title, body, now)
        .run();
      anyTriggered = true;
    }
  }

  if (anyTriggered) await sendPushToAll(env);
};

// ---------------------------------------------------------------------------
// RR≥1:3 構造的好機の検知（Jev不使用・完全無料）。Yahoo足だけで構造的RRを評価し、
// 好機があれば価格アラートと同じ基盤で Push する。15分ごと・クールダウン4時間。
// ---------------------------------------------------------------------------
const RR_INSTRUMENTS = ['XAU_USD', 'USD_JPY', 'EUR_USD', 'GBP_USD'];
const RR_TFS: SlTimeframe[] = ['15m', '30m', '1h', '4h'];
const RR_MIN = 3; // 1:3 以上
const RR_SCAN_INTERVAL_MS = 15 * 60 * 1000; // 走査間隔（毎分 scheduled の中でゲート）
const RR_COOLDOWN_MS = 4 * 60 * 60 * 1000; // 同「ペア＋TF＋方向」の再通知休止
const RR_DISPLAY: Record<string, string> = { XAU_USD: 'XAU/USD', USD_JPY: 'USD/JPY', EUR_USD: 'EUR/USD', GBP_USD: 'GBP/USD' };
const RR_TF_LABEL: Record<SlTimeframe, string> = { '15m': '15分足', '30m': '30分足', '1h': '1時間足', '4h': '4時間足' };

// Yahoo chart から OHLC ロウソク足＋現在値を取得（キーレス）。
const fetchCandles = async (symbol: string, interval: string): Promise<{ candles: Candle[]; currentRate: number }> => {
  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
    `?interval=${encodeURIComponent(interval)}&range=1mo`;
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`Yahoo HTTP ${res.status} (${symbol})`);
  const r = (
    (await res.json()) as {
      chart?: {
        result?: {
          meta?: { regularMarketPrice?: number };
          indicators?: { quote?: { high?: (number | null)[]; low?: (number | null)[]; close?: (number | null)[] }[] };
        }[];
      };
    }
  ).chart?.result?.[0];
  const q = r?.indicators?.quote?.[0];
  const highs = q?.high ?? [];
  const lows = q?.low ?? [];
  const closes = q?.close ?? [];
  const candles: Candle[] = [];
  for (let i = 0; i < closes.length; i++) {
    const h = highs[i];
    const l = lows[i];
    const c = closes[i];
    if (typeof h === 'number' && typeof l === 'number' && typeof c === 'number') candles.push({ high: h, low: l, close: c });
  }
  const currentRate = Number(r?.meta?.regularMarketPrice);
  if (candles.length === 0 || !Number.isFinite(currentRate)) throw new Error(`Yahoo: 足不足 (${symbol})`);
  return { candles, currentRate };
};

const runRrDetection = async (env: Env): Promise<void> => {
  const now = Date.now();
  // 15分ゲート（毎分 scheduled されても走査は15分に1回）。
  const last = Number((await getMeta(env, 'rr_last_run')) ?? '0');
  if (now - last < RR_SCAN_INTERVAL_MS) return;
  await setMeta(env, 'rr_last_run', String(now));

  let anyTriggered = false;
  for (const inst of RR_INSTRUMENTS) {
    try {
      const symbol = SL_YAHOO_SYMBOL[inst];
      if (!symbol) continue;
      const tfStructures: { tf: SlTimeframe; structure: SlStructure }[] = [];
      for (const tf of RR_TFS) {
        const { candles, currentRate } = await fetchCandles(symbol, SL_YAHOO_INTERVAL[tf]);
        tfStructures.push({ tf, structure: computeStructure(candles, currentRate) });
      }
      const best = scanStructuralRr(tfStructures, inst, RR_MIN);
      if (!best) continue;

      // クールダウン判定（同 ペア＋TF＋方向 は RR_COOLDOWN_MS 再通知しない）。
      const cdKey = `rr_cd:${inst}:${best.tf}:${best.direction}`;
      const cdUntil = Number((await getMeta(env, cdKey)) ?? '0');
      if (now < cdUntil) continue;

      const disp = RR_DISPLAY[inst] ?? inst;
      const dirJa = best.direction === 'long' ? 'ロング' : 'ショート';
      const title = `${disp} RR好機 1:${best.rr.toFixed(1)}`;
      const body = `${RR_TF_LABEL[best.tf]} ${dirJa}／リスク${best.riskPips}pips・リワード${best.rewardPips}pips が狙えます`;
      // pair 欄に "RR:" を付け、価格アラート(tag=pair)と別タグにして通知が衝突しないようにする。
      await env.DB.prepare('INSERT INTO alerts (pair, title, body, created_at) VALUES (?, ?, ?, ?)')
        .bind(`RR:${disp}`, title, body, now)
        .run();
      await setMeta(env, cdKey, String(now + RR_COOLDOWN_MS));
      anyTriggered = true;
    } catch (e) {
      console.error(`RR検知 失敗 ${inst}:`, e);
    }
  }
  if (anyTriggered) await sendPushToAll(env, true); // RR有効の購読のみへ
};

// ---------------------------------------------------------------------------
// フィード健全性（連続失敗の検知 → 自分へ通知）。meta テーブルに状態を保持。
// ---------------------------------------------------------------------------
const getMeta = async (env: Env, key: string): Promise<string | null> => {
  const row = await env.DB.prepare('SELECT value FROM meta WHERE key = ?').bind(key).first<{ value: string }>();
  return row ? row.value : null;
};

const setMeta = async (env: Env, key: string, value: string): Promise<void> => {
  await env.DB.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .bind(key, value)
    .run();
};

// 取得失敗を記録。連続 FEED_FAIL_ALERT_AFTER 回で健全性通知を一度だけ送る。
const recordFeedFailure = async (env: Env, detail: string): Promise<void> => {
  const count = Number((await getMeta(env, 'feed_fail_count')) ?? '0') + 1;
  await setMeta(env, 'feed_fail_count', String(count));
  const alerted = (await getMeta(env, 'feed_alerted')) === '1';
  if (count >= FEED_FAIL_ALERT_AFTER && !alerted) {
    await env.DB.prepare('INSERT INTO alerts (pair, title, body, created_at) VALUES (?, ?, ?, ?)')
      .bind(
        'system',
        '通知システムの不調',
        '相場変動通知のデータ取得に失敗しています。価格ソース（Yahoo/gold-api）の稼働状況を確認してください。',
        Date.now(),
      )
      .run();
    await sendPushToAll(env);
    await setMeta(env, 'feed_alerted', '1');
  }
  console.error(`価格取得失敗（${count}回連続）: ${detail}`);
};

// 取得成功時に失敗状態をリセット（不要な書込は避ける）。
const clearFeedFailure = async (env: Env): Promise<void> => {
  const count = await getMeta(env, 'feed_fail_count');
  if (count && count !== '0') await setMeta(env, 'feed_fail_count', '0');
  if ((await getMeta(env, 'feed_alerted')) === '1') await setMeta(env, 'feed_alerted', '0');
};

// ---------------------------------------------------------------------------
// Web Push（ペイロードレス・VAPID署名）。失効した購読は削除する。
// ---------------------------------------------------------------------------
interface SubscriptionRow {
  endpoint: string;
}

// onlyRrEnabled=true のときは rr_enabled=1 の購読にのみ送る（RR好機通知用）。
const sendPushToAll = async (env: Env, onlyRrEnabled = false): Promise<void> => {
  const sql = onlyRrEnabled
    ? 'SELECT endpoint FROM subscriptions WHERE rr_enabled = 1'
    : 'SELECT endpoint FROM subscriptions';
  const subs = await env.DB.prepare(sql).all<SubscriptionRow>();
  for (const sub of subs.results ?? []) {
    try {
      const aud = new URL(sub.endpoint).origin;
      const jwt = await makeVapidJwt(env, aud);
      const res = await fetch(sub.endpoint, {
        method: 'POST',
        headers: {
          TTL: '1800', // 端末オフライン/doze を跨いでも push サービスが30分保持
          Authorization: `vapid t=${jwt}, k=${env.VAPID_PUBLIC_KEY}`,
        },
      });
      if (res.status === 404 || res.status === 410) {
        await env.DB.prepare('DELETE FROM subscriptions WHERE endpoint = ?').bind(sub.endpoint).run();
      }
    } catch (e) {
      console.error('push 送信失敗:', e);
    }
  }
};

// VAPID の ES256 JWT を Web Crypto で署名して返す。
const makeVapidJwt = async (env: Env, audience: string): Promise<string> => {
  const header = strToB64url(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const payload = strToB64url(
    JSON.stringify({
      aud: audience,
      exp: Math.floor(Date.now() / 1000) + 12 * 3600,
      sub: env.VAPID_SUBJECT,
    }),
  );
  const unsigned = `${header}.${payload}`;
  const key = await importVapidPrivateKey(env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY);
  const sig = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    new TextEncoder().encode(unsigned),
  );
  // Web Crypto の ECDSA 署名は raw r||s（64バイト）＝ JWT が要求する形式そのまま。
  return `${unsigned}.${bytesToB64url(new Uint8Array(sig))}`;
};

// web-push 形式の鍵（公開=65バイト非圧縮点, 秘密=32バイト d）を JWK にして取り込む。
const importVapidPrivateKey = (publicB64: string, privateB64: string): Promise<CryptoKey> => {
  const pub = b64urlToBytes(publicB64); // 0x04 || X(32) || Y(32)
  const d = privateB64;
  const x = bytesToB64url(pub.slice(1, 33));
  const y = bytesToB64url(pub.slice(33, 65));
  return crypto.subtle.importKey(
    'jwk',
    { kty: 'EC', crv: 'P-256', x, y, d, ext: true },
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  );
};

// ---------------------------------------------------------------------------
// base64url ヘルパ
// ---------------------------------------------------------------------------
const b64urlToBytes = (input: string): Uint8Array => {
  let s = input.replace(/-/g, '+').replace(/_/g, '/');
  const pad = s.length % 4;
  if (pad) s += '='.repeat(4 - pad);
  const bin = atob(s);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
};

const bytesToB64url = (bytes: Uint8Array): string => {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

const strToB64url = (str: string): string => bytesToB64url(new TextEncoder().encode(str));

// ---------------------------------------------------------------------------
// クライアント向け API
// ---------------------------------------------------------------------------
interface SubscribeBody {
  endpoint?: string;
  keys?: { p256dh?: string; auth?: string };
  rrEnabled?: boolean; // RR好機通知を受け取るか（省略時 true）
}

const handleSubscribe = async (req: Request, env: Env): Promise<Response> => {
  const body = (await req.json()) as SubscribeBody;
  if (!body.endpoint || !body.keys?.p256dh || !body.keys?.auth) {
    return new Response(JSON.stringify({ error: 'invalid subscription' }), { status: 400, headers: CORS_HEADERS });
  }
  const rr = body.rrEnabled === false ? 0 : 1;
  await env.DB.prepare(
    'INSERT INTO subscriptions (endpoint, p256dh, auth, created_at, rr_enabled) VALUES (?, ?, ?, ?, ?) ' +
      'ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth, rr_enabled = excluded.rr_enabled',
  )
    .bind(body.endpoint, body.keys.p256dh, body.keys.auth, Date.now(), rr)
    .run();
  return new Response(JSON.stringify({ ok: true }), { headers: CORS_HEADERS });
};

// RR好機通知の購読ごと ON/OFF を更新（トグル用。購読自体は維持）。
const handleRrPref = async (req: Request, env: Env): Promise<Response> => {
  const body = (await req.json()) as { endpoint?: string; enabled?: boolean };
  if (!body.endpoint) {
    return new Response(JSON.stringify({ error: 'endpoint required' }), { status: 400, headers: CORS_HEADERS });
  }
  await env.DB.prepare('UPDATE subscriptions SET rr_enabled = ? WHERE endpoint = ?')
    .bind(body.enabled === false ? 0 : 1, body.endpoint)
    .run();
  return new Response(JSON.stringify({ ok: true }), { headers: CORS_HEADERS });
};

const handleUnsubscribe = async (req: Request, env: Env): Promise<Response> => {
  const body = (await req.json()) as { endpoint?: string };
  if (!body.endpoint) {
    return new Response(JSON.stringify({ error: 'endpoint required' }), { status: 400, headers: CORS_HEADERS });
  }
  await env.DB.prepare('DELETE FROM subscriptions WHERE endpoint = ?').bind(body.endpoint).run();
  return new Response(JSON.stringify({ ok: true }), { headers: CORS_HEADERS });
};

const handleRecent = async (env: Env): Promise<Response> => {
  const since = Date.now() - RECENT_WINDOW_MS;
  const rows = await env.DB.prepare(
    'SELECT id, pair, title, body FROM alerts WHERE created_at >= ? ORDER BY created_at ASC',
  )
    .bind(since)
    .all<{ id: number; pair: string; title: string | null; body: string }>();
  return new Response(JSON.stringify(rows.results ?? []), { headers: CORS_HEADERS });
};

// アプリ内「最近のアラート」履歴。新しい順に最大 limit 件（既定30・上限100）。
const handleAlerts = async (env: Env, url: URL): Promise<Response> => {
  const n = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '30', 10) || 30, 1), 100);
  const rows = await env.DB.prepare(
    'SELECT id, pair, title, body, created_at FROM alerts ORDER BY created_at DESC LIMIT ?',
  )
    .bind(n)
    .all<{ id: number; pair: string; title: string | null; body: string; created_at: number }>();
  return new Response(JSON.stringify(rows.results ?? []), { headers: CORS_HEADERS });
};

export default {
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      (async () => {
        try {
          await runDetection(env); // 相場変動（毎分）
        } catch (e) {
          console.error('検知 失敗（前回状態を保持）:', e);
        }
        try {
          await runRrDetection(env); // RR好機（15分ゲート・完全無料）
        } catch (e) {
          console.error('RR検知 失敗:', e);
        }
      })(),
    );
  },

  async fetch(req: Request, env: Env): Promise<Response> {
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS_HEADERS });
    const { pathname } = new URL(req.url);

    if (req.method === 'POST' && pathname === '/subscribe') return handleSubscribe(req, env);
    if (req.method === 'POST' && pathname === '/unsubscribe') return handleUnsubscribe(req, env);
    if (req.method === 'POST' && pathname === '/rr-pref') return handleRrPref(req, env);
    if (req.method === 'GET' && pathname === '/recent') return handleRecent(env);
    if (req.method === 'GET' && pathname === '/alerts') return handleAlerts(env, new URL(req.url));
    if (req.method === 'GET' && pathname === '/vapidPublicKey') {
      return new Response(JSON.stringify({ publicKey: env.VAPID_PUBLIC_KEY }), { headers: CORS_HEADERS });
    }
    return new Response(JSON.stringify({ error: 'not found' }), { status: 404, headers: CORS_HEADERS });
  },
};
