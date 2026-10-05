// DstInfoModal.tsx
import { FC } from 'react';
import { Popup } from '@mobiscroll/react';

interface DstInfoModalProps {
  isOpen: boolean;
  onClose: () => void;
}

const DstInfoModal: FC<DstInfoModalProps> = ({ isOpen, onClose }) => {
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
      <div className="max-h-[75vh] overflow-y-auto overscroll-contain p-4">
        <h3 className="font-bold mb-3">夏時間（サマータイム）と冬時間について</h3>

        <p className="mb-3">
          FX市場は欧米の取引時間を基準に動いているため、欧米が
          <span className="font-semibold">サマータイム（DST）</span>
          を採用している「夏時間」と、採用していない「冬時間」で、日本時間から見た取引時間が
          <span className="font-semibold">1時間ずれます</span>
          。日本はサマータイムを採用していません。
        </p>

        <h4 className="font-bold mt-4 mb-2">日本時間での主な違い:</h4>

        <div className="overflow-x-auto mb-3">
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr className="border-b border-gray-300">
                <th className="text-left py-1 pr-2"></th>
                <th className="text-left py-1 px-2">冬時間</th>
                <th className="text-left py-1 px-2">夏時間</th>
              </tr>
            </thead>
            <tbody>
              <tr className="border-b border-gray-200">
                <td className="py-1 pr-2 font-semibold">週の取引開始（月）</td>
                <td className="py-1 px-2">7:00頃</td>
                <td className="py-1 px-2">6:00頃</td>
              </tr>
              <tr className="border-b border-gray-200">
                <td className="py-1 pr-2 font-semibold">週の取引終了（土）</td>
                <td className="py-1 px-2">7:00</td>
                <td className="py-1 px-2">6:00</td>
              </tr>
              <tr className="border-b border-gray-200">
                <td className="py-1 pr-2 font-semibold">ロンドン市場</td>
                <td className="py-1 px-2">17:00頃〜</td>
                <td className="py-1 px-2">16:00頃〜</td>
              </tr>
              <tr>
                <td className="py-1 pr-2 font-semibold">ニューヨーク市場</td>
                <td className="py-1 px-2">22:00頃〜</td>
                <td className="py-1 px-2">21:00頃〜</td>
              </tr>
            </tbody>
          </table>
        </div>

        <p className="mb-3 text-sm">
          → 夏時間はすべて<span className="font-semibold">「1時間早まる」</span>と覚えると分かりやすいです。
        </p>

        <h4 className="font-bold mt-4 mb-2">切り替え時期:</h4>
        <ul className="list-disc pl-5 mb-3 text-sm">
          <li className="mb-2">
            <span className="font-semibold">アメリカ</span>: 3月第2日曜 〜 11月第1日曜
          </li>
          <li className="mb-2">
            <span className="font-semibold">ヨーロッパ（EU）</span>: 3月最終日曜 〜 10月最終日曜
          </li>
        </ul>
        <p className="mb-3 text-sm">
          アメリカとヨーロッパで切り替え日が数週間ずれるため、その「はざまの期間」はロンドンとニューヨークの時差が普段と変わり、いつもと違う時間帯の値動きになることがあります。
        </p>

        <h4 className="font-bold mt-4 mb-2">この画面の表示について:</h4>
        <p className="text-sm">
          世界時計の各市場に表示される
          <span className="inline-block mx-0.5 px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-amber-100 text-amber-700">夏時間</span>
          /
          <span className="inline-block mx-0.5 px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-sky-100 text-sky-700">冬時間</span>
          のバッジと「今週の取引時間（日本時間）」は、現地のDST状況から自動で判定しています。
        </p>
      </div>
    </Popup>
  );
};

export default DstInfoModal;
