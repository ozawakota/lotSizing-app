"""Cloudflare Worker の /mtf から、ペアの売買プランを作る（純関数）。

/mtf の各時間足には rr（方向・損切り・目標・RR）と timing（入りどき）が入っている:
  - timing.verdict == "ok"    → 成行（rr の損切り・目標のまま）
  - timing.verdict == "wait"  → timing.limit.price に指値（損切り・目標は同じ。RR は指値での値）
  - timing.verdict == "avoid" → 見送り（高値掴み・安値売りになりやすい）
rr が無い（レンジ・転換の兆し）・RR 不成立なら見送り。
"""
from __future__ import annotations

import json
import urllib.parse
import urllib.request
from dataclasses import dataclass


@dataclass
class TradePlan:
    instrument: str
    timeframe: str
    direction: str  # "long" | "short"
    order: str  # "market" | "limit"
    entry: float  # 成行は /mtf 時点の現在値、指値は指値の価格（どちらも /mtf の価格基準）
    stop: float
    target: float
    rr: float
    ref_price: float  # /mtf の現在値（ブローカー価格との差を補正するため）
    verdict: str
    reasons: list[str]

    @property
    def key(self) -> str:
        """同じセットアップの重複発注を防ぐための識別子。"""
        return f"{self.instrument}:{self.timeframe}:{self.direction}"


@dataclass
class Skip:
    instrument: str
    reason: str


def fetch_mtf(url: str, instrument: str, timeout: float = 60.0) -> dict:
    q = urllib.parse.urlencode({"instrument": instrument})
    req = urllib.request.Request(f"{url}?{q}", headers={"User-Agent": "lotsizing-autotrade/1.0"})
    with urllib.request.urlopen(req, timeout=timeout) as res:
        body = json.loads(res.read().decode("utf-8"))
    if "error" in body:
        raise RuntimeError(f"/mtf エラー: {body['error']}")
    return body


def build_plan(body: dict, instrument: str, timeframe: str, *, use_limit: bool, min_rr: float) -> TradePlan | Skip:
    tf = next((t for t in body.get("timeframes", []) if t.get("tf") == timeframe), None)
    if tf is None:
        return Skip(instrument, f"{timeframe} のデータがありません")
    rr = tf.get("rr")
    if not rr:
        return Skip(instrument, "方向なし（ダウ理論でレンジ・転換の兆し）")
    timing = tf.get("timing")
    if not timing:
        return Skip(instrument, "入りどきの判定なし（旧 Worker・足不足）")
    verdict = timing.get("verdict")
    reasons = [r.get("label", "") for r in timing.get("reasons", [])]
    current = float(body["currentRate"])
    base = dict(
        instrument=instrument,
        timeframe=timeframe,
        direction=rr["direction"],
        stop=float(rr["stop"]),
        target=float(rr["target"]),
        ref_price=current,
        verdict=verdict,
        reasons=reasons,
    )
    if verdict == "avoid":
        return Skip(instrument, "高値掴み/安値売り注意: " + "・".join(reasons))
    if verdict == "ok":
        if not rr.get("qualifies") or float(rr["rr"]) < min_rr:
            return Skip(instrument, f"RR 不足（1:{float(rr['rr']):.1f}）")
        return TradePlan(order="market", entry=current, rr=float(rr["rr"]), **base)
    if verdict == "wait":
        limit = timing.get("limit")
        if not use_limit:
            return Skip(instrument, "押し目/戻り待ち（指値は無効の設定）")
        if not limit or limit.get("rr") is None:
            return Skip(instrument, "押し目/戻り待ち（指値の目安なし）")
        if float(limit["rr"]) < min_rr:
            return Skip(instrument, f"指値での RR 不足（1:{float(limit['rr']):.1f}）")
        return TradePlan(order="limit", entry=float(limit["price"]), rr=float(limit["rr"]), **base)
    return Skip(instrument, f"不明な判定: {verdict}")


def shift_plan(plan: TradePlan, broker_mid: float) -> TradePlan:
    """/mtf（Yahoo 足。XAU は金先物）とブローカーの価格の差だけ、エントリー・損切り・目標を平行移動する。"""
    off = broker_mid - plan.ref_price
    return TradePlan(
        **{**plan.__dict__, "entry": plan.entry + off, "stop": plan.stop + off, "target": plan.target + off, "ref_price": broker_mid}
    )
