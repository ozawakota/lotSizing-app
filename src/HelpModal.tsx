// HelpModal.tsx
import { FC } from 'react';
import { Popup } from '@mobiscroll/react';

interface HelpModalProps {
  isOpen: boolean;
  onClose: () => void;
}

const HelpModal: FC<HelpModalProps> = ({ isOpen, onClose }) => {
  return (
    <Popup
      isOpen={isOpen}
      onClose={onClose}
      buttons={[
        {
          text: '閉じる',
          handler: onClose
        }
      ]}
    >
      <div className="p-4">
        <h3 className="font-bold mb-3">FXロットサイズ計算機について</h3>
        
        <p className="mb-3">
          このアプリは、FX取引における適切なポジションサイズ（ロットサイズ）を計算するためのツールです。資金管理は成功するトレーダーにとって最も重要な要素の一つです。
        </p>
        
        <h4 className="font-bold mt-4 mb-2">設定項目の説明:</h4>
        
        <ul className="list-disc pl-5 mb-3">
          <li className="mb-2">
            <span className="font-semibold">ストップ幅（pips）</span>: あなたの取引戦略における損切りポイントまでの距離をpips単位で入力します。例えば、USD/JPYで現在のレートが150.00、損切りポイントを149.70に設定する場合、ストップ幅は30pipsとなります。
          </li>
          <li className="mb-2">
            <span className="font-semibold">リスク%</span>: 1回の取引で許容する損失の割合です。資金全体の何%までをリスクにさらすかを設定します。一般的に、プロのトレーダーは1回の取引で資金の1〜3%以上をリスクにさらすことはありません。
          </li>
          <li className="mb-2">
            <span className="font-semibold">証拠金額</span>: 取引に使用可能な資金額を円単位で入力します。これはあなたの口座残高または特定の取引に割り当てる資金額です。
          </li>
          <li className="mb-2">
            <span className="font-semibold">基軸通貨</span>: 取引する通貨ペアの基軸（決済）通貨を選択します。これにより、pipsあたりの価値が変わります。
          </li>
          <li className="mb-2">
            <span className="font-semibold">レバレッジ</span>: 証拠金に対して何倍の取引が可能かを示す倍率です。レバレッジが高いほど、少ない証拠金でより大きなポジションを取ることができますが、リスクも比例して高くなります。
          </li>
        </ul>
        
        <h4 className="font-bold mt-4 mb-2">使い方:</h4>
        
        <ol className="list-decimal pl-5 mb-3">
          <li className="mb-2">各項目に適切な値を設定します</li>
          <li className="mb-2">上部に表示される「適正ロット」と「損失許容額」を確認します（リアルタイムで更新されます）</li>
          <li className="mb-2">必要に応じて「設定内容を確認」ボタンを押し、詳細情報と最大取引可能ロットを確認します</li>
        </ol>
        
        <h4 className="font-bold mt-4 mb-2">計算式:</h4>
        
        <div className="bg-gray-800 p-3 rounded mb-3">
          <p className="text-white">
            適正ロットサイズ = (口座残高 × リスク%) ÷ (ストップ幅(pips) × 1pipsあたりの価値)
          </p>
          <p className="text-white mt-2">
            損失許容額 = 口座残高 × リスク%
          </p>
          <p className="text-white mt-2">
            最大取引可能ロット = (証拠金 × レバレッジ) ÷ (通貨価格 × 10000)
          </p>
        </div>
        
        <h4 className="font-bold mt-4 mb-2">注意事項:</h4>
        <ul className="list-disc pl-5 mb-3">
          <li className="mb-2">
            <span className="font-semibold">リスク管理</span>: 一般的には資金の1〜3%以上をリスクにさらすことは避けるべきです。特に初心者は2%以下に抑えることをお勧めします。
          </li>
          <li className="mb-2">
            <span className="font-semibold">レバレッジの影響</span>: 高レバレッジはより大きな利益の可能性を提供しますが、損失のリスクも同様に増大します。自分の経験レベルに合ったレバレッジを選択してください。
          </li>
        </ul>
        
        <p className="text-sm text-gray-400">
          ※このアプリはあくまで参考値です。実際の取引では、市場の状況や個人の取引戦略に応じて調整してください。
        </p>
      </div>
    </Popup>
  );
};

export default HelpModal;