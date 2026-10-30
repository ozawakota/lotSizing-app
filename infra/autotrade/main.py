"""TF分析の「入りどき」で MT5 デモ口座に自動発注する。

  python main.py --config config.json --once   # 1回だけ（動作確認）
  python main.py --config config.json --loop   # 常駐（poll_seconds ごと）

MT5 のログイン情報は環境変数 MT5_LOGIN / MT5_PASSWORD / MT5_SERVER（端末でログイン済みなら不要）。
最初は config の dry_run を true のまま動かし、ログで判定と注文内容を確認してから false にする。
※投資助言ではない。デモ口座での検証用。
"""
from __future__ import annotations

import argparse
import logging
import sys

from autotrade.bot import Bot, run_loop
from autotrade.broker import Mt5Broker
from autotrade.config import load_config


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", default="config.json")
    g = ap.add_mutually_exclusive_group()
    g.add_argument("--once", action="store_true")
    g.add_argument("--loop", action="store_true")
    args = ap.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s", stream=sys.stdout)
    cfg = load_config(args.config)
    broker = Mt5Broker(path=cfg.mt5_path, login=cfg.login, password=cfg.password, server=cfg.server)
    acct = broker.account()
    logging.info(
        "接続: 口座 %s（%s）残高 %.2f %s / dry_run=%s / risk=%.1f%%",
        acct.login, "デモ" if acct.is_demo else "リアル", acct.balance, acct.currency, cfg.dry_run, cfg.risk_pct,
    )
    bot = Bot(cfg, broker)
    try:
        if args.loop:
            run_loop(bot, cfg.poll_seconds)
        else:
            for line in bot.run_once():
                logging.info(line)
    finally:
        broker.shutdown()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
