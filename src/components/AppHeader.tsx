// 共通ヘッダー。中央にページタイトル、右側にアクション（通知ベル・ヘルプ等）を置く。
import type { ReactNode } from 'react';

export default function AppHeader({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <header className="sticky top-0 z-20 bg-white/95 backdrop-blur border-b border-gray-200">
      <div className="lg:w-150 mx-auto relative h-12 flex items-center justify-center px-3">
        <h1 className="text-base! font-bold text-gray-800 lh-base">{title}</h1>
        <div className="absolute right-2 flex items-center gap-1">{children}</div>
      </div>
    </header>
  );
}
