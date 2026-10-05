// StrengthInfoModal.tsx
// 通貨強弱メーターのロジック説明モーダル。計算の考え方・起点・読み方・
// ゴールド線・データ源をやさしく説明する。FlowInfoModal と同じ mobiscroll Popup を踏襲。
import { FC } from 'react';
import { Popup } from '@mobiscroll/react';

interface StrengthInfoModalProps {
  isOpen: boolean;
  onClose: () => void;
}

const StrengthInfoModal: FC<StrengthInfoModalProps> = ({ isOpen, onClose }) => {
  return (
    <Popup
      isOpen={isOpen}
      onClose={onClose}
      headerText="通貨強弱の見方"
      buttons={[{ text: '閉じる', handler: onClose }]}
    >
      <div className="p-4 text-sm leading-relaxed">
        <p className="mb-4">
          主要8通貨（JPY・USD・EUR・GBP・AUD・NZD・CAD・CHF）が、選んだ起点から
          <span className="font-semibold">どれだけ買われた／売られたか</span>を相対的に比べる指標です。
          OANDA の通貨強弱と同じ考え方で、0を基準にした累積の折れ線で表示します。
        </p>

        <h4 className="mt-4 mb-1 font-bold">何を計算しているか</h4>
        <ul className="mb-4 list-disc space-y-1 pl-5">
          <li>各通貨の対円レート（X/JPY）の変化を基に、各通貨の値動きを算出します。</li>
          <li>
            ある通貨の強弱は、<span className="font-semibold">他の7通貨すべてに対する変化の合計</span>
            （対数変化）です。単独の価格ではなく「他通貨と比べて」の強さです。
          </li>
          <li>
            そのため8通貨の値は<span className="font-semibold">常に合計がほぼ0</span>になります。
            誰かが強ければ、必ず誰かが弱いという関係です。
          </li>
        </ul>

        <h4 className="mt-4 mb-1 font-bold">起点（4時間前 / 当日 / 年初 / 1時間前）</h4>
        <p className="mb-4">
          選んだ起点で<span className="font-semibold">全通貨が必ず0から</span>始まり、そこからの累積を描きます。
          同じ瞬間でも起点を変えると値や符号は変わります（例：「当日」は今日の始まりからの比較）。
        </p>

        <h4 className="mt-4 mb-1 font-bold">読み方</h4>
        <ul className="mb-4 list-disc space-y-1 pl-5">
          <li><span className="font-semibold text-green-700">プラス（上）</span>＝起点以降、他通貨より買われて強い。</li>
          <li><span className="font-semibold text-red-700">マイナス（下）</span>＝起点以降、他通貨より売られて弱い。</li>
          <li>一覧は強い順に並びます。上にあるほど強い通貨です。</li>
          <li>
            あくまで<span className="font-semibold">相対</span>評価です。「絶対的に強い」ではなく
            「この期間、他通貨と比べて強い／弱い」を表します。
          </li>
        </ul>

        <h4 className="mt-4 mb-1 font-bold">ゴールド（XAU）の破線</h4>
        <p className="mb-2">
          金価格（XAU）を<span className="font-semibold">8通貨バスケットと比べた相対強弱</span>として、
          別の破線で重ねて表示します。8通貨の値や順位には影響しません。
        </p>
        <ul className="mb-4 list-disc space-y-1 pl-5">
          <li>
            <span className="font-semibold text-green-700">プラス</span>＝通貨よりゴールドが買われている（リスクオフ寄り）。
          </li>
          <li>
            <span className="font-semibold text-red-700">マイナス</span>＝ゴールドより通貨が買われている（リスクオン寄り）。
            金の円建て価格が上がっていても、通貨の上昇がそれ以上ならマイナスになり得ます。
          </li>
        </ul>

        <h4 className="mt-4 mb-1 font-bold">データと更新</h4>
        <p className="mb-4">
          レートは外部データ（Twelve Data）をサーバーが定期取得してキャッシュし、
          表示を開いている間は1時間ごとに自動更新します（手動更新も可）。
          4時間前/当日/1時間前は15分足、年初は日足を使います。
        </p>

        <p className="text-xs text-gray-400">
          ※この指標は相場の傾向を見る参考値です。売買シグナルではありません。
        </p>
      </div>
    </Popup>
  );
};

export default StrengthInfoModal;
