/**
 * USD/JPY 価格変動アラート (Google Apps Script)
 * ------------------------------------------------------------------
 * 設計は docs/adr/0001-price-move-alerts-on-gas-rolling-spot.md を参照。
 * 用語は CONTEXT.md を参照（「5分足」＝ローリングスポット差分であって候足ではない）。
 *
 * 概要:
 *   時間トリガーで毎分 monitor() を実行し、平日15:00〜26:00 JST の間だけ
 *   Twelve Data から USD/JPY スポット価格を取得。今の価格と「5分前の価格」の
 *   差が 25pips(=0.25円) 以上なら Telegram にプッシュ通知する。
 *   一度発火したら15分はクールダウン。起動直後5分はウォームアップ（通知なし）。
 *
 * ------------------------------------------------------------------
 * セットアップ (一度だけ)
 * ------------------------------------------------------------------
 * 1. Twelve Data の API キーを取得 (無料枠: 800 req/日, 8 req/分)
 * 2. Telegram: @BotFather でボット作成 → bot token を取得。
 *    自分のボットに一度メッセージを送り、
 *      https://api.telegram.org/bot<TOKEN>/getUpdates
 *    の結果から chat.id を控える。
 * 3. GAS エディタ → プロジェクトの設定 → スクリプト プロパティ に以下を登録:
 *      TWELVE_DATA_API_KEY   = <your key>
 *      TELEGRAM_BOT_TOKEN    = <bot token>
 *      TELEGRAM_CHAT_ID      = <chat id>
 * 4. GAS エディタで一度 setup() を実行（1分間隔トリガーを作成）。
 *    以降は自動で毎分 monitor() が回る。
 *
 * テスト: sendTestNotification() を実行すると Telegram 疎通を確認できる。
 */

// ===== 設定（動作を変えたいときはここだけ） =====
var CONFIG = {
  SYMBOL: 'USD/JPY',
  PIP_SIZE: 0.01,        // USD/JPY の 1 pip = 0.01 円
  THRESHOLD_PIPS: 25,    // 発火閾値（25pips = 0.25円）
  WINDOW_MIN: 5,         // ローリング窓（分）
  COOLDOWN_MIN: 15,      // 連発防止（分）
  SESSION: {
    // 平日 15:00〜26:00(=翌02:00) JST の高ボラ帯のみ監視（≈660 req/日で無料枠内）
    EVENING_START_HOUR: 15, // 15:00〜23:59 は Mon〜Fri
    EARLY_END_HOUR: 2       // 00:00〜01:59 は Tue〜Sat（前営業日セッションの尾）
  },
  TZ: 'Asia/Tokyo'
};

var PROP_HISTORY = 'PRICE_HISTORY';   // 直近サンプルの JSON 配列 [[ms, price], ...]
var PROP_LAST_ALERT = 'LAST_ALERT_MS';

// ===== トリガー作成（一度だけ手動実行） =====
function setup() {
  // 既存の monitor トリガーを掃除してから作り直す
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'monitor') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('monitor').timeBased().everyMinutes(1).create();
  Logger.log('1分間隔トリガーを作成しました。');
}

// ===== 毎分実行される本体 =====
function monitor() {
  var now = new Date();
  if (!isWithinSession(now)) return; // 監視時間外は何もしない（クォータ節約）

  var price = fetchPrice();
  if (price === null) return; // 取得失敗はこのtickをスキップ（履歴も更新しない）

  var props = PropertiesService.getScriptProperties();
  var nowMs = now.getTime();

  // 履歴を更新（今の価格を追加し、古すぎるものを間引く）
  var history = readHistory(props);
  history.push([nowMs, price]);
  var keepAfter = nowMs - (CONFIG.WINDOW_MIN + 2) * 60 * 1000; // 窓+2分だけ保持
  history = history.filter(function (e) { return e[0] >= keepAfter; });
  props.setProperty(PROP_HISTORY, JSON.stringify(history));

  // 「5分前」に最も近いサンプルを探す（許容: 4.5〜6.5分前）
  var past = findSampleAround(history, nowMs, CONFIG.WINDOW_MIN);
  if (past === null) return; // ウォームアップ中 or データ欠損 → 通知しない

  var deltaPips = (price - past[1]) / CONFIG.PIP_SIZE;
  if (Math.abs(deltaPips) < CONFIG.THRESHOLD_PIPS) return;

  // クールダウン判定
  var lastAlert = Number(props.getProperty(PROP_LAST_ALERT) || 0);
  if (nowMs - lastAlert < CONFIG.COOLDOWN_MIN * 60 * 1000) return;

  sendTelegram(buildMessage(price, past[1], deltaPips, now));
  props.setProperty(PROP_LAST_ALERT, String(nowMs));
}

