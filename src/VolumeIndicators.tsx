// 4時間足の出来高インジケーター（全ペア一覧）。取引量ページの先頭に表示する。
// FX スポットには取引所の出来高が無いため CME 先物（6J/6E/6B/6A・金は GC=F）の出来高を使う。
// クロス円は単独の先物が無く「データなし」。Worker(/volume) が 30分キャッシュで返す。計算は src/lib/volume.ts。
import { FC, Fragment, useCallback, useEffect, useState } from 'react';
import { RVOL_LABEL, VOLUME_TREND_LABEL, type Dir3, type VolumeProfile, type VolumeSnapshot } from '@/lib/volume';
import { pipSize } from '@/lib/stoploss';

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

const digitsFor = (instrument: string) => (instrument.startsWith('XAU') ? 2 : instrument.endsWith('JPY') ? 3 : 5);

// 価格帯別出来高（出来高由来のレジサポ）の1行。現在値より上=レジ（赤）/ 下=サポ（緑）、距離は pips。
const ProfileLine: FC<{ instrument: string; profile: VolumeProfile; spot: number | null | undefined }> = ({ instrument, profile, spot }) => {
  const d = digitsFor(instrument);
  const pip = pipSize(instrument);
  const lvl = (label: string, price: number) => {
    const dist = spot != null ? (price - spot) / pip : null;
    const cls = dist == null ? 'text-gray-600' : dist >= 0 ? 'text-red-600' : 'text-green-600';
    return (
      <span key={`${label}-${price}`} className="whitespace-nowrap">
        <span className="text-gray-400">{label}</span>{' '}
        <span className={`font-semibold ${cls}`}>{price.toFixed(d)}</span>
        {dist != null && <span className="text-gray-400">({dist >= 0 ? '+' : '−'}{Math.abs(dist).toFixed(0)})</span>}
      </span>
    );
  };
  return (
    <div className="flex flex-wrap gap-x-2 gap-y-0.5 text-[10px]">
      {lvl('POC', profile.poc)}
      {lvl('VA上', profile.vah)}
      {lvl('VA下', profile.val)}
      {profile.hvns.map((h) => lvl('山', h))}
    </div>
  );
};

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
            {data.pairs.map(({ instrument, source, indicators: v, profile, spotRate }) => (
              <Fragment key={instrument}>
              <tr className={profile ? '' : 'border-b border-gray-50 last:border-0'}>
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
              {profile && (
                <tr className="border-b border-gray-50 last:border-0">
                  <td colSpan={4} className="pb-1.5">
                    <ProfileLine instrument={instrument} profile={profile} spot={spotRate} />
                  </td>
                </tr>
              )}
              </Fragment>
            ))}
          </tbody>
        </table>
      )}
      <p className="mt-1.5 text-[10px] leading-relaxed text-gray-400">
        CME 先物（6J/6E/6B/6A・金はGC=F）の出来高。RVOL＝最新確定足÷直近20本平均、増減＝直近5本平均÷20本平均、
        OBV/価格＝直近10本の向き（食い違い＝動きの裏付けが弱い・転換の兆し）。
        2行目は1か月分の1時間足の価格帯別出来高から求めたレジサポ（POC＝最多価格・VA＝出来高70%の範囲・山＝出来高の山。
        赤＝現在値より上、緑＝下、括弧内は現在値からのpips）。
      </p>
    </div>
  );
};

export default VolumeIndicators;
