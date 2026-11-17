// システムエラーの通知（ヘッダーの ⚠ アイコン → モーダル）。Worker と画面の両方で使う純関数と型。
// Worker 側で外部サービスの失敗（Jev AI の課金・キー・使用上限・障害、データ取得の失敗など）を記録し、
// /system-status で返す。画面はそれを一覧で表示し、未読があればアイコンに赤い印を付ける。
//   - 記録は KV への書き込み回数を抑えるため、同じ種類は THROTTLE_MS に1回だけ更新する
//   - 成功したら、その種類の記録を消す（解消）。古い記録（MAX_AGE_MS 超）は表示しない

export type IssueKind =
  | 'jev_billing' // Jev のクレジット不足（課金が必要）
  | 'jev_auth' // Jev の API キーが無効
  | 'jev_limit' // Jev の使用上限（短時間に呼びすぎ）
  | 'jev_down' // Jev が応答しない・エラーを返す
  | 'jev_key_missing' // Jev の API キーが未設定
  | 'turso_missing' // Turso（オーダーブックの記録）が未設定
  | 'data_fetch'; // 定期のデータ取得の失敗

export type IssueLevel = 'error' | 'warn' | 'info';

export interface SystemIssue {
  kind: IssueKind;
  level: IssueLevel;
  title: string;
  detail: string; // エラーの中身（短く）
  action?: string; // どうすれば直るか
  firstAt: number; // 初めて起きた時刻
  lastAt: number; // 最後に記録した時刻
}

export interface SystemStatusPayload {
  issues: SystemIssue[];
  checkedAt: number;
}

export const ISSUE_META: Record<IssueKind, { level: IssueLevel; title: string; action?: string }> = {
  jev_billing: {
    level: 'error',
    title: 'Jev AI の課金（クレジット）が必要です',
    action: 'typesafe.ai のダッシュボードでクレジットを追加するか、プランを確認してください。それまで AI の判定は Workers AI で代用し、ブレイク確率は表示されません。',
  },
  jev_auth: {
    level: 'error',
    title: 'Jev AI の API キーが使えません',
    action: 'typesafe.ai で API キーを確認し、worker/ で wrangler から TYPESAFE_API_KEY を登録し直してください。',
  },
  jev_limit: {
    level: 'warn',
    title: 'Jev AI の使用上限に達しました',
    action: 'しばらくすると自動で戻ります。続く場合は typesafe.ai のプランの上限を確認してください。',
  },
  jev_down: {
    level: 'warn',
    title: 'Jev AI が応答していません',
    action: '一時的な障害の可能性があります。その間は Workers AI で代用しています。',
  },
  jev_key_missing: {
    level: 'warn',
    title: 'Jev AI の API キーが未設定です',
    action: 'worker/ で wrangler から TYPESAFE_API_KEY を登録すると、Jev の判定とブレイク確率が使えます。',
  },
  turso_missing: {
    level: 'info',
    title: 'オーダーブックの記録（Turso）が未設定です',
    action: 'worker/README.md の手順で TURSO_DATABASE_URL と TURSO_AUTH_TOKEN を登録すると、ポジションの記録が始まります。',
  },
  data_fetch: {
    level: 'warn',
    title: 'データの定期取得に失敗しています',
    action: '前回のデータを表示しています。外部 API の制限や障害の可能性があり、多くは次の更新で戻ります。',
  },
};

export const JEV_KINDS: IssueKind[] = ['jev_billing', 'jev_auth', 'jev_limit', 'jev_down'];
export const THROTTLE_MS = 10 * 60 * 1000; // 同じ種類の記録を更新する最短の間隔
export const MAX_AGE_MS = 24 * 60 * 60 * 1000; // これより古い記録は表示しない

// Jev の失敗を種類に分ける。status=null は通信エラー。
export function classifyJevError(status: number | null, body = ''): IssueKind {
  if (status === 402 || /credit|balance|billing|payment|insufficient|top.?up|subscription|課金|残高/i.test(body)) return 'jev_billing';
  if (status === 401 || status === 403) return 'jev_auth';
  if (status === 429 || /rate.?limit|too many|quota|limit exceeded/i.test(body)) return 'jev_limit';
  return 'jev_down';
}

// 記録を追加・更新する。新しい種類か、前の記録から THROTTLE_MS 以上たったときだけ changed=true（保存する）。
export function upsertIssue(list: SystemIssue[], kind: IssueKind, detail: string, now: number): { list: SystemIssue[]; changed: boolean } {
  const prev = list.find((i) => i.kind === kind);
  if (prev && now - prev.lastAt < THROTTLE_MS) return { list, changed: false };
  const meta = ISSUE_META[kind];
  const next: SystemIssue = {
    kind,
    level: meta.level,
    title: meta.title,
    action: meta.action,
    detail: detail.slice(0, 200),
    firstAt: prev ? prev.firstAt : now,
    lastAt: now,
  };
  return { list: [...list.filter((i) => i.kind !== kind), next], changed: true };
}

// 解消した種類の記録を消す。
export function clearKinds(list: SystemIssue[], kinds: IssueKind[]): { list: SystemIssue[]; changed: boolean } {
  const next = list.filter((i) => !kinds.includes(i.kind));
  return { list: next, changed: next.length !== list.length };
}

const LEVEL_ORDER: Record<IssueLevel, number> = { error: 0, warn: 1, info: 2 };

// 表示用: 古い記録を除き、重い順・新しい順に並べる。
export function activeIssues(list: SystemIssue[], now: number): SystemIssue[] {
  return list
    .filter((i) => now - i.lastAt <= MAX_AGE_MS)
    .sort((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level] || b.lastAt - a.lastAt);
}

// アイコンの赤い印: 最後に開いた時刻（seenAt）より後に記録された error/warn の数。
export function unseenCount(issues: SystemIssue[], seenAt: number): number {
  return issues.filter((i) => i.level !== 'info' && i.lastAt > seenAt).length;
}
