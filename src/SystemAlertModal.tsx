// SystemAlertModal.tsx
// 「システムの通知」モーダル。Worker の /system-status から、外部サービスの失敗（Jev AI の課金・キー・使用上限・障害、
// データの定期取得の失敗）と設定の不足（API キー・Turso 未設定）を受け取り、重い順に表示する。
// ヘッダーの ⚠ ボタン（SystemAlertButton）は 5 分ごとに確認し、前に開いたあとに起きたエラーがあれば赤い数字を付ける。
// ProverbModal と同じ mobiscroll Popup を踏襲。
import { FC, useCallback, useEffect, useState } from 'react';
import { Popup } from '@mobiscroll/react';
import { CircleAlert, CircleCheck, Info, TriangleAlert } from 'lucide-react';
import { unseenCount, type IssueLevel, type SystemIssue, type SystemStatusPayload } from '@/lib/systemStatus';

const MTF_URL = import.meta.env.VITE_MTF_URL as string | undefined;
// 同じ Worker の /system-status（/mtf と同じベース URL）
const STATUS_URL = MTF_URL ? MTF_URL.replace(/\/mtf$/, '/system-status') : undefined;
const SEEN_KEY = 'systemAlertsSeenAt';
const POLL_MS = 5 * 60 * 1000;

const readSeen = (): number => {
  try {
    return Number(localStorage.getItem(SEEN_KEY)) || 0;
  } catch {
    return 0;
  }
};
const writeSeen = (t: number) => {
  try {
    localStorage.setItem(SEEN_KEY, String(t));
  } catch {
    // 保存できなくても表示はできる
  }
};

export interface SystemStatusState {
  data: SystemStatusPayload | null;
  error: string | null; // Worker に届かないときの文言
  loading: boolean;
  unseen: number;
  refresh: () => void;
  markSeen: () => void;
}

