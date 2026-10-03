-- 資金管理 fund-worker の Turso(libSQL) スキーマ。
-- 投入: turso db shell <db> < schema.sql

CREATE TABLE IF NOT EXISTS settings (
  user_id          TEXT PRIMARY KEY,
  starting_balance REAL NOT NULL DEFAULT 0,
  currency         TEXT NOT NULL DEFAULT 'JPY',
  updated_at       INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS trades (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  date       TEXT NOT NULL,          -- "YYYY-MM-DD"
  invested   REAL NOT NULL,          -- 投資金額
  recovered  REAL NOT NULL,          -- 回収金額（損益 = 回収 − 投資）
  tags       TEXT NOT NULL DEFAULT '[]', -- タグの JSON 配列（店舗/機種/レート等）
  note       TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_trades_user ON trades (user_id, date);

CREATE TABLE IF NOT EXISTS cashflows (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  date       TEXT NOT NULL,
  type       TEXT NOT NULL,          -- deposit | withdrawal
  amount     REAL NOT NULL,
  note       TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cashflows_user ON cashflows (user_id, date);
