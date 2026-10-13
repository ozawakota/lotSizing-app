// エッジ分析サーバーの起動。Oracle Cloud の VM 上で systemd から常駐させ、Caddy(HTTPS) の裏で待ち受ける。
// 環境変数: PORT(既定 8787) / HOST(既定 127.0.0.1) / DATA_DIR(既定 ./data) / ALLOWED_ORIGIN(既定 *)
import { createServer } from 'node:http';
import { EdgeEngine } from './engine';
import { dukascopyFeed } from './feed';
import { startScheduler } from './scheduler';
import { createHandler } from './server';
import { SeriesStore } from './store';

const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? '127.0.0.1';
const engine = new EdgeEngine(dukascopyFeed, new SeriesStore(process.env.DATA_DIR ?? './data'));

createServer(createHandler((tf) => engine.snapshot(tf), process.env.ALLOWED_ORIGIN ?? '*')).listen(port, host, () => {
  console.log(`[edge] listening on http://${host}:${port}`);
});
startScheduler(async (tf) => {
  const started = Date.now();
  const snap = await engine.refresh(tf);
  console.log(`[edge] ${tf} 集計 ${snap.pairs.length}ペア 失敗${snap.failed.length} (${Date.now() - started}ms)`);
});
