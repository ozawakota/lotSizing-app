"""標準ライブラリだけの単体テスト（MT5 不要）。  python3 -m unittest discover -s tests -v"""
from __future__ import annotations

import os
import sys
import tempfile
import unittest
from datetime import datetime, timezone

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from autotrade.bot import Bot, jst_midnight  # noqa: E402
from autotrade.broker import Account, OpenItem, OrderResult, Tick  # noqa: E402
from autotrade.config import Config, PairConfig  # noqa: E402
from autotrade.risk import SymbolSpec, daily_loss_exceeded, lot_size, stops_ok  # noqa: E402
from autotrade.signal import Skip, TradePlan, build_plan, shift_plan  # noqa: E402

NOW = datetime(2026, 10, 30, 3, 0, tzinfo=timezone.utc)
# USDJPY を円口座で: 1ロット=10万通貨、0.001 動くと 100円 → tick_value=100
USDJPY = SymbolSpec(tick_size=0.001, tick_value=100.0, volume_min=0.01, volume_max=100,
                    volume_step=0.01, stops_level_points=10, point=0.001)


def mtf(verdict="ok", rr=3.0, qualifies=True, limit=None, direction="long", current=150.0, stop=149.5, target=151.5,
        stop_entry=None):
    return {
        "currentRate": current,
        "timeframes": [
            {
                "tf": "1h",
                "rr": {"direction": direction, "stop": stop, "target": target, "rr": rr, "qualifies": qualifies, "spreadPips": 0.3},
                "timing": {"verdict": verdict, "reasons": [{"label": "直近の値幅の上の方（90%）", "points": 2}], "limit": limit},
                "stopEntry": stop_entry,
            }
        ],
    }


class FakeBroker:
    def __init__(self, *, demo=True, bid=149.998, ask=150.002, items=None, realized=0.0, spec=USDJPY):
        self.acct = Account(123, 1_000_000, 1_000_000, "JPY", demo)
        self._tick = Tick(bid, ask)
        self.items = list(items or [])
        self.realized = realized
        self._spec = spec
        self.sent: list[dict] = []
        self.cancelled: list[int] = []

    def account(self):
        return self.acct

    def spec(self, symbol):
        return self._spec

    def tick(self, symbol):
        return self._tick

    def open_items(self, magic):
        return list(self.items)

    def today_realized(self, magic, since):
        return self.realized

    def send(self, **kw):
        self.sent.append(kw)
        self.items.append(OpenItem(len(self.sent), kw["symbol"], "position" if kw["order"] == "market" else "order", NOW.timestamp()))
        return OrderResult(True, len(self.sent), "retcode=10009 done")

    def cancel(self, ticket):
        self.cancelled.append(ticket)
        self.items = [i for i in self.items if i.ticket != ticket]
        return OrderResult(True, ticket, "retcode=10009")


def make_bot(broker, body, **over):
    d = tempfile.mkdtemp()
    cfg = Config(pairs=[PairConfig("USD_JPY", "USDJPY", "1h")], dry_run=False, state_path=os.path.join(d, "s.json"), **over)
    return Bot(cfg, broker, fetch=lambda url, inst: body, now=lambda: NOW)


