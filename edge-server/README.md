# エッジ分析サーバー（edge-server）

ピンバー・包み足が各ペアで過去にどれだけ機能したか（N本先の勝率・平均pips・エッジ）を集計し、
最新確定足に優位性のあるパターンが出ていれば売買シグナルを返す Node.js サーバー。
**Oracle Cloud（Always Free）の VM に常駐**させ、フロントの「エッジ」タブ（[`src/EdgeAnalysis.tsx`](../src/EdgeAnalysis.tsx)）が `/edge` を読む。

Cloudflare Workers ではなく専用サーバーにしているのは、1分足や長期間の集計が Workers 無料枠の
CPU 時間（1リクエスト10ms）・KV 書き込み（1日1,000回、アカウント共有）に収まらないため。

- 判定・集計ロジック: フロントと共有 → [`../src/lib/edge.ts`](../src/lib/edge.ts)
- データ: **Dukascopy**（キー不要）を [dukascopy-node](https://github.com/Leo4815162342/dukascopy-node) で取得
  - Bid の OHLC で判定（チャートと同じ基準）、Ask の終値との差で**平均スプレッドを求め、各取引から控除**
  - XAU/USD は現物スポット（xauusd）
  - 非公式の取得経路のため、Dukascopy 側の仕様変更で止まる可能性がある

## 構成

| ファイル | 役割 |
|---|---|
| `src/main.ts` | 起動（HTTP サーバー＋更新ループ） |
| `src/scheduler.ts` | 時間足ごとの更新タイミング（足の確定＋15秒後） |
| `src/engine.ts` | 足の取得・保存 → 確定足で集計 → スナップショット保持 |
| `src/feed.ts` | Dukascopy アダプタ（過去分 `getHistoricalRates`、直近分 `getRealTimeRates`） |
| `src/store.ts` | 足の JSON 保存（`DATA_DIR/<ペア>_<足>.json`）と統合・スプレッドの純関数 |
| `src/server.ts` | `GET /edge?timeframe=…`・`GET /health`（CORS 付き） |
| `deploy/` | systemd ユニット・Caddyfile（HTTPS）・構築スクリプト |

## 時間足と統計期間

| 足 | 統計期間 | 検証本数 | 更新間隔 |
|---|---|---|---|
| 1m | 30日 | 5本先 | 1分 |
| 5m | 90日 | 6本先 | 5分 |
| 15m | 180日 | 4本先 | 15分 |
| 1h | 2年 | 4本先 | 15分 |
| 4h | 5年 | 3本先 | 30分 |
| 1d | 10年 | 3本先 | 60分 |

初回起動時は統計期間ぶんの過去データを取得するため、全時間足がそろうまで数十分かかる
（その間 `/edge` は未集計の足に 503 を返す）。取得した足は `DATA_DIR` に保存し、
再起動後は直近分だけを取り直す。取得に失敗しても保存済みの足で集計を続ける。

## API

```
GET /edge?timeframe=1m|5m|15m|1h|4h|1d   → EdgeSnapshot（src/lib/edge.ts の型）。未集計は 503
GET /health                               → { ok: true, ready: ["1d", "4h", ...] }
```

## Oracle Cloud へのデプロイ

MT5 用の既存 VM（E2.1.Micro, RAM 1GB）とは**別に**、Always Free の **Ampere A1**（ARM）を1台作る。

1. **インスタンス作成**: Shape `VM.Standard.A1.Flex`（1 OCPU / 6GB 程度で十分）、Image Ubuntu 22.04 または 24.04。
2. **VCN のセキュリティリスト**で Ingress TCP **80・443** を開放（Let's Encrypt の証明書取得と HTTPS 用）。
3. **ドメイン**: 独自ドメインの A レコードを VM の公開IPに向ける。無ければ `<IPのドットをハイフンに>.sslip.io` を使える。
4. VM に SSH して構築:
   ```bash
   curl -fsSLO https://raw.githubusercontent.com/ozawakota/lotSizing-app/main/edge-server/deploy/setup.sh
   EDGE_DOMAIN=141-147-1-2.sslip.io ALLOWED_ORIGIN=https://lotsizings.netlify.app sudo -E bash setup.sh
   ```
   Node.js 22・Caddy の導入、リポジトリの clone、systemd 登録、iptables の 80/443 開放まで行う。
5. 確認: `curl https://<EDGE_DOMAIN>/health`、ログは `journalctl -u edge-server -f`。
6. フロントの環境変数（`netlify.toml` の `[build.environment]`）に `VITE_EDGE_URL = "https://<EDGE_DOMAIN>/edge"` を設定して再ビルド。

更新: `cd /opt/lotsizing-app && git pull && cd edge-server && npm install --omit=dev && sudo systemctl restart edge-server`

## ローカル実行

```bash
cd edge-server
npm install
PORT=8787 DATA_DIR=./data npm start
curl "http://127.0.0.1:8787/edge?timeframe=1d"
```

テストはリポジトリ直下の `pnpm test`（vitest）で `edge-server/test/` も実行される（データ元はモック）。

## 注意

- **Always Free の回収**: Oracle は Always Free の VM を、CPU・ネットワーク・メモリの使用率が低い状態が
  続くと停止・回収することがある（最新条件は Oracle の規約を参照）。
- 1m の勝率・平均pipsはスプレッド控除後でも、約定の滑りや指標時の急なスプレッド拡大までは反映しない。
- ※過去統計による参考情報であり、投資助言ではない。
