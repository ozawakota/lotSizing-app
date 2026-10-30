# 自動売買ボット（MT5 デモ口座・Python）

TF分析ページの「入りどき」判定（Cloudflare Worker の `/mtf`）を使い、MT5 の**デモ口座**に自動で発注する。
OCI（Ubuntu + Wine）上の MT5 端末を、Wine 上の Windows 版 Python と `MetaTrader5` パッケージで操作する。

> ⚠ 投資助言ではない検証用のコード。**デモ口座専用**（`demo_only: true` でリアル口座では発注しない）。
> 判定のしきい値は経験的な初期値で、過去データでの検証はしていない。まず `dry_run: true` で数日ログを確認すること。

## しくみ

```
Cloudflare Worker (/mtf)            OCI: Wine 上の Windows 版 Python            MT5 端末（Wine・デモ口座）
 RR（方向・損切り・目標）  ──HTTP──▶  main.py --loop（5分ごと）        ──MetaTrader5──▶  発注・取消
 入りどき（ok/wait/avoid）           判定 → ロット計算 → 安全チェック
```

| 入りどき | 動き |
|---|---|
| 🟢 入りどき（ok） | 成行。損切り・目標は `/mtf` の RR のまま |
| 🟡 押し目待ち/戻り待ち（wait） | 指値の目安に指値注文（損切り・目標は同じ）。`limit_expiry_hours` で約定しなければ取消 |
| 🔴 高値掴み/安値売り注意（avoid） | 見送り |
| RR なし（レンジ・転換の兆し）・RR 不足 | 見送り |

### 安全装置
- **デモ口座以外は発注しない**（`demo_only`）。**dry_run**（既定 true）では注文を送らずログだけ
- **ロット**: 損切りまでの損失が 残高 × `risk_pct`% 以内（最小ロットでも超えるなら見送り）
- **1日の損失上限**（`daily_max_loss_pct`・日本時間の0時起点、確定＋含み損益）で新規発注を停止
- **同時ポジションの上限**（`max_positions`）、同じペアは1つまで、同じ向きは `cooldown_hours` 空ける
- **スプレッドが広い**とき・**判定から損切り幅の半分以上動いた**ときは見送り
- 損切り・目標の位置が不正/近すぎるときは見送り。ボットの注文は `magic` で手動の注文と区別
- XAU は `/mtf` が金先物（GC=F）基準のため、ブローカーの現物価格との差だけ平行移動する

## 設定（`config.json`）

`config.example.json` をコピーして編集する（`config.json` は Git に入れない）。

| 項目 | 既定 | 説明 |
|---|---|---|
| `pairs` | USD_JPY / USDJPY / 1h | `instrument`（アプリの表記）・`symbol`（ブローカーのシンボル名。`USDJPY.a` など末尾が付くことがある）・`timeframe`（15m/30m/1h/4h） |
| `risk_pct` | 2.0 | 1回の許容損失（残高の %） |
| `daily_max_loss_pct` | 6.0 | 1日の損失上限（残高の %） |
| `max_positions` | 3 | 同時に持つポジション＋指値の上限 |
| `max_spread_pips` | 3.0 | これより広いと見送り（XAU は 1pips=0.1） |
| `use_limit_orders` / `limit_expiry_hours` | true / 4 | 押し目待ちのときに指値を置くか・何時間で取り消すか |
| `min_rr` | 2.0 | これ未満の RR は見送り |
| `cooldown_hours` | 4 | 同じペア・同じ向きで続けて入らない時間 |
| `poll_seconds` | 300 | 確認間隔 |
| `dry_run` / `demo_only` | true / true | 最初は両方 true |

MT5 のログイン情報を Python から渡す場合は環境変数 `MT5_LOGIN` / `MT5_PASSWORD` / `MT5_SERVER`
（`/etc/mt5-autotrade.env`・権限600・Git 禁止）。端末側でログイン済みなら不要。

## OCI へのセットアップ

前提: `infra/oci/README.md` の手順で MT5 を Wine に導入し、**デモ口座にログイン済み**・端末の「アルゴリズム取引」が有効。

```sh
cd /opt/lotsizing-app && git pull
bash infra/oci/setup-python-mt5.sh                     # Wine に Windows 版 Python + MetaTrader5（接続テストまで）
sudo mkdir -p /opt/autotrade && sudo chown ubuntu /opt/autotrade
cp infra/autotrade/config.example.json /opt/autotrade/config.json
nano /opt/autotrade/config.json                        # symbol をブローカーに合わせる。dry_run は true のまま

# 1回だけ試す（判定と注文内容がログに出る）
cd infra/autotrade
wine "C:\\users\\ubuntu\\AppData\\Local\\Programs\\Python\\Python311\\python.exe" main.py --config Z:/opt/autotrade/config.json --once

# 常駐
sudo cp ../oci/systemd/mt5-autotrade.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now mt5-autotrade.service
journalctl -u mt5-autotrade.service -f
```

dry-run のログで判定と注文内容に納得できたら、`config.json` の `dry_run` を `false` にして
`sudo systemctl restart mt5-autotrade.service`。dry-run 中も「入ったことにする」ので、切り替え直後は
`cooldown_hours` の間だけ同じ向きの注文が出ないことがある。

## テスト（MT5 不要・標準ライブラリのみ）

```sh
cd infra/autotrade
python3 -m unittest discover -s tests -v
```

## 検証状況
- ✅ 判定 → プラン、ロット計算、安全装置、発注/取消の流れは、偽のブローカーで単体テスト済み
- ⏳ **実機で要確認**（この開発環境では MT5 を動かせない）: Wine 上の Windows 版 Python と `MetaTrader5` の接続、
  ブローカーごとの約定方式（filling mode）・シンボル名・最小距離（stops level）
- 1GB RAM の E2.1.Micro では Wine の MT5 と Python の同時稼働はメモリが厳しい（スワップ 2GB 前提）。
  不安定ならチャート数を減らすか、より大きいシェイプにする
