"""MT5（MetaTrader5 パッケージ）への薄いアダプタ。ボット本体はこの Broker の形だけを使う。

MetaTrader5 パッケージは Windows 版 Python（OCI では Wine 上）でのみ動く。テストは FakeBroker を使う。
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Protocol

from .risk import SymbolSpec


@dataclass
class Account:
    login: int
    balance: float
    equity: float
    currency: str
    is_demo: bool


@dataclass
class Tick:
    bid: float
    ask: float


@dataclass
class OpenItem:
    """ボットのポジション、または待機中の指値。"""
    ticket: int
    symbol: str
    kind: str  # "position" | "order"
    setup_time: float  # UNIX 秒
    profit: float = 0.0


@dataclass
class OrderResult:
    ok: bool
    ticket: int | None
    message: str


class Broker(Protocol):
    def account(self) -> Account: ...
    def spec(self, symbol: str) -> SymbolSpec: ...
    def tick(self, symbol: str) -> Tick: ...
    def open_items(self, magic: int) -> list[OpenItem]: ...
    def today_realized(self, magic: int, since: datetime) -> float: ...
    def send(self, *, symbol: str, direction: str, order: str, volume: float, price: float, stop: float,
             target: float, magic: int, comment: str, deviation: int) -> OrderResult: ...
    def cancel(self, ticket: int) -> OrderResult: ...


class Mt5Broker:
    def __init__(self, *, path: str | None = None, login: int | None = None, password: str | None = None,
                 server: str | None = None):
        import MetaTrader5 as mt5  # Windows 版 Python のみ

        self.mt5 = mt5
        kwargs: dict = {}
        if path:
            kwargs["path"] = path
        if login:
            kwargs.update(login=login, password=password or "", server=server or "")
        if not mt5.initialize(**kwargs):
            raise RuntimeError(f"MT5 に接続できません: {mt5.last_error()}")

    def shutdown(self) -> None:
        self.mt5.shutdown()

    def account(self) -> Account:
        a = self.mt5.account_info()
        if a is None:
            raise RuntimeError(f"口座情報を取得できません: {self.mt5.last_error()}")
        return Account(a.login, a.balance, a.equity, a.currency, a.trade_mode == self.mt5.ACCOUNT_TRADE_MODE_DEMO)

    def _info(self, symbol: str):
        if not self.mt5.symbol_select(symbol, True):
            raise RuntimeError(f"シンボル {symbol} を選択できません（ブローカーのシンボル名を確認）")
        info = self.mt5.symbol_info(symbol)
        if info is None:
            raise RuntimeError(f"シンボル {symbol} の情報がありません")
        return info

    def spec(self, symbol: str) -> SymbolSpec:
        i = self._info(symbol)
        return SymbolSpec(
            tick_size=i.trade_tick_size,
            tick_value=i.trade_tick_value,
            volume_min=i.volume_min,
            volume_max=i.volume_max,
            volume_step=i.volume_step,
            stops_level_points=i.trade_stops_level,
            point=i.point,
        )

    def tick(self, symbol: str) -> Tick:
        self._info(symbol)
        t = self.mt5.symbol_info_tick(symbol)
        if t is None:
            raise RuntimeError(f"{symbol} のレートを取得できません")
        return Tick(t.bid, t.ask)

    def open_items(self, magic: int) -> list[OpenItem]:
        items = [
            OpenItem(p.ticket, p.symbol, "position", p.time, p.profit + p.swap)
            for p in (self.mt5.positions_get() or [])
            if p.magic == magic
        ]
        items += [
            OpenItem(o.ticket, o.symbol, "order", o.time_setup)
            for o in (self.mt5.orders_get() or [])
            if o.magic == magic
        ]
        return items

    def today_realized(self, magic: int, since: datetime) -> float:
        deals = self.mt5.history_deals_get(since, datetime.now(timezone.utc)) or []
        return sum(d.profit + d.swap + d.commission for d in deals if d.magic == magic)

    def _filling(self, symbol: str, order: str) -> int:
        mt5 = self.mt5
        if order in ("limit", "stop"):
            return mt5.ORDER_FILLING_RETURN
        mode = self._info(symbol).filling_mode  # ビット: 1=FOK, 2=IOC
        if mode & 2:
            return mt5.ORDER_FILLING_IOC
        if mode & 1:
            return mt5.ORDER_FILLING_FOK
        return mt5.ORDER_FILLING_RETURN

    def send(self, *, symbol, direction, order, volume, price, stop, target, magic, comment, deviation) -> OrderResult:
        mt5 = self.mt5
        digits = self._info(symbol).digits
        if order == "market":
            t = self.tick(symbol)
            req_type = mt5.ORDER_TYPE_BUY if direction == "long" else mt5.ORDER_TYPE_SELL
            price = t.ask if direction == "long" else t.bid
            action = mt5.TRADE_ACTION_DEAL
        elif order == "limit":  # 指値: 今より有利な価格まで来たら約定
            req_type = mt5.ORDER_TYPE_BUY_LIMIT if direction == "long" else mt5.ORDER_TYPE_SELL_LIMIT
            action = mt5.TRADE_ACTION_PENDING
        else:  # 逆指値: 帯を抜けて価格がそこまで来たら約定（ブレイク狙い）
            req_type = mt5.ORDER_TYPE_BUY_STOP if direction == "long" else mt5.ORDER_TYPE_SELL_STOP
            action = mt5.TRADE_ACTION_PENDING
        req = {
            "action": action,
            "symbol": symbol,
            "volume": float(volume),
            "type": req_type,
            "price": round(price, digits),
            "sl": round(stop, digits),
            "tp": round(target, digits),
            "deviation": deviation,
            "magic": magic,
            "comment": comment[:31],
            "type_time": mt5.ORDER_TIME_GTC,  # 有効期限はボットが管理（ブローカーごとの期限指定の差を避ける）
            "type_filling": self._filling(symbol, order),
        }
        r = mt5.order_send(req)
        if r is None:
            return OrderResult(False, None, f"order_send 失敗: {mt5.last_error()}")
        ok = r.retcode in (mt5.TRADE_RETCODE_DONE, mt5.TRADE_RETCODE_PLACED)
        return OrderResult(ok, r.order or None, f"retcode={r.retcode} {r.comment}")

    def cancel(self, ticket: int) -> OrderResult:
        mt5 = self.mt5
        r = mt5.order_send({"action": mt5.TRADE_ACTION_REMOVE, "order": ticket})
        if r is None:
            return OrderResult(False, ticket, f"取消失敗: {mt5.last_error()}")
        return OrderResult(r.retcode == mt5.TRADE_RETCODE_DONE, ticket, f"retcode={r.retcode} {r.comment}")
