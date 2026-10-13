-- MT5 → Turso 同期基盤のスキーマ（libSQL / SQLite 互換）。
-- 投入: turso db shell <db> < infra/db/schema.sql
-- login 列で将来の複数口座にも対応する。時刻は epoch ミリ秒。

-- 口座スナップショット（最新。login 単位で upsert）。
CREATE TABLE IF NOT EXISTS accounts (
  login        INTEGER PRIMARY KEY,
  broker       TEXT,
  currency     TEXT,
  leverage     INTEGER,
  balance      REAL,
  equity       REAL,
  margin       REAL,
  margin_free  REAL,
  margin_level REAL,
  profit       REAL,              -- 保有ポジションの合計評価損益
  updated_at   INTEGER NOT NULL   -- EA 生成時刻（epoch ms）
);

-- 現在のオープンポジション（同期ごとに login 分を総入替）。
CREATE TABLE IF NOT EXISTS positions (
  ticket        INTEGER PRIMARY KEY,
  login         INTEGER NOT NULL,
  symbol        TEXT NOT NULL,
  type          TEXT NOT NULL,    -- 'buy' | 'sell'
  volume        REAL NOT NULL,
  price_open    REAL,
  sl            REAL,
  tp            REAL,
  price_current REAL,
  profit        REAL,
  swap          REAL,
  time_open     INTEGER,          -- epoch ms
  updated_at    INTEGER NOT NULL  -- EA 生成時刻（epoch ms）
);
CREATE INDEX IF NOT EXISTS idx_positions_login ON positions (login);

-- クローズ済みの約定履歴（deal_id で upsert・追記）。
CREATE TABLE IF NOT EXISTS deals (
  deal_id      INTEGER PRIMARY KEY,
  login        INTEGER NOT NULL,
  order_id     INTEGER,
  position_id  INTEGER,
  symbol       TEXT,
  type         TEXT,              -- 'buy' | 'sell' | 'balance' など
  entry        TEXT,              -- 'in' | 'out' | 'inout' | 'out_by'
  volume       REAL,
  price        REAL,
  profit       REAL,
  commission   REAL,
  swap         REAL,
  time         INTEGER,           -- epoch ms
  comment      TEXT
);
CREATE INDEX IF NOT EXISTS idx_deals_login_time ON deals (login, time);
