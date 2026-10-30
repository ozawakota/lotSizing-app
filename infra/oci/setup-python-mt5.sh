#!/usr/bin/env bash
# 自動売買（infra/autotrade）用に、Wine 上へ Windows 版 Python と MetaTrader5 パッケージを入れる（初回のみ）。
# 前提: setup-mt5.sh で MT5 を導入済み・デモ口座にログイン済み・Xvfb(:99) 稼働中。
# MetaTrader5 パッケージは Windows 版 Python からしか使えないため、Linux の python3 ではなく Wine の python.exe を使う。
set -euo pipefail

export WINEPREFIX="${WINEPREFIX:-$HOME/.wine}"
export DISPLAY="${DISPLAY:-:99}"
export WINEDEBUG="${WINEDEBUG:--all}"
PY_VER="${PY_VER:-3.11.9}"

cd /tmp
if [ ! -f "python-${PY_VER}-amd64.exe" ]; then
  echo "[setup-python] Windows 版 Python ${PY_VER} をダウンロード ..."
  curl -fL -o "python-${PY_VER}-amd64.exe" "https://www.python.org/ftp/python/${PY_VER}/python-${PY_VER}-amd64.exe"
fi

echo "[setup-python] Wine に Python をインストール（無人インストール）..."
wine "python-${PY_VER}-amd64.exe" /quiet InstallAllUsers=0 PrependPath=1 Include_test=0 || true
wineserver -w || true

PY_WIN='C:\users\'"$USER"'\AppData\Local\Programs\Python\Python311\python.exe'
echo "[setup-python] pip で MetaTrader5 を導入 ..."
wine "$PY_WIN" -m pip install --upgrade pip
wine "$PY_WIN" -m pip install -r /opt/lotsizing-app/infra/autotrade/requirements.txt

echo "[setup-python] 接続テスト（起動中の MT5 端末に接続して口座情報を表示）..."
wine "$PY_WIN" -c "import MetaTrader5 as m; print('initialize:', m.initialize()); print(m.account_info()); m.shutdown()"

cat <<MSG
------------------------------------------------------------
完了。次の手順:
  1) 設定: cp /opt/lotsizing-app/infra/autotrade/config.example.json /opt/autotrade/config.json
     （pairs の symbol をブローカーのシンボル名に合わせる。dry_run は true のまま）
  2) 1回だけ試す:
     cd /opt/lotsizing-app/infra/autotrade && wine "$PY_WIN" main.py --config Z:/opt/autotrade/config.json --once
  3) 常駐: sudo systemctl enable --now mt5-autotrade.service
------------------------------------------------------------
MSG
