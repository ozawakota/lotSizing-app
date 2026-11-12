# 通貨強弱 Worker (Cloudflare Workers)

OANDA式の通貨強弱（対数変化率の合算・起点から0ベースの累積）を出すため、**X/JPYの時系列を Cron で取得し KV にキャッシュ**、クライアントへ配信する Cloudflare Worker。
GAS は使わない。設計は [`docs/adr/0005-currency-strength-oanda-cumulative-log.md`](../docs/adr/0005-currency-strength-oanda-cumulative-log.md)、
用語は [`CONTEXT.md`](../CONTEXT.md)（Currency strength / Strength start point / Strength refresh）を参照。

- 本体: [`src/index.ts`](./src/index.ts)（`scheduled()`＝2つのCronで時系列取得、`fetch()`＝KV配信）
- 強弱の計算式はフロントの [`src/lib/strength.ts`](../src/lib/strength.ts)（`computeCumulativeStrength`）を共有 import（単一実装）。クライアントが起点(4時間前/当日/年初)を選んで累積を計算。

## 仕様の要点

| 項目 | 値 |
|------|-----|
| 対象通貨 | JPY, USD, EUR, GBP, AUD, NZD, CAD, CHF の8通貨 |
| 指標 | 各通貨の他7通貨に対する**対数変化率の合算**を起点から累積（総和≈0、起点0） |
| 起点 | 1時間前 / 4時間前 / 当日（15分足）／ 年初（日足） |
| データ源 | Twelve Data `time_series`（7ペア一括＝7 credits/回、credits はシンボル数課金） |
| 実行 | Cron 2本：15分足=2時間ごと `0 */2 * * *`、日足=1日1回 `30 0 * * *`（別の分にして分次制限を回避、≈91 credits/日で無料枠内） |
| キャッシュ | Workers KV（キー `intraday` / `daily`） |
| 失敗時 | KV を上書きせず前回値を保持 |

## ロジック（通貨強弱の計算）

OANDA の「通貨力バランス」に倣った、**対数変化率の合算・起点から0基準の累積**方式。
計算式はフロントと共有（[`src/lib/strength.ts`](../src/lib/strength.ts) の `computeCumulativeStrength` / `findStartIndex`）で、
**Worker は時系列の取得・キャッシュのみ**、**累積の計算はクライアント側**で行う（起点切替で追加のAPI呼び出しは発生しない）。

### 1. 何を測るか
各通貨が「他の全通貨に対して」どれだけ買われた/売られたかを、選択した起点から積み上げた相対スコア。
プラス=買われて強い、マイナス=売られて弱い。8通貨のスコアは各時点で合計≈0（相対指標）。

### 2. 入力データ
7本の **X/JPY 時系列**（USD/JPY, EUR/JPY, GBP/JPY, AUD/JPY, NZD/JPY, CAD/JPY, CHF/JPY）。
JPY は基軸なので単独では取らず、この7本から全8通貨をカバーする。

### 3. 計算手順
1. 各時点 `i` で、各通貨 C の **JPY に対する対数リターン**を起点 `start` からの差分で出す:
   `ln_C(i) = ln( C/JPY[i] )`、`cumRet_C(i) = ln_C(i) − ln_C(start)`（JPY は基軸なので常に 0）。
2. 任意の2通貨のクロスは `X/Y = (X/JPY)/(Y/JPY)` で導けるため、**「クォート側は 1/価格 で反転」も自動的に等価**に処理される。
3. 各通貨の強弱＝他7通貨に対する対数変化の**合算**を累積:
   ```
   strength_C(i) = Σ_(D≠C) [ cumRet_C(i) − cumRet_D(i) ] × 100
                 = ( 8 × cumRet_C(i) − Σ_all cumRet(i) ) × 100
   ```
   起点で全通貨 0、各時点で総和 ≈ 0。

### 4. 起点（0基準）
- `1h` / `4h` … 15分足シリーズで「今から1/4時間前」に最も近いバーを起点に。
- `today` … 15分足シリーズで当日(JST)最初のバーを起点に。
- `year` … 日足シリーズで今年(JST)最初のバーを起点に。

### 5. データフロー
```
Cron ──> Twelve Data time_series (7ペア一括) ──> KV(intraday / daily)
                                                     │
Client ──> Worker.fetch() ──> KV を読んで時系列を返す ──> ブラウザで computeCumulativeStrength → 折れ線描画
```

### 6. 注意
OANDA と同じ「対象8通貨・対数・合算・0基準の累積」だが、OANDA 独自の重み・足種・丸めまでは
再現しないため、**傾向は近くても数値は一致しない**。

## セットアップ

```bash
cd worker
npm install                      # wrangler と @cloudflare/workers-types
npx wrangler login               # Cloudflare アカウントにログイン
npx wrangler kv namespace create STRENGTH_KV   # 出力の id を wrangler.toml に貼る
npx wrangler secret put TWELVE_DATA_API_KEY    # Twelve Data のキーを登録（バンドルには載らない）
npx wrangler secret put MYFXBOOK_EMAIL         # /flow センチメント用（Myfxbook 無料アカウント）
npx wrangler secret put MYFXBOOK_PASSWORD      # /flow センチメント用
npx wrangler secret put TURSO_DATABASE_URL     # /orderbook 推定ポジションブック用（個人の建玉の毎時の記録先。libsql://...）
npx wrangler secret put TURSO_AUTH_TOKEN       # 同上（turso db tokens create の出力）
npx wrangler deploy              # デプロイ（Cron も同時に設定される）
```

