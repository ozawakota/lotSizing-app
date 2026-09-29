# 通貨強弱 Worker (Cloudflare Workers)

イントラデイの通貨強弱を **毎時 Cron で算出し KV にキャッシュ**、クライアントへ配信する Cloudflare Worker。
GAS は使わない。設計は [`docs/adr/0004-currency-strength-intraday-on-cloudflare-workers.md`](../docs/adr/0004-currency-strength-intraday-on-cloudflare-workers.md)、
用語は [`CONTEXT.md`](../CONTEXT.md)（Currency strength / Strength window / Strength refresh）を参照。

- 本体: [`src/index.ts`](./src/index.ts)（`scheduled()`＝毎時Cron、`fetch()`＝KV配信）
- 計算式はフロントの [`src/lib/strength.ts`](../src/lib/strength.ts) を共有 import（単一実装）

## 仕様の要点

| 項目 | 値 |
|------|-----|
| 対象通貨 | JPY, USD, EUR, GBP, AUD, NZD, CAD, CHF の8通貨 |
| 指標 | 各通貨の他7通貨に対する変化率の等加重平均（総和≈0） |
| 窓 | 直前の確定クロックアワー（例 09:00→10:00、1時間足2本） |
| データ源 | Twelve Data `time_series`（1h・直近2本、7ペア一括＝7 req/回） |
| 実行 | Cloudflare Cron・毎時（`0 * * * *`） |
| キャッシュ | Workers KV（キー `snapshot`） |
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
