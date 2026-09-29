# USD/JPY 価格変動アラート (Google Apps Script)

USD/JPY が5分で25pips以上動いたら Telegram にプッシュ通知する監視ジョブ。
フロントエンド（React SPA / GitHub Pages）とは独立したサーバー側の常駐処理です。

- 設計と背景: [`docs/adr/0001-price-move-alerts-on-gas-rolling-spot.md`](../docs/adr/0001-price-move-alerts-on-gas-rolling-spot.md)
- 用語: [`CONTEXT.md`](../CONTEXT.md)（「5分足」＝ローリングスポット差分であって候足ではない）
- スクリプト本体: [`priceAlert.gs`](./priceAlert.gs)

## 仕様の要点

| 項目 | 値 |
|------|-----|
| 監視対象 | USD/JPY（1 pip = 0.01 円） |
| 発火条件 | `\|今の価格 − 5分前の価格\| ≥ 25 pips`（ローリング判定） |
| データ源 | Twelve Data 無料枠（`/price`、800 req/日） |
| 実行 | GAS 時間トリガー・毎分 |
| 監視時間帯 | 平日 15:00〜翌 02:00 JST のみ（≈660 req/日で枠内） |
| 連発防止 | 15分クールダウン |
| ウォームアップ | 起動直後5分は通知なし（5分前サンプルが揃うまで） |

---

## セットアップ手順（一度だけ）

### 1. Twelve Data の API キーを取得

1. <https://twelvedata.com/> でサインアップ（無料）
2. ダッシュボードで API キーを控える
3. 無料枠は **800 req/日・8 req/分**。本ジョブは平日 約660 req/日で枠内

### 2. Telegram ボットを作成し chat_id を取得

1. Telegram で **@BotFather** を開き `/newbot` → 指示に従いボット作成 → **bot token** を控える
2. 作成したボットとのトークを開き、何かメッセージを1通送る
3. ブラウザで次の URL を開く（`<TOKEN>` を置換）:
   ```
   https://api.telegram.org/bot<TOKEN>/getUpdates
   ```
4. レスポンス中の `"chat":{"id": ...}` の数値が **chat_id**

### 3. GAS プロジェクトを用意しスクリプトを配置

1. <https://script.google.com/> で新規プロジェクトを作成
2. `priceAlert.gs` の内容をコードエディタに貼り付け（ファイル名は任意）

### 4. スクリプト プロパティに秘匿情報を登録

GAS エディタ左の **⚙ プロジェクトの設定 → スクリプト プロパティ** で以下を追加:

| プロパティ | 値 |
|-----------|-----|
| `TWELVE_DATA_API_KEY` | 手順1のキー |
| `TELEGRAM_BOT_TOKEN` | 手順2の bot token |
| `TELEGRAM_CHAT_ID` | 手順2の chat_id |

> これらはリポジトリには含めません。GAS 側にのみ保存します。

### 5. 疎通確認 → トリガー作成

1. 関数選択で **`sendTestNotification`** を実行 → 初回は権限承認を求められるので許可
   - Telegram に「✅ テスト通知」が届けば疎通OK
2. 続けて **`setup`** を実行 → 1分間隔トリガーが作成され、以降は自動で `monitor()` が回る

---

## 動作確認・運用

- **ログ**: GAS エディタの「実行数」やログで `monitor()` の挙動を確認できる
- **時間帯外**: 監視時間外・週末は `monitor()` が即 return するので通知は出ない
- **停止したいとき**: ⚙ ではなく「トリガー」画面で `monitor` トリガーを削除、または再度 `setup()`（既存を掃除して作り直す）

## 設定変更

閾値・時間帯・クールダウンなどは `priceAlert.gs` 冒頭の `CONFIG` を編集するだけ:

```js
var CONFIG = {
  THRESHOLD_PIPS: 25,   // 発火閾値（pips）
  WINDOW_MIN: 5,        // ローリング窓（分）
  COOLDOWN_MIN: 15,     // 連発防止（分）
  // ...
};
```

## 既知の注意点

1. **Twelve Data の鮮度** — `demo` キーで測定した結果、`last_quote_at` は現在時刻から**約30〜60秒**（≒準リアルタイム、約1分粒度で更新）で、1分ポーリング設計には十分だった。ただし本番の無料登録キーと完全に一致する保証はないため、**キー取得後に一度だけ再測定を推奨**:
   ```bash
   curl -s "https://api.twelvedata.com/quote?symbol=USD/JPY&apikey=<YOUR_KEY>" \
     | sed -E 's/.*"last_quote_at":([0-9]+).*/\1/' \
     | xargs -I{} sh -c 'echo "delay: $(( $(date +%s) - {} )) sec"'
   ```
   数分単位の遅延が出るようなら「1分粒度」の実効性が落ちるので、その場合は `/price` を `/quote` に替えて `last_quote_at` で鮮度ガードを入れる等を検討する。
2. **GAS 時間トリガーの精度** — 秒単位の正確さは保証されず、稀に実行がスキップ/遅延する。「毎分」はおおむねの目安。
3. **判定はローソク境界に一致しない** — ローリング窓のため、窓内でスパイクして戻る動きは取りこぼし得る（設計上の割り切り。詳細は ADR-0001）。

---

> **通貨強弱は GAS を使わない構成に変更しました。** ボタン押下でクライアントから無料・キー不要の
> Frankfurter(ECB) API を直接叩き、日次で算出・表示します（GAS 不要）。詳細は
> [`docs/adr/0003-currency-strength-on-demand-client-side-free-api.md`](../docs/adr/0003-currency-strength-on-demand-client-side-free-api.md) を参照。
> このディレクトリの GAS は price-move alert 専用です。
