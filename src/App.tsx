// App.tsx
import '@mobiscroll/react/dist/css/mobiscroll.min.css';
import { Select, Page, setOptions, localeJa, Input, Popup } from '@mobiscroll/react';
import { FC, useState, useEffect } from 'react';
import HelpModal from './HelpModal'; // 前提：別ファイルに作成済み
import DstInfoModal from './DstInfoModal'; // 夏時間/冬時間の説明モーダル
import CurrencyStrengthMeter from './CurrencyStrengthMeter';
import AlertBell from './AlertBell'; // ヘッダーの相場変動通知ベル
import AppHeader from './components/AppHeader';
import BottomTabBar, { type AppView } from './components/BottomTabBar';
import OrderFlow from './OrderFlow'; // 取引量・センチメント ページ
import StopLossTool from './StopLossTool'; // 損切り提案 ページ
import FundManager from './FundManager'; // 資金管理（トレードジャーナル）ページ
// 各ページのタイトル（共通ヘッダーに表示）。
const VIEW_TITLES: Record<AppView, string> = {
  calculator: 'ロット計算',
  flow: '取引量・センチメント',
  stoploss: '損切り提案',
  fund: '資金管理',
};

setOptions({
  locale: localeJa,
  theme: 'ios',
  themeVariant: 'light'
});

// 通貨コード型を定義
type CurrencyCode = 'JPY' | 'USD' | 'EUR' | 'GBP' | 'AUD' | 'NZD' | 'CAD' | 'CHF' | 'XAU';

// ゴールド(XAU/USD)の計算定数
const GOLD_CONTRACT_SIZE = 100; // 1ロット = 100オンス（標準）
const GOLD_PIP_SIZE = 0.1; // 1pip = 0.1ドル変動
const GOLD_PIP_VALUE_USD = GOLD_CONTRACT_SIZE * GOLD_PIP_SIZE; // = $10/lot/pip（金価格に非依存）
// 証拠金通貨単位
type BalanceCurrency = 'JPY' | 'USD';

// Mobiscroll の onChange イベントの最小構造（Select は value、Input は target.value を参照）
type MbscValueChangeEvent = { value: unknown };
type MbscInputChangeEvent = { target: { value: string } };

// 数値文字列を3桁ごとのカンマ区切りに整形する（純粋関数・モジュールスコープ）
const formatNumberWithCommas = (num: string): string => {
  // 数字以外の文字を除去
  const numericValue = num.replace(/[^\d]/g, '');
  // 3桁ごとにカンマを挿入
  return numericValue.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
};

// 整形後の文字列で、左からn個目の数字の直後にあたるカーソル位置を求める
// （カンマ挿入によるズレを吸収し、数字インデックス基準でカーソルを復元するために使用）
const caretPositionForDigitIndex = (formatted: string, digitCount: number): number => {
  if (digitCount <= 0) return 0;
  let count = 0;
  for (let i = 0; i < formatted.length; i++) {
    if (/\d/.test(formatted[i])) {
      count++;
      if (count === digitCount) return i + 1;
    }
  }
  return formatted.length;
};

// FX市場セッション（東京・ロンドン・ニューヨーク）の現地時刻とオープン状態を
// 1秒ごとに更新して表示する。オープン判定は各セッションの現地時間で行うため、
// DST（英BST・米EDT）は Intl により自動で吸収される。
type MarketSession = {
  label: string;
  timeZone: string;
  openHour: number; // 現地オープン時刻（時, 24h）
  closeHour: number; // 現地クローズ時刻（時, 24h）
};

// BabyPips標準のセッション時間（各セッションの現地時間で定義）
const MARKET_SESSIONS: MarketSession[] = [
  { label: '東京', timeZone: 'Asia/Tokyo', openHour: 9, closeHour: 18 },
  { label: 'ロンドン', timeZone: 'Europe/London', openHour: 8, closeHour: 17 },
  { label: 'ニューヨーク', timeZone: 'America/New_York', openHour: 8, closeHour: 17 },
];

// 指定タイムゾーンにおける現地の「時」と「曜日」を取り出す
const getLocalHourAndWeekday = (timeZone: string, at: Date): { hour: number; weekday: string } => {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: '2-digit',
    hourCycle: 'h23',
    weekday: 'short',
  }).formatToParts(at);
  const hour = parseInt(parts.find((p) => p.type === 'hour')?.value ?? '0', 10);
  const weekday = parts.find((p) => p.type === 'weekday')?.value ?? '';
  return { hour, weekday };
};

// セッションがオープン中か判定する。FX市場は土日クローズのため、
// 各セッションの現地曜日が月〜金かつ営業時間内のときのみオープン。
const isSessionOpen = (session: MarketSession, at: Date): boolean => {
  const { hour, weekday } = getLocalHourAndWeekday(session.timeZone, at);
  const isWeekday = weekday !== 'Sat' && weekday !== 'Sun';
  return isWeekday && hour >= session.openHour && hour < session.closeHour;
};

const formatSessionTime = (timeZone: string, at: Date): string =>
  new Intl.DateTimeFormat('ja-JP', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).format(at);

// 指定タイムゾーンのUTCからのオフセット（分, 東が正）を求める。
// 現地の壁掛け時計の時刻をUTCとして解釈し、実際のUTC時刻との差を取ることで算出する。
const getTimeZoneOffsetMinutes = (timeZone: string, at: Date): number => {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(at);
  const map: Record<string, string> = {};
  for (const p of parts) map[p.type] = p.value;
  const asUtc = Date.UTC(
    Number(map.year),
    Number(map.month) - 1,
    Number(map.day),
    Number(map.hour),
    Number(map.minute),
    Number(map.second),
  );
  return Math.round((asUtc - at.getTime()) / 60000);
};

// そのタイムゾーンがDST（サマータイム）を採用しているか（夏/冬の概念があるか）。
// 1月と7月でオフセットが異なればDST採用地域とみなす（東京は年中同じなので false）。
const observesDaylightSaving = (timeZone: string): boolean => {
  const year = new Date().getFullYear();
  const janOffset = getTimeZoneOffsetMinutes(timeZone, new Date(Date.UTC(year, 0, 1)));
  const julOffset = getTimeZoneOffsetMinutes(timeZone, new Date(Date.UTC(year, 6, 1)));
  return janOffset !== julOffset;
};

