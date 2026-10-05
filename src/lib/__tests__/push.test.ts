import { describe, it, expect } from 'vitest';
import { pickNewAlerts, type AlertHistoryItem } from '../push';

const mk = (id: number): AlertHistoryItem => ({
  id,
  pair: 'GBP/JPY',
  title: `t${id}`,
  body: `b${id}`,
  created_at: id,
});

describe('pickNewAlerts', () => {
  it('returns only alerts newer than lastSeenId, oldest-first', () => {
    const alerts = [mk(5), mk(4), mk(3), mk(2)]; // /alerts は新しい順
    expect(pickNewAlerts(alerts, 3).map((a) => a.id)).toEqual([4, 5]);
  });

  it('returns [] when nothing is newer', () => {
    expect(pickNewAlerts([mk(3), mk(2)], 3)).toEqual([]);
  });

  it('returns all when lastSeenId is 0', () => {
    expect(pickNewAlerts([mk(2), mk(1)], 0).map((a) => a.id)).toEqual([1, 2]);
  });
});
