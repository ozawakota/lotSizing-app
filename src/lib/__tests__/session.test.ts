import { describe, it, expect } from 'vitest';
import { MARKET_SESSIONS, isSessionOpen, sessionStatusText } from '../session';

const tokyo = MARKET_SESSIONS[0];

describe('isSessionOpen', () => {
  it('東京は平日の現地日中(=JST)に開場', () => {
    // 2026-01-05(月) 03:00 UTC = 12:00 JST → 東京(9-18)は開場
    expect(isSessionOpen(tokyo, new Date('2026-01-05T03:00:00Z'))).toBe(true);
  });

  it('東京は平日でも現地早朝は閉場', () => {
    // 2026-01-04(日) 23:00 UTC = 2026-01-05(月) 08:00 JST → 開場前(9時前)で閉場
    expect(isSessionOpen(tokyo, new Date('2026-01-04T23:00:00Z'))).toBe(false);
  });

  it('週末は閉場', () => {
    // 2026-01-03(土) 03:00 UTC = 12:00 JST(土) → 週末で閉場
    expect(isSessionOpen(tokyo, new Date('2026-01-03T03:00:00Z'))).toBe(false);
  });
});

describe('sessionStatusText', () => {
  it('現在時刻JSTと各セッションの開閉を含む', () => {
    const txt = sessionStatusText(new Date('2026-01-05T03:00:00Z'));
    expect(txt).toContain('市場セッション');
    expect(txt).toContain('JST');
    expect(txt).toContain('東京:開場中');
    expect(txt).toContain('ロンドン:');
    expect(txt).toContain('ニューヨーク:');
  });
});
