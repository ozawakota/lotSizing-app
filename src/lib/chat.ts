// AIbot（アプリデータ連携チャット）の純粋ロジック。Worker とクライアントで共有。
// 現在の相場データ（通貨強弱・取引量センチメント・ニュース要約・売買シグナル）を
// コンパクトな日本語コンテキスト文字列にまとめ、チャットのシステムプロンプトに差し込む。

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface MarketContextInput {
  strength?: { currency: string; score: number }[]; // 強い順
  flow?: { pair: string; lean: string; longPct: number }[];
  newsSummary?: string;
  signals?: { pair: string; buyPct: number; trend: string; confidence?: number; trendPct?: number }[];
}

const TREND_JP: Record<string, string> = {
  continuation: '継続',
  reversal: '反転',
  neutral: '中立',
};
const LEAN_JP: Record<string, string> = { buy: '買い優勢', sell: '売り優勢', neutral: '中立' };

/** 現在の相場データを、チャットに渡すコンパクトな日本語コンテキストにまとめる。 */
export function buildMarketContext(d: MarketContextInput): string {
  const parts: string[] = [];

  if (d.strength && d.strength.length > 0) {
    const line = d.strength
      .map((s) => `${s.currency}${s.score >= 0 ? '+' : ''}${s.score.toFixed(2)}`)
      .join(' / ');
    parts.push(`【通貨強弱】強い順: ${line}`);
  }

  if (d.flow && d.flow.length > 0) {
    const line = d.flow
      .map((f) => `${f.pair}:${LEAN_JP[f.lean] ?? f.lean}(買${Math.round(f.longPct)}%)`)
      .join(' / ');
    parts.push(`【取引量センチメント】${line}`);
  }

  if (d.signals && d.signals.length > 0) {
    const line = d.signals
      .map((s) => {
        const conf = typeof s.confidence === 'number' ? `(確信${s.confidence.toFixed(1)})` : '';
        const tp = typeof s.trendPct === 'number' ? `${s.trendPct}%` : '';
        return `${s.pair}:買${s.buyPct}%${conf}/${TREND_JP[s.trend] ?? s.trend}${tp}`;
      })
      .join(' / ');
    parts.push(`【売買シグナル】${line}`);
  }

  if (d.newsSummary && d.newsSummary.trim()) {
    parts.push(`【ニュース要約】${d.newsSummary.trim()}`);
  }

  return parts.length > 0 ? parts.join('\n') : '（現在データは取得できていません）';
}

/** システムプロンプト（相場観の前提＋回答方針）。jevMode=true で Jev 判定を根拠に縛る。 */
export function buildChatSystemPrompt(context: string, jevMode = false): string {
  const lines = [
    'あなたはこのFXアプリのアシスタントです。以下の「現在の相場データ」に基づき、日本語で簡潔に回答してください。',
    'データで答えられないことは一般論であると明示し、断定や投資助言は避けてください（最終判断はユーザー）。',
  ];
  if (jevMode) {
    lines.push(
      '「売買シグナル」は Jev（構造化意思決定AI）の判定です。売買の方向とトレンドの継続/反転は、この数値（確率・確信度）を根拠にし、推測で覆さないでください。回答末尾に「Jevの判定に基づく」と添えてください。',
    );
  }
  lines.push('', '# 現在の相場データ', context);
  return lines.join('\n');
}

/** クライアント履歴を検証・整形（role/内容の健全化、直近 maxHistory 件に制限）。 */
export function sanitizeHistory(messages: unknown, maxHistory = 8): ChatMessage[] {
  if (!Array.isArray(messages)) return [];
  const out: ChatMessage[] = [];
  for (const m of messages) {
    const role = (m as { role?: unknown })?.role;
    const content = (m as { content?: unknown })?.content;
    if ((role === 'user' || role === 'assistant') && typeof content === 'string' && content.trim()) {
      out.push({ role, content: content.trim().slice(0, 2000) });
    }
  }
  return out.slice(-maxHistory);
}