// 状態はヘッダーのボタンとモーダルで共有する（App で1回だけ呼ぶ）。
export function useSystemStatus(): SystemStatusState {
  const [data, setData] = useState<SystemStatusPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [errorAt, setErrorAt] = useState(0); // 接続できなくなった時刻
  const [loading, setLoading] = useState(false);
  const [seenAt, setSeenAt] = useState<number>(readSeen);

  const refresh = useCallback(async () => {
    if (!STATUS_URL) return;
    setLoading(true);
    try {
      const res = await fetch(STATUS_URL, { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setData((await res.json()) as SystemStatusPayload);
      setError(null);
      setErrorAt(0);
    } catch (e) {
      setErrorAt((t) => t || Date.now());
      setError(`サーバー（Worker）に接続できません（${e instanceof Error ? e.message : String(e)}）`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const id = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(id);
  }, [refresh]);

  const markSeen = useCallback(() => {
    const t = Date.now();
    writeSeen(t);
    setSeenAt(t);
  }, []);

  // 接続できないときも、前に開いたあとに起きたなら 1 件として数える
  const unseen = (data ? unseenCount(data.issues, seenAt) : 0) + (error && errorAt > seenAt ? 1 : 0);
  return { data, error, loading, unseen, refresh: () => void refresh(), markSeen };
}

// ヘッダーのボタン: 問題なし=灰色、未読のエラーあり=赤＋数字、既読だが続いている=赤の枠だけ
export const SystemAlertButton: FC<{ status: SystemStatusState; onClick: () => void }> = ({ status, onClick }) => {
  const ongoing = (status.data?.issues.some((i) => i.level !== 'info') ?? false) || !!status.error;
  const tone = status.unseen > 0 || ongoing ? 'text-red-500 border-red-500' : 'text-gray-400 border-gray-300';
  return (
    <button
      type="button"
      aria-label={status.unseen > 0 ? `システムの通知（未読 ${status.unseen} 件）` : 'システムの通知'}
      className={`relative rounded-full h-8 w-8 flex items-center justify-center border ${tone}`}
      onClick={onClick}
    >
      <TriangleAlert className="h-4 w-4" aria-hidden="true" />
      {status.unseen > 0 && (
        <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[9px] font-bold leading-none text-white">
          {status.unseen}
        </span>
      )}
    </button>
  );
};

const LEVEL_STYLE: Record<IssueLevel, { box: string; icon: typeof Info; iconCls: string; label: string }> = {
  error: { box: 'border-red-200 bg-red-50', icon: CircleAlert, iconCls: 'text-red-500', label: '要対応' },
  warn: { box: 'border-amber-200 bg-amber-50', icon: TriangleAlert, iconCls: 'text-amber-500', label: '注意' },
  info: { box: 'border-sky-200 bg-sky-50', icon: Info, iconCls: 'text-sky-500', label: 'お知らせ' },
};

const fmtTime = (t: number) =>
  new Date(t).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });

const IssueItem: FC<{ issue: SystemIssue }> = ({ issue }) => {
  const st = LEVEL_STYLE[issue.level];
  const Icon = st.icon;
  return (
    <li className={`rounded-lg border px-3 py-2 ${st.box}`} style={{ listStyle: 'none' }}>
      <div className="flex items-start gap-2">
        <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${st.iconCls}`} aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-bold text-gray-800">
            <span className={`mr-1 text-[10px] font-semibold ${st.iconCls}`}>{st.label}</span>
            {issue.title}
          </p>
          {issue.action && <p className="mt-0.5 text-xs leading-relaxed text-gray-700">{issue.action}</p>}
          <p className="mt-1 break-all text-[10px] text-gray-400">
            {issue.lastAt > 0
              ? `${fmtTime(issue.lastAt)} に発生${issue.firstAt < issue.lastAt ? `（${fmtTime(issue.firstAt)} から続いています）` : ''}`
              : '設定の確認'}
            ・{issue.detail}
          </p>
        </div>
      </div>
    </li>
  );
};

interface SystemAlertModalProps {
  isOpen: boolean;
  onClose: () => void;
  status: SystemStatusState;
}

const SystemAlertModal: FC<SystemAlertModalProps> = ({ isOpen, onClose, status }) => {
  const { data, error, loading, refresh, markSeen } = status;
  // 開いたら最新を取り直し、既読にする
  useEffect(() => {
    if (!isOpen) return;
    refresh();
    markSeen();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  const issues = data?.issues ?? [];
  const problems = issues.filter((i) => i.level !== 'info');

  return (
    <Popup
      isOpen={isOpen}
      onClose={onClose}
      maxHeight="80vh"
      buttons={[
        { text: '再確認', handler: () => refresh() },
        { text: '閉じる', handler: onClose },
      ]}
    >
      <div className="p-4">
        <p className="mb-3 text-xs font-semibold text-red-500">システムの通知</p>
        {!STATUS_URL ? (
          <p className="text-sm text-gray-500">
            通知の取得先が未設定です（<code>VITE_MTF_URL</code>）。
          </p>
        ) : (
          <>
            {!error && !problems.length && (
              <div className="mb-3 flex items-center gap-2 rounded-lg bg-green-50 px-3 py-3 text-sm font-semibold text-green-700">
                <CircleCheck className="h-5 w-5" aria-hidden="true" />
                {data ? 'エラーはありません' : loading ? '確認中…' : 'まだ確認していません'}
              </div>
            )}
            <ul className="space-y-2" style={{ paddingLeft: 0, margin: 0 }}>
              {error && (
                <IssueItem
                  issue={{
                    kind: 'data_fetch',
                    level: 'error',
                    title: 'サーバーに接続できません',
                    action: '通信環境を確認してください。続く場合は Worker の障害かデプロイの失敗の可能性があります。',
                    detail: error,
                    firstAt: 0,
                    lastAt: 0,
                  }}
                />
              )}
              {issues.map((i) => (
                <IssueItem key={i.kind} issue={i} />
              ))}
            </ul>
            <p className="mt-3 text-[10px] text-gray-400">
              {data ? `最終確認 ${fmtTime(data.checkedAt)}・` : ''}5分ごとに自動で確認します。解消したエラーは自動で消えます（最長24時間表示）。
            </p>
          </>
        )}
      </div>
    </Popup>
  );
};

export default SystemAlertModal;
