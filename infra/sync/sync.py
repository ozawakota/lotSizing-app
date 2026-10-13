"""MT5(CSV) → Turso 同期サービス。

使い方:
  python sync.py --dir /path/to/MQL5/Files/mt5sync --once
  python sync.py --dir /path/to/MQL5/Files/mt5sync --loop --interval 60

本番の DB 接続は環境変数 TURSO_DATABASE_URL / TURSO_AUTH_TOKEN（store.connect 参照）。
manifest.csv が無い（＝まだ1セット出力されていない）サイクルはスキップする。
同期は冪等なので、何度実行しても結果は収束する。
"""

from __future__ import annotations

import argparse
import sys
import time

from reader import read_account, read_deals, read_manifest, read_positions
from store import Store, connect


def sync_once(sync_dir: str, store: Store) -> dict:
    """1サイクル分の同期。結果サマリ（件数 or skip 理由）を返す。"""
    manifest = read_manifest(sync_dir)
    if manifest is None:
        return {"skipped": "manifest_missing"}
    generated_at = manifest["generated_at"]

    account = read_account(sync_dir)
    positions = read_positions(sync_dir)
    deals = read_deals(sync_dir)

    if account is not None:
        store.upsert_account(account, generated_at)
        # 建玉はその口座分を総入替（クローズ済みを消す）。
        store.replace_positions(account.login, positions, generated_at)
    store.upsert_deals(deals)

    return {
        "generated_at": generated_at,
        "account": account.login if account else None,
        "positions": len(positions),
        "deals": len(deals),
    }


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="MT5(CSV) → Turso 同期")
    ap.add_argument("--dir", required=True, help="EA 出力ディレクトリ（MQL5/Files/mt5sync）")
    ap.add_argument("--once", action="store_true", help="1回だけ実行して終了")
    ap.add_argument("--loop", action="store_true", help="間隔を空けて継続実行")
    ap.add_argument("--interval", type=int, default=60, help="--loop 時の間隔秒（既定60）")
    args = ap.parse_args(argv)

    store = Store(connect())

    def run() -> None:
        try:
            result = sync_once(args.dir, store)
            print(f"[mt5-sync] {result}", flush=True)
        except Exception as e:  # noqa: BLE001 - 1サイクル失敗は致命的にせず次回リトライ
            print(f"[mt5-sync] error: {e}", file=sys.stderr, flush=True)

    if args.loop:
        while True:
            run()
            time.sleep(max(args.interval, 1))
    else:
        run()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
