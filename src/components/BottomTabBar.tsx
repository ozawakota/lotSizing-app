// 下部タブバー（モバイル定番のナビ）。各ページを常時表示し、現在地をオレンジで示す。
import { BarChart3, Bot, Calculator, Layers, Newspaper, Ruler, Wallet } from 'lucide-react';

export type AppView = 'calculator' | 'flow' | 'aibot' | 'fund' | 'news' | 'mtf' | 'sr';

const TABS: { key: AppView; label: string; Icon: typeof Calculator }[] = [
  { key: 'calculator', label: '計算', Icon: Calculator },
  { key: 'flow', label: '取引量', Icon: BarChart3 },
  { key: 'news', label: 'ニュース', Icon: Newspaper },
  { key: 'mtf', label: 'TF分析', Icon: Layers },
  { key: 'sr', label: 'レジサポ', Icon: Ruler },
  { key: 'aibot', label: 'AIbot', Icon: Bot },
  { key: 'fund', label: '資金管理', Icon: Wallet },
];

export default function BottomTabBar({ view, onChange }: { view: AppView; onChange: (v: AppView) => void }) {
  return (
    <nav className="fixed bottom-0 inset-x-0 z-20 border-t border-gray-200 bg-white/95 backdrop-blur">
      <div className="lg:w-150 mx-auto grid grid-cols-7">
        {TABS.map(({ key, label, Icon }) => {
          const active = view === key;
          return (
            <button
              key={key}
              type="button"
              onClick={() => onChange(key)}
              aria-current={active ? 'page' : undefined}
              className={`flex flex-col items-center justify-center gap-0.5 py-2 min-h-[44px] transition-colors ${
                active ? 'text-orange-500' : 'text-gray-400'
              }`}
            >
              <Icon className="h-5 w-5" />
              <span className="text-[10px] font-medium">{label}</span>
            </button>
          );
        })}
      </div>
      {/* iOS ホームインジケータ分の余白 */}
      <div style={{ height: 'env(safe-area-inset-bottom)' }} />
    </nav>
  );
}
