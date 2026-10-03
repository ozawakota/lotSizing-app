import app as app_module
from fastapi.testclient import TestClient
from zigzag import Candle

client = TestClient(app_module.app)


def _line(prices):
    return [Candle(time=f"t{i}", high=p, low=p) for i, p in enumerate(prices)]


def test_health():
    r = client.get("/health")
    assert r.status_code == 200
    assert r.json() == {"status": "ok"}


def test_elliott_missing_token(monkeypatch):
    monkeypatch.setattr(app_module, "get_secret", lambda name: None)
    r = client.get("/elliott/USD_JPY")
    assert r.status_code == 500


def test_elliott_returns_three_timeframes(monkeypatch):
    monkeypatch.setattr(app_module, "get_secret", lambda name: "dummy-token")

    async def fake_fetch(client, token, instrument, granularity, count, price="M"):
        return _line([100, 120, 100, 130])  # 明確なジグザグ

    monkeypatch.setattr(app_module, "fetch_candles", fake_fetch)

    r = client.get("/elliott/USD_JPY")
    assert r.status_code == 200
    body = r.json()
    assert body["instrument"] == "USD_JPY"
    assert set(body["timeframes"].keys()) == {"30m", "1h", "4h"}
    tf = body["timeframes"]["1h"]
    assert tf["granularity"] == "H1"
    assert tf["thresholdPct"] == 0.3
    # 確定 pivot が少なくとも1つ（low→high→low のうち確定分）
    assert any(p["confirmed"] for p in tf["pivots"])


def test_stoploss_returns_recommendation(monkeypatch):
    monkeypatch.setattr(app_module, "get_secret", lambda name: "x" if name == "OANDA_API_TOKEN" else None)

    async def fake_fetch(client, token, instrument, granularity, count, price="M"):
        # 明確な下げ→上げ→下げで買い用のスイング安値ができる系列。
        return _line([1.2650, 1.2720, 1.2688, 1.2710])

    monkeypatch.setattr(app_module, "fetch_candles", fake_fetch)

    r = client.get("/stoploss/GBP_USD?direction=long&timeframe=1h")
    assert r.status_code == 200
    body = r.json()
    assert body["instrument"] == "GBP_USD"
    assert body["direction"] == "long"
    assert body["stopLoss"]["basis"] == "swing_low"
    assert body["stopLoss"]["price"] < body["entry"]
    assert body["confidence"]["level"] in {"low", "medium", "high"}


def test_stoploss_requires_direction():
    r = client.get("/stoploss/GBP_USD?timeframe=1h")
    assert r.status_code == 422  # direction 必須


def test_elliott_threshold_override(monkeypatch):
    monkeypatch.setattr(app_module, "get_secret", lambda name: "dummy-token")

    async def fake_fetch(client, token, instrument, granularity, count, price="M"):
        return _line([100, 101])

    monkeypatch.setattr(app_module, "fetch_candles", fake_fetch)

    r = client.get("/elliott/USD_JPY?threshold=1.5")
    assert r.status_code == 200
    for tf in r.json()["timeframes"].values():
        assert tf["thresholdPct"] == 1.5
