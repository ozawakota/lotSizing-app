"""通貨強弱(/)・取引量(/flow)を既存 Cloudflare Worker から取得する（httpx async・ベストエフォート）。

いずれも失敗時は None を返し、損切り推奨は確信度の注釈のみ落として継続する。
"""

import httpx

from stoploss import JPY_PAIRS, latest_strength

# 強弱の算出に使う直近バー数（intraday は 15min 足。16本 ≒ 4時間）。
STRENGTH_LOOKBACK_BARS = 16


async def fetch_strengths(client: httpx.AsyncClient, worker_base: str) -> dict[str, float] | None:
    """Worker ルート(/) の intraday 系列から各通貨の最新強弱を算出。"""
    res = await client.get(worker_base.rstrip("/") + "/")
    res.raise_for_status()
    data = res.json()
    series = data.get("intraday")
    if not series:
        return None
    rates = series.get("rates", {})
    if not all(p in rates and len(rates[p]) >= 2 for p in JPY_PAIRS):
        return None
    n = len(rates[JPY_PAIRS[0]])
    start = max(0, n - STRENGTH_LOOKBACK_BARS)
    return latest_strength(rates, start)


async def fetch_flow(client: httpx.AsyncClient, worker_base: str, instrument: str) -> dict | None:
    """/flow から該当ペアの long/short % を取り出す（instrument 'GBP_USD' → 'GBP/USD'）。"""
    res = await client.get(worker_base.rstrip("/") + "/flow")
    res.raise_for_status()
    data = res.json()
    flow_pair = instrument.replace("_", "/")
    for p in data.get("pairs", []):
        if p.get("pair") == flow_pair:
            return {"longPct": p["longPct"], "shortPct": p["shortPct"]}
    return None
