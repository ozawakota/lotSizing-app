# MT5 → Turso 同期基盤（infra）

OCI(Always Free) 上の Ubuntu + Wine + MT5 から、口座状態・建玉・約定履歴を
クラウド SQLite の **Turso** へ同期し、PC/スマホ/Web からリアルタイムに監視・分析するための基盤。

このディレクトリは **サブプロジェクト①「Turso スキーマ＋Python 同期」** を実装したもの。
OCI プロビジョニング（②）と監視画面（④）は別サブプロジェクトとして後続で扱う。

## アーキテクチャ

```
 MT5 端末 (Wine)                 OCI Linux 側 (Python)              Turso (libSQL)
 ┌───────────────┐   CSV ファイル   ┌──────────────────┐   libSQL   ┌──────────────┐
 │ Mt5SyncExporter│ ──────────────▶ │ sync.py           │ ─────────▶ │ accounts     │
 │  .mq5 (EA)     │  MQL5/Files/    │  reader → store   │            │ positions    │
 │  口座/建玉/約定 │   mt5sync/*.csv │  冪等 upsert       │            │ deals        │
 └───────────────┘  (アトミック書き) └──────────────────┘            └──────────────┘
```

- **EA（出力側）** は読み取り専用。発注は一切しない。口座/建玉/約定を CSV で `MQL5/Files/mt5sync/` に出力し、`tmp`→`FileMove` でアトミックに差し替える。`manifest.csv` を最後に書き、1セット完了を知らせる。
- **sync.py（取り込み側）** は manifest を確認し、CSV を読んで Turso へ **冪等 upsert**。建玉はその口座分を総入替してクローズ済みを消す。約定は `deal_id` で upsert。1サイクル失敗は致命的にせず次回リトライ。
- **Turso と SQLite は互換**なので、同じ SQL がローカル検証（sqlite3）と本番（libSQL）で動く。

## ディレクトリ

```
infra/
  db/schema.sql                 … Turso/SQLite スキーマ（accounts/positions/deals）
  mt5/Mt5SyncExporter.mq5        … 出力側 EA（MQL5）
  sync/
    config は環境変数（store.connect 参照）
    reader.py                    … CSV → データクラス（壊れ行に強い）
    store.py                     … DB アダプタ（sqlite3 / libsql）＋冪等 upsert
    sync.py                      … オーケストレーション＋CLI（--once/--loop）
    requirements.txt             … 本番のみ: libsql-experimental
    systemd/                     … OCI 常駐用 service/timer と env サンプル
    tests/                       … 標準ライブラリのみの単体テスト
```

## セットアップ

### 1) Turso DB を作成してスキーマ投入
```sh
turso db create mt5-sync
turso db shell mt5-sync < infra/db/schema.sql
turso db show mt5-sync --url            # TURSO_DATABASE_URL
turso db tokens create mt5-sync         # TURSO_AUTH_TOKEN
```

### 2) MT5 に EA を導入（MT5 端末側）
1. `infra/mt5/Mt5SyncExporter.mq5` を MetaEditor で開きコンパイル。
2. 任意のチャートに EA を適用（アルゴ取引を有効化）。
3. 入力: `InpIntervalSec`（出力間隔秒・既定60）、`InpDealsDays`（約定遡及日数・既定30）。
4. `MQL5/Files/mt5sync/` に CSV が出力されることを確認。

### 3) OCI 上で同期サービスを常駐（Linux 側）
```sh
sudo mkdir -p /opt/mt5-sync
sudo cp -r infra/sync/* /opt/mt5-sync/
sudo cp infra/db/schema.sql /opt/mt5-sync/../db/schema.sql  # store.py は ../db/schema.sql を参照
pip3 install -r /opt/mt5-sync/requirements.txt              # libsql-experimental

sudo cp infra/sync/systemd/mt5-sync.env.example /etc/mt5-sync.env
sudo nano /etc/mt5-sync.env        # TURSO_* と MT5_SYNC_DIR を設定（権限 600 推奨）
sudo cp infra/sync/systemd/mt5-sync.{service,timer} /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now mt5-sync.timer
```
> `store.py` はスキーマを `../db/schema.sql`（自身の1つ上の `db/`）から読む。`/opt/mt5-sync/` 配下に
> `sync/` と `db/` が並ぶように配置するか、`infra/` ごとコピーして `infra/sync/` から実行する。

### ローカル開発・テスト（追加 pip 不要）
```sh
cd infra/sync
python3 -m unittest discover -s tests -v           # 単体テスト（sqlite3 + CSVフィクスチャ）
# 手動確認（TURSO 未設定 → カレントに mt5sync.db を作成）:
python3 sync.py --dir /path/to/mt5sync --once
```

## 検証状況

- ✅ **ローカル検証済み**: スキーマ適用・CSV パース・冪等 upsert・建玉総入替・manifest 欠損スキップ・壊れ行耐性（`tests/` 6件 PASS）。
- ⏳ **実機で要確認（本環境では実行不可）**:
  - MQL5 EA のコンパイル/動作（MT5 が必要）。
  - 本番 Turso への実疎通（トークンが必要。SQL は SQLite 互換のためローカルで論理検証済み）。
  - OCI 上の Wine/MT5 稼働（サブプロジェクト②で扱う）。

## 自動売買（autotrade）

`infra/autotrade/` は、TF分析の「入りどき」判定（Worker の `/mtf`）を使って MT5 の**デモ口座**に自動発注する
Python ボット（Wine 上の Windows 版 Python + `MetaTrader5`）。同期 EA（読み取り専用）とは別に動く。
手順は `infra/autotrade/README.md`。

## 後続サブプロジェクト

- **②OCI プロビジョニング**: Terraform/cloud-init で Always Free インスタンス＋Wine＋MT5＋Python 環境を構築。
- **④監視画面**: fund-worker と同様の Cloudflare Worker で Turso を読み、本 React アプリに取引監視ページを追加。
