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

const App: FC = () => {
  const [currency, setCurrency] = useState<CurrencyCode>('JPY');
  const [riskPercentage, setRiskPercentage] = useState<number>(2.5); // デフォルト2.5%
  const [stopLossPips, setStopLossPips] = useState<string>('25'); // デフォルト25pips
  const [accountBalance, setAccountBalance] = useState<string>('0'); // デフォルト100,000円
  const [formattedBalance, setFormattedBalance] = useState<string>('0'); // 表示用フォーマット済み証拠金
  const [leverage, setLeverage] = useState<number>(500); // デフォルトレバレッジ500倍
  const [isModalOpen, setIsModalOpen] = useState<boolean>(false); // モーダルの表示状態
  const [isHelpModalOpen, setIsHelpModalOpen] = useState<boolean>(false); // ヘルプモーダルの表示状態
  const [currencyPrice, setCurrencyPrice] = useState<string>('-'); // 選択された通貨の価格
  const [lastUpdated, setLastUpdated] = useState<string>(''); // 価格更新日時
  const [calculatedLot, setCalculatedLot] = useState<string>('0.00'); // 計算されたロットサイズ
  const [riskAmount, setRiskAmount] = useState<string>('0'); // 計算されたリスク金額

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
  useEffect(() => {
    setFormattedBalance(formatNumberWithCommas(accountBalance));
  }, [accountBalance]);

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
      setRiskAmount(formatNumberWithCommas(riskAmt.toString()));
    } else {
      // 必要な値が揃っていない場合はリセット
      setCalculatedLot('0.00');
      setRiskAmount('0');
    }
  }, [accountBalance, riskPercentage, stopLossPips, currency, currencyPrice]);

  // リスク許容度のデータ（0.5%単位、0.5%から30%まで）
  const riskData = Array.from({ length: 60 }, (_, i) => {
    const value = (i + 1) * 0.5; // 0.5, 1.0, 1.5, ..., 29.5, 30.0
    return { text: `${value.toFixed(1)}%`, value: value };
  });

  // 通貨が変更されたときのハンドラ
  const handleCurrencyChange = (event: any) => {
    setCurrency(event.value as CurrencyCode);
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

  // 証拠金額が変更されたときのハンドラ
  const handleAccountBalanceChange = (event: any) => {
    const inputValue = event.target.value;
    // カンマを除去して純粋な数値を取得
    const numericValue = inputValue.replace(/[^\d]/g, '');
    // 状態を更新（純粋な数値のみを保存）
    setAccountBalance(numericValue);
  };

  // ロットサイズを計算
  const calculateLotSize = (): string => {
    if (!stopLossPips || parseInt(stopLossPips) === 0) return '0.00';
    
    const balance = parseFloat(accountBalance);
    const risk = riskPercentage / 100;
    const stopLoss = parseInt(stopLossPips);
    const riskAmount = balance * risk;
    
    // 簡略化した計算（実際にはより複雑な計算が必要かもしれません）
    let pipValue = 1000; // 1lot当たりのpip価値（円）
    if (currency !== 'JPY') {
      // 外貨の場合は為替レートを考慮
      pipValue = 1000 * parseFloat(currencyPrice) / 100;
    }
    
    const lotSize = riskAmount / (stopLoss * pipValue);
    return lotSize.toFixed(2);
  };

  // 最大ロットサイズを計算（レバレッジ考慮）
  const calculateMaxLotSize = (): string => {
    if (currency === 'JPY') return '0.00'; // JPYの場合は計算不要
    
    const balance = parseFloat(accountBalance);
    const rate = parseFloat(currencyPrice);
    
    // 簡略化した計算
    // 最大ロット = (証拠金 × レバレッジ) ÷ (通貨価格 × 10000)
    const maxLotSize = (balance * leverage) / (rate * 10000);
    return maxLotSize.toFixed(2);
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

  return (
    <Page>
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
      
      {/* 計算結果表示 - 常に表示 */}
      <div className="mt-3 bg-blue-50 rounded-md p-3 border border-blue-200 mx-3">
        <div className="flex justify-between items-center">
          <div>
            <p className="text-sm text-gray-600">適正ロット:</p>
            <p className="text-xl font-bold text-blue-700">{calculatedLot} Lots</p>
          </div>
          <div>
            <p className="text-sm text-gray-600">損失許容額:</p>
            <p className="text-xl font-bold text-red-600">{riskAmount}円</p>
          </div>
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
        <p className='text-center mb-2'>証拠金額 (円)</p>
        <Input
          type="text"
          value={formattedBalance}
          onChange={handleAccountBalanceChange}
          placeholder="証拠金額を入力"
          inputStyle="box"
          labelStyle="stacked"
        />
        <p className='text-xs text-gray-500 text-center mt-1'>
          取引に使用可能な資金額を入力してください
        </p>
        
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
          <p className="mb-3">証拠金額: <strong>{formattedBalance}円</strong></p>
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
              リスク金額: {riskAmount}円
            </p>
            {currency !== 'JPY' && (
              <p className="text-center text-sm text-gray-600 mt-1">
                最大取引可能ロット: {calculateMaxLotSize()} Lots (レバレッジ{leverage}倍)
              </p>
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
    </Page>
  );
};

export default App;