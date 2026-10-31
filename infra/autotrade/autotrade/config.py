"""設定の読み込み。設定ファイル（JSON）＋環境変数（MT5 のログイン情報など秘密はこちら）。"""
from __future__ import annotations

import json
import os
from dataclasses import dataclass, field

DEFAULT_MTF_URL = "https://currency-strength.ozawa19890413.workers.dev/mtf"


@dataclass
class PairConfig:
    instrument: str  # アプリの表記（例: USD_JPY）
    symbol: str  # ブローカーのシンボル名（例: USDJPY, USDJPY.a）
    timeframe: str = "1h"  # 判定に使う時間足（15m / 30m / 1h / 4h）


@dataclass
class Config:
    pairs: list[PairConfig]
    mtf_url: str = DEFAULT_MTF_URL
    risk_pct: float = 2.0  # 1回の取引で許す損失（口座残高に対する %）
    max_positions: int = 3  # ボット全体で同時に持つポジション＋待機中の指値の上限
    daily_max_loss_pct: float = 6.0  # その日（日本時間）の損失がこれを超えたら新規発注を止める
    max_spread_pips: float = 3.0  # スプレッドがこれより広いときは見送る（XAU は pips の単位が違うので個別に調整）
    use_limit_orders: bool = True  # 「押し目待ち/戻り待ち」のとき、指値の目安に指値注文を置く
    use_stop_orders: bool = True  # 高値掴み注意・押し目の目安なしのとき、ブレイク狙いの逆指値（Buy/Sell Stop）を置く
    limit_expiry_hours: float = 4.0  # 約定しない待機注文（指値・逆指値）をこの時間で取り消す
    min_rr: float = 2.0  # これ未満の RR（指値なら指値での RR）は見送る
    cooldown_hours: float = 4.0  # 同じペア・同じ向きで続けて入らない時間
    poll_seconds: int = 300  # --loop の確認間隔
    magic: int = 20261030  # このボットの注文の目印（手動の注文と区別する）
    deviation_points: int = 20  # 成行のスリッページ許容（ポイント）
    dry_run: bool = True  # true なら発注せずログだけ（最初は必ず true で動作確認）
    demo_only: bool = True  # true なら デモ口座以外では発注しない
    state_path: str = "autotrade_state.json"
    mt5_path: str | None = None  # terminal64.exe のパス（未指定なら起動中の端末に接続）
    login: int | None = field(default=None, repr=False)
    password: str | None = field(default=None, repr=False)
    server: str | None = None


def load_config(path: str) -> Config:
    with open(path, encoding="utf-8") as f:
        raw = json.load(f)
    pairs = [PairConfig(**p) for p in raw.pop("pairs", [])]
    if not pairs:
        raise ValueError("pairs が空です（少なくとも1ペアを設定してください）")
    cfg = Config(pairs=pairs, **raw)
    # 秘密は環境変数から（設定ファイルや Git に書かない）。
    if os.environ.get("MT5_LOGIN"):
        cfg.login = int(os.environ["MT5_LOGIN"])
    cfg.password = os.environ.get("MT5_PASSWORD") or cfg.password
    cfg.server = os.environ.get("MT5_SERVER") or cfg.server
    cfg.mt5_path = os.environ.get("MT5_PATH") or cfg.mt5_path
    if not 0 < cfg.risk_pct <= 5:
        raise ValueError("risk_pct は 0〜5 の範囲で指定してください")
    return cfg
