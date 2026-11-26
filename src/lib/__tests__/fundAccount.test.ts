import { describe, it, expect } from 'vitest';
import { parseFundAccount, scopedUserId, withAccount } from '../fundAccount';

describe('fundAccount', () => {
  it('real 以外は demo（未指定・不正値も）', () => {
    expect(parseFundAccount('real')).toBe('real');
    expect(parseFundAccount('demo')).toBe('demo');
    expect(parseFundAccount(null)).toBe('demo');
    expect(parseFundAccount('REAL')).toBe('demo');
  });

  it('demo はこれまでの user_id のまま、real は別の user_id', () => {
    expect(scopedUserId('123', 'demo')).toBe('123');
    expect(scopedUserId('123', 'real')).toBe('123#real');
  });

  it('API のパス: demo はそのまま、real は ?account=real を付ける', () => {
    expect(withAccount('/trades', 'demo')).toBe('/trades');
    expect(withAccount('/trades', 'real')).toBe('/trades?account=real');
    expect(withAccount('/trades/abc', 'real')).toBe('/trades/abc?account=real');
    expect(withAccount('/x?a=1', 'real')).toBe('/x?a=1&account=real');
  });
});
