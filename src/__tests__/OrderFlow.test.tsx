// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';
import OrderFlow from '../OrderFlow';
import { FLOW_ORDER_STORAGE_KEY, type FlowSnapshot } from '../lib/flow';

const WORKER_URL = 'https://currency-strength.example.workers.dev/flow';

const body: FlowSnapshot = {
  updatedAt: '2026-10-02T06:00:00.000Z',
  cotReportDate: '2026-10-06T00:00:00.000Z',
  cotUpdatedAt: '2026-10-10T21:00:00.000Z',
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
      cot: { net: -0.5, lean: 'sell', deltaNet: -0.2 },
    },
    {
      pair: 'EUR/JPY',
      longPct: 30,
      shortPct: 70,
      longVolume: 500,
      shortVolume: 900,
      dominant: 'sell',
      delta: { value: -250, direction: 'settlement' },
      cot: { net: 0.3, lean: 'buy' },
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

  // ペアのカード（li）。詳細（取引量・前回比・最大など）はカードを開くと出る。
  const cardOf = (pair: string) => screen.getByText(pair).closest('li') as HTMLElement;
  const openCard = async (pair: string) => {
    fireEvent.click(screen.getByRole('button', { name: `${pair} の詳細を開く` }));
    await waitFor(() => expect(screen.getByRole('button', { name: `${pair} の詳細を閉じる` })).toBeTruthy());
  };

  it('個人の優勢と割合を常時表示し、取引量はカードを開くと表示する', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(okResponse(body));
    render(<OrderFlow />);

    await waitFor(() => expect(screen.getByText('USD/JPY')).toBeTruthy());
    expect(cardOf('USD/JPY').textContent).toContain('個人買い 60%');
    expect(cardOf('EUR/JPY').textContent).toContain('個人売り 70%');
    expect(cardOf('USD/JPY').textContent).not.toContain('1,200');
    await openCard('USD/JPY');
    expect(cardOf('USD/JPY').textContent).toContain('買い量1,200');
    expect(cardOf('USD/JPY').textContent).toContain('売り量800');
  });

  it('前回比の建玉の増減を表示し、開くと符号付きの数量を表示する', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(okResponse(body));
    render(<OrderFlow />);

    await waitFor(() => expect(screen.getByText('USD/JPY')).toBeTruthy());
    // 増=積み増し（新規優勢）、減=巻き戻し（決済優勢）
    expect(cardOf('USD/JPY').textContent).toContain('前回から建玉 増');
    expect(cardOf('EUR/JPY').textContent).toContain('前回から建玉 減');
    await openCard('USD/JPY');
    await openCard('EUR/JPY');
    expect(cardOf('USD/JPY').textContent).toContain('前回比（合計）+200');
    expect(cardOf('EUR/JPY').textContent).toContain('前回比（合計）−250'); // 全角マイナス
  });

  it('大口（CFTC COT）の方向・強さ・前週比・個人との逆行と報告日（週次）を表示する', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(okResponse(body));
    render(<OrderFlow />);

    await waitFor(() => expect(screen.getByText('USD/JPY')).toBeTruthy());
    // USD/JPY: cot net=-0.5(sell/中), deltaNet=-0.2 → 売り越しが強まる。個人=買い → 逆行
    expect(cardOf('USD/JPY').textContent).toContain('大口売り越し・中強まる');
    expect(cardOf('USD/JPY').textContent).toContain('個人と大口が逆');
    // EUR/JPY: cot net=0.3(buy/弱), 個人=売り → 逆行
    expect(cardOf('EUR/JPY').textContent).toContain('大口買い越し・弱');
    expect(cardOf('EUR/JPY').textContent).toContain('個人と大口が逆');
    await openCard('USD/JPY');
    expect(cardOf('USD/JPY').textContent).toContain('大口のネット-0.50（前週比 -0.20）');
    expect(document.body.textContent).toContain('10/06時点'); // 報告日（週次）
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

  it('記録上の最大取引量と日時・レートはカードを開くと表示する', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(okResponse(body));
    render(<OrderFlow />);

    await waitFor(() => expect(screen.getByText('USD/JPY')).toBeTruthy());
    expect(cardOf('USD/JPY').textContent).not.toContain('157.84');
    await openCard('USD/JPY');
    expect(cardOf('USD/JPY').textContent).toContain('記録上の最大2,500');
    expect(cardOf('USD/JPY').textContent).toContain('157.84');
  });

  it('データが無いペアは「データを取得できませんでした」を表示する', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(okResponse(body));
    render(<OrderFlow />);

    // GBP/JPY などは欠損
    await waitFor(() => expect(screen.getByText('GBP/JPY')).toBeTruthy());
    expect(cardOf('GBP/JPY').textContent).toContain('データを取得できませんでした');
    expect(screen.getAllByText('データを取得できませんでした').length).toBeGreaterThanOrEqual(5);
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
