# Cloudflare Python Worker のエントリ。FastAPI(ASGI) を Worker のデフォルトに接続する。
# 設計: ../README.md
from workers import asgi

from app import app

Default = asgi.entrypoint(app)