class SignalTest(unittest.TestCase):
    def test_ok_is_market(self):
        p = build_plan(mtf("ok"), "USD_JPY", "1h", use_limit=True, min_rr=2.0)
        self.assertIsInstance(p, TradePlan)
        self.assertEqual((p.order, p.entry, p.stop, p.target), ("market", 150.0, 149.5, 151.5))

    def test_wait_is_limit_at_suggested_price(self):
        p = build_plan(mtf("wait", limit={"price": 149.8, "rr": 5.0}), "USD_JPY", "1h", use_limit=True, min_rr=2.0)
        self.assertEqual((p.order, p.entry, p.rr), ("limit", 149.8, 5.0))

    def test_avoid_and_no_direction_and_low_rr_are_skipped(self):
        self.assertIsInstance(build_plan(mtf("avoid"), "USD_JPY", "1h", use_limit=True, min_rr=2.0), Skip)
        body = mtf()
        body["timeframes"][0]["rr"] = None
        self.assertIsInstance(build_plan(body, "USD_JPY", "1h", use_limit=True, min_rr=2.0), Skip)
        self.assertIsInstance(build_plan(mtf("ok", rr=1.5, qualifies=False), "USD_JPY", "1h", use_limit=True, min_rr=2.0), Skip)
        self.assertIsInstance(build_plan(mtf("wait", limit=None), "USD_JPY", "1h", use_limit=True, min_rr=2.0), Skip)
        self.assertIsInstance(
            build_plan(mtf("wait", limit={"price": 149.8, "rr": 5.0}), "USD_JPY", "1h", use_limit=False, min_rr=2.0), Skip)

    def test_avoid_uses_stop_entry_when_available(self):
        se = {"price": 150.2, "rr": 2.4, "breakPct": 62, "zoneLabel": "R1", "distancePips": 20}
        p = build_plan(mtf("avoid", stop_entry=se), "USD_JPY", "1h", use_limit=True, min_rr=2.0, use_stop=True)
        self.assertEqual((p.order, p.entry, p.rr, p.stop, p.target), ("stop", 150.2, 2.4, 149.5, 151.5))
        # 逆指値を使わない設定・RR 不足なら見送り
        self.assertIsInstance(build_plan(mtf("avoid", stop_entry=se), "USD_JPY", "1h", use_limit=True, min_rr=2.0), Skip)
        low = {**se, "rr": 1.5}
        s = build_plan(mtf("avoid", stop_entry=low), "USD_JPY", "1h", use_limit=True, min_rr=2.0, use_stop=True)
        self.assertIsInstance(s, Skip)
        self.assertIn("逆指値での RR 不足", s.reason)

    def test_wait_prefers_limit_and_falls_back_to_stop(self):
        se = {"price": 150.2, "rr": 2.4}
        p = build_plan(mtf("wait", limit={"price": 149.8, "rr": 5.0}, stop_entry=se), "USD_JPY", "1h",
                       use_limit=True, min_rr=2.0, use_stop=True)
        self.assertEqual(p.order, "limit")
        p2 = build_plan(mtf("wait", limit=None, stop_entry=se), "USD_JPY", "1h", use_limit=True, min_rr=2.0, use_stop=True)
        self.assertEqual(p2.order, "stop")

    def test_shift_moves_all_levels(self):
        p = build_plan(mtf("ok", current=2400.0, stop=2390.0, target=2430.0), "XAU_USD", "1h", use_limit=True, min_rr=2.0)
        s = shift_plan(p, 2390.0)  # 現物は先物より 10 安い
        self.assertEqual((s.entry, s.stop, s.target), (2390.0, 2380.0, 2420.0))


class RiskTest(unittest.TestCase):
    def test_lot_size_keeps_loss_within_risk(self):
        # 残高100万円・2% = 2万円、損切り 50pips(0.5円) → 1ロットで 5万円の損 → 0.4 ロット
        self.assertAlmostEqual(lot_size(1_000_000, 2.0, 150.0, 149.5, USDJPY), 0.4)

    def test_lot_size_zero_when_min_lot_exceeds_risk(self):
        self.assertEqual(lot_size(1_000, 2.0, 150.0, 149.5, USDJPY), 0.0)

    def test_stops(self):
        self.assertTrue(stops_ok("long", 150.0, 149.5, 151.0, USDJPY))
        self.assertFalse(stops_ok("long", 150.0, 150.5, 151.0, USDJPY))  # 損切りが上
        self.assertFalse(stops_ok("short", 150.0, 150.005, 149.0, USDJPY))  # 近すぎ（stops level 10pt=0.01）

    def test_daily_loss(self):
        self.assertTrue(daily_loss_exceeded(-60_000, 1_000_000, 6.0))
        self.assertFalse(daily_loss_exceeded(-59_999, 1_000_000, 6.0))

    def test_jst_midnight(self):
        self.assertEqual(jst_midnight(NOW), datetime(2026, 10, 29, 15, 0, tzinfo=timezone.utc))


