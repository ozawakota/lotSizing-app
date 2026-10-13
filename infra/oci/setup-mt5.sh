#!/usr/bin/env bash
# MT5 を Wine + Xvfb(:99) 上に導入する補助スクリプト（初回のみ・VNC 接続中に実行）。
# 前提: cloud-init 済み（wine/xvfb 導入・xvfb.service 稼働）。SSHトンネルで VNC 接続済み。
# 流れ: Wine 初期化 → 推奨フォント等 → MT5 インストーラ取得 → GUI インストーラ起動。
# インストーラは GUI 操作が要るため、VNC 画面でクリック進行する。
set -euo pipefail

export WINEPREFIX="${WINEPREFIX:-$HOME/.wine}"
export DISPLAY="${DISPLAY:-:99}"
export WINEDEBUG="${WINEDEBUG:--all}"

echo "[setup-mt5] WINEPREFIX=$WINEPREFIX DISPLAY=$DISPLAY"

# 1) Wine プレフィックス初期化（初回のみ時間がかかる）。
echo "[setup-mt5] wineboot --init ..."
wineboot --init || true
wineserver -w || true

# 2) 推奨ランタイム/フォント（winetricks があれば）。無くても MT5 は概ね動く。
if command -v winetricks >/dev/null 2>&1; then
  echo "[setup-mt5] winetricks corefonts ..."
  winetricks -q corefonts || true
else
  echo "[setup-mt5] winetricks 未導入（任意）。必要なら: sudo apt-get install -y winetricks"
fi

# 3) MT5 インストーラ取得（MetaQuotes 汎用。ブローカー専用版がある場合はその URL に差し替え可）。
cd /tmp
if [ ! -f mt5setup.exe ]; then
  echo "[setup-mt5] mt5setup.exe をダウンロード ..."
  curl -fL -o mt5setup.exe "https://download.mql5.com/cdn/web/metaquotes.software.corp/mt5/mt5setup.exe"
fi

# 4) インストーラ起動（GUI）。VNC 画面でウィザードを進める。
cat <<'MSG'
------------------------------------------------------------
これから MT5 インストーラを起動します（GUI）。
VNC 画面でウィザードを完了してください。完了後:
  - MT5 が起動したらブローカー口座にログイン
  - ナビゲータから Mt5SyncExporter を対象チャートに適用（アルゴ取引を有効化）
    ※ EA 配置: <WINEPREFIX>/drive_c/.../MQL5/Experts/ に Mt5SyncExporter.mq5 を置き、
      MetaEditor でコンパイル(.ex5)してから適用する。
------------------------------------------------------------
MSG
wine /tmp/mt5setup.exe || true

echo "[setup-mt5] 完了。MT5_SYNC_DIR の実パス確認:"
echo "  ls -d \"$WINEPREFIX\"/drive_c/users/*/AppData/Roaming/MetaQuotes/Terminal/*/MQL5/Files 2>/dev/null"
