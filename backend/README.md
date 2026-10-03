# エリオット波動(ZigZag) API

FastAPI 製の API。指定銘柄の **30分足/1時間足/4時間足** について、エリオット波動の土台となる
**ZigZag 転換点（スイング高値/安値）** を返す。OANDA practice の candles（mid OHLC）を使用。
**Cloudflare Python Worker**（ASGI）としてデプロイでき、ローカルは uvicorn でも動く。

## エンドポイント

| メソッド | パス | 説明 |
|---|---|---|
| GET | `/elliott/{instrument}` | 3足の ZigZag 転換点をまとめて返す |
| GET | `/health` | 死活確認 |

クエリ（任意）:
- `count` … 各足の取得ローソク本数（既定 300、10〜5000）
- `threshold` … 反転しきい値(%)。未指定なら足ごとの既定（30m=0.2 / 1h=0.3 / 4h=0.5）
- `price` … `M`(mid, 既定) / `B`(bid) / `A`(ask)

例:
```
GET /elliott/USD_JPY
GET /elliott/XAU_USD?count=500&threshold=0.4
```

レスポンス例:
```json
{
  "instrument": "XAU_USD",
  "generatedAt": "2026-10-03T10:00:00+00:00",
  "timeframes": {
    "30m": { "granularity": "M30", "thresholdPct": 0.2, "candles": 300,
      "pivots": [ {"time":"...","price":2650.1,"type":"low","confirmed":true},
                  {"time":"...","price":2661.4,"type":"high","confirmed":false} ] },
    "1h":  { "granularity": "H1", "thresholdPct": 0.3, "candles": 300, "pivots": [ ... ] },
    "4h":  { "granularity": "H4", "thresholdPct": 0.5, "candles": 300, "pivots": [ ... ] }
  }
}
```
`confirmed:false` は末尾の「進行中スイング」の暫定転換点（最新の未確定スイング）。

## 構成

```
backend/
  src/
    app.py      # FastAPI 本体・ルーティング・CORS
    zigzag.py   # ZigZag 純ロジック（依存なし・テスト対象）
    oanda.py    # OANDA candles 取得（httpx async）
    config.py   # secret 取得（CF: workers.env / ローカル: os.environ）
    entry.py    # Cloudflare Python Worker の ASGI エントリ
  tests/        # pytest（zigzag / app）
  wrangler.jsonc
  requirements.txt
```

ZigZag はパーセント偏差方式（直近の極値から `threshold`% 逆行で転換確定）。銘柄非依存で
FX もゴールドも同じロジック。高値/安値（ヒゲ）を使うため瞬間的な転換も捉える。

## ローカル開発

```bash
cd backend
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt

# テスト
.venv/bin/python -m pytest -q

# 起動（OANDA トークンを環境変数で）
OANDA_API_TOKEN=xxxx .venv/bin/uvicorn app:app --app-dir src --reload
# → http://127.0.0.1:8000/elliott/USD_JPY
```

## Cloudflare Python Worker へデプロイ

Python Workers（2026-09 GA）で FastAPI を ASGI アダプタ経由で動かす。cron 不要の
リクエスト駆動なので、既存 Worker の cron 本数には影響しない。

```bash
cd backend
npx wrangler secret put OANDA_API_TOKEN   # 通知機能と同じトークンでOK
npx wrangler deploy
# → https://lotsizing-elliott.<subdomain>.workers.dev/elliott/USD_JPY
```

> 備考: `requirements.txt` の fastapi / httpx は Python Workers 上では PyEmscripten/Pyodide
> wheel として解決される（httpx は内部で fetch 経由にパッチされる）。uvicorn/pytest は
> ローカル専用。初回デプロイ時にパッケージ解決の警告が出た場合は内容を確認のこと。
