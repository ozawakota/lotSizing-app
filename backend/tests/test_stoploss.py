import math

from stoploss import (
    build_recommendation,
    compute_stop_loss,
    fib_check,
    fib_levels,
    latest_strength,
    parse_pair,
    pick_structural_swing,
    pip_size,
    strength_agreement,
    volume_signal,
)
from zigzag import Pivot


def piv(price, type_, confirmed=True, t="t"):
    return Pivot(time=t, price=price, type=type_, confirmed=confirmed)


def test_parse_pair_and_pip_size():
    assert parse_pair("GBP_USD") == ("GBP", "USD")
    assert pip_size("USD_JPY") == 0.01
    assert pip_size("GBP_USD") == 0.0001
    assert pip_size("XAU_USD") == 0.1


def test_latest_strength_sums_to_zero_and_ranks():
    # 全 X/JPY が同率上昇 → JPY だけ最弱、他7通貨は同値で最強。合計は ~0。
    rates = {c: [1.0, 1.1] for c in ["USD", "EUR", "GBP", "AUD", "NZD", "CAD", "CHF"]}
    s = latest_strength(rates, 0)
    assert abs(sum(s.values())) < 1e-9
    assert s["JPY"] == min(s.values())
    non_jpy = [s[c] for c in ["USD", "EUR", "GBP", "AUD", "NZD", "CAD", "CHF"]]
    assert max(non_jpy) - min(non_jpy) < 1e-9  # 7通貨は同値


def test_latest_strength_ranks_biggest_mover_strongest():
    rates = {c: [1.0, 1.0] for c in ["USD", "EUR", "GBP", "AUD", "NZD", "CAD", "CHF"]}
    rates["GBP"] = [1.0, 1.2]  # GBP/JPY だけ上昇 → GBP 最強、JPY 最弱寄り
    s = latest_strength(rates, 0)
    assert s["GBP"] == max(s.values())


def test_pick_structural_swing_long_takes_recent_low_below_price():
    pivots = [piv(1.2650, "low"), piv(1.2720, "high"), piv(1.2688, "low")]
    sw = pick_structural_swing(pivots, "long", current_price=1.2710)
    assert sw.price == 1.2688


def test_pick_structural_swing_short_takes_recent_high_above_price():
    pivots = [piv(1.2650, "low"), piv(1.2720, "high"), piv(1.2700, "low")]
    sw = pick_structural_swing(pivots, "short", current_price=1.2690)
    assert sw.price == 1.2720


def test_pick_structural_swing_returns_none_when_no_candidate():
    pivots = [piv(1.2720, "high")]
    assert pick_structural_swing(pivots, "long", 1.2600) is None


def test_compute_stop_loss_long_below_entry():
    sl = compute_stop_loss(1.2688, "long", entry=1.2710, buffer_pct=0.05, pip=0.0001)
    assert sl["price"] < 1.2688
    assert sl["basis"] == "swing_low"
    assert sl["distancePips"] > 0


def test_compute_stop_loss_short_above_entry():
    sl = compute_stop_loss(1.2720, "short", entry=1.2690, buffer_pct=0.05, pip=0.0001)
    assert sl["price"] > 1.2720
    assert sl["basis"] == "swing_high"


def test_fib_levels_and_check():
    pivots = [piv(1.2720, "high"), piv(1.2688, "low")]
    fib = fib_levels(pivots)
    assert fib["high"] == 1.2720 and fib["low"] == 1.2688
    # 0.618 水準は脚内にある
    assert fib["low"] < fib["levels"]["0.618"] < fib["high"]
    chk = fib_check(fib, sl_price=1.2679, swing_price=1.2688, direction="long")
    assert chk["beyond618"] is True  # 損切りは0.618より下


def test_strength_agreement_metal_is_none():
    assert strength_agreement("XAU", "USD", {"USD": 0.1}, "long") is None


def test_strength_agreement_agree_and_disagree():
    strengths = {"GBP": 1.0, "USD": -0.5}
    assert strength_agreement("GBP", "USD", strengths, "long")["agree"] is True
    assert strength_agreement("GBP", "USD", strengths, "short")["agree"] is False


def test_volume_signal_contrarian_support_and_crowded():
    # 個人が62%ショート、こちらは買い → 逆張り支持(+1)
    s, _, _ = volume_signal(38, 62, "long")
    assert s == 1
    # 個人が70%ロング、こちらも買い → 混雑注意(−1)
    s2, _, _ = volume_signal(70, 30, "long")
    assert s2 == -1
    # 偏りが小さい → 中立(0)
    s3, _, _ = volume_signal(52, 48, "long")
    assert s3 == 0


def test_build_recommendation_high_confidence_long():
    pivots = [piv(1.2650, "low"), piv(1.2720, "high"), piv(1.2688, "low", confirmed=False)]
    rec = build_recommendation(
        instrument="GBP_USD",
        direction="long",
        entry=1.2710,
        timeframe="1h",
        pivots=pivots,
        strengths={"GBP": 1.0, "USD": -0.5},
        flow={"longPct": 38, "shortPct": 62},
        buffer_pct=0.05,
    )
    assert rec["stopLoss"]["price"] < 1.2710
    assert rec["stopLoss"]["basis"] == "swing_low"
    assert rec["confidence"]["level"] == "high"
    assert rec["confidence"]["score"] == 3
    assert rec["signals"]["volume"]["lean"] == "sell"


def test_build_recommendation_no_swing_returns_error():
    rec = build_recommendation(
        instrument="GBP_USD", direction="long", entry=1.0,
        timeframe="1h", pivots=[piv(2.0, "high")], strengths=None, flow=None, buffer_pct=0.05,
    )
    assert "error" in rec
