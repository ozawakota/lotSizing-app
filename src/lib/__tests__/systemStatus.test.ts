import { describe, it, expect } from 'vitest';
import { activeIssues, classifyJevError, clearKinds, MAX_AGE_MS, THROTTLE_MS, unseenCount, upsertIssue, type SystemIssue } from '../systemStatus';

describe('classifyJevError', () => {
  it('402 やクレジット不足の文言は課金', () => {
    expect(classifyJevError(402)).toBe('jev_billing');
    expect(classifyJevError(400, '{"error":"Insufficient credits. Please top up."}')).toBe('jev_billing');
    expect(classifyJevError(429, 'credit balance is too low')).toBe('jev_billing');
  });
  it('401/403 はキー、429 は使用上限、ほかは障害', () => {
    expect(classifyJevError(401, 'unauthorized')).toBe('jev_auth');
    expect(classifyJevError(403)).toBe('jev_auth');
    expect(classifyJevError(429, 'too many requests')).toBe('jev_limit');
    expect(classifyJevError(503, 'service unavailable')).toBe('jev_down');
    expect(classifyJevError(null, 'TypeError: fetch failed')).toBe('jev_down');
  });
});

describe('upsertIssue / clearKinds', () => {
  const t0 = Date.UTC(2026, 10, 17, 0);
  it('新しい種類は保存し、同じ種類は10分以内なら保存しない', () => {
    const a = upsertIssue([], 'jev_billing', 'HTTP 402', t0);
    expect(a.changed).toBe(true);
    expect(a.list[0]).toMatchObject({ kind: 'jev_billing', level: 'error', firstAt: t0, lastAt: t0 });
    const b = upsertIssue(a.list, 'jev_billing', 'HTTP 402', t0 + THROTTLE_MS - 1);
    expect(b.changed).toBe(false);
    const c = upsertIssue(a.list, 'jev_billing', 'HTTP 402 again', t0 + THROTTLE_MS);
    expect(c.changed).toBe(true);
    expect(c.list).toHaveLength(1);
    expect(c.list[0]).toMatchObject({ firstAt: t0, lastAt: t0 + THROTTLE_MS, detail: 'HTTP 402 again' });
  });
  it('解消した種類だけ消す', () => {
    const list = upsertIssue(upsertIssue([], 'jev_limit', 'x', t0).list, 'data_fetch', 'y', t0).list;
    const r = clearKinds(list, ['jev_limit', 'jev_billing']);
    expect(r.changed).toBe(true);
    expect(r.list.map((i) => i.kind)).toEqual(['data_fetch']);
    expect(clearKinds(r.list, ['jev_limit']).changed).toBe(false);
  });
});

describe('activeIssues / unseenCount', () => {
  const now = Date.UTC(2026, 10, 17, 12);
  const mk = (kind: SystemIssue['kind'], level: SystemIssue['level'], lastAt: number): SystemIssue => ({
    kind, level, title: kind, detail: '', firstAt: lastAt, lastAt,
  });
  it('24時間より古い記録は除き、重い順に並べる', () => {
    const list = [mk('jev_down', 'warn', now - 1000), mk('jev_billing', 'error', now - 5000), mk('data_fetch', 'warn', now - MAX_AGE_MS - 1)];
    expect(activeIssues(list, now).map((i) => i.kind)).toEqual(['jev_billing', 'jev_down']);
  });
  it('前に開いたあとに起きた error/warn だけ数える（お知らせは数えない）', () => {
    const list = [mk('jev_billing', 'error', now), mk('jev_down', 'warn', now - 10_000), mk('turso_missing', 'info', now)];
    expect(unseenCount(list, now - 5000)).toBe(1);
    expect(unseenCount(list, 0)).toBe(2);
  });
});
