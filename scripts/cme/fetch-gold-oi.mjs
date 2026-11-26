// CME 金先物（GC・product 437）の建玉（全限月合計の取引終了時）と前日比を、本物のブラウザ（Playwright/Chromium）で取得する。
// Cloudflare Worker から直接取りに行くと CME のボット対策で止められるため、GitHub Actions（.github/workflows/cme-gold-oi.yml）で動かし、
// 結果を Worker の KV（gold_oi_cme）に書く。Worker は毎時それを読み、Yahoo の金先物の値動きと合わせて日次の大口推定にする。
//
// 出力: 第1引数のファイルに { date: "YYYY-MM-DD", oi, change, final, fetchedAt } を書く。取れなければ exit 1（スクリーンショットを残す）。
import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';

const OUT = process.argv[2] ?? 'gold-oi.json';
const PAGE = 'https://www.cmegroup.com/markets/metals/precious/gold.volume.html';
const DETAILS = /\/CmeWS\/mvc\/Volume\/Details\/F\/437\//;

const toNum = (v) => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim()) {
    const n = Number(v.replace(/,/g, '').replace(/^\+/, ''));
    return Number.isFinite(n) ? n : null;
  }
  return null;
};
// 応答から建玉と前日比を取り出す（まだ出ていない日は null）
const parse = (body) => {
  const t = body?.totals ?? {};
  const oi = toNum(t.atClose ?? t.openInterest);
  const change = toNum(t.change ?? t.oiChange);
  if (oi == null || change == null || oi <= 0) return null;
  return { oi, change, final: body.isFinal === true || body.isFinal === 'true' };
};
// 米中部時間の直近の平日（新しい順に n 日）"YYYYMMDD"
const recentDates = (n) => {
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short' });
  const out = [];
  for (let k = 0; out.length < n && k < n + 7; k++) {
    const p = Object.fromEntries(fmt.formatToParts(new Date(Date.now() - k * 86_400_000)).map((x) => [x.type, x.value]));
    if (p.weekday === 'Sat' || p.weekday === 'Sun') continue;
    out.push(`${p.year}${p.month}${p.day}`);
  }
  return out;
};

// CME（Akamai）のボット対策はヘッドレスを HTTP/2 の段階で切ることがある（ERR_HTTP2_PROTOCOL_ERROR）。
// 画面ありの Chromium（Actions では xvfb-run の仮想ディスプレイ上）・HTTP/1.1・自動操作の目印を消す、で開く。
// HEADLESS=1 で従来のヘッドレスに戻せる。ユーザーエージェントは偽らない（OS と食い違うと逆に弾かれやすい）。
const browser = await chromium.launch({
  headless: process.env.HEADLESS === '1',
  args: ['--disable-http2', '--disable-blink-features=AutomationControlled'],
});
const context = await browser.newContext({
  locale: 'en-US',
  timezoneId: 'America/Chicago',
  viewport: { width: 1366, height: 900 },
});
await context.addInitScript(() => {
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
});
const page = await context.newPage();
const captured = new Map(); // "YYYYMMDD" -> 応答
page.on('response', async (r) => {
  if (!DETAILS.test(r.url()) || !r.ok()) return;
  try {
    const m = /\/437\/(\d{8})\//.exec(r.url());
    if (m) captured.set(m[1], await r.json());
  } catch {
    // JSON でなければ無視
  }
});

let result = null;
try {
  // 一時的に切られることもあるので、間を空けて最大3回試す
  let res = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      res = await page.goto(PAGE, { waitUntil: 'domcontentloaded', timeout: 90_000 });
      break;
    } catch (e) {
      console.log(`page.goto 失敗（${attempt}/3）:`, String(e).split('\n')[0]);
      if (attempt === 3) throw e;
      await page.waitForTimeout(5_000 * attempt);
    }
  }
  console.log('page status:', res?.status(), 'title:', await page.title());
  await page.waitForTimeout(8_000); // ページの JS が建玉の JSON を読み込むのを待つ
  // ページが読み込んだ日 → 足りなければページの中から（同じ cookie で）新しい順に取りに行く
  for (const d of recentDates(4)) {
    let body = captured.get(d);
    if (!body) {
      body = await page.evaluate(async (ymd) => {
        const r = await fetch(`/CmeWS/mvc/Volume/Details/F/437/${ymd}/P?tradeDate=${ymd}&pageSize=50`, { credentials: 'include' });
        if (!r.ok) return { __status: r.status };
        try {
          return await r.json();
        } catch {
          return { __status: 'not-json' };
        }
      }, d);
      if (body?.__status) console.log(`details ${d}:`, body.__status);
    }
    const got = body && !body.__status ? parse(body) : null;
    if (got) {
      result = { date: `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6)}`, ...got, fetchedAt: new Date().toISOString() };
      break;
    }
  }
} finally {
  if (!result) await page.screenshot({ path: 'cme-failure.png', fullPage: false }).catch(() => {});
  await browser.close();
}

if (!result) {
  console.error('CME の建玉を取得できませんでした（cme-failure.png を確認）');
  process.exit(1);
}
writeFileSync(OUT, JSON.stringify(result));
console.log('ok:', JSON.stringify(result));
