import { describe, it, expect } from 'vitest';
import { validateGoogleClaims, type GoogleClaims } from '../googleAuth';

const CFG = { clientId: 'client-123', allowedEmails: ['me@gmail.com'], nowMs: 1_000_000_000_000 };

const base = (): GoogleClaims => ({
  iss: 'https://accounts.google.com',
  aud: 'client-123',
  sub: 'user-sub-1',
  email: 'me@gmail.com',
  email_verified: true,
  exp: Math.floor(CFG.nowMs / 1000) + 3600,
});

describe('validateGoogleClaims', () => {
  it('正当なトークンを受理し userId/email を返す', () => {
    const r = validateGoogleClaims(base(), CFG);
    expect(r).toEqual({ ok: true, userId: 'user-sub-1', email: 'me@gmail.com' });
  });

  it('email_verified が文字列 "true" でも受理', () => {
    const r = validateGoogleClaims({ ...base(), email_verified: 'true' }, CFG);
    expect(r.ok).toBe(true);
  });

  it('aud 不一致は拒否', () => {
    expect(validateGoogleClaims({ ...base(), aud: 'other' }, CFG).ok).toBe(false);
  });

  it('iss 不正は拒否', () => {
    expect(validateGoogleClaims({ ...base(), iss: 'evil.com' }, CFG).ok).toBe(false);
  });

  it('期限切れは拒否', () => {
    expect(validateGoogleClaims({ ...base(), exp: Math.floor(CFG.nowMs / 1000) - 1 }, CFG).ok).toBe(false);
  });

  it('許可リスト外のメールは拒否（大小文字無視）', () => {
    expect(validateGoogleClaims({ ...base(), email: 'other@gmail.com' }, CFG).ok).toBe(false);
    expect(validateGoogleClaims({ ...base(), email: 'ME@GMAIL.COM' }, CFG).ok).toBe(true);
  });

  it('email 未確認は拒否', () => {
    expect(validateGoogleClaims({ ...base(), email_verified: false }, CFG).ok).toBe(false);
  });
});
