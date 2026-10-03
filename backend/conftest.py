import os
import sys

# src/ をインポートパスに追加（CF Python Worker は src/ をモジュールパスとして扱うため、
# ローカルのテスト/実行でも同じ絶対インポート `from zigzag import ...` を使えるようにする）。
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "src"))
