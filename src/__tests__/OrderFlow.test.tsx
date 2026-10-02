// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';
import OrderFlow from '../OrderFlow';
import { FLOW_ORDER_STORAGE_KEY, type FlowSnapshot } from '../lib/flow';

const WORKER_URL = 'https://currency-strength.example.workers.dev/flow';

const body: FlowSnapshot = {
  updatedAt: '2026-10-02T06:00:00.000Z',
  pairs: [
    {
      pair: 'USD/JPY',
      longPct: 60,
      shortPct: 40,
      longVolume: 1200,
      shortVolume: 800,
      dominant: 'buy',
      peak: { volume: 2500, datetime: '2026-10-02T08:00:00.000Z', rate: 157.84 },
      delta: { value: 200, direction: 'entry' },
    },
    {
      pair: 'EUR/JPY',
      longPct: 30,
      shortPct: 70,
      longVolume: 500,
      shortVolume: 900,
      dominant: 'sell',
      delta: { value: -250, direction: 'settlement' },
    },
  ],
};

const okResponse = (b: unknown): Response => ({ ok: true, status: 200, json: async () => b }) as Response;

beforeEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.stubEnv('VITE_FLOW_URL', WORKER_URL);
  localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('OrderFlow', () => {
  it('マウント時に取得し全ペア（JPY7本＋EUR/USD＋XAU/USD）を一覧表示する', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(okResponse(body));
    render(<OrderFlow />);

    await waitFor(() => expect(screen.getByText('USD/JPY')).toBeTruthy());
    expect(String(fetchSpy.mock.calls[0][0])).toBe(WORKER_URL);
    for (const p of [
      'USD/JPY', 'EUR/JPY', 'GBP/JPY', 'AUD/JPY', 'NZD/JPY', 'CAD/JPY', 'CHF/JPY',
      'EUR/USD', 'GBP/USD', 'AUD/USD', 'XAU/USD',
    ]) {
      expect(screen.getByText(p)).toBeTruthy();
    }
  });

  it('取引量・割合と優勢ラベルを表示する', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(okResponse(body));
    render(<OrderFlow />);

    await waitFor(() => expect(screen.getByText('USD/JPY')).toBeTruthy());
    expect(screen.getByText('1,200')).toBeTruthy(); // longVolume
    expect(screen.getByText('800')).toBeTruthy(); // shortVolume
    expect(screen.getAllByText('買い').length).toBeGreaterThan(0); // 優勢ラベル
    expect(screen.getAllByText('売り').length).toBeGreaterThan(0);
  });

  it('前回比の積み増し/巻き戻しを符号付きで表示する', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(okResponse(body));
    render(<OrderFlow />);

    await waitFor(() => expect(screen.getByText('USD/JPY')).toBeTruthy());
    // 増=積み増し（新規優勢）、符号付き +200
    expect(screen.getByText('積み増し')).toBeTruthy();
    expect(screen.getByText('+200')).toBeTruthy();
    // 減=巻き戻し（決済優勢）、符号付き −250（全角マイナス）
    expect(screen.getByText('巻き戻し')).toBeTruthy();
    expect(screen.getByText('−250')).toBeTruthy();
  });

  it('「見方」ボタンから説明モーダルを開ける', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(okResponse(body));
    render(<OrderFlow />);

    await waitFor(() => expect(screen.getByText('USD/JPY')).toBeTruthy());
    const infoBtn = screen.getByRole('button', { name: '見方' });
    expect(infoBtn).toBeTruthy();
    fireEvent.click(infoBtn);
    await waitFor(() => expect(screen.getByText('表示の見方')).toBeTruthy());
  });

  it('最大取引量ピークはヘッダー常時表示、レートはアコーディオンで開閉する', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(okResponse(body));
    render(<OrderFlow />);

    await waitFor(() => expect(screen.getByText('USD/JPY')).toBeTruthy());
    // ヘッダー（最大値）は常時表示、詳細（レート）は初期状態で非表示。
    expect(screen.getByText('最大 2,500')).toBeTruthy();
    expect(screen.queryByText('157.84')).toBeNull();
    // トグルを開くとレートが表示される。
    fireEvent.click(screen.getByRole('button', { name: 'USD/JPY の最大取引量の詳細' }));
    await waitFor(() => expect(screen.getByText('157.84')).toBeTruthy());
  });

  it('データが無いペアは — を表示する', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(okResponse(body));
    render(<OrderFlow />);

    // GBP/JPY などは欠損 → —
    await waitFor(() => expect(screen.getByText('GBP/JPY')).toBeTruthy());
    expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(5);
  });

  it('取得失敗時はエラーを表示する', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network down'));
    render(<OrderFlow />);

    await waitFor(() => expect(screen.getByText('network down')).toBeTruthy());
  });

  it('Worker のエラーペイロードを表示する', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(okResponse({ error: 'no snapshot' }));
    render(<OrderFlow />);

    await waitFor(() => expect(screen.getByText('no snapshot')).toBeTruthy());
  });

  it('localStorage に保存済みの順序で描画する', async () => {
    localStorage.setItem(FLOW_ORDER_STORAGE_KEY, JSON.stringify(['XAU/USD', 'USD/JPY']));
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(okResponse(body));
    render(<OrderFlow />);

    await waitFor(() => expect(screen.getByText('USD/JPY')).toBeTruthy());
    // 並び替えハンドルの aria-label 順＝描画順。保存した2ペアが先頭、残りは既定順で続く。
    const handles = screen.getAllByRole('button', { name: /を並び替え/ });
    const names = handles.map((h) => h.getAttribute('aria-label'));
    expect(names[0]).toBe('XAU/USD を並び替え');
    expect(names[1]).toBe('USD/JPY を並び替え');
    expect(names).toHaveLength(11);
  });
});
