// 資金管理のログインセッション（6時間）。Google の IDトークンは1時間で切れるため、
// fund-worker が Google ログインを確かめたあとに自前のセッション券を出し、以降はそれで認証する。
//
// 券の形: "fs1.<payload>.<署名>"（payload = base64url(JSON {sub, email, exp})、署名 = HMAC-SHA256(鍵, "fs1.<payload>")）。
// payload の位置は Google の IDトークン（JWT）と同じ2番目なので、画面側は同じやり方で email と exp を読める。
// Web Crypto（Workers・ブラウザ・Node 共通）だけを使う純粋な関数。

export const SESSION_PREFIX = 'fs1';
export const SESSION_TTL_SEC = 6 * 60 * 60; // 6時間

export interface SessionClaims {
  sub: string; // Google のユーザーID
  email: string;
  exp: number; // 失効時刻（UNIX 秒）
}

const enc = new TextEncoder();

const b64url = (bytes: Uint8Array): string => {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const fromB64url = (s: string): Uint8Array => {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};

const hmacKey = (secret: string) =>
  crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);

/** セッション券を作る（nowSec から ttlSec 秒有効）。 */
export async function signSession(
  secret: string,
  user: { sub: string; email: string },
  nowSec = Math.floor(Date.now() / 1000),
  ttlSec = SESSION_TTL_SEC,
): Promise<{ token: string; exp: number }> {
  const exp = nowSec + ttlSec;
  const payload = b64url(enc.encode(JSON.stringify({ sub: user.sub, email: user.email, exp } satisfies SessionClaims)));
  const body = `${SESSION_PREFIX}.${payload}`;
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(body)));
  return { token: `${body}.${b64url(sig)}`, exp };
}

/** セッション券か（Google の IDトークンと見分ける）。 */
export const isSessionToken = (token: string): boolean => token.startsWith(`${SESSION_PREFIX}.`);

/** セッション券を確かめる。署名が合わない・形が違う・期限切れなら null。 */
export async function verifySession(secret: string, token: string, nowSec = Math.floor(Date.now() / 1000)): Promise<SessionClaims | null> {
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== SESSION_PREFIX) return null;
  try {
    const ok = await crypto.subtle.verify('HMAC', await hmacKey(secret), fromB64url(parts[2]), enc.encode(`${parts[0]}.${parts[1]}`));
    if (!ok) return null;
    const c = JSON.parse(new TextDecoder().decode(fromB64url(parts[1]))) as Partial<SessionClaims>;
    if (typeof c.sub !== 'string' || typeof c.email !== 'string' || typeof c.exp !== 'number') return null;
    if (c.exp <= nowSec) return null;
    return { sub: c.sub, email: c.email, exp: c.exp };
  } catch {
    return null;
  }
}

/** 署名用のランダムな鍵（32バイト）。 */
export function randomSecret(): string {
  return b64url(crypto.getRandomValues(new Uint8Array(32)));
}