// ===== 監視時間帯（平日 15:00〜翌02:00 JST） =====
function isWithinSession(date) {
  var hour = parseInt(Utilities.formatDate(date, CONFIG.TZ, 'H'), 10);
  var dow = parseInt(Utilities.formatDate(date, CONFIG.TZ, 'u'), 10); // 1=Mon..7=Sun
  var evening = hour >= CONFIG.SESSION.EVENING_START_HOUR && dow >= 1 && dow <= 5; // Mon-Fri 15:00-23:59
  var early = hour < CONFIG.SESSION.EARLY_END_HOUR && dow >= 2 && dow <= 6;        // Tue-Sat 00:00-01:59
  return evening || early;
}

// ===== Twelve Data からスポット価格取得 =====
function fetchPrice() {
  var key = PropertiesService.getScriptProperties().getProperty('TWELVE_DATA_API_KEY');
  if (!key) { Logger.log('TWELVE_DATA_API_KEY 未設定'); return null; }
  var url = 'https://api.twelvedata.com/price?symbol=' +
            encodeURIComponent(CONFIG.SYMBOL) + '&apikey=' + encodeURIComponent(key);
  try {
    var res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    var data = JSON.parse(res.getContentText());
    // 正常: {"price":"150.27"} / 異常: {"code":..., "message":...}
    if (data && data.price) {
      var p = parseFloat(data.price);
      return isNaN(p) ? null : p;
    }
    Logger.log('Twelve Data 応答が想定外: ' + res.getContentText());
    return null;
  } catch (e) {
    Logger.log('Twelve Data 取得失敗: ' + e);
    return null;
  }
}

// ===== 履歴ヘルパー =====
function readHistory(props) {
  var raw = props.getProperty(PROP_HISTORY);
  if (!raw) return [];
  try { var h = JSON.parse(raw); return Array.isArray(h) ? h : []; }
  catch (e) { return []; }
}

/**
 * targetMin 分前に最も近いサンプルを返す。
 * 許容範囲は targetMin-0.5 〜 targetMin+1.5 分前（1分ポーリングの揺らぎ吸収）。
 * 見つからなければ null（ウォームアップ or 欠損）。
 */
function findSampleAround(history, nowMs, targetMin) {
  var lo = nowMs - (targetMin + 1.5) * 60 * 1000;
  var hi = nowMs - (targetMin - 0.5) * 60 * 1000;
  var best = null, bestDiff = Infinity;
  var idealMs = nowMs - targetMin * 60 * 1000;
  for (var i = 0; i < history.length; i++) {
    var t = history[i][0];
    if (t >= lo && t <= hi) {
      var d = Math.abs(t - idealMs);
      if (d < bestDiff) { bestDiff = d; best = history[i]; }
    }
  }
  return best;
}

// ===== Telegram 通知 =====
function buildMessage(price, pastPrice, deltaPips, date) {
  var rounded = Math.round(deltaPips);
  var up = rounded >= 0;
  var sign = up ? '+' : '−';
  var dir = up ? '上昇' : '下落';
  var time = Utilities.formatDate(date, CONFIG.TZ, 'HH:mm') + ' JST';
  return '⚠️ USD/JPY 急変動\n' +
         '5分で ' + sign + Math.abs(rounded) + ' pips ' + dir + '\n' +
         pastPrice.toFixed(2) + ' → ' + price.toFixed(2) + '\n' +
         time;
}

function sendTelegram(text) {
  var props = PropertiesService.getScriptProperties();
  var token = props.getProperty('TELEGRAM_BOT_TOKEN');
  var chatId = props.getProperty('TELEGRAM_CHAT_ID');
  if (!token || !chatId) { Logger.log('Telegram 設定が未登録'); return; }
  var url = 'https://api.telegram.org/bot' + token + '/sendMessage';
  var payload = { chat_id: chatId, text: text };
  try {
    UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });
  } catch (e) {
    Logger.log('Telegram 送信失敗: ' + e);
  }
}

// ===== 疎通テスト（手動実行用） =====
function sendTestNotification() {
  sendTelegram('✅ テスト通知: USD/JPY アラートの設定が完了しました。');
}
