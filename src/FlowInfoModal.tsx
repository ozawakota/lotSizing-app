// FlowInfoModal.tsx
// 取引量・センチメントページの各指標（建玉割合 / 取引量 / 前回比の積み増し・巻き戻し）の
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
          データは <span className="font-semibold">Myfxbook</span> の個人投資家コミュニティの現在ポジションです。
          スポットFXに中央集権的な出来高は無いため、市場全体ではなく
          <span className="font-semibold">個人投資家層の傾向</span>を表します。
        </p>

        <h4 className="mt-4 mb-1 font-bold">建玉割合（%）</h4>
        <p className="mb-4">
          買い（<span className="text-green-700 font-semibold">緑</span>）と
          売り（<span className="text-red-700 font-semibold">赤</span>）の建玉が占める割合です。バーと上段の%がこれに当たります。
        </p>

        <h4 className="mt-4 mb-1 font-bold">取引量（下段の数値）</h4>
        <p className="mb-4">
          買い量・売り量の実建玉ボリュームです。「買い」「売り」の優勢ラベルは、割合ではなく
          <span className="font-semibold">この取引量の多い方</span>で判定しています。
        </p>

        <h4 className="mt-4 mb-1 font-bold">前回比（積み増し / 巻き戻し）</h4>
        <p className="mb-2">
          合計取引量（買い＋売り）を<span className="font-semibold">前回の更新スナップショットと比較</span>した純増減です。
        </p>
        <ul className="mb-3 list-none space-y-2">
          <li className="rounded-md bg-green-50 px-2 py-1">
            <span className="font-semibold text-green-700">↗ 積み増し（新規優勢）</span>
            <br />
            合計建玉が増加 ＝ 新規エントリーが決済を上回った。
          </li>
          <li className="rounded-md bg-red-50 px-2 py-1">
            <span className="font-semibold text-red-700">↘ 巻き戻し（決済優勢）</span>
            <br />
            合計建玉が減少 ＝ 決済が新規エントリーを上回った。
          </li>
          <li className="rounded-md bg-gray-100 px-2 py-1">
            <span className="font-semibold text-gray-600">− 変化なし</span>
            <br />
            前回から合計建玉に増減なし。
          </li>
        </ul>

        <h4 className="mt-4 mb-1 font-bold">注意点</h4>
        <ul className="list-disc space-y-2 pl-5">
          <li>
            Myfxbook は建玉の<span className="font-semibold">純増減</span>しか取得できないため、
            エントリーと決済を個別には観測できません。例えば同じ時間に新規100・決済60があっても、表示は差し引き+40になります。
          </li>
          <li>
            比較基準は<span className="font-semibold">毎時更新の前回スナップショット</span>です。
            初回更新のペアは比較対象が無いため、バッジは表示されません。
          </li>
          <li>
            これは「今ポジションが積み増されているか巻き戻されているか」という
            <span className="font-semibold">状態</span>を示す指標であり、売買シグナル（転換／継続）ではありません。
          </li>
        </ul>
      </div>
    </Popup>
  );
};

export default FlowInfoModal;
