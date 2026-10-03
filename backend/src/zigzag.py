"""エリオット波動の土台となる ZigZag（スイング転換点）検出。純ロジック・依存なし。

パーセント偏差方式: 直近の基準となる極値から価格が threshold_pct% 以上逆行したら
その極値を転換点（pivot）として確定し、方向を反転する。銘柄非依存（FX もゴールドも同じ）。
高値・安値（mid の h/l）を用いて、ヒゲ先での転換も捉える。

末尾の「進行中スイング」の暫定極値は confirmed=False の pivot として1件付与する
（最新の未確定スイングを使えるようにするため）。
"""

from dataclasses import asdict, dataclass
from typing import Literal

PivotType = Literal["high", "low"]


@dataclass
class Candle:
    time: str
    high: float
    low: float


@dataclass
class Pivot:
    time: str
    price: float
    type: PivotType
    confirmed: bool

    def as_dict(self) -> dict:
        return asdict(self)


def compute_zigzag(candles: list[Candle], threshold_pct: float) -> list[Pivot]:
    """ZigZag 転換点を時系列順に返す。candles は時刻昇順を前提。"""
    if len(candles) < 2 or threshold_pct <= 0:
        return []

    thr = threshold_pct / 100.0
    pivots: list[Pivot] = []

    trend = 0  # 1=上昇, -1=下降, 0=未確定
    ref_high = candles[0].high
    ref_high_i = 0
    ref_low = candles[0].low
    ref_low_i = 0

    for i in range(1, len(candles)):
        c = candles[i]
        if trend == 0:
            # 未確定: 高安を更新しつつ、どちらに閾値ブレイクしたかで初期方向を決める。
            if c.high > ref_high:
                ref_high, ref_high_i = c.high, i
            if c.low < ref_low:
                ref_low, ref_low_i = c.low, i
            if c.low <= ref_high * (1 - thr):
                pivots.append(Pivot(candles[ref_high_i].time, ref_high, "high", True))
                trend, ref_low, ref_low_i = -1, c.low, i
            elif c.high >= ref_low * (1 + thr):
                pivots.append(Pivot(candles[ref_low_i].time, ref_low, "low", True))
                trend, ref_high, ref_high_i = 1, c.high, i
        elif trend == 1:
            # 上昇中: 高値を更新。閾値%下落で high を確定し下降へ反転。
            if c.high > ref_high:
                ref_high, ref_high_i = c.high, i
            if c.low <= ref_high * (1 - thr):
                pivots.append(Pivot(candles[ref_high_i].time, ref_high, "high", True))
                trend, ref_low, ref_low_i = -1, c.low, i
        else:  # trend == -1
            # 下降中: 安値を更新。閾値%上昇で low を確定し上昇へ反転。
            if c.low < ref_low:
                ref_low, ref_low_i = c.low, i
            if c.high >= ref_low * (1 + thr):
                pivots.append(Pivot(candles[ref_low_i].time, ref_low, "low", True))
                trend, ref_high, ref_high_i = 1, c.high, i

    # 末尾の進行中スイングの極値を暫定 pivot として付与。
    if trend == 1:
        pivots.append(Pivot(candles[ref_high_i].time, ref_high, "high", False))
    elif trend == -1:
        pivots.append(Pivot(candles[ref_low_i].time, ref_low, "low", False))

    return pivots
