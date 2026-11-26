import { describe, it, expect } from 'vitest';
import { SESSION_TTL_SEC, isSessionToken, randomSecret, signSession, verifySession } from '../fundSession';

// 鍵はテストのたびにランダムに作る（固定の値をコードに書かない）
const key = randomSecret();
const user = { sub: 'google-123', email: 'user@example.com' };
const now = 1_800_000_000;

describe('fundSession', () => {
  it('6時間有効な券を作り、その間は確かめられる', async () => {
    const { token, exp } = await signSession(key, user, now);
    expect(exp).toBe(now + 6 * 3600);
    expect(SESSION_TTL_SEC).toBe(6 * 3600);
    expect(isSessionToken(token)).toBe(true);
    expect(await verifySession(key, token, now + 5 * 3600 + 59 * 60)).toEqual({ ...user, exp });
  });

  it('6時間を過ぎたら無効', async () => {
    const { token } = await signSession(key, user, now);
    expect(await verifySession(key, token, now + 6 * 3600)).toBeNull();
  });

  it('鍵が違う・中身を書き換えた券は無効', async () => {
    const { token } = await signSession(key, user, now);
    expect(await verifySession(randomSecret(), token, now)).toBeNull();
    const [p, payload, sig] = token.split('.');
    const forged = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')));
    forged.email = 'attacker@example.com';
    const forgedPayload = btoa(JSON.stringify(forged)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    expect(await verifySession(key, `${p}.${forgedPayload}.${sig}`, now)).toBeNull();
  });

  it('Google の IDトークン（JWT）は券ではない。2番目の部分から email と exp を読める', async () => {
    expect(isSessionToken('eyJhbGciOiJSUzI1NiJ9.eyJlbWFpbCI6IngifQ.sig')).toBe(false);
    const { token } = await signSession(key, user, now);
    const payload = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    expect(payload).toMatchObject({ email: user.email, exp: now + 6 * 3600 });
  });

  it('ランダムな鍵は毎回違う', () => {
    expect(randomSecret()).not.toBe(randomSecret());
  });
});
