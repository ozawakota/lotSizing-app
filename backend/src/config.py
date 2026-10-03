"""実行環境を問わず secret/env を取得するヘルパ。

Cloudflare Python Workers では `from workers import env` で bindings/secrets にアクセスする。
ローカル（uvicorn/pytest）ではその import が無いので os.environ にフォールバックする。
"""

import os


def get_secret(name: str) -> str | None:
    try:
        from workers import env  # type: ignore  # CF ランタイムのみ存在

        value = getattr(env, name, None)
        if value is not None:
            return str(value)
    except Exception:
        pass
    return os.environ.get(name)
