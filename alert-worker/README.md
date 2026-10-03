# 相場変動通知 Alert Worker

外貨ex の「相場変動通知」準拠。対象4ペア（GBP/JPY, XAU/JPY, AUD/USD, GBP/USD）の
**Bid が過去15分以内に大きく変動**（FX=25pips / XAU/JPY=1000円）したら Web Push で通知し、
**発火後15分はそのペアの測定を休止**する。アプリを閉じていても届く（iOS はホーム画面に追加した PWA のみ）。
対象ペア・しきい値は [`../src/lib/alert.ts`](../src/lib/alert.ts) の `PAIR_CONFIG` で変更できる。

- 本体: [`src/index.ts`](./src/index.ts)（`scheduled()`＝毎分の検知、`fetch()`＝購読API/`/recent`）
- 判定ロジック: フロント/テストと共有 → [`../src/lib/alert.ts`](../src/lib/alert.ts)（`evaluate`）
- データ源: **OANDA practice** v20 pricing（本物の Bid/Ask・コール課金なし）
- 保存: **D1**（`subscriptions` / `pair_state` / `alerts`）
- 送信: **ペイロードレス Web Push**（VAPID署名のみ）。SW が受信を合図に `/recent` を引く。

## 仕組み

```
毎分 Cron ──> OANDA pricing(4ペアの Bid) ──> evaluate(15分窓で高安差≥しきい値?)
                                                 │ 発火
                                                 ├─ alerts に記録
                                                 └─ 全購読へ空Push(VAPID)
ブラウザ/PWA ── push受信 ─> SW が /recent 取得 ─> 通知表示(tag=ペアで重複排除)
```

ペイロードを暗号化(RFC8291)しないため実装が軽い。通知文は SW が `/recent` から取得する。

## 無料枠

- Cloudflare Cron はアカウント合計5本。`currency-strength`(3) + 本Worker(1) = 4本で収まる。
- D1 無料枠（書込10万/日）に対し、毎分4ペア書込 ≒ 5,760/日で十分。
- OANDA practice はデモ口座・コール課金なし。

## セットアップ

### 1. OANDA practice 口座とトークン
1. **fxTrade Practice**（v20）のデモ口座を作成。**MT4 デモは選ばない**こと
   （MT4 サブ口座は無操作90日で閉鎖される。v20 の fxTrade Practice は原則期限なし）。
2. [hub.oanda.com](https://hub.oanda.com) → My Account → My Services → **Manage API Access**
   で **Personal Access Token** を発行（1度しか表示されないので即コピー）。
3. **口座ID**（デモは先頭 `101-`、例 `101-009-xxxxxxx-001`）を控える。
   `curl -H "Authorization: Bearer <TOKEN>" https://api-fxpractice.oanda.com/v3/accounts` でも確認可。

> 本 Worker は毎分 API を叩くため「無操作」にならず、デモ口座は実質失効しない。
> 万一トークン失効/口座閉鎖で取得が連続失敗した場合は、**健全性通知（"データ取得に失敗
> しています"）を自分にプッシュ**するので、無言停止には気づける（`FEED_FAIL_ALERT_AFTER`）。

### 2. VAPID 鍵を生成
```bash
npx web-push generate-vapid-keys
# publicKey / privateKey が出力される
```
- `publicKey` … `wrangler.toml` の `VAPID_PUBLIC_KEY` と、フロントの `VITE_VAPID_PUBLIC_KEY` に**同じ値**を設定。
- `privateKey` … secret として登録（下記）。

### 3. D1 を作成してスキーマ投入
```bash
cd alert-worker
npx wrangler d1 create lotsizing-alert       # 出力の database_id を wrangler.toml に貼る
npx wrangler d1 execute lotsizing-alert --remote --file=./schema.sql
```

### 4. 設定と secret
`wrangler.toml` の `[vars]`（`VAPID_SUBJECT`, `VAPID_PUBLIC_KEY`）を埋め、秘匿情報は secret で登録:
```bash
npx wrangler secret put OANDA_API_TOKEN
npx wrangler secret put OANDA_ACCOUNT_ID
npx wrangler secret put VAPID_PRIVATE_KEY
```

### 5. デプロイ
```bash
npm install          # 初回のみ（wrangler を取得）
npx wrangler deploy  # Cron も同時に設定される
```

### 6. フロント側の環境変数
リポジトリ直下の `.env` に以下を設定して再ビルド（`.env.example` 参照）:
```
VITE_ALERT_URL=https://lotsizing-alert.<subdomain>.workers.dev
VITE_VAPID_PUBLIC_KEY=<VAPID publicKey（手順2と同値）>
```
両方セットすると計算機ページに「相場変動通知」カードが出る。

## 動作確認

```bash
# ローカルで scheduled をテスト（毎分の検知を手動発火）
npx wrangler dev --test-scheduled
curl "http://localhost:8787/__scheduled"

# 直近アラート
curl "https://lotsizing-alert.<subdomain>.workers.dev/recent"
```

> **iOS 注意**: iPhone/iPad は Safari で「ホーム画面に追加」した PWA（iOS 16.4+）でのみ
> Web Push が届く。アプリ側カードが未インストール時に案内を表示する。
