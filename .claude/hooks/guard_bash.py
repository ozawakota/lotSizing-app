"""ガードレール L4: settings.json の Bash パターンでは漏れる変形を止める。

- 外部送信コマンド（パス指定・bash -c・パイプ・$(...) の中でも検出）
- git push の強制（-f / --force* / +refspec）
- フックの回避（--no-verify / core.hooksPath の変更）
- .gitignore のシェル経由の書き換え
- フルの pnpm install、npm run git/deploy、gh-pages、wrangler secret

exit 2 + stderr で Claude に理由を返す。
"""

from __future__ import annotations

import json
import re
import shlex
import sys

EXFIL = {"curl", "wget", "scp", "rsync", "nc", "ncat", "netcat", "sftp", "ftp", "telnet", "socat"}
WRAPPERS = {"sudo", "env", "command", "exec", "nohup", "time", "xargs", "builtin", "eval"}
SHELLS = {"sh", "bash", "zsh", "dash"}

RULES: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"\bgit\b[^;&|]*\bpush\b[^;&|]*(\s-[a-zA-Z]*f\b|--force|\s\+[\w/.-]+)"), "git push の強制は禁止です"),
    (re.compile(r"--no-verify\b|\bcore\.hooksPath\b"), "git フックの回避・変更は禁止です"),
    (re.compile(r"(sed|perl)\s+[^;&|]*-i[^;&|]*\.gitignore|>>?\s*\S*\.gitignore\b|\btee\b[^;&|]*\.gitignore"), ".gitignore のシェル経由の書き換えは禁止です（Edit で提案してください）"),
    (re.compile(r"\bnpm\s+run\s+(git|deploy)\b|\bpnpm\s+(run\s+)?(git|deploy)\b|\bgh-pages\b"), "npm run git / deploy（push・公開）は禁止です。ユーザーに実行を依頼してください"),
    (re.compile(r"\bwrangler\s+secret\b"), "wrangler secret の操作は禁止です"),
    (re.compile(r"\b(npm|pnpm|yarn)\s+publish\b"), "パッケージの公開は禁止です"),
    (re.compile(r"\bgh\s+gist\b"), "gh gist は禁止です"),
]

PNPM_INSTALL = re.compile(r"\bpnpm\s+(install|i)\b([^;&|]*)")


def segments(cmd: str) -> list[list[str]]:
    """; && || | ( ) ` $( で区切ったコマンド列をトークン化して返す（bash -c の中身も展開）。"""
    out: list[list[str]] = []
    for seg in re.split(r"&&|\|\||[;|&()`\n]|\$\(", cmd):
        try:
            toks = shlex.split(seg)
        except ValueError:
            toks = seg.split()
        # 先頭の VAR=val とラッパーを外す
        while toks and (re.match(r"^\w+=", toks[0]) or toks[0].rsplit("/", 1)[-1] in WRAPPERS):
            toks.pop(0)
            while toks and toks[0].startswith("-") and not out:
                toks.pop(0)
        if not toks:
            continue
        if toks[0].rsplit("/", 1)[-1] in SHELLS and "-c" in toks:
            i = toks.index("-c")
            if i + 1 < len(toks):
                out.extend(segments(toks[i + 1]))
            continue
        out.append(toks)
    return out


def check(cmd: str) -> str | None:
    for toks in segments(cmd):
        name = toks[0].rsplit("/", 1)[-1]
        if name in EXFIL:
            return f"外部送信コマンド（{name}）は禁止です"
    for pat, msg in RULES:
        if pat.search(cmd):
            return msg
    for m in PNPM_INSTALL.finditer(cmd):
        if not re.search(r"(--filter|-F)\b", m.group(2)):
            return "フルの pnpm install は禁止です（@mobiscroll/react のエイリアスが壊れる）。--filter で対象を絞ってください"
    return None


def main() -> int:
    data = json.load(sys.stdin)
    cmd = (data.get("tool_input") or {}).get("command") or ""
    reason = check(cmd)
    if reason:
        print(f"ブロック: {reason}\nコマンド: {cmd}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
