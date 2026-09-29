// 通貨強弱メーター（Cloudflare Worker から取得・毎時オートリフレッシュ）
// 設計: docs/adr/0004-currency-strength-intraday-on-cloudflare-workers.md
// Worker(Cron+KV) が毎時算出・キャッシュしたスナップショットを読むだけ。
// マウント時＋1時間ごとに自動再取得し、手動更新ボタンも備える。
// 取得失敗はボタン近傍にエラー表示するのみで、電卓本体の動作は妨げない。
import { FC, useCallback, useEffect, useState } from 'react';
import { StrengthSnapshot, sortScores, formatWindowLabel } from '@/lib/strength';

const REFRESH_MS = 60 * 60 * 1000; // 1時間

const fetchStrength = async (): Promise<StrengthSnapshot> => {
  const url = import.meta.env.VITE_STRENGTH_URL as string | undefined;
  if (!url) throw new Error('強弱エンドポイント(VITE_STRENGTH_URL)が未設定です');
  const res = await fetch(url);
  if (!res.ok) throw new Error(`強弱API HTTP ${res.status}`);
  const data = (await res.json()) as StrengthSnapshot | { error: string };
  if ('error' in data) throw new Error(data.error);
  return data;
};

const CurrencyStrengthMeter: FC = () => {
  const [snapshot, setSnapshot] = useState<StrengthSnapshot | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string>('');

  const loadStrength = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      setSnapshot(await fetchStrength());
    } catch (e) {
      console.warn('通貨強弱の取得に失敗:', e);
      setError(e instanceof Error ? e.message : '取得に失敗しました');
    } finally {
      setLoading(false);
    }
  }, []);

  // マウント時に取得し、1時間ごとに自動再取得（開いている間）
  useEffect(() => {
    if (!import.meta.env.VITE_STRENGTH_URL) return;
    loadStrength();
    const id = setInterval(loadStrength, REFRESH_MS);
    return () => clearInterval(id);
  }, [loadStrength]);

  const ranked = snapshot ? sortScores(snapshot.scores) : [];
  const maxAbs = ranked.reduce((m, s) => Math.max(m, Math.abs(s.changePct)), 0) || 1;

  return (
    <div className="mt-2 text-xs">
      <div className="flex items-center justify-center gap-2">
        <button
          type="button"
          onClick={loadStrength}
          disabled={loading}
          className="rounded-full border border-orange-500 px-3 py-1 text-orange-600 disabled:opacity-50"
        >
          {loading ? '取得中…' : snapshot ? '通貨強弱を更新' : '通貨強弱を表示'}
        </button>
        {snapshot && !loading && (
          <span className="text-gray-500 tabular-nums">{formatWindowLabel(snapshot)}</span>
        )}
      </div>

      {error && <p className="mt-1 text-center text-red-600">{error}</p>}

      {snapshot && (
        <div className="mx-auto mt-2 max-w-xs space-y-1">
          {ranked.map((s) => {
            const positive = s.changePct >= 0;
            const widthPct = (Math.abs(s.changePct) / maxAbs) * 50; // 中心から左右へ最大50%
            return (
              <div key={s.currency} className="flex items-center gap-2">
                <span className="w-8 font-mono">{s.currency}</span>
                <span
                  className={`w-16 text-right tabular-nums ${positive ? 'text-green-600' : 'text-red-600'}`}
                >
                  {positive ? '+' : ''}
                  {s.changePct.toFixed(2)}%
                </span>
                <div className="relative h-2 flex-1 bg-gray-100">
                  <span className="absolute left-1/2 top-0 bottom-0 w-px bg-gray-300" aria-hidden="true" />
                  <span
                    className={`absolute top-0 bottom-0 ${positive ? 'left-1/2 bg-green-500' : 'right-1/2 bg-red-500'}`}
                    style={{ width: `${widthPct}%` }}
                    aria-hidden="true"
                  />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

export default CurrencyStrengthMeter;
