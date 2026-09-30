# 通貨強弱はイントラデイ（毎時）を、Cloudflare Workers の Cron + KV キャッシュで算出・配信する

## Status

superseded by ADR-0005

> Cloudflare Worker + Cron + KV というインフラ構成は維持しつつ、指標と表示を OANDA 方式
> （対数変化率の合算・起点から0ベースの累積折れ線）へ変更したため差し替え。
> 現行方針は [ADR-0005](./0005-currency-strength-oanda-cumulative-log.md) を参照。

## Context / Decision

**「1時間ごとに更新（値が毎時動くイントラデイ）」** の要望により、日次・オンデマンド（ADR-0003）から再度イントラデイに戻す。
イントラデイの為替時系列はキー必須（Twelve Data 等）で、そのキーを公開バンドルに置けないためサーバーが要る。
一方で「GAS は使いたくない」ため、**GAS 以外のサーバーレス = Cloudflare Workers** を採用する。

- **実行場所は Cloudflare Workers（Cron Triggers + Workers KV）。** Worker の Cron が毎時1回だけ Twelve Data の
  `time_series`（1h・直近2本、7ペア一括）を取得して8通貨の強弱を算出し、結果を KV にキャッシュする。クライアントは
  Worker の `fetch` ハンドラ経由で KV のスナップショットを読むだけ（Twelve Data を直接叩かない）。SPA は GitHub Pages のまま、
  Worker は独立した小さなエンドポイント。
- **キーは Worker シークレット（`wrangler secret`）に保持。** 公開バンドルには一切載らない。価格アラート（ADR-0001, GAS）とは
  別管理になるが、GAS を使わない要望を優先する。
- **計算式はテスト済みの `src/lib/strength.ts` を Worker からも import して共有**（単一実装）。各ペア X/JPY の
  1時間足終値をそのまま使う（円/単位の向き）。
- **クライアントは毎時オートリフレッシュ。** マウント時に取得し、`setInterval` で1時間ごとに再取得（開いている間）。手動ボタンも残す。

## Consequences

- **無料枠内。** Cloudflare 側は Workers 100k req/日・KV 書込 1000/日・Cron 3個/Worker のいずれも十分（毎時Cron＝24 write/日）。
  実質のボトルネックは Twelve Data 無料枠800/日で、価格アラート約660/日と共有し残り約140/日。毎時×7シンボル＝約77/日で収まる。
- **窓は直前の確定クロックアワー。** Twelve Data の1時間足2本（`values[1]`→開始、`values[0]`→終了）で判定。ローソク境界に一致。
- **失敗時は前回スナップショットを保持。** Cron の取得失敗・部分欠損時は KV を上書きしない。クライアントの取得失敗は
  ボタン近傍にエラー表示するのみで、電卓は妨げない。
- **セットアップが必要。** Cloudflare アカウント＋`wrangler` で KV ネームスペース作成・`TWELVE_DATA_API_KEY` シークレット登録・
  Cron 設定・デプロイ。手順は `worker/README.md` に記載。クライアントは Worker の URL を `VITE_STRENGTH_URL` に設定する。
- **裏で（アプリを閉じていても）更新されるのは KV スナップショットまで。** クライアント表示の更新は開いている間のオートリフレッシュに依存する。
