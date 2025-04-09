// App.tsx
import '@mobiscroll/react/dist/css/mobiscroll.min.css';
import { Select, Page, setOptions, localeJa, Input, Popup } from '@mobiscroll/react';
import { FC, useState, useEffect } from 'react';
import HelpModal from './HelpModal'; // 前提：別ファイルに作成済み

setOptions({
  locale: localeJa,
  theme: 'ios',
  themeVariant: 'light'
});

// 通貨コード型を定義
type CurrencyCode = 'JPY' | 'USD' | 'EUR' | 'GBP' | 'AUD' | 'NZD' | 'CAD' | 'CHF';
// 証拠金通貨単位
type BalanceCurrency = 'JPY' | 'USD';

const App: FC = () => {
  const [currency, setCurrency] = useState<CurrencyCode>('JPY');
  const [riskPercentage, setRiskPercentage] = useState<number>(2.5); // デフォルト2.5%
  const [stopLossPips, setStopLossPips] = useState<string>('25'); // デフォルト25pips
  const [accountBalance, setAccountBalance] = useState<string>('0'); // デフォルト証拠金
  const [formattedBalance, setFormattedBalance] = useState<string>('0'); // 表示用フォーマット済み証拠金
  const [leverage, setLeverage] = useState<number>(500); // デフォルトレバレッジ500倍
  const [isModalOpen, setIsModalOpen] = useState<boolean>(false); // モーダルの表示状態
  const [isHelpModalOpen, setIsHelpModalOpen] = useState<boolean>(false); // ヘルプモーダルの表示状態
  const [currencyPrice, setCurrencyPrice] = useState<string>('-'); // 選択された通貨の価格
  const [lastUpdated, setLastUpdated] = useState<string>(''); // 価格更新日時
  const [calculatedLot, setCalculatedLot] = useState<string>('0.00'); // 計算されたロットサイズ
  const [riskAmount, setRiskAmount] = useState<string>('0'); // 計算されたリスク金額
  const [balanceCurrency, setBalanceCurrency] = useState<BalanceCurrency>('JPY'); // 証拠金通貨
  const [riskAmountUSD, setRiskAmountUSD] = useState<string>('0'); // USD表示のリスク金額
  const [balanceEquivalent, setBalanceEquivalent] = useState<string>('0');
  const [inputBalance, setInputBalance] = useState<string>('0');
  const [marginRatio, setMarginRatio] = useState<string>('0.00'); // 証拠金維持率のstate追加

  // 基軸通貨データ
  const currencyData = [
    { text: 'JPY', value: 'JPY' },
    { text: 'USD', value: 'USD' },
    { text: 'EUR', value: 'EUR' },
    { text: 'GBP', value: 'GBP' },
    { text: 'AUD', value: 'AUD' },
    { text: 'NZD', value: 'NZD' },
    { text: 'CAD', value: 'CAD' },
    { text: 'CHF', value: 'CHF' }
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

  // 各通貨の仮想価格データ（実際のアプリでは、APIから取得するなど）
  const currencyPrices: Record<CurrencyCode, string> = {
    'JPY': '1.0000',
    'USD': '147.52',
    'EUR': '159.83',
    'GBP': '186.45',
    'AUD': '96.38',
    'NZD': '89.72',
    'CAD': '108.34',
    'CHF': '163.91'
  };

  // 数値を3桁カンマ区切りにフォーマットする関数
  const formatNumberWithCommas = (num: string): string => {
    // 数字以外の文字を除去
    const numericValue = num.replace(/[^\d]/g, '');
    // 3桁ごとにカンマを挿入
    return numericValue.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  };

  // 通貨が変更されたときに価格を更新
  useEffect(() => {
    setCurrencyPrice(currencyPrices[currency] || '-');
    
    // 現在の日時を取得して更新時間とする
    const now = new Date();
    const formattedDate = now.toLocaleDateString('ja-JP');
    const formattedTime = now.toLocaleTimeString('ja-JP', { 
      hour: '2-digit', 
      minute: '2-digit' 
    });
    setLastUpdated(`${formattedDate} ${formattedTime}`);
  }, [currency]);

  // 証拠金額が変更されたときにフォーマット済み表示を更新

  // 入力値が変更されるたびにリアルタイムで計算結果を更新
  useEffect(() => {
    // 必要な値がすべて揃っているか確認
    if (accountBalance && stopLossPips && parseInt(stopLossPips) > 0) {
      // ロットサイズを計算
      const lotSize = calculateLotSize();
      setCalculatedLot(lotSize);
      
      // リスク金額を計算
      const balance = parseFloat(accountBalance);
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
    } else {
      // 必要な値が揃っていない場合はリセット
      setCalculatedLot('0.00');
      setRiskAmount('0');
      setRiskAmountUSD('0');
    }
  }, [accountBalance, riskPercentage, stopLossPips, currency, currencyPrice, balanceCurrency]);

  // リスク許容度のデータ（0.5%単位、0.5%から30%まで）
  const riskData = Array.from({ length: 60 }, (_, i) => {
    const value = (i + 1) * 0.5; // 0.5, 1.0, 1.5, ..., 29.5, 30.0
    return { text: `${value.toFixed(1)}%`, value: value };
  });

  // 通貨が変更されたときのハンドラ
  const handleCurrencyChange = (event: any) => {
    setCurrency(event.value as CurrencyCode);
  };

  // 通貨変更時の処理も修正
  const handleBalanceCurrencyChange = (event: any) => {
    const newCurrency = event.value as BalanceCurrency;
    const oldCurrency = balanceCurrency;
    
    // 通貨が実際に変更された場合のみ処理
    if (newCurrency !== oldCurrency) {
      // 現在の証拠金額を取得
      const currentBalance = parseFloat(accountBalance) || 0;
      
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
          setInputBalance(newBalance.toFixed(2));
        } else {
          setInputBalance(newBalance.toString());
        }
      }
    }
    
    // 状態を更新
    setBalanceCurrency(newCurrency);
  };

  // リスク許容度が変更されたときのハンドラ
  const handleRiskChange = (event: any) => {
    setRiskPercentage(event.value);
  };

  // レバレッジが変更されたときのハンドラ
  const handleLeverageChange = (event: any) => {
    setLeverage(event.value);
  };

  // 損切り幅が変更されたときのハンドラ
  const handleStopLossChange = (event: any) => {
    // 数値以外の入力を排除
    const value = event.target.value.replace(/[^0-9]/g, '');
    setStopLossPips(value);
  };

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

  // 証拠金額が変更されたときのハンドラを修正
  const handleAccountBalanceChange = (event: any) => {
    const inputValue = event.target.value;
    
    // まず入力値をそのまま保存（編集中の値）
    setInputBalance(inputValue);
    
    // 次に処理済みの値を内部状態として保存
    if (balanceCurrency === 'USD') {
      // USDの場合、小数点は許可
      const numericValue = inputValue.replace(/[^\d.]/g, '');
      // 小数点が2つ以上ある場合は最初の小数点のみ保持
      const parts = numericValue.split('.');
      const formattedValue = parts[0] + (parts.length > 1 ? '.' + parts[1] : '');
      setAccountBalance(formattedValue);
    } else {
      // JPYの場合、整数のみ
      const numericValue = inputValue.replace(/[^\d]/g, '');
      setAccountBalance(numericValue);
    }
  };

  // 証拠金額が変更されたときにフォーマット済み表示を更新するuseEffectを修正
  useEffect(() => {
    // 入力値のフォーマット処理
    if (balanceCurrency === 'USD') {
      // 入力中の場合は入力値をそのまま使用
      if (document.activeElement && document.activeElement.id === 'balance-input') {
        setFormattedBalance(inputBalance);
      } else {
        // 非入力時は整形された表示用の値を使用
        const value = parseFloat(accountBalance) || 0;
        setFormattedBalance(value.toFixed(2));
        // 入力値も同期させる
        setInputBalance(value.toFixed(2));
      }
    } else {
      // JPYの場合は3桁カンマ区切り（従来通りだがformatBalanceを使用）
      setFormattedBalance(formatBalance(accountBalance, 'JPY'));
      // 入力値も同期させる
      setInputBalance(formatBalance(accountBalance, 'JPY'));
    }
  
    // 必要な値がすべて揃っているか確認
    if (accountBalance && stopLossPips && parseInt(stopLossPips) > 0) {
      // ロットサイズを計算
      const lotSize = calculateLotSize();
      setCalculatedLot(lotSize);
      
      // リスク金額を計算
      const balance = parseFloat(accountBalance);
      const risk = parseFloat((riskPercentage / 100).toFixed(4)); // 小数点を固定
      const riskAmt = Math.round(balance * risk); // 端数を丸める
      
      if (balanceCurrency === 'JPY') {
        setRiskAmount(formatBalance(riskAmt.toString(), 'JPY')); // formatBalanceを使用
        // USDでのリスク金額も計算（参考表示用）
        const usdRate = parseFloat(currencyPrices['USD']);
        if (!isNaN(usdRate) && usdRate > 0) {
          const riskAmtUSD = riskAmt / usdRate;
          setRiskAmountUSD(riskAmtUSD.toFixed(2));
        }
      } else {
        setRiskAmount(formatBalance(riskAmt.toString(), 'USD')); // formatBalanceを使用
        // JPYでのリスク金額も計算（参考表示用）
        const usdRate = parseFloat(currencyPrices['USD']);
        if (!isNaN(usdRate) && usdRate > 0) {
          const riskAmtJPY = riskAmt * usdRate;
          setRiskAmountUSD(formatBalance(Math.round(riskAmtJPY).toString(), 'JPY')); // formatBalanceを使用
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
  }, [accountBalance, riskPercentage, stopLossPips, currency, currencyPrice, balanceCurrency, leverage, inputBalance]);
  

  // ロットサイズを計算
  const calculateLotSize = (): string => {
    if (!stopLossPips || parseInt(stopLossPips) === 0) return '0.00';
    
    const balance = parseFloat(accountBalance);
    const risk = riskPercentage / 100;
    const stopLoss = parseInt(stopLossPips);
    const riskAmount = balance * risk;
    
    // 証拠金がUSDの場合
    if (balanceCurrency === 'USD') {
      // USD建ての場合、1標準ロット(100,000通貨単位)のpip価値を計算
      // 基本的に、USD/通貨ペアの場合、1pipあたり10ドル（1標準ロット）
      const basePipValueUSD = 10; // 基本の1pipあたりの価値（USD）
      
      // 通貨ペアに応じた調整
      let adjustedPipValueUSD = basePipValueUSD;
      
      if (currency === 'JPY') {
        // USD/JPYは特殊なケース: 1 pip = 0.01円 = 0.01円 ÷ USD/JPYレート
        // 例: USD/JPY=147.52の場合、0.01円 ÷ 147.52 = 約 $0.0000678（1通貨あたり）
        // 標準ロット(100,000通貨)では: 0.0000678 × 100,000 = 約 $6.78
        adjustedPipValueUSD = 100000 * 0.01 / parseFloat(currencyPrices['USD']);
      } else if (currency === 'USD') {
        // USD自体を取引する場合は特別な計算が必要
        adjustedPipValueUSD = 10; // 簡略化
      } else {
        // 他の通貨ペア（EUR/USD, GBP/USDなど）は基本の10ドル/pipを使用
        adjustedPipValueUSD = basePipValueUSD;
      }
      
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
    
    const balance = parseFloat(accountBalance);
    
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


  // 既存のuseEffectに証拠金の換算計算を追加
  useEffect(() => {
    // 必要な値がすべて揃っているか確認
    if (accountBalance && stopLossPips && parseInt(stopLossPips) > 0) {
      // ロットサイズを計算
      const lotSize = calculateLotSize();
      setCalculatedLot(lotSize);
      
      // リスク金額を計算
      const balance = parseFloat(accountBalance);
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
    } else {
      // 必要な値が揃っていない場合はリセット
      setCalculatedLot('0.00');
      setRiskAmount('0');
      setRiskAmountUSD('0');
      setBalanceEquivalent('0');
    }
  }, [accountBalance, riskPercentage, stopLossPips, currency, currencyPrice, balanceCurrency]);

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
    
    const balance = parseFloat(accountBalance);
    const lotSize = parseFloat(calculatedLot);
    const rate = parseFloat(currencyPrice);
    
    // ポジションサイズ（通貨単位）：1ロット = 100,000通貨単位
    const positionSize = lotSize * 100000;
    
    // 必要証拠金 = ポジションサイズ × レート × 証拠金率(1/レバレッジ)
    const requiredMargin = positionSize * rate * (1 / leverage);
    
    // 証拠金維持率(%) = (有効証拠金 ÷ 必要証拠金) × 100
    // 未決済ポジションがないため、有効証拠金 = 口座残高
    const ratio = (balance / requiredMargin) * 100;
    
    // 小数点以下2桁で表示
    return ratio.toFixed(2);
  };
  
  return (
    <Page>
      <div className='lg:w-150 lg:mx-auto pb-3'>

      {/* ヘッダー部分 */}
      <div className="relative">
        <h1 className='text-center text-2xl lh-base'>FX</h1>
        <p className='text-center'>Lot Size Calculator</p>
        
        {/* ヘルプボタン（右上に配置） */}
        <button 
          className="absolute top-0 right-3 text-orange-500 font-bold rounded-full h-8 w-8 flex items-center justify-center border border-orange-500"
          onClick={openHelpModal}
        >
          ?
        </button>
      </div>

      <div className='flex justify-center'>

      {/* 計算結果表示 - 常に表示 */}
      <div className=" bg-blue-50 rounded-md p-3 border border-blue-200 mx-3 w-55">
        <div className="">
          <div>
            <p className="text-sm text-gray-600">適正ロット:</p>
            <p className="text-xl font-bold text-blue-700">{calculatedLot} Lots</p>
          </div>
          <div>
            <p className="text-sm text-gray-600">損失許容額:</p>
            <p className="text-xl font-bold text-red-600">
              {balanceCurrency === 'JPY' ? `${riskAmount}円` : `$${riskAmount}`}
            </p>
            <p className="text-xs text-gray-500">
              {balanceCurrency === 'JPY' ? `(約$${riskAmountUSD})` : `(約${riskAmountUSD}円)`}
            </p>
          </div>
          {/* 証拠金維持率を追加 */}
          {currency !== 'JPY' && parseFloat(marginRatio) > 0 && (
            <div className="mt-2 border-t pt-2">
              <p className="text-sm text-gray-600">証拠金維持率:</p>
              <p className={`text-lg font-bold ${
                parseFloat(marginRatio) < 100 ? 'text-red-600' : 
                parseFloat(marginRatio) < 200 ? 'text-yellow-600' : 'text-green-600'
              }`}>
                {marginRatio}%
              </p>
              <p className="text-xs text-gray-500">
                (レバレッジ {leverage}倍)
              </p>
            </div>
          )}
        </div>
      </div>

      {/* 証拠金通貨選択 */}
      <div className='px-1 mb-4 w-45'>
        <p className="text-sm text-gray-600">証拠金通貨選択</p>
        <Select
          data={balanceCurrencyData}
          value={balanceCurrency}
          onChange={handleBalanceCurrencyChange}
          display="inline"
          touchUi={true}
          label="証拠金通貨"
          labelStyle="stacked"
        />
      </div>
      </div>

      <div className='flex gap-2 px-3 mb-4 justify-center'>
        <div className='w-55'>
          <p className='text-center mb-2'>ストップ幅（pips）</p>
          <Input
            type="number"
            value={stopLossPips}
            onChange={handleStopLossChange}
            placeholder="損切り幅を入力"
            inputStyle="box"
            labelStyle="stacked"
          />
          <p className='text-sm text-gray-500 text-center mt-1'>
            例: USD/JPYなら30pips = 0.30円
          </p>
        </div>
        <div className='w-45'>
          <p className='text-center'>リスク%</p>
          <Select
            data={riskData}
            value={riskPercentage}
            onChange={handleRiskChange}
            display="inline"
            touchUi={true}
            label="リスク%"
            labelStyle="stacked"
          />
        </div>
      </div>

      {/* 証拠金入力フィールド */}
      <div className='px-3 mb-4'>
        <p className='text-center mb-2'>
          証拠金額 ({balanceCurrency === 'JPY' ? '円' : 'USD'})
        </p>
        <Input
          type={balanceCurrency === 'USD' ? 'tel' : 'text'} // USDの場合はtelタイプを使用
          value={inputBalance} // 編集中の入力値を使用
          onChange={handleAccountBalanceChange}
          placeholder={balanceCurrency === 'JPY' ? "証拠金額を入力" : "証拠金額を入力 (例: 1000.50)"}
          inputStyle="box"
          labelStyle="stacked"
        />
        <div className='text-xs text-gray-500 text-center mt-1'>
          <p>取引に使用可能な資金額を入力してください</p>
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

      {/* 基軸通貨選択と価格表示 */}
      <div className='px-3'>
        <div className="flex flex-col items-center">
          {/* 通貨価格表示と更新日時 */}
          <div className="flex items-center gap-20 mb-2">
            <div className="bg-gray-100 rounded-full text-center">
              <p className='font-bold'>通貨ベース（価格）</p>
              <p className="text-center font-semibold">
                {currency === 'JPY' 
                  ? `${currency} = ${currencyPrice}` 
                  : `${currency}/JPY = ${currencyPrice}`}
              </p>
            </div>
            <div className='text-center'>
              <p className='font-bold'>価格更新日時</p>
              <p className="text-xs text-gray-500 p-2">{lastUpdated}</p>
            </div>
          </div>
        </div>
      </div>

      <div className='flex gap-2 px-3 mb-4 justify-center'>
        {/* 基軸通貨選択 */}
        <div className='w-50'>
          <p className='text-center mb-1'>基軸通貨</p>
          <Select
              data={currencyData}
              value={currency}
              onChange={handleCurrencyChange}
              display="inline"
              touchUi={true}
              label="基軸通貨"
              labelStyle="stacked"
            />
        </div>

        {/* レバレッジ選択 */}
        <div className='w-50'>
          <p className='text-center mb-2'>レバレッジ</p>
          <Select
            data={leverageData}
            value={leverage}
            onChange={handleLeverageChange}
            display="inline"
            touchUi={true}
            label="レバレッジ"
            labelStyle="stacked"
          />
          <p className='text-xs text-gray-500 text-center mt-1'>
            お使いのブローカーが提供するレバレッジを選択してください
          </p>
        </div>
      </div>
      
      {/* 設定確認ボタン - おしゃれなデザイン */}
      <div className='px-3 mt-6'>
        <button 
          onClick={openModal}
          className="w-full py-3 px-4 bg-gradient-to-r from-orange-400 to-orange-600 text-white rounded-lg shadow-md hover:shadow-lg transform hover:-translate-y-0.5 transition-all duration-200 font-medium flex items-center justify-center"
        >
          <span className="mr-2">
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" viewBox="0 0 16 16">
              <path d="M8 15A7 7 0 1 1 8 1a7 7 0 0 1 0 14zm0 1A8 8 0 1 0 8 0a8 8 0 0 0 0 16z"/>
              <path d="m8.93 6.588-2.29.287-.082.38.45.083c.294.07.352.176.288.469l-.738 3.468c-.194.897.105 1.319.808 1.319.545 0 1.178-.252 1.465-.598l.088-.416c-.2.176-.492.246-.686.246-.275 0-.375-.193-.304-.533L8.93 6.588zM9 4.5a1 1 0 1 1-2 0 1 1 0 0 1 2 0z"/>
            </svg>
          </span>
          設定内容を確認
        </button>
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
              ? `${formattedBalance}円`
              : `$${parseFloat(accountBalance).toFixed(2)}`}
          </strong></p>
          <p className="mb-3">証拠金通貨: <strong>{balanceCurrency}</strong></p>
          <p className="mb-3">基軸通貨: <strong>{currency}</strong> {currency !== 'JPY' && `(${currencyPrice}円)`}</p>
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
      </div>
    </Page>
  );
};

export default App;