// そのタイムゾーンが現在DSTを実施中か判定する。北半球では標準時（冬）が
// オフセット最小・DST（夏）が最大になる性質を使い、現在が標準時でなければDSTとみなす。
const isDaylightSavingTime = (timeZone: string, at: Date): boolean => {
  const year = at.getFullYear();
  const janOffset = getTimeZoneOffsetMinutes(timeZone, new Date(Date.UTC(year, 0, 1)));
  const julOffset = getTimeZoneOffsetMinutes(timeZone, new Date(Date.UTC(year, 6, 1)));
  if (janOffset === julOffset) return false; // DST非採用地域
  const standardOffset = Math.min(janOffset, julOffset);
  return getTimeZoneOffsetMinutes(timeZone, at) !== standardOffset;
};

// FX市場の週の取引時間（日本時間）を求める。基準はニューヨーク市場で、
// 週明けは日曜17:00 ET・週末は金曜17:00 ET。NYがDST（EDT）なら日本時間は1時間早まる。
const getWeeklyTradingHoursJst = (at: Date): { hour: number; isNyDst: boolean } => {
  const nyOffsetHours = getTimeZoneOffsetMinutes('America/New_York', at) / 60;
  // NY 17:00 を日本時間（UTC+9）へ変換（翌日の時刻になる）
  const hour = (((17 + (9 - nyOffsetHours)) % 24) + 24) % 24;
  return { hour, isNyDst: isDaylightSavingTime('America/New_York', at) };
};

const WorldClock: FC = () => {
  const [now, setNow] = useState<Date>(() => new Date());

  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  const { hour: weeklyHour, isNyDst } = getWeeklyTradingHoursJst(now);

  return (
    <div className="mt-1">
      <div className="flex justify-center gap-5">
        {MARKET_SESSIONS.map((session) => {
          const open = isSessionOpen(session, now);
          const hasDst = observesDaylightSaving(session.timeZone);
          const dst = hasDst && isDaylightSavingTime(session.timeZone, now);
          return (
            <div key={session.timeZone} className="text-center">
              <div className="flex items-center justify-center gap-1">
                <span
                  aria-hidden="true"
                  className={`inline-block h-2 w-2 rounded-full ${
                    open ? 'bg-green-500' : 'border border-gray-400'
                  }`}
                />
                <span className={`text-sm ${open ? 'text-gray-800 font-medium' : 'text-gray-400'}`}>
                  {session.label}
                </span>
              </div>
              <div
                className={`font-mono tabular-nums text-lg leading-tight ${
                  open ? 'text-gray-800' : 'text-gray-400'
                }`}
              >
                {formatSessionTime(session.timeZone, now)}
              </div>
              {hasDst ? (
                <span
                  className={`inline-block mt-0.5 px-1.5 py-0.5 rounded-full text-[10px] font-medium ${
                    dst ? 'bg-amber-100 text-amber-700' : 'bg-sky-100 text-sky-700'
                  }`}
                >
                  {dst ? '夏時間' : '冬時間'}
                </span>
              ) : (
                <span className="inline-block mt-0.5 px-1.5 py-0.5 text-[10px] text-gray-400">
                  DSTなし
                </span>
              )}
            </div>
          );
        })}
      </div>
      <p className="text-center text-xs text-gray-500 mt-1">
        今週の取引時間（日本時間）: 月 {weeklyHour}:00 〜 土 {weeklyHour}:00
        <span className="ml-1">{isNyDst ? '(NY夏時間)' : '(NY冬時間)'}</span>
      </p>
    </div>
  );
};

