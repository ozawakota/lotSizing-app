/// <reference types="@cloudflare/workers-types" />
// 資金管理 fund-worker。Google 認証（許可メールのみ）→ Turso にユーザー別で記録。
//
// 認証: フロントの Google IDトークンを Authorization: Bearer で受け、Google JWKS で
//       RS256 署名検証 → ../src/lib/googleAuth の validateGoogleClaims でクレーム検証。
// DB: Turso(libSQL) を @libsql/client/web 経由で操作。全行を user_id(=sub) で分離。
//     口座（?account=real）ごとにも分ける: デモ口座 = sub（これまでの記録）、リアル口座 = `${sub}#real`（../src/lib/fundAccount）。
// 集計: /summary は ../src/lib/fund の computeSummary を共有。
import { createClient, type Client } from '@libsql/client/web';

import { computeSummary, type Cashflow, type FundSettings, type Trade } from '../../src/lib/fund';
import { validateGoogleClaims } from '../../src/lib/googleAuth';
import { verifyGoogleIdToken } from '../../src/lib/googleVerify';
import { isSessionToken, randomSecret, signSession, verifySession } from '../../src/lib/fundSession';
import { parseFundAccount, scopedUserId } from '../../src/lib/fundAccount';

interface Env {
  GOOGLE_CLIENT_ID: string;
  ALLOWED_EMAILS: string;
  TURSO_DATABASE_URL: string;
  TURSO_AUTH_TOKEN: string;
  SESSION_SECRET?: string; // セッション券の署名鍵（任意）。無ければ Turso に自動で作った鍵を使う
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

// Google IDトークン検証（JWKS/RS256）は ../../src/lib/googleVerify に共有抽出。

interface AuthOk {
  userId: string;
  email: string;
  via: 'google' | 'session'; // どちらで認証したか（セッション券の発行は Google ログイン直後だけ）
}

// ---------------------------------------------------------------------------
// ログインセッション（6時間）。Google の IDトークンは1時間で切れるので、Google ログインを確かめたら
// /session で自前の券（../../src/lib/fundSession）を出し、以降はそれで認証する。
// 署名鍵は SESSION_SECRET があればそれ、無ければ初回に Turso の app_secrets に乱数の鍵を作って使う。
// ---------------------------------------------------------------------------
let sessionKeyCache: string | null = null;
const sessionKey = async (env: Env, db: Client): Promise<string> => {
  if (env.SESSION_SECRET) return env.SESSION_SECRET;
  if (sessionKeyCache) return sessionKeyCache;
  await db.execute('CREATE TABLE IF NOT EXISTS app_secrets (name TEXT PRIMARY KEY, value TEXT NOT NULL)');
  // 同時に初回が来ても鍵が1つに決まるよう、INSERT OR IGNORE してから読む
  await db.execute({ sql: 'INSERT OR IGNORE INTO app_secrets (name, value) VALUES (?, ?)', args: ['session_key', randomSecret()] });
  const res = await db.execute({ sql: 'SELECT value FROM app_secrets WHERE name = ?', args: ['session_key'] });
  const v = (res.rows[0] as Row | undefined)?.value;
  if (typeof v !== 'string' || !v) throw new Error('セッションの鍵を用意できませんでした');
  sessionKeyCache = v;
  return v;
};

const isAllowedEmail = (env: Env, email: string): boolean =>
  (env.ALLOWED_EMAILS ?? '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean)
    .includes(email.toLowerCase());

// Bearer トークン（Google の IDトークン、または6時間のセッション券）を検証し userId を返す。失敗時は Response。
const authenticate = async (req: Request, env: Env, db: Client): Promise<AuthOk | Response> => {
  const header = req.headers.get('Authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) return json(401, { error: '未認証' });

  if (isSessionToken(token)) {
    const s = await verifySession(await sessionKey(env, db), token);
    if (!s) return json(401, { error: 'ログインの有効期限が切れました。もう一度ログインしてください' });
    if (!isAllowedEmail(env, s.email)) return json(403, { error: '許可されていないアカウントです' });
    return { userId: s.sub, email: s.email, via: 'session' };
  }

  const claims = await verifyGoogleIdToken(token);
  if (!claims) return json(401, { error: 'トークン検証に失敗しました' });

  const result = validateGoogleClaims(claims, {
    clientId: env.GOOGLE_CLIENT_ID,
    allowedEmails: (env.ALLOWED_EMAILS ?? '').split(','),
  });
  if (!result.ok) return json(403, { error: result.reason });
  return { userId: result.userId, email: result.email, via: 'google' };
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

    const db = dbClient(env);
    let auth: AuthOk | Response;
    try {
      auth = await authenticate(req, env, db);
    } catch (e) {
      console.error('fund-worker 認証エラー:', e);
      return json(500, { error: '認証の処理に失敗しました' });
    }
    if (auth instanceof Response) return auth;

    const url = new URL(req.url);
    const path = url.pathname;
    // 記録の読み書きは口座ごとの user_id で行う（セッション券の発行は Google の sub のまま）
    const userId = scopedUserId(auth.userId, parseFundAccount(url.searchParams.get('account')));

    try {
      // Google ログイン直後に6時間のセッション券を出す（券で券を出し直して期限を延ばすことはできない）
      if (req.method === 'POST' && path === '/session') {
        if (auth.via !== 'google') return json(403, { error: 'セッションの発行には Google ログインが必要です' });
        return json(200, await signSession(await sessionKey(env, db), { sub: auth.userId, email: auth.email }));
      }

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
