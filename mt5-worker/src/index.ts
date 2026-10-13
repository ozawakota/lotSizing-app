/// <reference types="@cloudflare/workers-types" />
// MT5 監視 worker。Google 認証（許可メールのみ）→ mt5-sync Turso を読んで /state を返す。
//
// 認証: フロントの Google IDトークンを Authorization: Bearer で受け、googleVerify で
//       RS256 署名検証 → googleAuth の validateGoogleClaims でクレーム検証（fund-worker と共有）。
// DB: Turso(libSQL) を @libsql/client/web 経由で読み取り（書き込みはしない）。
// 型/集計はフロントと共有: ../../src/lib/mt5.ts。
import { createClient, type Client } from '@libsql/client/web';

import { validateGoogleClaims } from '../../src/lib/googleAuth';
import { verifyGoogleIdToken } from '../../src/lib/googleVerify';
import type { Mt5Account, Mt5Deal, Mt5Position, Mt5State } from '../../src/lib/mt5';

interface Env {
  GOOGLE_CLIENT_ID: string;
  ALLOWED_EMAILS: string;
  TURSO_DATABASE_URL: string;
  TURSO_AUTH_TOKEN: string;
}

const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
};

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: CORS });

// Bearer トークンを検証（署名＋クレーム＋許可メール）。失敗時は Response を返す。
const authenticate = async (req: Request, env: Env): Promise<true | Response> => {
  const header = req.headers.get('Authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) return json(401, { error: '未認証' });
  const claims = await verifyGoogleIdToken(token);
  if (!claims) return json(401, { error: 'トークン検証に失敗しました' });
  const result = validateGoogleClaims(claims, {
    clientId: env.GOOGLE_CLIENT_ID,
    allowedEmails: (env.ALLOWED_EMAILS ?? '').split(','),
  });
  if (!result.ok) return json(403, { error: result.reason });
  return true;
};

type Row = Record<string, unknown>;
const num = (v: unknown): number => (v == null ? 0 : Number(v));
const str = (v: unknown): string => (v == null ? '' : String(v));

const toAccount = (r: Row): Mt5Account => ({
  login: num(r.login), broker: str(r.broker), currency: str(r.currency), leverage: num(r.leverage),
  balance: num(r.balance), equity: num(r.equity), margin: num(r.margin), margin_free: num(r.margin_free),
  margin_level: num(r.margin_level), profit: num(r.profit), updated_at: num(r.updated_at),
});
const toPosition = (r: Row): Mt5Position => ({
  ticket: num(r.ticket), login: num(r.login), symbol: str(r.symbol), type: str(r.type), volume: num(r.volume),
  price_open: num(r.price_open), sl: num(r.sl), tp: num(r.tp), price_current: num(r.price_current),
  profit: num(r.profit), swap: num(r.swap), time_open: num(r.time_open), updated_at: num(r.updated_at),
});
const toDeal = (r: Row): Mt5Deal => ({
  deal_id: num(r.deal_id), login: num(r.login), order_id: num(r.order_id), position_id: num(r.position_id),
  symbol: str(r.symbol), type: str(r.type), entry: str(r.entry), volume: num(r.volume), price: num(r.price),
  profit: num(r.profit), commission: num(r.commission), swap: num(r.swap), time: num(r.time), comment: str(r.comment),
});

// mt5-sync を読み、監視用の状態を組み立てる。口座は最新更新の1件、約定は直近100件。
const handleState = async (env: Env): Promise<Response> => {
  const db: Client = createClient({ url: env.TURSO_DATABASE_URL, authToken: env.TURSO_AUTH_TOKEN });
  const [acc, pos, dls] = await Promise.all([
    db.execute('SELECT * FROM accounts ORDER BY updated_at DESC LIMIT 1'),
    db.execute('SELECT * FROM positions ORDER BY profit ASC'),
    db.execute('SELECT * FROM deals ORDER BY time DESC LIMIT 100'),
  ]);
  const state: Mt5State = {
    account: acc.rows.length ? toAccount(acc.rows[0] as Row) : null,
    positions: (pos.rows as unknown as Row[]).map(toPosition),
    deals: (dls.rows as unknown as Row[]).map(toDeal),
  };
  return json(200, state);
};

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
    const auth = await authenticate(req, env);
    if (auth !== true) return auth;

    const { pathname } = new URL(req.url);
    if (pathname === '/state' || pathname === '/') {
      try {
        return await handleState(env);
      } catch (e) {
        return json(502, { error: e instanceof Error ? e.message : 'DB読取に失敗しました' });
      }
    }
    return json(404, { error: 'not found' });
  },
};
