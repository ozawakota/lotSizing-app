// AlertInfoModal.tsx
// 相場変動通知の機能説明モーダル。対象ペア・しきい値・仕組み・使い方・注意点を
// やさしく説明する。FlowInfoModal / DstInfoModal と同じ mobiscroll Popup を踏襲。
import { FC } from 'react';
import { Popup } from '@mobiscroll/react';

interface AlertInfoModalProps {
  isOpen: boolean;
  onClose: () => void;
}

const AlertInfoModal: FC<AlertInfoModalProps> = ({ isOpen, onClose }) => {
  return (
    <Popup
      isOpen={isOpen}
      onClose={onClose}
      headerText="相場変動通知とは"
      maxHeight="80vh"
      buttons={[{ text: '閉じる', handler: onClose }]}
    >
      <div className="p-4 text-sm leading-relaxed">
        <p className="mb-4">
          対象ペアの価格が<span className="font-semibold">直近15分で大きく動いた</span>ときに、
          スマホへ<span className="font-semibold">プッシュ通知</span>でお知らせする機能です。
          アプリやブラウザを閉じていても届きます。
        </p>

        <h4 className="mt-4 mb-1 font-bold">対象ペアと通知の目安</h4>
        <table className="mb-2 w-full border-collapse text-left">
          <thead>
            <tr className="border-b border-gray-300 text-gray-600">
              <th className="py-1 pr-2 font-semibold">ペア</th>
              <th className="py-1 font-semibold">15分での変動が…</th>
            </tr>
          </thead>
          <tbody>
            <tr className="border-b border-gray-100">
              <td className="py-1 pr-2">GBP/JPY</td>
              <td className="py-1">25 pips 以上</td>
            </tr>
            <tr className="border-b border-gray-100">
              <td className="py-1 pr-2">GBP/USD</td>
              <td className="py-1">25 pips 以上</td>
            </tr>
            <tr className="border-b border-gray-100">
              <td className="py-1 pr-2">AUD/USD</td>
              <td className="py-1">25 pips 以上</td>
            </tr>
            <tr>
              <td className="py-1 pr-2">XAU/USD（ゴールド）</td>
              <td className="py-1">5 ドル 以上</td>
            </tr>
          </tbody>
        </table>
        <p className="mb-4 text-xs text-gray-500">
          「変動」は直近15分間の<span className="font-semibold">高値と安値の差</span>で判定します。
        </p>

        <h4 className="mt-4 mb-1 font-bold">仕組み</h4>
        <ul className="mb-4 list-disc space-y-1 pl-5">
          <li>サーバーが<span className="font-semibold">毎分</span>各ペアの価格を取得します。</li>
          <li>直近15分の高安差がしきい値に達したら通知を送ります。</li>
          <li>
            通知したあとの<span className="font-semibold">15分間はそのペアをお休み</span>し、
            同じ変動で何度も鳴らないようにします。
          </li>
        </ul>

        <h4 className="mt-4 mb-1 font-bold">使い方</h4>
        <ul className="mb-4 list-disc space-y-1 pl-5">
          <li>ヘッダーの<span className="font-semibold">ベルアイコン</span>をタップし、スイッチを ON にします。</li>
          <li>初回は<span className="font-semibold">通知の許可</span>を求められるので「許可」を選びます。</li>
          <li>ONのときはベルに<span className="font-semibold text-orange-600">オレンジの点</span>が表示されます。</li>
        </ul>

        <h4 className="mt-4 mb-1 font-bold">iPhone / iPad をお使いの方へ</h4>
        <p className="mb-4">
          iOSでは、Safariの共有メニューから<span className="font-semibold">「ホーム画面に追加」</span>したアプリ
          （PWA / iOS 16.4以降）からのみ通知が届きます。ホーム画面のアイコンから起動して ON にしてください。
        </p>

        <h4 className="mt-4 mb-1 font-bold">注意点</h4>
        <ul className="list-disc space-y-2 pl-5">
          <li>
            これは「大きく動いた」という<span className="font-semibold">気づき</span>を知らせるもので、
            売買シグナル（買い／売りの推奨）ではありません。
          </li>
          <li>
            価格は無料の外部データを参照しているため、業者レートとはわずかに差が出ることがあります。
            実取引の判断前には必ずご自身の取引ツールで確認してください。
          </li>
        </ul>
      </div>
    </Popup>
  );
};

export default AlertInfoModal;
