// ProverbModal.tsx
// 「今日の相場格言」を表示するモーダル。格言は日付（JST）で決まり、同じ日は同じものを表示する。
// DstInfoModal と同じ mobiscroll Popup を踏襲。
import { FC } from 'react';
import { Popup } from '@mobiscroll/react';
import { Quote } from 'lucide-react';
import { dailyProverb } from '@/lib/proverbs';

interface ProverbModalProps {
  isOpen: boolean;
  onClose: () => void;
}

const ProverbModal: FC<ProverbModalProps> = ({ isOpen, onClose }) => {
  // 表示のたびにその日（JST）の格言を選ぶ（軽い計算なので毎回でよい。日付をまたげば翌日の格言になる）。
  const now = new Date();
  const proverb = dailyProverb(now);
  const dateLabel = now.toLocaleDateString('ja-JP', { timeZone: 'Asia/Tokyo', month: 'long', day: 'numeric', weekday: 'short' });

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
      <div className="p-4">
        <p className="mb-3 text-xs font-semibold text-amber-600">{dateLabel}の相場格言</p>
        <div className="relative rounded-xl bg-amber-50 px-4 py-5">
          <Quote className="absolute left-2 top-2 h-4 w-4 text-amber-300" aria-hidden="true" />
          <p className="text-center text-lg font-bold leading-relaxed text-gray-800">{proverb.text}</p>
        </div>
        <p className="mt-2 text-right text-xs text-gray-500">— {proverb.source}</p>
        <h4 className="mt-4 mb-1 text-sm font-bold text-gray-700">意味</h4>
        <p className="text-sm leading-relaxed text-gray-700">{proverb.meaning}</p>
        <p className="mt-4 text-[10px] text-gray-400">格言は毎日0時（日本時間）に入れ替わります。</p>
      </div>
    </Popup>
  );
};

export default ProverbModal;
