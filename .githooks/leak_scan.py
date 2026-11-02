"""シークレット検出の共通ロジック。

Claude Code の PreToolUse フック（.claude/hooks/guard_leaks.py）と
git の pre-commit（.githooks/pre-commit）の両方から使う。
"""

from __future__ import annotations

import re
import sys

PATTERNS: list[tuple[str, re.Pattern[str]]] = [
    ("秘密鍵", re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----")),
    ("AWS アクセスキー", re.compile(r"\bAKIA[0-9A-Z]{16}\b")),
    ("GitHub トークン", re.compile(r"\bgh[pousr]_[A-Za-z0-9]{36,}\b")),
    ("GitHub PAT", re.compile(r"\bgithub_pat_[A-Za-z0-9_]{20,}\b")),
    ("sk- 形式の API キー", re.compile(r"\bsk-[A-Za-z0-9_-]{20,}")),
    ("Slack トークン", re.compile(r"\bxox[abprs]-[A-Za-z0-9-]{10,}")),
    ("Google API キー", re.compile(r"\bAIza[0-9A-Za-z_-]{35}\b")),
    (
        "キー/トークン/パスワードの直書き",
        re.compile(
            r"""(?i)\b[\w-]*(?:api[_-]?key|apikey|secret|token|password|passwd)[\w-]*["']?\s*[:=]\s*["']([A-Za-z0-9_\-/+=]{20,})["']"""
        ),
    ),
]

PLACEHOLDER = re.compile(r"(?i)(example|dummy|placeholder|your[_-]|xxxx|changeme|sample|<)")


def scan(text: str) -> list[tuple[str, str]]:
    """見つかったシークレットを (名前, 伏せ字にした一部) のリストで返す。"""
    found: list[tuple[str, str]] = []
    for name, pat in PATTERNS:
        for m in pat.finditer(text):
            value = m.group(1) if pat.groups else m.group(0)
            if PLACEHOLDER.search(value):
                continue
            found.append((name, value[:6] + "…"))
    return found


if __name__ == "__main__":
    hits = scan(sys.stdin.read())
    for name, snippet in hits:
        print(f"{name}: {snippet}")
    sys.exit(1 if hits else 0)
