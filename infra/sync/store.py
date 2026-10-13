"""Turso(libSQL) / ローカル SQLite 共通の保存層。

libSQL は SQLite 互換なので、同一の SQL（`?` プレースホルダ・`ON CONFLICT`）が両方で動く。
- 本番: 環境変数 TURSO_DATABASE_URL / TURSO_AUTH_TOKEN があれば libsql へ接続。
- ローカル/テスト: それが無ければ標準ライブラリ sqlite3（追加 pip 不要）。

接続オブジェクトは sqlite3.Connection 互換（execute/commit を持つ）を前提にする。
libsql（libsql-experimental）の Connection も同じ API を提供する。
"""

from __future__ import annotations

import os
import sqlite3

from reader import Account, Deal, Position

SCHEMA_PATH = os.path.join(os.path.dirname(__file__), "..", "db", "schema.sql")


def _statements(sql: str) -> list[str]:
    # スキーマを個別文に分割（executescript 非対応の接続でも動くように）。
    # 文字列リテラル内に ';' を含まない前提（本スキーマは該当なし）。
    return [s.strip() for s in sql.split(";") if s.strip()]


def connect():
    """環境に応じて DB 接続を返す。TURSO_* があれば libsql、無ければローカル sqlite。"""
    url = os.environ.get("TURSO_DATABASE_URL")
    token = os.environ.get("TURSO_AUTH_TOKEN")
    if url:
        import libsql_experimental as libsql  # 本番のみ必要（requirements.txt）

        return libsql.connect(database=url, auth_token=token or "")
    path = os.environ.get("SQLITE_PATH", "mt5sync.db")
    return sqlite3.connect(path)


class Store:
    """スキーマ適用と冪等 upsert を提供する。conn は sqlite3 互換。"""

    def __init__(self, conn):
        self.conn = conn
        self.apply_schema()

    def apply_schema(self) -> None:
        with open(SCHEMA_PATH, encoding="utf-8") as f:
            for stmt in _statements(f.read()):
                self.conn.execute(stmt)
        self.conn.commit()

    # 口座スナップショットを login 単位で upsert。
    def upsert_account(self, a: Account, generated_at: int) -> None:
        self.conn.execute(
            """
            INSERT INTO accounts (login, broker, currency, leverage, balance, equity,
                                  margin, margin_free, margin_level, profit, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(login) DO UPDATE SET
              broker=excluded.broker, currency=excluded.currency, leverage=excluded.leverage,
              balance=excluded.balance, equity=excluded.equity, margin=excluded.margin,
              margin_free=excluded.margin_free, margin_level=excluded.margin_level,
              profit=excluded.profit, updated_at=excluded.updated_at
            """,
            [a.login, a.broker, a.currency, a.leverage, a.balance, a.equity,
             a.margin, a.margin_free, a.margin_level, a.profit, generated_at],
        )
        self.conn.commit()

    # その login の建玉を総入替（クローズされた建玉を確実に消すため）。
    def replace_positions(self, login: int, positions: list[Position], generated_at: int) -> None:
        self.conn.execute("DELETE FROM positions WHERE login = ?", [login])
        for p in positions:
            self.conn.execute(
                """
                INSERT INTO positions (ticket, login, symbol, type, volume, price_open, sl, tp,
                                       price_current, profit, swap, time_open, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                [p.ticket, login, p.symbol, p.type, p.volume, p.price_open, p.sl, p.tp,
                 p.price_current, p.profit, p.swap, p.time_open, generated_at],
            )
        self.conn.commit()

    # 約定履歴を deal_id で upsert（追記・修正取り込み）。
    def upsert_deals(self, deals: list[Deal]) -> None:
        for d in deals:
            self.conn.execute(
                """
                INSERT INTO deals (deal_id, login, order_id, position_id, symbol, type, entry,
                                   volume, price, profit, commission, swap, time, comment)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(deal_id) DO UPDATE SET
                  symbol=excluded.symbol, type=excluded.type, entry=excluded.entry,
                  volume=excluded.volume, price=excluded.price, profit=excluded.profit,
                  commission=excluded.commission, swap=excluded.swap, time=excluded.time,
                  comment=excluded.comment
                """,
                [d.deal_id, d.login, d.order_id, d.position_id, d.symbol, d.type, d.entry,
                 d.volume, d.price, d.profit, d.commission, d.swap, d.time, d.comment],
            )
        self.conn.commit()
