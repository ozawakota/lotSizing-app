"""ボット本体: 1サイクル = 期限切れ指値の取消 → 各ペアの判定 → 条件を満たせば発注。"""
from __future__ import annotations

import json
import logging
import os
import time
from datetime import datetime, timedelta, timezone

from .broker import Broker
from .config import Config
from .risk import daily_loss_exceeded, lot_size, stops_ok
from .signal import Skip, TradePlan, build_plan, fetch_mtf, shift_plan

log = logging.getLogger("autotrade")
JST = timezone(timedelta(hours=9))
ORDER_JA = {"market": "成行", "limit": "指値", "stop": "逆指値"}


def jst_midnight(now: datetime) -> datetime:
    j = now.astimezone(JST)
    return j.replace(hour=0, minute=0, second=0, microsecond=0).astimezone(timezone.utc)


def pip_size(instrument: str) -> float:
    if instrument.startswith("XAU"):
        return 0.1
    return 0.01 if instrument.endswith("JPY") else 0.0001


class State:
    """直近に入ったセットアップ（重複防止）。小さな JSON に保存する。"""

    def __init__(self, path: str):
        self.path = path
        self.last_entry: dict[str, float] = {}
        if os.path.exists(path):
            try:
                with open(path, encoding="utf-8") as f:
                    self.last_entry = json.load(f).get("last_entry", {})
            except (OSError, ValueError):
                self.last_entry = {}

    def save(self) -> None:
        tmp = self.path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump({"last_entry": self.last_entry}, f)
        os.replace(tmp, self.path)


