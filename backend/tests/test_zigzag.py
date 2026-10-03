from zigzag import Candle, Pivot, compute_zigzag


def line(prices: list[float], start: int = 0) -> list[Candle]:
    """高値=安値=終値 の単純なローソク列（ヒゲなし）を作る。"""
    return [Candle(time=f"t{start + i}", high=p, low=p) for i, p in enumerate(prices)]


def confirmed(pivots: list[Pivot]) -> list[Pivot]:
    return [p for p in pivots if p.confirmed]


def test_empty_or_short_returns_nothing():
    assert compute_zigzag([], 1.0) == []
    assert compute_zigzag(line([100]), 1.0) == []


def test_non_positive_threshold_returns_nothing():
    assert compute_zigzag(line([100, 110, 90]), 0) == []


def test_detects_low_then_high_on_up_down_move():
    # 100→110 上昇（1%で 100 が安値確定）→ 108 まで下落（110 から約1.8%）で 110 が高値確定。
    candles = line([100, 101, 105, 110, 108])
    pivots = compute_zigzag(candles, 1.0)
    conf = confirmed(pivots)
    assert [(p.price, p.type) for p in conf] == [(100, "low"), (110, "high")]


def test_appends_tentative_last_swing():
    candles = line([100, 101, 105, 110, 108])
    pivots = compute_zigzag(candles, 1.0)
    # 末尾は進行中（下降）の暫定安値。
    assert pivots[-1].confirmed is False
    assert pivots[-1].type == "low"
    assert pivots[-1].price == 108


def test_small_moves_below_threshold_produce_no_confirmed_pivots():
    # 0.5% 未満の揺れだけ → 確定転換なし。
    candles = line([100.0, 100.2, 100.1, 100.3, 100.15])
    assert confirmed(compute_zigzag(candles, 0.5)) == []


def test_uses_high_low_wicks():
    # 終値は横ばいでも、ヒゲで閾値を超えれば転換を捉える。
    candles = [
        Candle("t0", high=100, low=100),
        Candle("t1", high=112, low=100),  # 高値 112
        Candle("t2", high=101, low=98),   # 112 から約12%下落 → 高値確定
    ]
    conf = confirmed(compute_zigzag(candles, 5.0))
    assert conf[0].type == "high"
    assert conf[0].price == 112


def test_alternating_zigzag_sequence():
    # 明確なジグザグ: 100 →(+) 120 →(-) 100 →(+) 130
    candles = line([100, 120, 100, 130])
    types = [p.type for p in confirmed(compute_zigzag(candles, 5.0))]
    # low, high, low の確定（最後の 130 は進行中=暫定）
    assert types == ["low", "high", "low"]