const App: FC = () => {
  // 表示中のページ（ロット計算 / 取引量・センチメント）とハンバーガーメニューの開閉。
  const [view, setView] = useState<AppView>('calculator');
  const validCurrencies: CurrencyCode[] = ['JPY', 'USD', 'EUR', 'GBP', 'AUD', 'NZD', 'CAD', 'CHF', 'XAU'];
  const [currency, setCurrency] = useState<CurrencyCode>(() => {
    const saved = localStorage.getItem('currency') as CurrencyCode | null;
    return saved && validCurrencies.includes(saved) ? saved : 'JPY';
  });
  const [riskPercentage, setRiskPercentage] = useState<number>(() => {
    const saved = localStorage.getItem('riskPercentage');
    const n = saved ? parseFloat(saved) : NaN;
    return Number.isFinite(n) ? n : 2.5;
  });
  const [stopLossPips, setStopLossPips] = useState<string>(() => localStorage.getItem('stopLossPips') ?? '25');
  const [accountBalance, setAccountBalance] = useState<string>(() => localStorage.getItem('accountBalance') ?? '0');
  const [leverage, setLeverage] = useState<number>(() => {
    const saved = localStorage.getItem('leverage');
    const n = saved ? parseInt(saved, 10) : NaN;
    return Number.isFinite(n) ? n : 500;
  });
  const [isModalOpen, setIsModalOpen] = useState<boolean>(false); // モーダルの表示状態
  const [isHelpModalOpen, setIsHelpModalOpen] = useState<boolean>(false); // ヘルプモーダルの表示状態
  const [isDstModalOpen, setIsDstModalOpen] = useState<boolean>(false); // 夏時間/冬時間モーダルの表示状態
  const [currencyPrice, setCurrencyPrice] = useState<string>('-'); // 選択された通貨の価格
  const [lastUpdated, setLastUpdated] = useState<string>(''); // 価格更新日時
  const [calculatedLot, setCalculatedLot] = useState<string>('0.00'); // 計算されたロットサイズ
  const [riskAmount, setRiskAmount] = useState<string>('0'); // 計算されたリスク金額
  const [balanceCurrency, setBalanceCurrency] = useState<BalanceCurrency>(() => (localStorage.getItem('balanceCurrency') as BalanceCurrency) ?? 'JPY');
  const [riskAmountUSD, setRiskAmountUSD] = useState<string>('0'); // USD表示のリスク金額
  const [balanceEquivalent, setBalanceEquivalent] = useState<string>('0');
  const [inputBalance, setInputBalance] = useState<string>(() => {
    const stored = localStorage.getItem('inputBalance') ?? '0';
    // JPYは初期表示からカンマ区切りに揃える（USDは小数点があるためそのまま）
    const savedCurrency = (localStorage.getItem('balanceCurrency') as BalanceCurrency) ?? 'JPY';
    return savedCurrency === 'JPY' ? formatNumberWithCommas(stored) : stored;
  });
  const [marginRatio, setMarginRatio] = useState<string>('0.00'); // 証拠金維持率のstate追加
  const [isLoading, setIsLoading] = useState<boolean>(false); // APIロード中の状態
  const [errorMessage, setErrorMessage] = useState<string>(''); // エラーメッセージ

  // 通貨価格データをステートとして管理
  const [currencyPrices, setCurrencyPrices] = useState<Record<CurrencyCode, string>>({
    'JPY': '1.0000',
    'USD': '147.52', // デフォルト値（API取得前）
    'EUR': '159.83',
    'GBP': '186.45',
    'AUD': '96.38',
    'NZD': '89.72',
    'CAD': '108.34',
    'CHF': '163.91',
    'XAU': '4164.40' // ゴールド価格(USD/oz) — 他通貨はXXX/JPYレートだがXAUのみ金価格を保持
  });

  // 基軸通貨データ
  const currencyData = [
    { text: 'JPY', value: 'JPY' },
    { text: 'USD', value: 'USD' },
    { text: 'EUR', value: 'EUR' },
    { text: 'GBP', value: 'GBP' },
    { text: 'AUD', value: 'AUD' },
    { text: 'NZD', value: 'NZD' },
    { text: 'CAD', value: 'CAD' },
    { text: 'CHF', value: 'CHF' },
    { text: 'ゴールド(XAU/USD)', value: 'XAU' }
  ];

  // 証拠金通貨データ
  const balanceCurrencyData = [
    { text: '日本円', value: 'JPY' },
    { text: '米ドル', value: 'USD' }
  ];

  // レバレッジデータ
  const leverageData = [
    { text: '1倍', value: 1 },
    { text: '2倍', value: 2 },
    { text: '5倍', value: 5 },
    { text: '10倍', value: 10 },
    { text: '25倍', value: 25 },
    { text: '50倍', value: 50 },
    { text: '100倍', value: 100 },
    { text: '200倍', value: 200 },
    { text: '400倍', value: 400 },
    { text: '500倍', value: 500 },
    { text: '888倍', value: 888 },
    { text: '1000倍', value: 1000 }
  ];

  // ExchangeRate-API 経由で取得
  const fetchFromExchangeRateAPI = async (): Promise<Partial<Record<CurrencyCode, string>>> => {
    const apiKey = import.meta.env.VITE_EXCHANGERATE_API_KEY;
    const url = apiKey
      ? `https://v6.exchangerate-api.com/v6/${apiKey}/latest/JPY`
      : 'https://open.er-api.com/v6/latest/JPY';
    const response = await fetch(url);
    if (!response.ok) throw new Error(`ExchangeRate HTTP ${response.status}`);
    const data = await response.json();
    if (data.result !== 'success') throw new Error(`ExchangeRate: ${data['error-type'] ?? '不明'}`);
    const rates = (data.conversion_rates ?? data.rates) as Record<string, number> | undefined;
    if (!rates) throw new Error('ExchangeRate: レスポンスに rates が含まれていません');
    const result: Partial<Record<CurrencyCode, string>> = {};
    const currencies: CurrencyCode[] = ['USD', 'EUR', 'GBP', 'AUD', 'NZD', 'CAD', 'CHF'];
    for (const curr of currencies) {
      const rate = rates[curr];
      if (rate) result[curr] = (1 / rate).toFixed(2);
    }
    return result;
  };

  // GAS 経由で取得（JSONP方式：CORS回避のため <script> タグで読み込み）
  const fetchFromGAS = (gasUrl: string): Promise<Partial<Record<CurrencyCode, string>>> => {
    return new Promise((resolve, reject) => {
      const callbackName = `gasCallback_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const script = document.createElement('script');
      const cleanup = () => {
        clearTimeout(timer);
        delete (window as unknown as Record<string, unknown>)[callbackName];
        script.remove();
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error('GAS タイムアウト (10秒)'));
      }, 10000);
      (window as unknown as Record<string, (data: unknown) => void>)[callbackName] = (data) => {
        cleanup();
        const d = data as { result?: string; error?: string; rates?: Record<string, number> };
        if (d.result !== 'success') {
          reject(new Error(`GAS: ${d.error ?? '不明'}`));
          return;
        }
        const result: Partial<Record<CurrencyCode, string>> = {};
        const currencies: CurrencyCode[] = ['USD', 'EUR', 'GBP', 'AUD', 'NZD', 'CAD', 'CHF'];
        for (const curr of currencies) {
          const rate = d.rates?.[curr];
          if (typeof rate === 'number' && rate > 0) result[curr] = rate.toFixed(2);
        }
        console.log('[GAS] 取得レート:', result);
        resolve(result);
      };
      script.onerror = () => {
        cleanup();
        reject(new Error('GAS スクリプト読み込み失敗（URL/権限を確認）'));
      };
      const sep = gasUrl.includes('?') ? '&' : '?';
      script.src = `${gasUrl}${sep}callback=${callbackName}`;
      document.head.appendChild(script);
    });
  };

  // ゴールド価格(XAU/USD, USD/oz)を取得（キーレス・無料API）
  const fetchGoldPrice = async (): Promise<string | null> => {
    const response = await fetch('https://api.gold-api.com/price/XAU');
    if (!response.ok) throw new Error(`GoldAPI HTTP ${response.status}`);
    const data = await response.json();
    const price = parseFloat(data?.price);
    if (!Number.isFinite(price) || price <= 0) throw new Error('GoldAPI: 価格が不正です');
    return price.toFixed(2);
  };

  // レートを一括取得する関数（GAS優先、失敗時はExchangeRate-APIにフォールバック）
  const fetchCurrencyRates = async () => {
    setIsLoading(true);
    setErrorMessage('');

    const gasUrl = import.meta.env.VITE_GAS_RATES_URL;
    let fetched: Partial<Record<CurrencyCode, string>> = {};
    let source = '';

    try {
      if (gasUrl) {
        try {
          fetched = await fetchFromGAS(gasUrl);
          source = 'GAS';
        } catch (e) {
          console.warn('GAS失敗、ExchangeRate-APIへフォールバック:', e);
          fetched = await fetchFromExchangeRateAPI();
          source = 'ExchangeRate(fallback)';
        }
      } else {
        fetched = await fetchFromExchangeRateAPI();
        source = 'ExchangeRate';
      }

      if (Object.keys(fetched).length === 0) {
        throw new Error('レート取得に失敗しました（0件）');
      }

      // ゴールド価格は別API（失敗してもFXレートには影響させない）
      try {
        const gold = await fetchGoldPrice();
        if (gold) fetched.XAU = gold;
      } catch (e) {
        console.warn('ゴールド価格の取得に失敗（既存値を維持）:', e);
      }

      // 既存の値を保持しつつ取得したキーのみ上書き（マージ）
      setCurrencyPrices(prev => ({ ...prev, ...fetched, JPY: '1.0000' }));

      const now = new Date();
      const formattedDate = now.toLocaleDateString('ja-JP');
      const formattedTime = now.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
      setLastUpdated(`${formattedDate} ${formattedTime} (${source})`);

      // currentのcurrencyに対して即座にcurrencyPriceも更新
      if (fetched[currency]) setCurrencyPrice(fetched[currency] as string);
      else if (currency === 'JPY') setCurrencyPrice('1.0000');
    } catch (error) {
      console.error('通貨レート取得エラー:', error);
      setErrorMessage(error instanceof Error ? error.message : '通貨レートの取得に失敗しました。');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    localStorage.setItem('accountBalance', accountBalance);
    localStorage.setItem('inputBalance', inputBalance);
    localStorage.setItem('balanceCurrency', balanceCurrency);
    localStorage.setItem('currency', currency);
    localStorage.setItem('riskPercentage', String(riskPercentage));
    localStorage.setItem('stopLossPips', stopLossPips);
    localStorage.setItem('leverage', String(leverage));
  }, [accountBalance, inputBalance, balanceCurrency, currency, riskPercentage, stopLossPips, leverage]);

  // コンポーネントマウント時に通貨レートを取得
  useEffect(() => {
    fetchCurrencyRates();
    
    // 現在の日時を取得して更新時間とする（デフォルト値用）
    const now = new Date();
    const formattedDate = now.toLocaleDateString('ja-JP');
    const formattedTime = now.toLocaleTimeString('ja-JP', { 
      hour: '2-digit', 
      minute: '2-digit' 
    });
    setLastUpdated(`${formattedDate} ${formattedTime} (デフォルト値)`);
  }, []);

  // 通貨が変更されたときに価格を更新
  useEffect(() => {
    setCurrencyPrice(currencyPrices[currency] || '-');
  }, [currency, currencyPrices]);

  // 数値を3桁カンマ区切りにフォーマットする関数
  // 数値をフォーマットする関数を通貨に合わせて変更
  const formatBalance = (num: string, currency: BalanceCurrency): string => {
    if (currency === 'USD') {
      // USDの場合、小数点を許可した数値処理
      // 数字と小数点以外を除去
      const numericValue = num.replace(/[^\d.]/g, '');
      
      // 小数点が複数ある場合は最初のみ保持
      const parts = numericValue.split('.');
      const cleanValue = parts[0] + (parts.length > 1 ? '.' + parts[1] : '');
      
      // 数値に変換して小数点2桁で表示
      const value = parseFloat(cleanValue) || 0;
      return value.toFixed(2);
    } else {
      // JPYの場合は3桁カンマ区切り（従来通り）
      const numericValue = num.replace(/[^\d]/g, '');
      return numericValue.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    }
  };

  // 通貨変更時の処理
  const handleBalanceCurrencyChange = (event: MbscValueChangeEvent) => {
    const newCurrency = event.value as BalanceCurrency;
    const oldCurrency = balanceCurrency;
    
    // 通貨が実際に変更された場合のみ処理
    if (newCurrency !== oldCurrency) {
      // 現在の証拠金額を取得
      const currentBalance = parseFloat(accountBalance.replace(/,/g, '')) || 0;
      
      // 証拠金額が0より大きい場合のみ変換
      if (currentBalance > 0) {
        let newBalance: number;
        const usdRate = parseFloat(currencyPrices['USD']);
        
        // JPY → USD の変換
        if (oldCurrency === 'JPY' && newCurrency === 'USD') {
          newBalance = currentBalance / usdRate;
          // 小数点第2位までに丸める
          newBalance = Math.round(newBalance * 100) / 100;
        } 
        // USD → JPY の変換
        else if (oldCurrency === 'USD' && newCurrency === 'JPY') {
          newBalance = currentBalance * usdRate;
          // 整数に丸める
          newBalance = Math.round(newBalance);
        }
        else {
          newBalance = currentBalance;
        }
        
        // 新しい証拠金額をセット
        setAccountBalance(newBalance.toString());
        
        // 入力値も更新
        if (newCurrency === 'USD') {
          const formattedValue = newBalance.toFixed(2);
          setInputBalance(formattedValue);
        } else {
          setInputBalance(formatNumberWithCommas(newBalance.toString()));
        }
      }
    }
    
    // 状態を更新
    setBalanceCurrency(newCurrency);
  };

  // リスク許容度が変更されたときのハンドラ
  const handleRiskChange = (event: MbscValueChangeEvent) => {
    setRiskPercentage(event.value as number);
  };

  // レバレッジが変更されたときのハンドラ
  const handleLeverageChange = (event: MbscValueChangeEvent) => {
    setLeverage(event.value as number);
  };

  // 損切り幅が変更されたときのハンドラ
  const handleStopLossChange = (event: MbscInputChangeEvent) => {
    // 数値以外の入力を排除
    const value = event.target.value.replace(/[^0-9]/g, '');
    setStopLossPips(value);
  };

  // 証拠金額が変更されたときのハンドラを修正
  const handleAccountBalanceChange = (event: MbscInputChangeEvent) => {
    const inputValue = event.target.value;

    if (balanceCurrency === 'USD') {
      // USDの場合、小数点は許可。編集中の値はそのまま表示
      setInputBalance(inputValue);

      // カンマを削除し、小数点と数字のみ許可
      const numericValue = inputValue.replace(/,/g, '').replace(/[^\d.]/g, '');

      // 小数点が2つ以上ある場合は最初の小数点のみ保持
      const parts = numericValue.split('.');
      const formattedValue = parts[0] + (parts.length > 1 ? '.' + parts[1] : '');

      setAccountBalance(formattedValue);
    } else {
      // JPYの場合、整数のみ。表示はカンマ区切りに整形する
      const el = event.target as HTMLInputElement;
      const prevCaret = el.selectionStart ?? inputValue.length;
      // カーソルより左にある数字の個数を記録しておく（カンマ位置に依存しない基準）
      const digitsBeforeCaret = inputValue.slice(0, prevCaret).replace(/[^\d]/g, '').length;

      // 先頭の余分な0を除去（初期値"0"への打鍵で "01,000,000" になるのを防ぐ）
      const numericValue = inputValue.replace(/[^\d]/g, '').replace(/^0+(?=\d)/, '');
      const formatted = formatNumberWithCommas(numericValue);

      setAccountBalance(numericValue);
      setInputBalance(formatted);

      // 再レンダリングでカーソルが末尾に飛ぶため、数字インデックス基準で復元する
      requestAnimationFrame(() => {
        const newCaret = caretPositionForDigitIndex(formatted, digitsBeforeCaret);
        el.setSelectionRange(newCaret, newCaret);
      });
    }
  };

  const handleClearBalance = () => {
    setAccountBalance('0');
    setInputBalance('0');
    localStorage.removeItem('accountBalance');
    localStorage.removeItem('inputBalance');
  };

  // 入力値のフォーマットと計算
  useEffect(() => {
    // 必要な値がすべて揃っているか確認
    if (accountBalance && stopLossPips && parseInt(stopLossPips) > 0) {
      // ロットサイズを計算
      const lotSize = calculateLotSize();
      setCalculatedLot(lotSize);
      
      // リスク金額を計算
      const balance = parseFloat(accountBalance.replace(/,/g, ''));
      const risk = parseFloat((riskPercentage / 100).toFixed(4)); // 小数点を固定
      const riskAmt = Math.round(balance * risk); // 端数を丸める
      
      if (balanceCurrency === 'JPY') {
        setRiskAmount(formatNumberWithCommas(riskAmt.toString()));
        // USDでのリスク金額も計算（参考表示用）
        const usdRate = parseFloat(currencyPrices['USD']);
        if (!isNaN(usdRate) && usdRate > 0) {
          const riskAmtUSD = riskAmt / usdRate;
          setRiskAmountUSD(riskAmtUSD.toFixed(2));
        }
      } else {
        setRiskAmount(riskAmt.toFixed(2));
        // JPYでのリスク金額も計算（参考表示用）
        const usdRate = parseFloat(currencyPrices['USD']);
        if (!isNaN(usdRate) && usdRate > 0) {
          const riskAmtJPY = riskAmt * usdRate;
          setRiskAmountUSD(formatNumberWithCommas(Math.round(riskAmtJPY).toString()));
        }
      }
      
      // 証拠金の通貨換算表示を更新
      updateBalanceEquivalent(balance);
      
      // 証拠金維持率を計算
      const ratio = calculateMarginRatio();
      setMarginRatio(ratio);
    } else {
      // 必要な値が揃っていない場合はリセット
      setCalculatedLot('0.00');
      setRiskAmount('0');
      setRiskAmountUSD('0');
      setBalanceEquivalent('0');
      setMarginRatio('0.00');
    }
  }, [accountBalance, riskPercentage, stopLossPips, currency, currencyPrice, balanceCurrency, leverage]);

  // リスク許容度のデータ（0.5%単位、0.5%から30%まで）
  const riskData = Array.from({ length: 60 }, (_, i) => {
    const value = (i + 1) * 0.5; // 0.5, 1.0, 1.5, ..., 29.5, 30.0
    return { text: `${value.toFixed(1)}%`, value: value };
  });

  // 通貨が変更されたときのハンドラ
  const handleCurrencyChange = (event: MbscValueChangeEvent) => {
    setCurrency(event.value as CurrencyCode);
    const now = new Date();
    setLastUpdated(
      `${now.toLocaleDateString('ja-JP')} ${now.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })}`
    );
  };

  // ロットサイズを計算
  const calculateLotSize = (): string => {
    if (!stopLossPips || parseInt(stopLossPips) === 0) return '0.00';
    
    const balance = parseFloat(accountBalance.replace(/,/g, ''));
    const risk = riskPercentage / 100;
    const stopLoss = parseInt(stopLossPips);
    const riskAmount = balance * risk;

    // ゴールド(XAU/USD)の場合: pip価値 = 100oz × 0.1ドル = $10/lot/pip（金価格に非依存）
    if (currency === 'XAU') {
      if (balanceCurrency === 'USD') {
        // USD口座: リスク額(USD) ÷ (SL幅 × $10)
        const lotSize = riskAmount / (stopLoss * GOLD_PIP_VALUE_USD);
        return lotSize.toFixed(2);
      } else {
        // JPY口座: pip価値(円) = $10 × USD/JPYレート
        const usdJpyRate = parseFloat(currencyPrices['USD']);
        const pipValueJPY = GOLD_PIP_VALUE_USD * usdJpyRate;
        const lotSize = riskAmount / (stopLoss * pipValueJPY);
        return lotSize.toFixed(2);
      }
    }

    // 証拠金がUSDの場合
    if (balanceCurrency === 'USD') {
      // このアプリのペアはすべて XXX/JPY
      // 1pip = 0.01円 × 100,000通貨 = 1,000円/lot
      // pip価値(USD) = 1,000円 ÷ USD/JPYレート
      const usdJpyRate = parseFloat(currencyPrices['USD']);
      const adjustedPipValueUSD = 1000 / usdJpyRate;

      // リスク額 ÷ (ストップロス幅 × pip価値) = ロットサイズ
      const lotSize = riskAmount / (stopLoss * adjustedPipValueUSD);
      return lotSize.toFixed(2);
    } 
    // 証拠金がJPYの場合
    else {
      // 円建ての場合の計算
      let pipValue = 1000; // 1標準ロット当たりのpip価値（円）- 基本値
      
      if (currency !== 'JPY') {
        // 外貨/円ペアの場合: 1pip = 0.01円 × 100,000通貨 = 1,000円
        // ただし通貨レートによって調整が必要
        pipValue = 1000; // 基本的には1標準ロットで1,000円/pip
        
        // USD/JPYは1標準ロットで1,000円/pip
        // EUR/JPYなどの場合も基本は同じだが、必要に応じて調整可能
      } else {
        // JPYが基軸の場合（JPY/USD等）- 理論上は可能だが実務ではあまり使わない
        // この場合は別途計算が必要だが、ここでは簡略化
        pipValue = 1000;
      }
      
      // リスク額 ÷ (ストップロス幅 × pip価値) = ロットサイズ
      const lotSize = riskAmount / (stopLoss * pipValue);
      return lotSize.toFixed(2);
    }
  };

  // 最大ロットサイズを計算（レバレッジ考慮）
  const calculateMaxLotSize = (): string => {
    if (currency === 'JPY') return '0.00'; // JPYの場合は計算不要

    const balance = parseFloat(accountBalance.replace(/,/g, ''));

    // ゴールド(XAU/USD)の場合: 建玉価値(USD) = lot × 100oz × 金価格
    if (currency === 'XAU') {
      const goldPrice = parseFloat(currencyPrices['XAU']);
      // USD口座はそのまま、JPY口座はUSD換算した残高で計算
      const balanceUSD = balanceCurrency === 'USD'
        ? balance
        : balance / parseFloat(currencyPrices['USD']);
      const maxLotSize = (balanceUSD * leverage) / (GOLD_CONTRACT_SIZE * goldPrice);
      return maxLotSize.toFixed(2);
    }

    // 証拠金がUSDの場合
    if (balanceCurrency === 'USD') {
      // USD建ての計算
      // 最大ロット = (証拠金 × レバレッジ) ÷ 100000
      const maxLotSize = (balance * leverage) / 100000;
      return maxLotSize.toFixed(2);
    }
    // 証拠金がJPYの場合
    else {
      const rate = parseFloat(currencyPrice);
      // 簡略化した計算
      // 最大ロット = (証拠金 × レバレッジ) ÷ (通貨価格 × 10000)
      const maxLotSize = (balance * leverage) / (rate * 10000);
      return maxLotSize.toFixed(2);
    }
  };

  // モーダルを開く
  const openModal = () => {
    setIsModalOpen(true);
  };

  // モーダルを閉じる
  const closeModal = () => {
    setIsModalOpen(false);
  };

  // ヘルプモーダルを開く
  const openHelpModal = () => {
    setIsHelpModalOpen(true);
  };

  // ヘルプモーダルを閉じる
  const closeHelpModal = () => {
    setIsHelpModalOpen(false);
  };

  // 夏時間/冬時間モーダルを開く
  const openDstModal = () => {
    setIsDstModalOpen(true);
  };

  // 夏時間/冬時間モーダルを閉じる
  const closeDstModal = () => {
    setIsDstModalOpen(false);
  };

  // 証拠金の通貨換算を計算する関数を追加
  const updateBalanceEquivalent = (balance: number) => {
    if (balance <= 0) {
      setBalanceEquivalent('0');
      return;
    }
    
    const usdRate = parseFloat(currencyPrices['USD']);
    
    if (balanceCurrency === 'USD') {
      // USDをJPYに換算
      const jpyValue = balance * usdRate;
      setBalanceEquivalent(formatBalance(Math.round(jpyValue).toString(), 'JPY')); // formatBalanceを使用
    } else {
      // JPYをUSDに換算
      const usdValue = balance / usdRate;
      setBalanceEquivalent(formatBalance(usdValue.toString(), 'USD')); // formatBalanceを使用
    }
  };

  const calculateMarginRatio = (): string => {
    // 必要なパラメータがない場合は計算しない
    if (!accountBalance || parseFloat(calculatedLot) <= 0 || currency === 'JPY') return '0.00';
    
    const balance = parseFloat(accountBalance.replace(/,/g, ''));
    const lotSize = parseFloat(calculatedLot);
    const rate = parseFloat(currencyPrice);

    // ゴールド(XAU/USD)の場合: 必要証拠金(USD) = lot × 100oz × 金価格 ÷ レバレッジ
    if (currency === 'XAU') {
      const goldPrice = parseFloat(currencyPrices['XAU']);
      const requiredMarginUSD = (lotSize * GOLD_CONTRACT_SIZE * goldPrice) / leverage;
      const balanceUSD = balanceCurrency === 'USD'
        ? balance
        : balance / parseFloat(currencyPrices['USD']);
      const ratio = (balanceUSD / requiredMarginUSD) * 100;
      return ratio.toFixed(2);
    }

    // ポジションサイズ（通貨単位）：1ロット = 100,000通貨単位
    const positionSize = lotSize * 100000;
    
    let requiredMargin = 0;
    
    // 証拠金通貨がUSDの場合
    if (balanceCurrency === 'USD') {
      if (currency === 'USD') {
        // USD/JPYなどUSDが基軸の場合：必要証拠金 = ポジションサイズ × (1/レバレッジ)
        requiredMargin = positionSize * (1 / leverage);
      } else {
        // EUR/JPY など、USDが基軸でない場合
        // USD建ての必要証拠金 = (ポジションサイズ × レート) × (1/レバレッジ) ÷ USD/JPYレート
        const usdRate = parseFloat(currencyPrices['USD']);
        requiredMargin = (positionSize * rate * (1 / leverage)) / usdRate;
      }
    } 
    // 証拠金通貨がJPYの場合
    else {
      // 必要証拠金 = ポジションサイズ × レート × (1/レバレッジ)
      requiredMargin = positionSize * rate * (1 / leverage);
    }
    
    // 証拠金維持率(%) = (有効証拠金 ÷ 必要証拠金) × 100
    const ratio = (balance / requiredMargin) * 100;
    
    // 小数点以下2桁で表示
    return ratio.toFixed(2);
  };

  const UpdateRatesButton = () => (
    <button
      onClick={fetchCurrencyRates}
      disabled={isLoading}
      className={`mt-2 px-3 py-2 rounded-full ${
        isLoading ? 'bg-gray-300' : 'bg-blue-500 hover:bg-blue-600'
      } text-white text-sm flex items-center justify-center`}
    >
      {isLoading ? (
        <>
          <svg className="animate-spin -ml-1 mr-2 h-4 w-4 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path>
          </svg>
          更新中...
        </>
      ) : (
        <>
          <svg className="mr-1 h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"></path>
          </svg>
          レート更新
        </>
      )}
    </button>
  );

  return (
    <Page>
      <div className='lg:w-150 lg:mx-auto min-h-screen bg-gray-50'>

      {/* 共通ヘッダー（タイトル + 通知ベル。計算ページのみヘルプ/夏時間を表示） */}
      <AppHeader title={VIEW_TITLES[view]}>
        <AlertBell />
        {view === 'calculator' && (
          <>
            <button
              type="button"
              aria-label="夏時間・冬時間について"
              className="text-sky-500 rounded-full h-8 w-8 flex items-center justify-center border border-sky-500"
              onClick={openDstModal}
            >
              <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <circle cx="12" cy="12" r="9" strokeWidth="2" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 7v5l3 2" />
              </svg>
            </button>
            <button
              type="button"
              aria-label="ヘルプ"
              className="text-orange-500 font-bold rounded-full h-8 w-8 flex items-center justify-center border border-orange-500"
              onClick={openHelpModal}
            >
              ?
            </button>
          </>
        )}
      </AppHeader>

      {/* コンテンツ（下部タブバー分の余白を確保） */}
      <div className="pb-20 pt-2">

      {view === 'calculator' ? (
      <>
      {/* 時間 */}
      <WorldClock />
      {/* 通貨強弱（毎時・折りたたみ式） */}
      <CurrencyStrengthMeter />

      {/* エラーメッセージ表示 */}
      {errorMessage && (
        <div className="mx-3 my-2 p-2 bg-red-100 border border-red-300 text-red-700 text-sm rounded">
          {errorMessage}
        </div>
      )}

      <div className='flex justify-center mt-1'>

      {/* 計算結果表示 - 常に表示 */}
      <div className="bg-blue-50 rounded-md px-2 py-1.5 border border-blue-200 mx-3 w-55 text-sm">
        <div className="flex justify-between items-baseline">
          <span className="text-gray-600">適正ロット:</span>
          <span className="text-base font-bold text-blue-700">{calculatedLot} Lots</span>
        </div>
        <div className="flex justify-between items-baseline">
          <span className="text-gray-600">損失許容額:</span>
          <span className="text-base font-bold text-red-600">
            {balanceCurrency === 'JPY' ? `${riskAmount}円` : `$${riskAmount}`}
          </span>
        </div>
        <p className="text-xs text-gray-500 text-right leading-tight">
          {balanceCurrency === 'JPY' ? `(約$${riskAmountUSD})` : `(約${riskAmountUSD}円)`}
        </p>
        {/* 証拠金維持率を追加 */}
        {currency !== 'JPY' && parseFloat(marginRatio) > 0 && (
          <div className="mt-1 border-t pt-1 flex justify-between items-baseline">
            <span className="text-gray-600">証拠金維持率:</span>
            <span className="text-right">
              <span className={`text-base font-bold ${
                parseFloat(marginRatio) < 100 ? 'text-red-600' :
                parseFloat(marginRatio) < 200 ? 'text-yellow-600' : 'text-green-600'
              }`}>
                {marginRatio}%
              </span>
              <span className="text-xs text-gray-500 ml-1">(×{leverage})</span>
            </span>
          </div>
        )}
      </div>

      {/* 証拠金通貨選択 */}
      <div className='px-1 mb-2 w-45'>
        <p className="text-sm text-gray-600">証拠金通貨選択</p>
        <Select
          data={balanceCurrencyData}
          value={balanceCurrency}
          onChange={handleBalanceCurrencyChange}
          display="inline"
          touchUi={true}
          rows={3}
          itemHeight={30}
          label="証拠金通貨"
          labelStyle="stacked"
        />
      </div>
      </div>

      <div className='flex gap-2 px-3 mb-2 justify-center'>
        <div className='w-45'>
          <p className='text-center'>リスク%</p>
          <Select
            data={riskData}
            value={riskPercentage}
            onChange={handleRiskChange}
            display="inline"
            touchUi={true}
            rows={3}
            itemHeight={30}
            label="リスク%"
            labelStyle="stacked"
          />
        </div>
        <div className='w-55 mb-0'>
          <p className='text-center mb-1'>ストップ幅（pips）</p>
          <Input
            type="number"
            value={stopLossPips}
            onChange={handleStopLossChange}
            placeholder="損切り幅を入力"
            inputStyle="box"
            labelStyle="stacked"
            className='mb-0'
          />
          <p className='text-center'><small>ゴールドは1Points = 10pips</small></p>
        </div>
      </div>

      {/* 証拠金入力フィールド + 設定確認ボタン */}
      <div className='flex flex-row-reverse gap-2 px-3 mb-2 items-center'>
        <div className='flex-1'>
          <p className='text-center mb-1'>
            証拠金額 ({balanceCurrency === 'JPY' ? '円' : 'USD'})
          </p>
          <div className='relative'>
            <Input
              type={balanceCurrency === 'USD' ? 'tel' : 'text'} // USDの場合はtelタイプを使用
              value={inputBalance} // 編集中の入力値を使用
              onChange={handleAccountBalanceChange}
              placeholder={balanceCurrency === 'JPY' ? "証拠金額を入力" : "証拠金額を入力 (例: 1000.50)"}
              inputStyle="box"
              labelStyle="stacked"
            />
            {inputBalance && (
              <button
                onClick={handleClearBalance}
                aria-label="証拠金額をクリア"
                className="absolute right-6 top-1/2 -translate-y-1/2 flex items-center justify-center h-5 w-5 rounded-full bg-gray-300 text-white text-xs leading-none hover:bg-red-400 transition-colors duration-150"
              >
                ✕
              </button>
            )}
          </div>
          <div className='text-xs text-gray-500 text-center mt-1'>
            {/* 証拠金の換算表示 */}
            {parseFloat(accountBalance) > 0 && (
              <p className="mt-1 text-blue-600">
                {balanceCurrency === 'JPY'
                  ? `(約$${balanceEquivalent})`
                  : `(約${balanceEquivalent}円 = $${accountBalance} × ${currencyPrices['USD']})`}
              </p>
            )}
          </div>
        </div>
        {/* 設定確認ボタン */}
        <button
          onClick={openModal}
          className="w-28 py-3 px-2 bg-gradient-to-r from-orange-400 to-orange-600 text-white rounded-lg shadow-md hover:shadow-lg transition-all duration-200 text-sm font-medium flex flex-col items-center justify-center"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" fill="currentColor" viewBox="0 0 16 16" className="mb-1">
            <path d="M8 15A7 7 0 1 1 8 1a7 7 0 0 1 0 14zm0 1A8 8 0 1 0 8 0a8 8 0 0 0 0 16z"/>
            <path d="m8.93 6.588-2.29.287-.082.38.45.083c.294.07.352.176.288.469l-.738 3.468c-.194.897.105 1.319.808 1.319.545 0 1.178-.252 1.465-.598l.088-.416c-.2.176-.492.246-.686.246-.275 0-.375-.193-.304-.533L8.93 6.588zM9 4.5a1 1 0 1 1-2 0 1 1 0 0 1 2 0z"/>
          </svg>
          設定確認
        </button>
      </div>

      {/* 基軸通貨選択と価格表示 */}
      <div className='px-3'>
        <div className="flex flex-col items-center">
          {/* 通貨価格表示と更新日時 */}
          <div className="flex items-center gap-8 mb-1">
            <div className="bg-gray-100 rounded-full text-center">
              <p className='font-bold'>通貨ベース（価格）</p>
              <p className="text-center font-semibold">
                {currency === 'JPY'
                  ? `${currency} = ${currencyPrice}`
                  : currency === 'XAU'
                  ? `XAU/USD = ${currencyPrice}`
                  : `${currency}/JPY = ${currencyPrice}`}
              </p>
            </div>
            <div className='text-center'>
              <p className='font-bold'>価格更新日時</p>
              <p className="text-xs text-gray-500 p-2">{lastUpdated}</p>
              <UpdateRatesButton />
            </div>
          </div>
        </div>
      </div>

      <div className='flex gap-2 px-3 mb-2 justify-center'>
        {/* 基軸通貨選択 */}
        <div className='w-50'>
          <p className='text-center mb-1'>基軸通貨</p>
          <Select
              data={currencyData}
              value={currency}
              onChange={handleCurrencyChange}
              display="inline"
              touchUi={true}
              rows={3}
              itemHeight={30}
              label="基軸通貨"
              labelStyle="stacked"
            />
        </div>

        {/* レバレッジ選択 */}
        <div className='w-50'>
          <p className='text-center mb-1'>レバレッジ</p>
          <Select
            data={leverageData}
            value={leverage}
            onChange={handleLeverageChange}
            display="inline"
            touchUi={true}
            rows={3}
            itemHeight={30}
            label="レバレッジ"
            labelStyle="stacked"
          />
        </div>
      </div>

      {/* 設定内容のモーダル */}
      <Popup
        isOpen={isModalOpen}
        onClose={closeModal}
        buttons={[
          {
            text: '閉じる',
            handler: closeModal
          }
        ]}
      >
        <div className="p-4">
          <p className="mb-3">証拠金額: <strong>
            {balanceCurrency === 'JPY'
              ? `${inputBalance}円`
              : `$${parseFloat(accountBalance).toFixed(2)}`}
          </strong></p>
          <p className="mb-3">証拠金通貨: <strong>{balanceCurrency}</strong></p>
          <p className="mb-3">基軸通貨: <strong>{currency}</strong> {currency === 'XAU' ? `($${currencyPrice}/oz)` : currency !== 'JPY' && `(${currencyPrice}円)`}</p>
          <p className="mb-3">リスク％: <strong>{riskPercentage.toFixed(1)}%</strong></p>
          <p className="mb-3">損切り幅: <strong>{stopLossPips} pips</strong></p>
          <p className="mb-3">レバレッジ: <strong>{leverage}倍</strong></p>
          
          <div className="bg-orange-100 p-3 rounded mb-3">
            <p className="font-bold text-center">計算結果</p>
            <p className="text-center">
              推奨ロットサイズ: <span className="font-bold text-xl">{calculatedLot}</span> Lots
            </p>
            <p className="text-center text-sm text-gray-600 mt-1">
              リスク金額: {balanceCurrency === 'JPY' ? `${riskAmount}円` : `$${riskAmount}`}
              <br />
              <span className="text-xs">
                {balanceCurrency === 'JPY' ? `(約$${riskAmountUSD})` : `(約${riskAmountUSD}円)`}
              </span>
            </p>
            {currency !== 'JPY' && (
              <div>
                <p className="text-center text-sm text-gray-600 mt-1">
                  最大取引可能ロット: {calculateMaxLotSize()} Lots (レバレッジ{leverage}倍)
                </p>
                {/* 証拠金維持率をモーダルにも追加 */}
                {parseFloat(marginRatio) > 0 && (
                  <p className="text-center text-sm text-gray-600 mt-1">
                    証拠金維持率: <span className={`font-bold ${
                      parseFloat(marginRatio) < 100 ? 'text-red-600' : 
                      parseFloat(marginRatio) < 200 ? 'text-yellow-600' : 'text-green-600'
                    }`}>{marginRatio}%</span>
                  </p>
                )}
              </div>
            )}
          </div>

          <div className="mt-6 border-t pt-4">
            <p className="text-center text-sm text-gray-400">
              この結果はあくまで参考値です。実際の取引では、市場の状況や個人の取引戦略に応じて調整してください。
            </p>
          </div>
        </div>
      </Popup>
      
      {/* 別ファイルから作成したヘルプモーダル */}
      <HelpModal
        isOpen={isHelpModalOpen}
        onClose={closeHelpModal}
      />

      {/* 夏時間/冬時間の説明モーダル */}
      <DstInfoModal
        isOpen={isDstModalOpen}
        onClose={closeDstModal}
      />
      </>
      ) : view === 'flow' ? (
        <OrderFlow />
      ) : view === 'stoploss' ? (
        <StopLossTool />
      ) : (
        <FundManager />
      )}
      </div>

      <BottomTabBar view={view} onChange={setView} />
      </div>
    </Page>
  );
};

export default App;