class BotTest(unittest.TestCase):
    def test_market_order_sent_with_risk_lot(self):
        b = FakeBroker()
        out = make_bot(b, mtf("ok")).run_once()
        self.assertEqual(len(b.sent), 1, out)
        s = b.sent[0]
        self.assertEqual((s["order"], s["direction"], s["stop"], s["target"]), ("market", "long", 149.5, 151.5))
        self.assertAlmostEqual(s["volume"], 0.39)  # entry=ask 150.002 → 損切り幅 0.502 → 0.398 → 0.39

    def test_limit_order(self):
        b = FakeBroker()
        make_bot(b, mtf("wait", limit={"price": 149.8, "rr": 5.0})).run_once()
        self.assertEqual((b.sent[0]["order"], b.sent[0]["price"]), ("limit", 149.8))

    def test_stop_order_sent_above_price(self):
        b = FakeBroker()
        se = {"price": 150.2, "rr": 2.4}
        bot = make_bot(b, mtf("avoid", stop_entry=se))
        bot.run_once()
        self.assertEqual((b.sent[0]["order"], b.sent[0]["price"]), ("stop", 150.2))
        # 損切り 149.5 まで 0.7 → 1ロット 7万円の損 → 2万円 / 7万 = 0.28
        self.assertAlmostEqual(b.sent[0]["volume"], 0.28)

    def test_stop_order_skipped_when_already_broken(self):
        b = FakeBroker(bid=150.218, ask=150.222)  # 逆指値 150.2 を既に越えている（判定時から 22pips < 損切り幅の半分）
        out = make_bot(b, mtf("avoid", stop_entry={"price": 150.2, "rr": 2.4})).run_once()
        self.assertEqual(b.sent, [])
        self.assertTrue(any("既に越えている" in l for l in out), out)

    def test_dry_run_sends_nothing(self):
        b = FakeBroker()
        bot = make_bot(b, mtf("ok"))
        bot.cfg.dry_run = True
        out = bot.run_once()
        self.assertEqual(b.sent, [])
        self.assertTrue(any("dry-run" in l for l in out))

    def test_real_account_refused(self):
        b = FakeBroker(demo=False)
        out = make_bot(b, mtf("ok")).run_once()
        self.assertEqual(b.sent, [])
        self.assertIn("デモ口座ではない", out[0])

    def test_skips_when_position_exists_or_cooldown(self):
        b = FakeBroker(items=[OpenItem(9, "USDJPY", "position", NOW.timestamp())])
        make_bot(b, mtf("ok")).run_once()
        self.assertEqual(b.sent, [])
        b2 = FakeBroker()
        bot = make_bot(b2, mtf("ok"))
        bot.run_once()
        b2.items.clear()  # 決済された
        bot.run_once()  # 4時間以内なので入らない
        self.assertEqual(len(b2.sent), 1)

    def test_skips_wide_spread_and_stale_signal(self):
        b = FakeBroker(bid=149.98, ask=150.02)  # 4pips
        make_bot(b, mtf("ok")).run_once()
        self.assertEqual(b.sent, [])
        b2 = FakeBroker(bid=150.298, ask=150.302)  # 判定時 150.0 から 30pips（損切り幅 50pips の半分超）
        out = make_bot(b2, mtf("ok")).run_once()
        self.assertEqual(b2.sent, [])
        self.assertTrue(any("動きすぎ" in l for l in out))

    def test_daily_loss_stops_new_orders(self):
        b = FakeBroker(realized=-70_000)
        out = make_bot(b, mtf("ok")).run_once()
        self.assertEqual(b.sent, [])
        self.assertTrue(any("新規発注を停止" in l for l in out))

    def test_expired_limit_is_cancelled(self):
        old = NOW.timestamp() - 5 * 3600
        b = FakeBroker(items=[OpenItem(7, "USDJPY", "order", old)])
        make_bot(b, mtf("avoid")).run_once()
        self.assertEqual(b.cancelled, [7])


if __name__ == "__main__":
    unittest.main()
