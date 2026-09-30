# 通貨強弱 Worker (Cloudflare Workers)

OANDA式の通貨強弱（対数変化率の合算・起点から0ベースの累積）を出すため、**X/JPYの時系列を Cron で取得し KV にキャッシュ**、クライアントへ配信する Cloudflare Worker。
GAS は使わない。設計は [`docs/adr/0005-currency-strength-oanda-cumulative-log.md`](../docs/adr/0005-currency-strength-oanda-cumulative-log.md)、
用語は [`CONTEXT.md`](../CONTEXT.md)（Currency strength / Strength start point / Strength refresh）を参照。

- 本体: [`src/index.ts`](./src/index.ts)（`scheduled()`＝2つのCronで時系列取得、`fetch()`＝KV配信）
- 強弱の計算式はフロントの [`src/lib/strength.ts`](../src/lib/strength.ts)（`computeCumulativeStrength`）を共有 import（単一実装）。クライアントが起点(4時間前/当日/年初)を選んで累積を計算。

## 仕様の要点

| 項目 | 値 |
|------|-----|
| 対象通貨 | JPY, USD, EUR, GBP, AUD, NZD, CAD, CHF の8通貨 |
| 指標 | 各通貨の他7通貨に対する**対数変化率の合算**を起点から累積（総和≈0、起点0） |
| 起点 | 4時間前 / 当日（15分足）／ 年初（日足） |
| データ源 | Twelve Data `time_series`（7ペア一括＝7 credits/回、credits はシンボル数課金） |
| 実行 | Cron 2本：15分足=2時間ごと `0 */2 * * *`、日足=1日1回 `0 0 * * *`（≈91 credits/日で無料枠内） |
| キャッシュ | Workers KV（キー `intraday` / `daily`） |
| 失敗時 | KV を上書きせず前回値を保持 |

## セットアップ

```bash
cd worker
npm install                      # wrangler と @cloudflare/workers-types
npx wrangler login               # Cloudflare アカウントにログイン
npx wrangler kv namespace create STRENGTH_KV   # 出力の id を wrangler.toml に貼る
npx wrangler secret put TWELVE_DATA_API_KEY    # Twelve Data のキーを登録（バンドルには載らない）
npx wrangler deploy              # デプロイ（Cron も同時に設定される）
```

デプロイで発行された Worker の URL を、フロントの環境変数 `VITE_STRENGTH_URL` に設定する
（例: `.env` に `VITE_STRENGTH_URL=https://currency-strength.<subdomain>.workers.dev`）。

## 動作確認

```bash
# 手動で fetch を叩く（Cron が一度回った後はスナップショットが返る）
curl "https://currency-strength.<subdomain>.workers.dev"
# ローカル実行（scheduled のテストは --test-scheduled）
npx wrangler dev --test-scheduled
```

## 無料枠

Workers 100k req/日・KV 書込 1000/日（毎時Cron＝約24/日）・Cron 3個/Worker で、いずれも十分。
実質のボトルネックは Twelve Data 無料枠 800/日（価格アラートと共有、強弱は約77/日）。
