"""損切り位置サジェストの純ロジック（構造ファースト + 確信度）。副作用なし・テスト可能。

- 損切り価格は構造（直近 ZigZag スイング）で決める。Fib は照合（注釈）、強弱・取引量は
  確信度（価格は動かさない）。
- build_recommendation() は I/O を一切せず、取得済みの pivots / strength / flow から
  推奨を組み立てる。取得は app.py / signals.py が担う。
"""

import math

from zigzag import Pivot

CURRENCIES = ["JPY", "USD", "EUR", "GBP", "AUD", "NZD", "CAD", "CHF"]
JPY_PAIRS = ["USD", "EUR", "GBP", "AUD", "NZD", "CAD", "CHF"]

# Fib リトレースメント比率。
FIB_RATIOS = [0.236, 0.382, 0.5, 0.618, 0.786]


def parse_pair(instrument: str) -> tuple[str, str]:
    """'GBP_USD' → ('GBP','USD')。"""
    base, _, quote = instrument.partition("_")
    return base, quote


def pip_size(instrument: str) -> float:
    base, quote = parse_pair(instrument)
    if base in ("XAU", "XAG"):
        return 0.1  # メタルは 0.1 を 1pip として扱う
    if quote == "JPY":
        return 0.01
    return 0.0001


# ---------------------------------------------------------------------------
# 通貨強弱（累積対数法）。src/lib/strength.ts の computeCumulativeStrength の最新値を移植。
# ---------------------------------------------------------------------------
def latest_strength(rates: dict[str, list[float]], start_index: int) -> dict[str, float]:
    """各通貨の最新時点の累積対数強弱(%)を返す。rates は {pair: [closes]}（JPY_PAIRS）。"""
    cum: dict[str, float] = {"JPY": 0.0}
    for p in JPY_PAIRS:
        arr = rates[p]
        cum[p] = math.log(arr[-1]) - math.log(arr[start_index])
    sum_all = sum(cum[c] for c in CURRENCIES)
    n = len(CURRENCIES)
    return {c: (n * cum[c] - sum_all) * 100 for c in CURRENCIES}


# ---------------------------------------------------------------------------
# 構造（スイング）と損切り価格
# ---------------------------------------------------------------------------
def pick_structural_swing(pivots: list[Pivot], direction: str, current_price: float) -> Pivot | None:
    """買いなら現在値より下の直近スイング安値、売りなら現在値より上の直近スイング高値。"""
    want = "low" if direction == "long" else "high"
    for p in reversed(pivots):
        if p.type != want:
            continue
        if direction == "long" and p.price < current_price:
            return p
        if direction == "short" and p.price > current_price:
            return p
    return None


def compute_stop_loss(swing_price: float, direction: str, entry: float, buffer_pct: float, pip: float) -> dict:
    """スイングの少し外側に損切りを置き、価格と距離(pips)を返す。"""
    if direction == "long":
        price = swing_price * (1 - buffer_pct / 100.0)
        distance = entry - price
    else:
        price = swing_price * (1 + buffer_pct / 100.0)
        distance = price - entry
    return {
        "price": price,
        "distancePips": round(distance / pip, 1),
        "basis": "swing_low" if direction == "long" else "swing_high",
        "bufferPct": buffer_pct,
    }


# ---------------------------------------------------------------------------
# フィボナッチ（直近の推進脚）
# ---------------------------------------------------------------------------
def fib_levels(pivots: list[Pivot]) -> dict | None:
    """直近2ピボットを1脚として Fib リトレースメント水準を返す。"""
    if len(pivots) < 2:
        return None
    a, b = pivots[-2], pivots[-1]
    hi, lo = max(a.price, b.price), min(a.price, b.price)
    if hi == lo:
        return None
    levels = {f"{r}": hi - (hi - lo) * r for r in FIB_RATIOS}
    return {"high": hi, "low": lo, "levels": levels}


