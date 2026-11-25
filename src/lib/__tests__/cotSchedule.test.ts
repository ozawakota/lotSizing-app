import { describe, it, expect } from 'vitest';
import { cotIsBehind, expectedCotReportDate } from '../flow';

// CFTC は毎週金曜 15:30（米東部）に火曜時点の建玉を公表する。
describe('expectedCotReportDate', () => {
  it('週の途中は、先週金曜に発表された火曜が最新', () => {
    expect(expectedCotReportDate(new Date('2026-11-25T12:00:00Z'))).toBe('2026-11-17'); // 水曜
  });

  it('金曜は 15:30（米東部）の発表を境に切り替わる（冬時間 UTC−5）', () => {
    expect(expectedCotReportDate(new Date('2026-11-27T20:29:00Z'))).toBe('2026-11-17'); // 15:29 EST
    expect(expectedCotReportDate(new Date('2026-11-27T20:30:00Z'))).toBe('2026-11-24'); // 15:30 EST
  });

  it('夏時間（UTC−4）でも米東部の 15:30 で切り替わる', () => {
    expect(expectedCotReportDate(new Date('2026-07-10T19:29:00Z'))).toBe('2026-06-30'); // 15:29 EDT
    expect(expectedCotReportDate(new Date('2026-07-10T19:31:00Z'))).toBe('2026-07-07'); // 15:31 EDT
  });

  it('土曜（日本時間の朝）は、前日の金曜に発表された週', () => {
    expect(expectedCotReportDate(new Date('2026-11-28T00:00:00Z'))).toBe('2026-11-24');
  });
});

describe('cotIsBehind', () => {
  const sat = new Date('2026-11-28T00:00:00Z'); // 11/24 時点が発表済み
  it('発表済みの最新より古ければ true、同じなら false', () => {
    expect(cotIsBehind('2026-11-17T00:00:00.000', sat)).toBe(true);
    expect(cotIsBehind('2026-11-24T00:00:00.000', sat)).toBe(false);
  });
  it('報告日が無ければ古い扱い', () => {
    expect(cotIsBehind(undefined, sat)).toBe(true);
  });
});
