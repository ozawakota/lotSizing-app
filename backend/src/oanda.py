"""OANDA practice の candles から mid OHLC を取得する（httpx async）。

Cloudflare Python Workers では httpx が内部で fetch 経由にパッチされるため、
ローカル（uvicorn/pytest）でも CF 上でも同じコードで動く。
"""

import httpx

from zigzag import Candle

OANDA_HOST = "https://api-fxpractice.oanda.com"

# 当API のタイムフレーム → OANDA の granularity。
GRANULARITY: dict[str, str] = {"30m": "M30", "1h": "H1", "4h": "H4"}


async def fetch_candles(
    client: httpx.AsyncClient,
    token: str,
    instrument: str,
    granularity: str,
    count: int,
    price: str = "M",
) -> list[Candle]:
    """指定足の mid ローソクを古い順に返す。未完成の最新足は除外する。"""
    url = f"{OANDA_HOST}/v3/instruments/{instrument}/candles"
    params = {"granularity": granularity, "count": count, "price": price}
    res = await client.get(url, params=params, headers={"Authorization": f"Bearer {token}"})
    res.raise_for_status()
    data = res.json()

    candles: list[Candle] = []
    for c in data.get("candles", []):
        if not c.get("complete", False):
            continue  # 進行中の足は確定値でないため除外
        mid = c.get("mid", {})
        try:
            candles.append(Candle(time=c["time"], high=float(mid["h"]), low=float(mid["l"])))
        except (KeyError, TypeError, ValueError):
            continue
    return candles
