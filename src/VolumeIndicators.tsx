// 4時間足の出来高インジケーター（全ペア一覧）。取引量ページの先頭に表示する。
// FX スポットには取引所の出来高が無いため CME 先物（6J/6E/6B/6A・金は GC=F）の出来高を使う。
// クロス円は単独の先物が無く「データなし」。Worker(/volume) が 30分キャッシュで返す。計算は src/lib/volume.ts。
import { FC, useCallback, useEffect, useState } from 'react';
import { RVOL_LABEL, VOLUME_TREND_LABEL, type Dir3, type VolumeSnapshot } from '@/lib/volume';

// VITE_VOLUME_URL が無ければ VITE_FLOW_URL（…/flow）と同じ Worker の /volume を使う。
const volumeUrl = (): string | undefined => {
  const v = import.meta.env.VITE_VOLUME_URL as string | undefined;
  if (v) return v;
  const flow = import.meta.env.VITE_FLOW_URL as string | undefined;
  return flow ? flow.replace(/\/flow\/?$/, '/volume') : undefined;
};

const REFRESH_MS = 30 * 60 * 1000;
const RVOL_STYLE = { surge: 'bg-orange-100 text-orange-700', high: 'bg-amber-50 text-amber-700', normal: 'bg-gray-100 text-gray-600', low: 'bg-gray-50 text-gray-400' } as const;
const DIR_ARROW: Record<Dir3, string> = { up: '↑', down: '↓', flat: '→' };
const DIR_STYLE: Record<Dir3, string> = { up: 'text-green-600', down: 'text-red-600', flat: 'text-gray-400' };

const VolumeIndicators: FC = () => {
  const [data, setData] = useState<VolumeSnapshot | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    const url = volumeUrl();
    if (!url) return;
    try {
      const res = await fetch(url);
      const body = (await res.json()) as VolumeSnapshot | { error: string };
      if ('error' in body) throw new Error(body.error);
      setData(body);
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : '出来高の取得に失敗しました');
    }
  }, []);

  useEffect(() => {
    void load();
    const id = setInterval(() => void load(), REFRESH_MS);
    return () => clearInterval(id);
  }, [load]);

  if (!volumeUrl()) return null;

  return (
    <div className="mb-3 rounded-lg border border-gray-200 bg-white p-3">
      <div className="mb-1.5 flex items-center justify-between">
        <p className="text-sm font-bold text-gray-800">4時間足の出来高</p>
        {data && (
          <span className="text-[10px] text-gray-400">
            {new Date(data.generatedAt).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })} 更新
          </span>
        )}
      </div>
      {error && <p className="text-xs text-red-600">{error}</p>}
      {!data && !error && <p className="text-xs text-gray-400">取得中…</p>}
      {data && (
        <table className="w-full text-[11px] tabular-nums">
          <thead>
            <tr className="border-b border-gray-100 text-gray-400">
              <th className="py-1 text-left font-normal">ペア</th>
              <th className="py-1 text-right font-normal">RVOL</th>
              <th className="py-1 text-right font-normal">増減</th>
              <th className="py-1 text-right font-normal">OBV/価格</th>
            </tr>
          </thead>
          <tbody>
            {data.pairs.map(({ instrument, source, indicators: v }) => (
              <tr key={instrument} className="border-b border-gray-50 last:border-0">
                <td className="py-1 font-semibold text-gray-700">{instrument.replace('_', '/')}</td>
                {v ? (
                  <>
                    <td className="py-1 text-right">
                      <span className={`rounded px-1.5 py-0.5 ${RVOL_STYLE[v.rvolLevel]}`}>
                        {v.rvol.toFixed(2)}倍 {RVOL_LABEL[v.rvolLevel]}
                      </span>
                    </td>
                    <td className="py-1 text-right text-gray-600">{VOLUME_TREND_LABEL[v.trend]}</td>
                    <td className="py-1 text-right">
                      <span className={DIR_STYLE[v.obv]}>{DIR_ARROW[v.obv]}</span>
                      <span className="text-gray-300">/</span>
                      <span className={DIR_STYLE[v.price]}>{DIR_ARROW[v.price]}</span>
                      {v.divergence && <span className="ml-1 rounded bg-amber-50 px-1 text-amber-700">食い違い</span>}
                    </td>
                  </>
                ) : (
                  <td colSpan={3} className="py-1 text-right text-gray-400">
                    {source ? '取得できませんでした' : 'データなし（対応する先物なし）'}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="mt-1.5 text-[10px] leading-relaxed text-gray-400">
        CME 先物（6J/6E/6B/6A・金はGC=F）の出来高。RVOL＝最新確定足÷直近20本平均、増減＝直近5本平均÷20本平均、
        OBV/価格＝直近10本の向き（食い違い＝動きの裏付けが弱い・転換の兆し）。
      </p>
    </div>
  );
};

export default VolumeIndicators;
