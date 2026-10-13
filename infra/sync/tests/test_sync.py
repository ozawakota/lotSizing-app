"""MT5→Turso 同期のローカル単体テスト（標準ライブラリのみ）。

実行: cd infra/sync && python -m unittest discover -s tests
EA/本番Turso は不要。CSV フィクスチャ + メモリ SQLite で論理検証する。
"""

import os
import sqlite3
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))  # infra/sync

from store import Store  # noqa: E402
from sync import sync_once  # noqa: E402

ACCOUNT_HEADER = "login,broker,currency,leverage,balance,equity,margin,margin_free,margin_level,profit"
POS_HEADER = "ticket,login,symbol,type,volume,price_open,sl,tp,price_current,profit,swap,time_open"
DEAL_HEADER = "deal_id,login,order_id,position_id,symbol,type,entry,volume,price,profit,commission,swap,time,comment"


def write(path: str, lines: list[str]) -> None:
    with open(path, "w", encoding="utf-8", newline="") as f:
        f.write("\n".join(lines) + "\n")


def write_set(d: str, *, generated_at: int, account: str, positions: list[str], deals: list[str]) -> None:
    write(os.path.join(d, "account.csv"), [ACCOUNT_HEADER, account])
    write(os.path.join(d, "positions.csv"), [POS_HEADER, *positions])
    write(os.path.join(d, "deals.csv"), [DEAL_HEADER, *deals])
    # manifest は最後に（1セット完了の合図）。
    write(os.path.join(d, "manifest.csv"), ["generated_at,accounts,positions,deals", f"{generated_at},1,{len(positions)},{len(deals)}"])


class SyncTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = self.tmp.name
        self.store = Store(sqlite3.connect(":memory:"))

    def tearDown(self):
        self.tmp.cleanup()

    def _count(self, table: str) -> int:
        return self.store.conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]

    def test_full_sync(self):
        write_set(
            self.dir,
            generated_at=1_700_000_000_000,
            account="12345,TestBroker,JPY,500,100000,100500,20000,80500,502.5,500",
            positions=["111,12345,XAUUSD,buy,0.1,2650.0,2600.0,2700.0,2655.0,50.0,-1.2,1700000000000"],
            deals=["9001,12345,8001,111,XAUUSD,buy,in,0.1,2650.0,0,-0.5,0,1699990000000,entry"],
        )
        res = sync_once(self.dir, self.store)
        self.assertEqual(res["account"], 12345)
        self.assertEqual(res["positions"], 1)
        self.assertEqual(res["deals"], 1)
        self.assertEqual(self._count("accounts"), 1)
        self.assertEqual(self._count("positions"), 1)
        self.assertEqual(self._count("deals"), 1)
        row = self.store.conn.execute("SELECT equity, updated_at FROM accounts WHERE login=12345").fetchone()
        self.assertAlmostEqual(row[0], 100500.0)
        self.assertEqual(row[1], 1_700_000_000_000)

    def test_idempotent(self):
        args = dict(
            generated_at=1_700_000_000_000,
            account="12345,B,JPY,500,100000,100500,20000,80500,502.5,500",
            positions=["111,12345,XAUUSD,buy,0.1,2650,2600,2700,2655,50,-1,1700000000000"],
            deals=["9001,12345,8001,111,XAUUSD,buy,in,0.1,2650,0,-0.5,0,1699990000000,x"],
        )
        write_set(self.dir, **args)
        sync_once(self.dir, self.store)
        sync_once(self.dir, self.store)  # 2回目
        self.assertEqual(self._count("accounts"), 1)
        self.assertEqual(self._count("positions"), 1)
        self.assertEqual(self._count("deals"), 1)

    def test_positions_replaced(self):
        # 1回目は2建玉、2回目は1建玉（1つクローズ）→ 総入替で古い方が消える。
        write_set(
            self.dir, generated_at=1,
            account="12345,B,JPY,500,100000,100000,0,100000,0,0",
            positions=[
                "111,12345,XAUUSD,buy,0.1,2650,0,0,2655,50,0,1",
                "222,12345,EURUSD,sell,0.2,1.08,0,0,1.07,30,0,1",
            ],
            deals=[],
        )
        sync_once(self.dir, self.store)
        self.assertEqual(self._count("positions"), 2)
        write_set(
            self.dir, generated_at=2,
            account="12345,B,JPY,500,100000,100000,0,100000,0,0",
            positions=["111,12345,XAUUSD,buy,0.1,2650,0,0,2660,100,0,1"],
            deals=[],
        )
        sync_once(self.dir, self.store)
        self.assertEqual(self._count("positions"), 1)
        remaining = self.store.conn.execute("SELECT ticket, price_current FROM positions").fetchone()
        self.assertEqual(remaining[0], 111)
        self.assertAlmostEqual(remaining[1], 2660.0)  # 更新も効いている

    def test_deals_accumulate_and_update(self):
        write_set(self.dir, generated_at=1, account="12345,B,JPY,500,0,0,0,0,0,0", positions=[],
                  deals=["9001,12345,8001,111,XAUUSD,buy,in,0.1,2650,0,0,0,100,x"])
        sync_once(self.dir, self.store)
        # 新しい約定が増え、既存(9001)は profit が確定して更新される。
        write_set(self.dir, generated_at=2, account="12345,B,JPY,500,0,0,0,0,0,0", positions=[],
                  deals=[
                      "9001,12345,8001,111,XAUUSD,buy,in,0.1,2650,12.5,0,0,100,x",
                      "9002,12345,8002,111,XAUUSD,sell,out,0.1,2680,30,0,0,200,y",
                  ])
        sync_once(self.dir, self.store)
        self.assertEqual(self._count("deals"), 2)
        p = self.store.conn.execute("SELECT profit FROM deals WHERE deal_id=9001").fetchone()[0]
        self.assertAlmostEqual(p, 12.5)

    def test_manifest_missing_skips(self):
        # account.csv だけ置いて manifest 無し → スキップ（何も書かない）。
        write(os.path.join(self.dir, "account.csv"), [ACCOUNT_HEADER, "12345,B,JPY,500,1,1,0,1,0,0"])
        res = sync_once(self.dir, self.store)
        self.assertEqual(res.get("skipped"), "manifest_missing")
        self.assertEqual(self._count("accounts"), 0)

    def test_malformed_rows_tolerated(self):
        write_set(
            self.dir, generated_at=1,
            account="12345,B,JPY,500,100000,100000,0,100000,0,0",
            positions=[
                "111,12345,XAUUSD,buy,0.1,2650,0,0,2655,50,0,1",
                "bad,row,only,three",  # 壊れた行 → スキップ
                "333,12345,GBPUSD,buy,0.3,1.26,0,0,1.27,20,0,1",
            ],
            deals=[],
        )
        sync_once(self.dir, self.store)
        self.assertEqual(self._count("positions"), 2)  # 壊れた行以外の2件


if __name__ == "__main__":
    unittest.main()
