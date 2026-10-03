"""エリオット波動(ZigZag) API 本体（FastAPI）。

GET /elliott/{instrument} … 30分足/1時間足/4時間足の ZigZag 転換点をまとめて返す。
GET /health              … 死活確認。
"""

import asyncio
from datetime import datetime, timezone

import httpx
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware

from config import get_secret
from oanda import GRANULARITY, fetch_candles
from zigzag import compute_zigzag

# タイムフレームごとの既定しきい値（反転 %）。クエリ threshold で上書き可能。
DEFAULT_THRESHOLD_PCT: dict[str, float] = {"30m": 0.2, "1h": 0.3, "4h": 0.5}

app = FastAPI(title="Elliott ZigZag API", version="1.0.0")

# 公開の読み取り専用 API。フロント（GH Pages/localhost）から呼べるよう CORS を許可。
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET"],
    allow_headers=["*"],
)


@app.get("/health")
def health() -> dict:
    return {"status": "ok"}


@app.get("/elliott/{instrument}")
async def elliott(
    instrument: str,
    count: int = Query(300, ge=10, le=5000, description="各足の取得ローソク本数"),
    threshold: float | None = Query(None, gt=0, le=20, description="反転しきい値(%)。未指定なら足ごとの既定値"),
    price: str = Query("M", pattern="^[MBA]$", description="M=mid / B=bid / A=ask"),
) -> dict:
    token = get_secret("OANDA_API_TOKEN")
    if not token:
        raise HTTPException(status_code=500, detail="OANDA_API_TOKEN が未設定です")

    async def one(tf: str, gran: str) -> tuple[str, dict]:
        thr = threshold if threshold is not None else DEFAULT_THRESHOLD_PCT[tf]
        candles = await fetch_candles(client, token, instrument, gran, count, price)
        pivots = compute_zigzag(candles, thr)
        return tf, {
            "granularity": gran,
            "thresholdPct": thr,
            "candles": len(candles),
            "pivots": [p.as_dict() for p in pivots],
        }

    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            results = await asyncio.gather(*(one(tf, g) for tf, g in GRANULARITY.items()))
    except httpx.HTTPStatusError as e:
        detail = f"OANDA エラー {e.response.status_code}: {e.response.text[:200]}"
        raise HTTPException(status_code=502, detail=detail)
    except httpx.HTTPError as e:
        raise HTTPException(status_code=502, detail=f"OANDA 取得失敗: {e}")

    return {
        "instrument": instrument,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "timeframes": dict(results),
    }