def fib_check(fib: dict | None, sl_price: float, swing_price: float, direction: str) -> dict:
    """損切り/スイングが Fib と整合するか（確信度用）。"""
    if not fib:
        return {"alignedWithSwing": False, "beyond618": False, "nearest": None}
    levels = fib["levels"]
    span = fib["high"] - fib["low"]
    # スイングが何らかの Fib 水準に近接（脚幅の5%以内）していれば整合。
    aligned = any(abs(swing_price - lvl) <= span * 0.05 for lvl in levels.values())
    l618 = levels["0.618"]
    beyond = sl_price <= l618 if direction == "long" else sl_price >= l618
    nearest = min(levels, key=lambda k: abs(levels[k] - sl_price))
    return {"alignedWithSwing": aligned, "beyond618": beyond, "nearest": nearest}


# ---------------------------------------------------------------------------
# 確信度（強弱 + 取引量 + Fib）
# ---------------------------------------------------------------------------
def strength_agreement(base: str, quote: str, strengths: dict[str, float] | None, direction: str) -> dict | None:
    """base が quote より強い/弱いが方向と一致するか。対象外（メタル等）は None。"""
    if not strengths or base not in strengths or quote not in strengths:
        return None
    diff = strengths[base] - strengths[quote]
    agree = diff > 0 if direction == "long" else diff < 0
    return {
        "base": base,
        "quote": quote,
        "baseStrength": round(strengths[base], 3),
        "quoteStrength": round(strengths[quote], 3),
        "agree": agree,
    }


def volume_signal(long_pct: float, short_pct: float, direction: str) -> tuple[int, str, dict]:
    """個人投資家センチメントを逆張り解釈で確信度に反映。(score, reason, signal)。"""
    lean = "buy" if long_pct > short_pct else "sell"
    crowd_pct = max(long_pct, short_pct)
    sig = {"longPct": long_pct, "shortPct": short_pct, "lean": lean}
    my_side = "buy" if direction == "long" else "sell"
    if crowd_pct > 60:
        if lean != my_side:
            return 1, f"取引量: 個人の{crowd_pct:.0f}%が{'ショート' if lean == 'sell' else 'ロング'}→方向に逆張り支持(+)", sig
        return -1, f"取引量: 個人の{crowd_pct:.0f}%が同方向に偏り混雑注意(−)", sig
    return 0, f"取引量: 個人の偏りは中立的({long_pct:.0f}/{short_pct:.0f})", sig


def build_recommendation(
    instrument: str,
    direction: str,
    entry: float,
    timeframe: str,
    pivots: list[Pivot],
    strengths: dict[str, float] | None,
    flow: dict | None,
    buffer_pct: float,
) -> dict:
    """取得済みデータから損切り推奨を組み立てる（純関数）。"""
    base, quote = parse_pair(instrument)
    pip = pip_size(instrument)

    swing = pick_structural_swing(pivots, direction, entry)
    if swing is None:
        return {"error": "方向に合致する直近スイングが見つかりませんでした", "instrument": instrument}

    sl = compute_stop_loss(swing.price, direction, entry, buffer_pct, pip)
    fib = fib_levels(pivots)
    fibc = fib_check(fib, sl["price"], swing.price, direction)

    reasons: list[str] = []
    score = 0

    agree = strength_agreement(base, quote, strengths, direction)
    if agree is None:
        reasons.append("通貨強弱: 対象外（メタル等）のため評価なし")
    elif agree["agree"]:
        score += 1
        reasons.append(f"通貨強弱: {base}が{quote}より方向に一致(+)")
    else:
        score -= 1
        reasons.append(f"通貨強弱: {base}/{quote}が方向と不一致(−)")

    vol_sig = None
    if flow is not None:
        vs, vr, vol_sig = volume_signal(flow["longPct"], flow["shortPct"], direction)
        score += vs
        reasons.append(vr)
    else:
        reasons.append("取引量: データ取得なし")

    if fibc["alignedWithSwing"] or fibc["beyond618"]:
        score += 1
        reasons.append("Fib: 損切りが61.8%外側/水準整合で妥当(+)")

    level = "high" if score >= 2 else ("low" if score < 0 else "medium")

    return {
        "instrument": instrument,
        "direction": direction,
        "timeframe": timeframe,
        "entry": entry,
        "stopLoss": {
            **sl,
            "swing": swing.as_dict(),
        },
        "fibonacci": {**fib, **fibc} if fib else None,
        "confidence": {"level": level, "score": score, "reasons": reasons},
        "signals": {"strength": agree, "volume": vol_sig},
    }
