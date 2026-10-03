/// <reference types="@cloudflare/workers-types" />
// 資金管理 fund-worker。Google 認証（許可メールのみ）→ Turso にユーザー別で記録。
//
// 認証: フロントの Google IDトークンを Authorization: Bearer で受け、Google JWKS で
//       RS256 署名検証 → ../src/lib/googleAuth の validateGoogleClaims でクレーム検証。
// DB: Turso(libSQL) を @libsql/client/web 経由で操作。全行を user_id(=sub) で分離。
// 集計: /summary は ../src/lib/fund の computeSummary を共有。
import { createClient, type Client } from '@libsql/client/web';

import { computeSummary, type Cashflow, type FundSettings, type Trade } from '../../src/lib/fund';
import { validateGoogleClaims, type GoogleClaims } from '../../src/lib/googleAuth';

interface Env {
  GOOGLE_CLIENT_ID: string;
  ALLOWED_EMAILS: string;
  TURSO_DATABASE_URL: string;
  TURSO_AUTH_TOKEN: string;
}

const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
};

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: CORS });

// ---------------------------------------------------------------------------
// Google IDトークン検証（JWKS/RS256）
// ---------------------------------------------------------------------------
const JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
let jwksCache: { keys: JsonWebKey[]; at: number } | null = null;

const b64urlToString = (s: string): string => {
  let t = s.replace(/-/g, '+').replace(/_/g, '/');
  const pad = t.length % 4;
  if (pad) t += '='.repeat(4 - pad);
  return atob(t);
};
const b64urlToBytes = (s: string): Uint8Array => {
  const bin = b64urlToString(s);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
};

const getJwks = async (): Promise<JsonWebKey[]> => {
  if (jwksCache && Date.now() - jwksCache.at < 3600_000) return jwksCache.keys;
  const res = await fetch(JWKS_URL);
  const data = (await res.json()) as { keys: (JsonWebKey & { kid: string })[] };
  jwksCache = { keys: data.keys, at: Date.now() };
  return data.keys;
};

// 署名を検証し、通れば payload(claims) を返す。失敗は null。
const verifyGoogleIdToken = async (token: string): Promise<GoogleClaims | null> => {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [h, p, s] = parts;
  let header: { alg?: string; kid?: string };
  try {
    header = JSON.parse(b64urlToString(h));
  } catch {
    return null;
  }
  if (header.alg !== 'RS256' || !header.kid) return null;

  const keys = await getJwks();
  const jwk = (keys as (JsonWebKey & { kid: string })[]).find((k) => k.kid === header.kid);
  if (!jwk) return null;

  const key = await crypto.subtle.importKey(
    'jwk',
    jwk,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  const ok = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    key,
    b64urlToBytes(s),
    new TextEncoder().encode(`${h}.${p}`),
  );
  if (!ok) return null;

  try {
    return JSON.parse(b64urlToString(p)) as GoogleClaims;
  } catch {
    return null;
  }
};

interface AuthOk {
  userId: string;
  email: string;
}

// Bearer トークンを検証し userId を返す。失敗時は Response（呼び出し側がそのまま返す）。
const authenticate = async (req: Request, env: Env): Promise<AuthOk | Response> => {
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
  return { userId: result.userId, email: result.email };
};

// ---------------------------------------------------------------------------
// Turso
// ---------------------------------------------------------------------------
const dbClient = (env: Env): Client =>
  createClient({ url: env.TURSO_DATABASE_URL, authToken: env.TURSO_AUTH_TOKEN });

type Row = Record<string, unknown>;

const parseTags = (v: unknown): string[] => {
  try {
    const arr = JSON.parse(String(v ?? '[]'));
    return Array.isArray(arr) ? arr.map(String) : [];
  } catch {
    return [];
  }
};

const rowToTrade = (r: Row): Trade => ({
  id: String(r.id),
  date: String(r.date),
  invested: Number(r.invested),
  recovered: Number(r.recovered),
  tags: parseTags(r.tags),
  note: r.note == null ? undefined : String(r.note),
});

const rowToCashflow = (r: Row): Cashflow => ({
  id: String(r.id),
  date: String(r.date),
  type: r.type === 'withdrawal' ? 'withdrawal' : 'deposit',
  amount: Number(r.amount),
  note: r.note == null ? undefined : String(r.note),
});

const loadSettings = async (db: Client, userId: string): Promise<FundSettings> => {
  const res = await db.execute({
    sql: 'SELECT starting_balance, currency FROM settings WHERE user_id = ?',
    args: [userId],
  });
  const r = res.rows[0] as Row | undefined;
  return r
    ? { startingBalance: Number(r.starting_balance), currency: String(r.currency) }
    : { startingBalance: 0, currency: 'JPY' };
};

