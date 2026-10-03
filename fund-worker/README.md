# 資金管理 fund-worker

Google 認証（許可メールのみ）で認可し、**Turso(libSQL)** にユーザー別でトレード/入出金/設定を
記録する TS Cloudflare Worker。`/summary` で残高・累計損益・勝率・最大ドローダウン・
エクイティカーブを返す。集計は [`../src/lib/fund.ts`](../src/lib/fund.ts)、Google クレーム検証は
[`../src/lib/googleAuth.ts`](../src/lib/googleAuth.ts) をフロント/テストと共有。

## 認証
- フロントの Google IDトークンを `Authorization: Bearer <token>` で受け取る。
- Google JWKS（RS256）で署名検証 → `aud=GOOGLE_CLIENT_ID`・`iss`・`exp`・`email_verified`・
  **`email ∈ ALLOWED_EMAILS`** を確認。`user_id = sub` で全行を分離。

## エンドポイント（すべて要 Bearer）
| メソッド | パス | 説明 |
|---|---|---|
| GET/PUT | `/settings` | 初期残高・通貨 |
| GET/POST | `/trades` | トレード一覧/追加 |
| DELETE | `/trades/:id` | トレード削除 |
| GET/POST | `/cashflows` | 入出金一覧/追加 |
| DELETE | `/cashflows/:id` | 入出金削除 |
| GET | `/summary` | 残高・損益・勝率・DD・エクイティカーブ |

## セットアップ

### 1. GCP で OAuth クライアントID
1. [Google Cloud Console](https://console.cloud.google.com/) → APIとサービス → 認証情報 →
   **OAuth クライアント ID を作成**（種類: ウェブアプリケーション）。
2. **承認済み JavaScript 生成元**に本番(GH Pages)と `http://localhost:5173` を登録。
3. 発行された **クライアントID**（`...apps.googleusercontent.com`）を控える。

### 2. Turso
```bash
# Turso CLI 導入後
turso db create lotsizing-fund
turso db show lotsizing-fund --url          # → TURSO_DATABASE_URL (libsql://...)
turso db tokens create lotsizing-fund       # → TURSO_AUTH_TOKEN
turso db shell lotsizing-fund < schema.sql  # スキーマ投入
```

### 3. Worker 設定・デプロイ
`wrangler.toml` の `[vars]`（`GOOGLE_CLIENT_ID`, `ALLOWED_EMAILS`）を埋めて:
```bash
cd fund-worker
npm install
npx wrangler secret put TURSO_DATABASE_URL
npx wrangler secret put TURSO_AUTH_TOKEN
npx wrangler deploy
# → https://lotsizing-fund.<subdomain>.workers.dev
```

### 4. フロント `.env`
```
VITE_FUND_URL=https://lotsizing-fund.<subdomain>.workers.dev
VITE_GOOGLE_CLIENT_ID=<クライアントID>.apps.googleusercontent.com
```
両方セットすると「資金管理」ページで Google ログインが有効になる。

> 備考: `@libsql/client/web` は fetch ベースで Workers で動作する想定。初回デプロイで
> 動作を確認すること（不可なら Turso の HTTP API 直叩きに切替）。
