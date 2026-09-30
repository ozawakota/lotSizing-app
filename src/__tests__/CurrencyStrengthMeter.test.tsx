// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import CurrencyStrengthMeter from '../CurrencyStrengthMeter';
import type { RateSeries } from '../lib/strength';

const WORKER_URL = 'https://currency-strength.example.workers.dev';

// USD だけ上昇する小さな時系列を作る
const makeSeries = (interval: string, dts: string[], usd: number[]): RateSeries => ({
  interval,
  datetimes: dts,
  rates: {
    USD: usd,
    EUR: dts.map(() => 100),
    GBP: dts.map(() => 100),
    AUD: dts.map(() => 100),
    NZD: dts.map(() => 100),
    CAD: dts.map(() => 100),
    CHF: dts.map(() => 100),
  },
});

const body = {
  computedAt: Date.now(),
  intraday: makeSeries(
    '15min',
    ['2026-09-30 09:00:00', '2026-09-30 09:15:00', '2026-09-30 09:30:00', '2026-09-30 09:45:00'],
    [100, 100.3, 100.6, 101],
  ),
  daily: makeSeries('1day', ['2026-09-28 00:00:00', '2026-09-29 00:00:00', '2026-09-30 00:00:00'], [100, 100.5, 101]),
};

const okResponse = (b: unknown): Response => ({ ok: true, status: 200, json: async () => b }) as Response;

beforeEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.stubEnv('VITE_STRENGTH_URL', WORKER_URL);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('CurrencyStrengthMeter', () => {
  it('auto-fetches on mount and renders the chart + legend', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(okResponse(body));
    render(<CurrencyStrengthMeter />);

    await waitFor(() => expect(screen.getByRole('img', { name: '通貨強弱チャート' })).toBeTruthy());
    expect(String(fetchSpy.mock.calls[0][0])).toBe(WORKER_URL);
    // 凡例に8通貨
    for (const c of ['USD', 'EUR', 'GBP', 'JPY', 'CHF', 'AUD', 'CAD', 'NZD']) {
      expect(screen.getByText(c)).toBeTruthy();
    }
  });

  it('renders start-point buttons and lets you switch range', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(okResponse(body));
    render(<CurrencyStrengthMeter />);

    await waitFor(() => expect(screen.getByRole('button', { name: '年初' })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: '年初' }));
    // 切替後もチャートが描画される（daily を使用）
    expect(screen.getByRole('img', { name: '通貨強弱チャート' })).toBeTruthy();
  });

  it('re-fetches automatically every hour', async () => {
    vi.useFakeTimers();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(okResponse(body));
    render(<CurrencyStrengthMeter />);

    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('shows an error and no chart when the fetch fails', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network down'));
    render(<CurrencyStrengthMeter />);

    await waitFor(() => expect(screen.getByText('network down')).toBeTruthy());
    expect(screen.queryByRole('img', { name: '通貨強弱チャート' })).toBeNull();
  });

  it('surfaces an error payload from the Worker', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(okResponse({ error: 'no snapshot' }));
    render(<CurrencyStrengthMeter />);

    await waitFor(() => expect(screen.getByText('no snapshot')).toBeTruthy());
  });
});
