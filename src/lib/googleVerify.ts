// Google IDトークンの署名検証（JWKS / RS256）。Cloudflare Worker 実行環境の Web Crypto で動く。
// fund-worker / mt5-worker など複数の worker で共有する（認証実装を一本化）。
// クレーム検証（aud/iss/exp/email 許可）は googleAuth.ts の validateGoogleClaims に委ねる。
import type { GoogleClaims } from './googleAuth';

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

// 署名を検証し、通れば payload(claims) を返す。失敗は null（クレーム妥当性は別途検証すること）。
export const verifyGoogleIdToken = async (token: string): Promise<GoogleClaims | null> => {
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
