"""ガードレール L4: Write/Edit/MultiEdit/NotebookEdit で書き込む内容にシークレットがあれば止める。

.env / .env.*（.env.example を除く）/ .dev.vars への書き込みは許可する。
exit 2 + stderr で Claude に理由を返す。
"""

from __future__ import annotations

import json
import os
import re
import sys

ROOT = os.environ.get("CLAUDE_PROJECT_DIR") or os.getcwd()
sys.path.insert(0, os.path.join(ROOT, ".githooks"))
from leak_scan import scan  # noqa: E402

ALLOWED_FILES = re.compile(r"(^|/)(\.env(\.(?!example$)[^/]+)?|\.dev\.vars)$")


def main() -> int:
    data = json.load(sys.stdin)
    ti = data.get("tool_input") or {}
    path = ti.get("file_path") or ti.get("notebook_path") or ""
    if ALLOWED_FILES.search(path):
        return 0

    parts = [ti.get("content"), ti.get("new_string"), ti.get("new_source")]
    parts += [e.get("new_string") for e in ti.get("edits") or []]
    text = "\n".join(p for p in parts if isinstance(p, str))

    hits = scan(text)
    if not hits:
        return 0
    lines = "\n".join(f"  - {n}: {s}" for n, s in hits)
    print(
        f"ブロック: {path} にシークレットらしき値を書き込もうとしています。\n{lines}\n"
        "値は .env に置き、コードからは環境変数で読んでください（CLAUDE.md のセキュリティルール）。",
        file=sys.stderr,
    )
    return 2


if __name__ == "__main__":
    sys.exit(main())
