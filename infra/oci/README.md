# ②OCIプロビジョニング（Always Free + Wine + MT5 + Python + 同期常駐）

OCI Always Free の x86 インスタンスに **Ubuntu + Wine + MT5 + Python 同期**を構築し、
`mt5-sync.timer` で Turso へ常時同期する手順。構築は **cloud-init + OCIコンソール**、MT5の初回設定は
**VNC（SSHトンネル）** で行う。

> ⚠ **検証状況**: cloud-init / スクリプト / systemd ユニット / 手順は作成・構文チェック済みだが、
> **OCI/Wine/MT5 の実動作は未検証**（実機でのみ確認可能）。Wine上のMT5は環境差があるため、
> うまくいかない場合は該当ステップのログを見て調整すること。

## 0) 重要な前提
- **シェイプは x86 の `VM.Standard.E2.1.Micro`**（AMD, 1 OCPU / 1GB RAM）。
  **ARM の `A1.Flex` は不可**（Wine は x86 バイナリの MT5 を ARM で実行できない）。
- RAM 1GB は小さいので cloud-init が **2GB スワップ**を作成する。
- 事前に Turso 側は準備済み（`mt5-sync` DB・スキーマ・URL・トークン）。

## 1) インスタンス作成（OCIコンソール）
1. Compute → Instances → Create instance。
2. Image/Shape: **Ubuntu 22.04**、**VM.Standard.E2.1.Micro**（Always Free 対象）。
3. SSH 公開鍵を登録。
4. **Advanced → Management → cloud-init（User data）** に `infra/oci/cloud-init.yaml` の中身を貼り付け。
5. ネットワーク: VCN のセキュリティリストで **22/tcp（SSH）を自分のIPのみ許可**。VNC(5900)は**開けない**（SSHトンネルを使う）。
6. 作成 → パブリックIP を控える。

## 2) 起動確認（SSH）
```sh
ssh ubuntu@<PUBLIC_IP>
cloud-init status --wait          # done になるまで待つ
cat NEXT_STEPS.txt
systemctl status xvfb.service     # active
systemctl list-timers | grep mt5  # mt5-sync.timer が登録済み（MT5未導入のうちは skip ログ）
```

## 3) MT5 導入（VNC over SSH トンネル・初回のみ）
別ターミナルで SSH トンネルを張る:
```sh
ssh -L 5900:localhost:5900 ubuntu@<PUBLIC_IP>
```
インスタンス側で VNC を一時起動し、セットアップスクリプトを実行:
```sh
sudo systemctl start x11vnc.service
cd /opt/lotsizing-app/infra/oci
bash setup-mt5.sh
```
手元の VNC クライアントで `localhost:5900` に接続し、GUI で:
1. MT5 インストーラを完了。
2. MT5 でブローカー口座にログイン。
3. EA を配置して適用:
   ```sh
   # EA ソースを MT5 の Experts フォルダへコピー
   cp /opt/lotsizing-app/infra/mt5/Mt5SyncExporter.mq5 \
      "$HOME/.wine/drive_c/users/$USER/AppData/Roaming/MetaQuotes/Terminal/"*/MQL5/Experts/
   ```
   MetaEditor（VNC画面）で `Mt5SyncExporter.mq5` をコンパイル → ナビゲータからチャートに適用 →
   「アルゴリズム取引」を有効化。`InpIntervalSec`/`InpDealsDays` は必要に応じて調整。

## 4) 同期先の設定
EA が出力を始めたら実パスを確認し、env を更新:
```sh
ls -d "$HOME"/.wine/drive_c/users/*/AppData/Roaming/MetaQuotes/Terminal/*/MQL5/Files/mt5sync
sudo nano /etc/mt5-sync.env    # TURSO_AUTH_TOKEN と MT5_SYNC_DIR を実値に（権限600）
```
手動で1回テスト:
```sh
sudo systemctl start mt5-sync.service
journalctl -u mt5-sync.service -n 20 --no-pager     # [mt5-sync] {...counts...}
```

## 5) ヘッドレス常駐へ
```sh
sudo systemctl enable --now mt5.service   # MT5 を Xvfb 上で常駐（端末を閉じても稼働）
# 同期タイマーは cloud-init で有効化済み。稼働を確認:
systemctl status mt5-sync.timer
```

## 6) 片付け（セキュリティ・重要）
```sh
sudo systemctl stop x11vnc.service && sudo systemctl disable x11vnc.service
```
- VNC は初回設定時のみ。終わったら必ず停止（`-localhost` なので公開はされないが念のため）。
- `/etc/mt5-sync.env` は権限600・Git 禁止。MT5 パスワードは強固に。SSH は鍵認証・自IP限定。

## 動作確認（Turso 側）
```sh
turso db shell mt5-sync "SELECT login, equity, updated_at FROM accounts;"
turso db shell mt5-sync "SELECT COUNT(*) FROM positions;"
turso db shell mt5-sync "SELECT COUNT(*) FROM deals;"
```

## トラブルシュート
- `mt5-sync` が `skipped: manifest_missing`: EA がまだ出力していない / `MT5_SYNC_DIR` のパス違い。
- Wine で MT5 が起動しない: `journalctl -u mt5.service`、`WINEDEBUG=war+all wine .../terminal64.exe` で切り分け。`winetricks corefonts vcrun2019` を追加。
- メモリ逼迫: `free -h` でスワップ使用を確認。チャート・インジケータを最小化。
- 最新 Wine が必要な場合: WineHQ リポジトリ（`dpkg --add-architecture i386` 済）から `winehq-stable` を導入。
