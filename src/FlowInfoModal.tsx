// FlowInfoModal.tsx
// 取引量・センチメントページの各指標（個人の建玉割合・前回比 / 大口の COT / 逆行の判定）の
// 読み方とロジックを説明するモーダル。DstInfoModal と同じ mobiscroll Popup を踏襲。
import { FC } from 'react';
import { Popup } from '@mobiscroll/react';

interface FlowInfoModalProps {
  isOpen: boolean;
  onClose: () => void;
}

const FlowInfoModal: FC<FlowInfoModalProps> = ({ isOpen, onClose }) => {
  return (
    <Popup
      isOpen={isOpen}
      onClose={onClose}
      maxHeight="80vh"
      buttons={[
        {
          text: '閉じる',
          handler: onClose,
        },
      ]}
    >
      <div className="p-4 text-sm leading-relaxed">
        <h3 className="mb-3 font-bold">表示の見方</h3>

        <p className="mb-4">
          各ペアのカードは、<span className="font-semibold">個人</span>と<span className="font-semibold">大口</span>の
          2本のバーでポジションの偏りを示します。<span className="text-green-700 font-semibold">緑＝買い</span>、
          <span className="text-red-700 font-semibold">赤＝売り</span>です。
        </p>

        <h4 className="mt-4 mb-1 font-bold">個人（Myfxbook・毎時）</h4>
        <p className="mb-2">
          Myfxbook の個人投資家コミュニティの建玉の割合です。右の「売り 68%」は、多い側とその割合です。
          スポットFXには取引所の出来高が無いため、市場全体ではなく<span className="font-semibold">個人投資家層の傾向</span>を表します。
        </p>
        <ul className="mb-4 list-none space-y-2">
          <li className="rounded-md bg-amber-50 px-2 py-1">
            <span className="font-semibold text-amber-700">偏り大</span>：多い側が65%以上。
          </li>
          <li className="rounded-md bg-gray-100 px-2 py-1">
            <span className="font-semibold text-green-700">↗ 増</span> /
            <span className="font-semibold text-red-700"> ↘ 減</span>：1時間前と比べた合計建玉（買い＋売り）の増減。
            新規が決済を上回れば増、下回れば減です。
          </li>
        </ul>

        <h4 className="mt-4 mb-1 font-bold">大口（CFTC・週次）</h4>
        <p className="mb-2">
          米 CFTC が公表する COT の<span className="font-semibold">非商業（大口投機筋）</span>のネットポジションです。
          バーは中央から<span className="font-semibold">右に伸びれば買い越し、左なら売り越し</span>で、長いほど偏りが強く、
          「弱・中・強」で表します。「強まる / 弱まる」は前週からの変化です。
        </p>
        <p className="mb-4">
          CME の通貨先物は対ドルで建つため、各通貨のネットを正規化し、ペア X/Y は <span className="font-semibold">X − Y</span> で合成しています
          （クロス円も含む）。毎週金曜に火曜時点が発表されるため、約3日遅れです。
        </p>

        <h4 className="mt-4 mb-1 font-bold">個人と大口が逆 / 同じ向き</h4>
        <p className="mb-4">
          個人の多い側と大口の向きを比べた結果です。個人は<span className="font-semibold">逆張り</span>、
          大口は<span className="font-semibold">トレンド追随</span>になりやすいとされ、両者が逆向きのペアはオレンジの枠で目立たせています。
          「逆行のみ」で絞り込めます。
        </p>

        <h4 className="mt-4 mb-1 font-bold">詳細（カードをタップ）</h4>
        <p className="mb-4">買い量・売り量の実数、前回比の数値、記録を始めてからの最大取引量とその日時・レート、大口のネット値を表示します。</p>

        <h4 className="mt-4 mb-1 font-bold">注意点</h4>
        <ul className="list-disc space-y-2 pl-5">
          <li>
            Myfxbook は建玉の<span className="font-semibold">純増減</span>しか取得できず、新規と決済を分けて見ることはできません
            （新規100・決済60でも表示は差し引き+40）。
          </li>
          <li>前回比は毎時更新の前回スナップショットとの比較です。初回はまだ比較対象が無いため表示されません。</li>
          <li>
            いずれもポジションの<span className="font-semibold">状態</span>を示す情報で、売買シグナルではありません。
          </li>
        </ul>
      </div>
    </Popup>
  );
};

export default FlowInfoModal;