デプロイで発行された Worker の URL を、フロントの環境変数に設定する:
- `VITE_STRENGTH_URL=https://currency-strength.<subdomain>.workers.dev`（通貨強弱）
- `VITE_FLOW_URL=https://currency-strength.<subdomain>.workers.dev/flow`（取引量・センチメント）

### 推定オーダーブック（/orderbook）

TF分析ページの「推定オーダーブック」は、この Worker の `/orderbook?instrument=USD_JPY` が返す自作の推定（OANDA の API は使わない）。
URL は `VITE_MTF_URL` の `/mtf` を置き換えて使うので、フロントの設定追加は不要。推定ロジックは `src/lib/estimatedBook.ts`。

- **注文（オーダーブック）**: 1時間足から推定。まだ抜けていないスイング高値の少し上＝買いの逆指値・少し下＝売り指値、
  まだ割れていないスイング安値の少し下＝売りの逆指値・少し上＝買い指値、キリ番（00・50）＝指値とその外の逆指値。
  新しいスイングほど重く、個人の建玉（Myfxbook）が売りに偏るほど買いの逆指値（売り方の損切り）を重くする。Turso なしで動く。
- **ポジション（ポジションブック）**: `/flow` の毎時更新（Cron 毎時15分）のたびに、Myfxbook の建玉（買い/売りの割合・取引量・平均取得価格）を
  Turso の `flow_snapshots` に1行ずつ記録し（30日分を保持）、直近の記録を新しいほど重く積み上げて価格帯ごとの分布にする。
  記録が3件たまるまでは表示しない。テーブルは Worker が初回に自動で作る。
- Turso の準備:
  ```bash
  turso db create lotsizing-flow
  turso db show lotsizing-flow --url        # → TURSO_DATABASE_URL（libsql://...）
  turso db tokens create lotsizing-flow     # → TURSO_AUTH_TOKEN
  ```
  それぞれを `npx wrangler secret put` で登録（リポジトリには置かない）。未登録なら記録はせず、注文の推定だけを返す。
- **集計の仕方は OANDA の板情報に合わせる**（入力が推定である点だけが違う）:
  - 20分ごと（:00 / :20 / :40）のスナップショット。Cron（5分ごと）が各スロットの最初の回に全ペア分を作り、
    Turso の `book_snapshots` に保存（14日分を保持）。`/orderbook` はいちばん新しいスナップショットを返す
  - `/orderbook?instrument=USD_JPY&time=2026-11-12T21:20:00Z`（または ms）で、その時刻以前のスナップショット（OANDA の `time` と同じ）
  - 固定幅のバケツ（JPY 0.05・USD 0.0005・XAU 1）ごとの [価格, 買い%, 売り%]。% は板全体の合計に対する割合
- Turso 未設定のときは保存せず、リクエストのたびにその場で推定する（20分のスロットの間は Worker のメモリ＋Cache API に置く。過去の時刻の指定は不可）。KV は使わない。

## 動作確認

```bash
# 手動で fetch を叩く（Cron が一度回った後はスナップショットが返る）
curl "https://currency-strength.<subdomain>.workers.dev"
# ローカル実行（scheduled のテストは --test-scheduled）
npx wrangler dev --test-scheduled
```

## 取引量・センチメント (`/flow`)

同じ Worker の **`/flow` パス**で、7ペア（X/JPY）の建玉情報を配信する。
フロントは [`src/OrderFlow.tsx`](../src/OrderFlow.tsx)、ロジック/型は [`src/lib/flow.ts`](../src/lib/flow.ts) を Worker と共有する。

> **経緯**: 当初 Twelve Data の `interval=4h` tick volume を使う設計だったが、FXでは常に `volume=0` が返り使えなかった。
> そのため取引量は **Myfxbook Community Outlook の実建玉 volume（`longVolume` / `shortVolume`）に一本化**した。
> これは当初要望「取引量が買いか売りか」に直接合致する（Twelve Data 4時間足取得は廃止）。

| 項目 | 値 |
|------|-----|
| データ源 | Myfxbook Community Outlook（`login.json` → `get-community-outlook.json`） |
| 取得値 | ペアごとの `longPercentage/shortPercentage`（建玉割合）と `longVolume/shortVolume`（買い量/売り量） |
| 優勢判定 | `longVolume` と `shortVolume` の多い方を「買い優勢 / 売り優勢」とする |
| 実行 | Cron 1本：毎時 `15 * * * *`（Myfxbook 最大48 req/日、無料枠100内・最小15分粒度も満たす） |
| キャッシュ | Workers KV（`flow` / `mfb_session`。session 切れ時は再ログインして1回リトライ） |
| 失敗時 | KV を上書きせず前回値を保持 |

> **注意**: スポットFXに中央集権的な出来高は無い。ここで言う取引量・建玉割合は **Myfxbook の個人投資家コミュニティの現在ポジション**であり、市場全体ではなく個人投資家層の傾向を表す。

動作確認: `curl "https://currency-strength.<subdomain>.workers.dev/flow"`

## 無料枠

Workers 100k req/日・KV 書込 1000/日・Cron 3個/Worker で、いずれも十分。
※ Workers/KV の無料枠は**アカウント単位**で全 Worker/Pages と共有。
実質のボトルネックは Twelve Data 無料枠 800/日（15分足84＋日足7＝**約91/日**、価格アラートと共有）。
なお 8 credits/分 の分次制限があるため、7ペア一括(=7)を超えないよう Cron を別の分に分散している。
Myfxbook は無料枠 100 req/日・最小15分粒度で、毎時更新（1〜2 req/回）はいずれも満たす。
