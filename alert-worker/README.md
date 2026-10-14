# 相場変動通知 Alert Worker

外貨ex の「相場変動通知」準拠。対象4ペア（GBP/JPY, XAU/USD, AUD/USD, GBP/USD）の
**Bid が過去15分以内に大きく変動**（FX=25pips / XAU/USD=5ドル）したら Web Push で通知し、
**発火後15分はそのペアの測定を休止**する。アプリを閉じていても届く（iOS はホーム画面に追加した PWA のみ）。
対象ペア・しきい値は [`../src/lib/alert.ts`](../src/lib/alert.ts) の `PAIR_CONFIG` で変更できる。

- 本体: [`src/index.ts`](./src/index.ts)（`scheduled()`＝毎分の検知、`fetch()`＝購読API/`/recent`）
- 判定ロジック: フロント/テストと共有 → [`../src/lib/alert.ts`](../src/lib/alert.ts)（`evaluate`）
- データ源（いずれも**キーレス・口座不要**）:
  - FX 3ペア（GBP/JPY, AUD/USD, GBP/USD）… **Yahoo Finance** `v8/finance/chart` の `regularMarketPrice`
  - XAU/USD … **gold-api.com** のスポット金価格（USD/oz）
  - 実 Bid ではなく last/spot 価格を用いるが、しきい値（25pips/$5）はスプレッド誤差より十分大きく変動検知には問題なし。
- 保存: **D1**（`subscriptions` / `pair_state` / `alerts`）
- 送信: **ペイロードレス Web Push**（VAPID署名のみ）。SW が受信を合図に `/recent` を引く。

## 仕組み

```
毎分 Cron ──> Yahoo(FX3) + gold-api(XAU) の価格 ──> evaluate(15分窓で高安差≥しきい値?)
                                                 │ 発火
                                                 ├─ alerts に記録
                                                 └─ 全購読へ空Push(VAPID)
ブラウザ/PWA ── push受信 ─> SW が /recent 取得 ─> 通知表示(tag=ペアで重複排除)
```

ペイロードを暗号化(RFC8291)しないため実装が軽い。通知文は SW が `/recent` から取得する。

## RR好機通知

15分ごとに 4ペア（XAU/USD・USD/JPY・EUR/USD・GBP/USD）× 15m/30m/1h/4h の Yahoo 足から構造的 RR を評価し、
**1:2.5 以上**の時間足を通知する。通知対象は **15m/30m/1h**（4h は利確目標＝上位TFスイングの供給元としてだけ使う）。
RR は**ペアごとの一般的なスプレッド**（`TYPICAL_SPREAD_PIPS`、例 USD/JPY 0.3pips・XAU/USD 4pips）をリスクに足し
リワードから引いた実質値で判定する（同じ ペア＋TF＋方向 は2時間再通知しない。ヘッダーの RR トグルが ON の購読のみ）。
判定は [`../src/lib/stoploss.ts`](../src/lib/stoploss.ts) の `scanStructuralRrAll`。

**個人投資家の建玉（Myfxbook）による逆張りフィルタ**: currency-strength Worker の `/flow` を Service Binding（`STRENGTH`）経由で呼び、
setup と**同じ向きに 65% 以上**偏っていれば見送る。**逆向きに 60% 以上**なら本文に「逆張り支持」と付記する。
建玉を取得できないときはフィルタなしで通知する。判定は [`../src/lib/flow.ts`](../src/lib/flow.ts) の `retailBias`。

## 無料枠

- Cloudflare Cron はアカウント合計5本。`currency-strength`(3) + 本Worker(1) = 4本で収まる。
- D1 無料枠（書込10万/日）に対し、毎分4ペア書込 ≒ 5,760/日で十分。
- Yahoo Finance / gold-api はキーレス。Cloudflare の共有 IP で稀に 429 の可能性があるが、
  10分連続失敗で健全性通知が出るため無言停止には気づける。

## セットアップ

> 価格ソースはキーレス（Yahoo Finance / gold-api）のため、**API トークンや取引口座は不要**。

### 1. VAPID 鍵を生成
```bash
npx web-push generate-vapid-keys
# publicKey / privateKey が出力される
```
- `publicKey` … `wrangler.toml` の `VAPID_PUBLIC_KEY` と、フロントの `VITE_VAPID_PUBLIC_KEY` に**同じ値**を設定。
- `privateKey` … secret として登録（下記）。

> 取得が連続失敗した場合は、**健全性通知（"データ取得に失敗しています"）を自分にプッシュ**するので、
> 無言停止には気づける（`FEED_FAIL_ALERT_AFTER`）。

### 2. D1 を作成してスキーマ投入
```bash
cd alert-worker
npx wrangler d1 create lotsizing-alert       # 出力の database_id を wrangler.toml に貼る
npx wrangler d1 execute lotsizing-alert --remote --file=./schema.sql
```

### 3. 設定と secret
`wrangler.toml` の `[vars]`（`VAPID_SUBJECT`, `VAPID_PUBLIC_KEY`）を埋め、秘匿情報は secret で登録:
```bash
npx wrangler secret put VAPID_PRIVATE_KEY
```

### 4. デプロイ
```bash
npm install          # 初回のみ（wrangler を取得）
npx wrangler deploy  # Cron も同時に設定される
```

### 5. フロント側の環境変数
リポジトリ直下の `.env` に以下を設定して再ビルド（`.env.example` 参照）:
```
VITE_ALERT_URL=https://lotsizing-alert.<subdomain>.workers.dev
VITE_VAPID_PUBLIC_KEY=<VAPID publicKey（手順1と同値）>
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
