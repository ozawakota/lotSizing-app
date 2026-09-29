// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import CurrencyStrengthMeter from '../CurrencyStrengthMeter';
import type { StrengthSnapshot } from '../lib/strength';

const WORKER_URL = 'https://currency-strength.example.workers.dev';

// USD 最強・JPY 最弱になる Worker スナップショット
const snapshot: StrengthSnapshot = {
  windowStart: '09:00',
  windowEnd: '10:00',
  computedAt: Date.now(),
  scores: [
    { currency: 'USD', changePct: 0.42 },
    { currency: 'GBP', changePct: 0.18 },
    { currency: 'EUR', changePct: 0.05 },
    { currency: 'AUD', changePct: 0.01 },
    { currency: 'NZD', changePct: -0.02 },
    { currency: 'CAD', changePct: -0.1 },
    { currency: 'CHF', changePct: -0.2 },
    { currency: 'JPY', changePct: -0.34 },
  ],
};

const okResponse = (body: unknown): Response =>
  ({ ok: true, status: 200, json: async () => body }) as Response;

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
  it('auto-fetches the Worker snapshot on mount and renders ranked bars', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(okResponse(snapshot));
    render(<CurrencyStrengthMeter />);

    await waitFor(() => expect(screen.getByText('09:00 → 10:00')).toBeTruthy());
    expect(String(fetchSpy.mock.calls[0][0])).toBe(WORKER_URL);
    // USD は JPY より上位（DOM上で前）
    const usd = screen.getByText('USD');
    const jpy = screen.getByText('JPY');
    expect(usd.compareDocumentPosition(jpy) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('re-fetches automatically every hour', async () => {
    vi.useFakeTimers();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(okResponse(snapshot));
    render(<CurrencyStrengthMeter />);

    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('re-fetches when the update button is pressed', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(okResponse(snapshot));
    render(<CurrencyStrengthMeter />);

    await waitFor(() => expect(screen.getByRole('button', { name: '通貨強弱を更新' })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: '通貨強弱を更新' }));
    await waitFor(() => expect(fetchSpy.mock.calls.length).toBeGreaterThanOrEqual(2));
  });

  it('shows an error and no bars when the fetch fails, without crashing', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network down'));
    render(<CurrencyStrengthMeter />);

    await waitFor(() => expect(screen.getByText('network down')).toBeTruthy());
    expect(screen.queryByText('→', { exact: false })).toBeNull();
  });

  it('surfaces a "no snapshot" error payload from the Worker', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(okResponse({ error: 'no snapshot' }));
    render(<CurrencyStrengthMeter />);

    await waitFor(() => expect(screen.getByText('no snapshot')).toBeTruthy());
  });
});