class Bot:
    def __init__(self, cfg: Config, broker: Broker, fetch=fetch_mtf, now=lambda: datetime.now(timezone.utc)):
        self.cfg = cfg
        self.broker = broker
        self.fetch = fetch
        self.now = now
        self.state = State(cfg.state_path)

    def run_once(self) -> list[str]:
        """1サイクル。何をしたか（または見送った理由）を1行ずつ返す。"""
        cfg = self.cfg
        out: list[str] = []
        acct = self.broker.account()
        if cfg.demo_only and not acct.is_demo:
            msg = f"口座 {acct.login} はデモ口座ではないため発注しません（demo_only=true）"
            log.error(msg)
            return [msg]

        now = self.now()
        items = self.broker.open_items(cfg.magic)

        # 1) 期限切れの待機注文（指値・逆指値）を取り消す。
        for it in [i for i in items if i.kind == "order"]:
            if now.timestamp() - it.setup_time > cfg.limit_expiry_hours * 3600:
                r = (self.broker.cancel(it.ticket) if not cfg.dry_run else None)
                out.append(f"{it.symbol}: 期限切れの待機注文 #{it.ticket} を取消" + ("（dry-run）" if cfg.dry_run else f" {r.message if r else ''}"))
        items = self.broker.open_items(cfg.magic)

        # 2) その日の損失の上限（確定損益＋含み損益）。
        today = self.broker.today_realized(cfg.magic, jst_midnight(now)) + sum(i.profit for i in items)
        if daily_loss_exceeded(today, acct.balance, cfg.daily_max_loss_pct):
            out.append(f"本日の損失 {today:.0f} {acct.currency} が上限（残高の{cfg.daily_max_loss_pct}%）に達したため新規発注を停止")
            return out

        for pair in cfg.pairs:
            if len(items) >= cfg.max_positions:
                out.append(f"同時ポジションの上限（{cfg.max_positions}）に達しています")
                break
            if any(i.symbol == pair.symbol for i in items):
                out.append(f"{pair.instrument}: 既にポジション/指値あり")
                continue
            try:
                line, placed = self._try_pair(pair, acct, now)
            except Exception as e:  # 1ペアの失敗で全体を止めない
                log.exception("ペア処理失敗 %s", pair.instrument)
                line, placed = f"{pair.instrument}: エラー {e}", False
            out.append(line)
            if placed:
                items = self.broker.open_items(cfg.magic)
        self.state.save()
        return out

    def _try_pair(self, pair, acct, now: datetime) -> tuple[str, bool]:
        """(結果の1行, 実際に注文を送って受け付けられたか)。"""
        cfg = self.cfg
        body = self.fetch(cfg.mtf_url, pair.instrument)
        plan = build_plan(
            body, pair.instrument, pair.timeframe, use_limit=cfg.use_limit_orders, min_rr=cfg.min_rr, use_stop=cfg.use_stop_orders
        )
        if isinstance(plan, Skip):
            return f"{plan.instrument}: 見送り（{plan.reason}）", False

        last = self.state.last_entry.get(plan.key)
        if last and now.timestamp() - last < cfg.cooldown_hours * 3600:
            return f"{pair.instrument}: 見送り（同じ向きで {cfg.cooldown_hours}時間以内に入ったばかり）", False

        tick = self.broker.tick(pair.symbol)
        spread_pips = (tick.ask - tick.bid) / pip_size(pair.instrument)
        if spread_pips > cfg.max_spread_pips:
            return f"{pair.instrument}: 見送り（スプレッド {spread_pips:.1f}pips が広い）", False

        mid = (tick.bid + tick.ask) / 2
        if pair.instrument.startswith("XAU"):
            # /mtf の XAU は金先物（GC=F）基準。現物との差（ベーシス）だけ平行移動する。
            plan = shift_plan(plan, mid)
        elif abs(mid - plan.ref_price) > abs(plan.ref_price - plan.stop) * 0.5:
            # 判定の後に損切り幅の半分以上動いた（判定が古い）。損切り・目標は価格の節目なので動かさず見送る。
            return f"{pair.instrument}: 見送り（判定時 {plan.ref_price:.5g} から {mid:.5g} へ動きすぎ）", False
        spec = self.broker.spec(pair.symbol)
        long = plan.direction == "long"
        if plan.order == "market":
            entry = tick.ask if long else tick.bid
        elif plan.order == "limit":
            entry = plan.entry
            # 指値は現在値より有利な側でなければならない（買い指値 < ask / 売り指値 > bid）。
            if (long and entry >= tick.ask) or (not long and entry <= tick.bid):
                return f"{pair.instrument}: 見送り（指値 {entry:.5g} が現在値を越えている）", False
        else:
            entry = plan.entry
            # 逆指値は現在値より先（買い逆指値 > ask / 売り逆指値 < bid）。既に抜けていたら追いかけない。
            if (long and entry <= tick.ask) or (not long and entry >= tick.bid):
                return f"{pair.instrument}: 見送り（逆指値 {entry:.5g} を既に越えている）", False
        if not stops_ok(plan.direction, entry, plan.stop, plan.target, spec):
            return f"{pair.instrument}: 見送り（損切り/目標の位置が不正または近すぎる）", False

        volume = lot_size(acct.balance, cfg.risk_pct, entry, plan.stop, spec)
        if volume <= 0:
            return f"{pair.instrument}: 見送り（最小ロットでも許容損失 {cfg.risk_pct}% を超える）", False

        desc = (
            f"{pair.instrument} {'買い' if long else '売り'} {ORDER_JA[plan.order]} "
            f"{volume}lot @ {entry:.5g} 損切 {plan.stop:.5g} 目標 {plan.target:.5g} RR 1:{plan.rr:.1f}（{pair.timeframe}・{plan.verdict}）"
        )
        if cfg.dry_run:
            self.state.last_entry[plan.key] = now.timestamp()
            return f"発注（dry-run・送信なし）: {desc}", False
        r = self.broker.send(
            symbol=pair.symbol, direction=plan.direction, order=plan.order, volume=volume, price=entry,
            stop=plan.stop, target=plan.target, magic=cfg.magic, comment=f"lotsizing {pair.timeframe} {plan.verdict}",
            deviation=cfg.deviation_points,
        )
        if not r.ok:
            return f"発注失敗: {desc} — {r.message}", False
        self.state.last_entry[plan.key] = now.timestamp()
        return f"発注: {desc} — #{r.ticket} {r.message}", True


def run_loop(bot: Bot, poll_seconds: int) -> None:
    while True:
        try:
            for line in bot.run_once():
                log.info(line)
        except Exception:
            log.exception("サイクル失敗（次回リトライ）")
        time.sleep(poll_seconds)
