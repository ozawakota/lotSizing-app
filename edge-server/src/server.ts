// HTTP の口。GET /edge?timeframe=… で集計済みスナップショットを返すだけ（計算は scheduler 側）。
import type { IncomingMessage, ServerResponse } from 'node:http';
import { EDGE_TIMEFRAMES, type EdgeSnapshot, type EdgeTimeframe } from '../../src/lib/edge';

export function createHandler(getSnapshot: (tf: EdgeTimeframe) => EdgeSnapshot | undefined, allowedOrigin = '*') {
  return (req: IncomingMessage, res: ServerResponse) => {
    const headers: Record<string, string> = {
      'Access-Control-Allow-Origin': allowedOrigin,
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    };
    const send = (status: number, body: unknown) => {
      res.writeHead(status, headers);
      res.end(JSON.stringify(body));
    };
    if (req.method === 'OPTIONS') {
      res.writeHead(204, headers);
      res.end();
      return;
    }
    if (req.method !== 'GET') return send(405, { error: 'GET のみ対応' });

    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === '/health') {
      return send(200, { ok: true, ready: EDGE_TIMEFRAMES.filter((tf) => getSnapshot(tf)) });
    }
    if (url.pathname === '/edge') {
      const raw = url.searchParams.get('timeframe');
      const tf: EdgeTimeframe = raw && (EDGE_TIMEFRAMES as string[]).includes(raw) ? (raw as EdgeTimeframe) : '1h';
      const snap = getSnapshot(tf);
      // 初回集計中（起動直後・初回の過去データ取得中）。クライアントは時間をおいて再取得する。
      if (!snap) return send(503, { error: '集計中です。数分後に再度お試しください' });
      return send(200, snap);
    }
    return send(404, { error: 'not found' });
  };
}
