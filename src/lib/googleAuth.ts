// Google ID トークンの「クレーム検証」純ロジック（署名検証後に使う）。
// 署名(RS256/JWKS)の検証はランタイム側(fund-worker)で行い、ここでは aud/iss/exp/
// email_verified/許可リスト/sub をチェックする。純関数なのでテスト可能。

export interface GoogleClaims {
  iss?: string;
  aud?: string;
  sub?: string;
  email?: string;
  email_verified?: boolean | string;
  exp?: number; // 秒
}

export interface AuthConfig {
  clientId: string;
  allowedEmails: string[];
  nowMs?: number; // 省略時は Date.now()
}

export type AuthResult =
  | { ok: true; userId: string; email: string }
  | { ok: false; reason: string };

const VALID_ISS = ['accounts.google.com', 'https://accounts.google.com'];

export function validateGoogleClaims(claims: GoogleClaims, config: AuthConfig): AuthResult {
  const now = config.nowMs ?? Date.now();

  if (!claims.iss || !VALID_ISS.includes(claims.iss)) return { ok: false, reason: 'iss 不正' };
  if (!claims.aud || claims.aud !== config.clientId) return { ok: false, reason: 'aud 不一致' };
  if (!claims.exp || claims.exp * 1000 <= now) return { ok: false, reason: 'トークン期限切れ' };

  const verified = claims.email_verified === true || claims.email_verified === 'true';
  if (!verified) return { ok: false, reason: 'email 未確認' };

  const email = (claims.email ?? '').toLowerCase();
  const allowed = config.allowedEmails.map((e) => e.trim().toLowerCase()).filter(Boolean);
  if (!email || !allowed.includes(email)) return { ok: false, reason: '許可されていないメール' };

  if (!claims.sub) return { ok: false, reason: 'sub 欠落' };

  return { ok: true, userId: claims.sub, email };
}