// ---------------------------------------------------------------------------
// ハンドラ
// ---------------------------------------------------------------------------
const handleGetTrades = async (db: Client, userId: string): Promise<Response> => {
  const res = await db.execute({
    sql: 'SELECT * FROM trades WHERE user_id = ? ORDER BY date ASC, created_at ASC',
    args: [userId],
  });
  return json(200, (res.rows as Row[]).map(rowToTrade));
};

const handlePostTrade = async (db: Client, userId: string, body: Row): Promise<Response> => {
  const id = crypto.randomUUID();
  const tags = Array.isArray(body.tags) ? body.tags.map(String) : [];
  await db.execute({
    sql: 'INSERT INTO trades (id, user_id, date, invested, recovered, tags, note, created_at) VALUES (?,?,?,?,?,?,?,?)',
    args: [
      id,
      userId,
      String(body.date ?? ''),
      Number(body.invested ?? 0),
      Number(body.recovered ?? 0),
      JSON.stringify(tags),
      body.note == null ? null : String(body.note),
      Date.now(),
    ],
  });
  return json(201, { ok: true, id });
};

const handlePostCashflow = async (db: Client, userId: string, body: Row): Promise<Response> => {
  const id = crypto.randomUUID();
  const type = body.type === 'withdrawal' ? 'withdrawal' : 'deposit';
  await db.execute({
    sql: 'INSERT INTO cashflows (id, user_id, date, type, amount, note, created_at) VALUES (?,?,?,?,?,?,?)',
    args: [id, userId, String(body.date ?? ''), type, Number(body.amount ?? 0), body.note == null ? null : String(body.note), Date.now()],
  });
  return json(201, { ok: true, id });
};

const handleGetCashflows = async (db: Client, userId: string): Promise<Response> => {
  const res = await db.execute({
    sql: 'SELECT * FROM cashflows WHERE user_id = ? ORDER BY date ASC, created_at ASC',
    args: [userId],
  });
  return json(200, (res.rows as Row[]).map(rowToCashflow));
};

const handlePutSettings = async (db: Client, userId: string, body: Row): Promise<Response> => {
  await db.execute({
    sql: 'INSERT INTO settings (user_id, starting_balance, currency, updated_at) VALUES (?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET starting_balance = excluded.starting_balance, currency = excluded.currency, updated_at = excluded.updated_at',
    args: [userId, Number(body.startingBalance ?? 0), String(body.currency ?? 'JPY'), Date.now()],
  });
  return json(200, { ok: true });
};

const handleSummary = async (db: Client, userId: string): Promise<Response> => {
  const settings = await loadSettings(db, userId);
  const [tradesRes, cashRes] = await Promise.all([
    db.execute({ sql: 'SELECT * FROM trades WHERE user_id = ?', args: [userId] }),
    db.execute({ sql: 'SELECT * FROM cashflows WHERE user_id = ?', args: [userId] }),
  ]);
  const trades = (tradesRes.rows as Row[]).map(rowToTrade);
  const cashflows = (cashRes.rows as Row[]).map(rowToCashflow);
  return json(200, computeSummary(settings, trades, cashflows));
};

const deleteOwned = async (db: Client, table: 'trades' | 'cashflows', userId: string, id: string): Promise<Response> => {
  await db.execute({ sql: `DELETE FROM ${table} WHERE id = ? AND user_id = ?`, args: [id, userId] });
  return json(200, { ok: true });
};

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });

    const auth = await authenticate(req, env);
    if (auth instanceof Response) return auth;
    const { userId } = auth;

    const url = new URL(req.url);
    const path = url.pathname;
    const db = dbClient(env);

    try {
      if (req.method === 'GET' && path === '/summary') return await handleSummary(db, userId);
      if (req.method === 'GET' && path === '/settings') return json(200, await loadSettings(db, userId));
      if (req.method === 'PUT' && path === '/settings') return await handlePutSettings(db, userId, await req.json());

      if (req.method === 'GET' && path === '/trades') return await handleGetTrades(db, userId);
      if (req.method === 'POST' && path === '/trades') return await handlePostTrade(db, userId, await req.json());

      if (req.method === 'GET' && path === '/cashflows') return await handleGetCashflows(db, userId);
      if (req.method === 'POST' && path === '/cashflows') return await handlePostCashflow(db, userId, await req.json());

      const tradeDel = path.match(/^\/trades\/(.+)$/);
      if (req.method === 'DELETE' && tradeDel) return await deleteOwned(db, 'trades', userId, tradeDel[1]);
      const cashDel = path.match(/^\/cashflows\/(.+)$/);
      if (req.method === 'DELETE' && cashDel) return await deleteOwned(db, 'cashflows', userId, cashDel[1]);

      return json(404, { error: 'not found' });
    } catch (e) {
      console.error('fund-worker エラー:', e);
      return json(500, { error: e instanceof Error ? e.message : 'internal error' });
    }
  },
};
