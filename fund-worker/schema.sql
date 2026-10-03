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
  instrument TEXT NOT NULL,
  direction  TEXT NOT NULL,          -- long | short
  lot        REAL NOT NULL,
  entry      REAL,
  exit       REAL,
  pnl        REAL NOT NULL,          -- 口座通貨の符号付き損益
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
