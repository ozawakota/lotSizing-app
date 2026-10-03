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
from signals import fetch_flow, fetch_strengths
from stoploss import build_recommendation
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


@app.get("/stoploss/{instrument}")
async def stoploss(
    instrument: str,
    direction: str = Query(..., pattern="^(long|short)$", description="long=買い / short=売り"),
    timeframe: str = Query("1h", pattern="^(30m|1h|4h)$"),
    entry: float | None = Query(None, gt=0, description="エントリー価格。未指定なら直近足の中値"),
    count: int = Query(300, ge=10, le=5000),
    threshold: float | None = Query(None, gt=0, le=20, description="ZigZag 反転%。未指定なら足の既定"),
    buffer_pct: float = Query(0.05, ge=0, le=5, description="スイング外側のバッファ(%)"),
) -> dict:
    token = get_secret("OANDA_API_TOKEN")
    if not token:
        raise HTTPException(status_code=500, detail="OANDA_API_TOKEN が未設定です")

    gran = GRANULARITY[timeframe]
    thr = threshold if threshold is not None else DEFAULT_THRESHOLD_PCT[timeframe]
    worker_base = get_secret("STRENGTH_WORKER_URL")

    async with httpx.AsyncClient(timeout=15.0) as client:
        try:
            candles = await fetch_candles(client, token, instrument, gran, count)
        except httpx.HTTPStatusError as e:
            raise HTTPException(status_code=502, detail=f"OANDA エラー {e.response.status_code}: {e.response.text[:200]}")
        except httpx.HTTPError as e:
            raise HTTPException(status_code=502, detail=f"OANDA 取得失敗: {e}")
        if len(candles) < 2:
            raise HTTPException(status_code=502, detail="ローソク足が不足しています")

        entry_price = entry if entry is not None else (candles[-1].high + candles[-1].low) / 2
        pivots = compute_zigzag(candles, thr)

        # 強弱・取引量はベストエフォート（取得失敗でも推奨は返す）。
        strengths = None
        flow = None
        if worker_base:
            try:
                strengths = await fetch_strengths(client, worker_base)
            except httpx.HTTPError:
                strengths = None
            try:
                flow = await fetch_flow(client, worker_base, instrument)
            except httpx.HTTPError:
                flow = None

    rec = build_recommendation(instrument, direction, entry_price, timeframe, pivots, strengths, flow, buffer_pct)
    if "error" in rec:
        raise HTTPException(status_code=422, detail=rec["error"])
    rec["generatedAt"] = datetime.now(timezone.utc).isoformat()
    return rec
