-- 相場変動通知 Alert Worker の D1 スキーマ。
-- 投入: npx wrangler d1 execute lotsizing-alert --remote --file=./schema.sql

-- Web Push 購読（1ブラウザ=1行）。endpoint が主キー。
CREATE TABLE IF NOT EXISTS subscriptions (
  endpoint   TEXT PRIMARY KEY,
  p256dh     TEXT NOT NULL,
  auth       TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- ペアごとの測定状態（15分ローリング窓とクールダウン明け時刻）。
-- samples は Sample[] の JSON、cooldown_until は epoch ms（なければ NULL）。
CREATE TABLE IF NOT EXISTS pair_state (
  pair           TEXT PRIMARY KEY,
  samples        TEXT NOT NULL,
  cooldown_until INTEGER
);

-- 発火したアラート。SW が push 受信時に /recent で引いて通知表示する。
CREATE TABLE IF NOT EXISTS alerts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  pair       TEXT NOT NULL,
  body       TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_alerts_created_at ON alerts (created_at);

-- 汎用 key-value。フィード健全性（連続失敗回数・通知済みフラグ）の保持に使う。
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
