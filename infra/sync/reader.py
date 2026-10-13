"""MQL5 EA が出力した CSV を読み、型付きデータに変換する純ロジック。

EA は MQL5/Files/mt5sync/ に以下をアトミックに出力する（tmp 書き→FileMove）:
  - account.csv    : ヘッダ + 1行（口座状態）
  - positions.csv  : ヘッダ + N行（現在の建玉）
  - deals.csv      : ヘッダ + N行（クローズ約定履歴）
  - manifest.csv   : ヘッダ + 1行（generated_at=epoch ms と各件数）。最後に書く＝1セット完了の合図。

ファイル未生成・部分書き込み・欠損列に強い（壊れた行はスキップ）。ネットワーク非依存。
"""

from __future__ import annotations

import csv
import os
from dataclasses import dataclass


@dataclass
class Account:
    login: int
    broker: str
    currency: str
    leverage: int
    balance: float
    equity: float
    margin: float
    margin_free: float
    margin_level: float
    profit: float


@dataclass
class Position:
    ticket: int
    login: int
    symbol: str
    type: str
    volume: float
    price_open: float
    sl: float
    tp: float
    price_current: float
    profit: float
    swap: float
    time_open: int


@dataclass
class Deal:
    deal_id: int
    login: int
    order_id: int
    position_id: int
    symbol: str
    type: str
    entry: str
    volume: float
    price: float
    profit: float
    commission: float
    swap: float
    time: int
    comment: str


def _f(v: str) -> float:
    try:
        return float(v)
    except (TypeError, ValueError):
        return 0.0


def _i(v: str) -> int:
    try:
        return int(float(v))  # "123.0" も許容
    except (TypeError, ValueError):
        return 0


def _rows(sync_dir: str, name: str) -> list[dict]:
    path = os.path.join(sync_dir, name)
    if not os.path.isfile(path):
        return []
    try:
        with open(path, newline="", encoding="utf-8") as f:
            return list(csv.DictReader(f))
    except (OSError, csv.Error):
        return []


def read_manifest(sync_dir: str) -> dict | None:
    """1セット完了の合図。無ければ None（＝まだ出力中 or 未生成）。"""
    rows = _rows(sync_dir, "manifest.csv")
    if not rows:
        return None
    r = rows[0]
    gen = _i(r.get("generated_at", "0"))
    if gen <= 0:
        return None
    return {"generated_at": gen}


def read_account(sync_dir: str) -> Account | None:
    rows = _rows(sync_dir, "account.csv")
    if not rows:
        return None
    r = rows[0]
    login = _i(r.get("login", "0"))
    if login <= 0:
        return None
    return Account(
        login=login,
        broker=r.get("broker", ""),
        currency=r.get("currency", ""),
        leverage=_i(r.get("leverage", "0")),
        balance=_f(r.get("balance", "0")),
        equity=_f(r.get("equity", "0")),
        margin=_f(r.get("margin", "0")),
        margin_free=_f(r.get("margin_free", "0")),
        margin_level=_f(r.get("margin_level", "0")),
        profit=_f(r.get("profit", "0")),
    )


def read_positions(sync_dir: str) -> list[Position]:
    out: list[Position] = []
    for r in _rows(sync_dir, "positions.csv"):
        ticket = _i(r.get("ticket", "0"))
        if ticket <= 0:
            continue
        out.append(
            Position(
                ticket=ticket,
                login=_i(r.get("login", "0")),
                symbol=r.get("symbol", ""),
                type=r.get("type", ""),
                volume=_f(r.get("volume", "0")),
                price_open=_f(r.get("price_open", "0")),
                sl=_f(r.get("sl", "0")),
                tp=_f(r.get("tp", "0")),
                price_current=_f(r.get("price_current", "0")),
                profit=_f(r.get("profit", "0")),
                swap=_f(r.get("swap", "0")),
                time_open=_i(r.get("time_open", "0")),
            )
        )
    return out


def read_deals(sync_dir: str) -> list[Deal]:
    out: list[Deal] = []
    for r in _rows(sync_dir, "deals.csv"):
        deal_id = _i(r.get("deal_id", "0"))
        if deal_id <= 0:
            continue
        out.append(
            Deal(
                deal_id=deal_id,
                login=_i(r.get("login", "0")),
                order_id=_i(r.get("order_id", "0")),
                position_id=_i(r.get("position_id", "0")),
                symbol=r.get("symbol", ""),
                type=r.get("type", ""),
                entry=r.get("entry", ""),
                volume=_f(r.get("volume", "0")),
                price=_f(r.get("price", "0")),
                profit=_f(r.get("profit", "0")),
                commission=_f(r.get("commission", "0")),
                swap=_f(r.get("swap", "0")),
                time=_i(r.get("time", "0")),
                comment=r.get("comment", ""),
            )
        )
    return out
