"""ロット計算と損失の上限（純関数）。"""
from __future__ import annotations

import math
from dataclasses import dataclass


@dataclass
class SymbolSpec:
    tick_size: float  # 価格の最小単位
    tick_value: float  # 1ロットで tick_size 動いたときの損益（口座通貨）
    volume_min: float
    volume_max: float
    volume_step: float
    stops_level_points: int = 0  # 現在値から損切り・利確を置ける最小距離（ポイント）
    point: float = 0.0


def lot_size(balance: float, risk_pct: float, entry: float, stop: float, spec: SymbolSpec) -> float:
    """損切りまで動いたときの損失が 残高×risk_pct% 以内になる最大のロット（刻みで切り捨て）。最小ロットでも超えるなら 0。"""
    dist = abs(entry - stop)
    if dist <= 0 or spec.tick_size <= 0 or spec.tick_value <= 0:
        return 0.0
    loss_per_lot = dist / spec.tick_size * spec.tick_value
    raw = balance * risk_pct / 100 / loss_per_lot
    steps = math.floor(raw / spec.volume_step + 1e-9)
    lot = round(steps * spec.volume_step, 8)
    if lot < spec.volume_min:
        return 0.0
    return min(lot, spec.volume_max)


def stops_ok(direction: str, entry: float, stop: float, target: float, spec: SymbolSpec) -> bool:
    """損切りと目標が正しい側にあり、最小距離（stops level）以上離れているか。"""
    min_dist = spec.stops_level_points * spec.point
    if direction == "long":
        return stop < entry - min_dist and target > entry + min_dist
    return stop > entry + min_dist and target < entry - min_dist


def daily_loss_exceeded(today_pnl: float, balance: float, max_loss_pct: float) -> bool:
    return today_pnl <= -balance * max_loss_pct / 100
