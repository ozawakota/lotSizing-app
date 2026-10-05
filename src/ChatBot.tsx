// AIbot ページ。アプリの相場データ（通貨強弱・センチメント・ニュース・シグナル）に
// 連携したチャット。Worker(/chat, VITE_CHAT_URL) が Workers AI で日本語回答を返す。
// ※AIによる参考情報であり投資助言ではない。
import { FC, useEffect, useRef, useState } from 'react';
import { Send } from 'lucide-react';
import type { ChatMessage } from '@/lib/chat';

const CHAT_URL = import.meta.env.VITE_CHAT_URL as string | undefined;
const STORE_KEY = 'aibot-chat';

const QUICK_PROMPTS = [
  '今の通貨強弱を教えて',
  'ドル円の見通しは？',
  'いま注目すべきペアは？',
  '今日のニュースを要約して',
];

const loadStored = (): ChatMessage[] => {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    return raw ? (JSON.parse(raw) as ChatMessage[]) : [];
  } catch {
    return [];
  }
};

const ChatBot: FC = () => {
  const [messages, setMessages] = useState<ChatMessage[]>(loadStored);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    localStorage.setItem(STORE_KEY, JSON.stringify(messages.slice(-30)));
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, loading]);

  const send = async (text: string) => {
    const content = text.trim();
    if (!content || loading || !CHAT_URL) return;
    setError('');
    const next: ChatMessage[] = [...messages, { role: 'user', content }];
    setMessages(next);
    setInput('');
    setLoading(true);
    try {
      const res = await fetch(CHAT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: next.slice(-8) }),
      });
      const data = (await res.json()) as { reply?: string; error?: string };
      if (data.error) throw new Error(data.error);
      setMessages((m) => [...m, { role: 'assistant', content: data.reply ?? '（応答が空でした）' }]);
    } catch (e) {
      setError(e instanceof Error ? e.message : '取得に失敗しました');
    } finally {
      setLoading(false);
    }
  };

  const clear = () => {
    setMessages([]);
    setError('');
    localStorage.removeItem(STORE_KEY);
  };

  if (!CHAT_URL) {
    return (
      <div className="mx-3 my-3 rounded border border-amber-200 bg-amber-50 p-3 text-sm text-amber-700">
        AIbot は未設定です。<code>VITE_CHAT_URL</code> を設定すると使えます。
      </div>
    );
  }

  return (
    <div className="mx-auto flex max-w-md flex-col px-3 pb-4" style={{ minHeight: '60vh' }}>
      <div className="mt-2 flex items-center justify-between">
        <p className="text-xs text-gray-500">アプリの相場データに基づいて回答します</p>
        {messages.length > 0 && (
          <button type="button" onClick={clear} className="text-[11px] text-gray-400 hover:text-gray-600">
            会話をクリア
          </button>
        )}
      </div>

      {/* メッセージ一覧 */}
      <div className="mt-2 flex-1 space-y-2">
        {messages.length === 0 && (
          <div className="rounded-lg bg-gray-50 p-3 text-xs text-gray-500">
            通貨強弱・取引量・ニュース・売買シグナルを踏まえて答えます。下のボタンか入力から質問してください。
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div
              className={`max-w-[85%] whitespace-pre-wrap rounded-2xl px-3 py-2 text-sm ${
                m.role === 'user' ? 'bg-orange-500 text-white' : 'bg-gray-100 text-gray-800'
              }`}
            >
              {m.content}
            </div>
          </div>
        ))}
        {loading && (
          <div className="flex justify-start">
            <div className="rounded-2xl bg-gray-100 px-3 py-2 text-sm text-gray-400">考え中…</div>
          </div>
        )}
        <div ref={endRef} />
      </div>

      {error && <p className="mt-2 text-center text-xs text-red-600">{error}</p>}

      {/* クイック質問 */}
      {messages.length === 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {QUICK_PROMPTS.map((q) => (
            <button
              key={q}
              type="button"
              onClick={() => send(q)}
              className="rounded-full border border-gray-300 px-2 py-1 text-[11px] text-gray-600"
            >
              {q}
            </button>
          ))}
        </div>
      )}

      {/* 入力 */}
      <form
        className="mt-2 flex items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          send(input);
        }}
      >
        <textarea
          className="flex-1 resize-none rounded border border-gray-300 px-2 py-2 text-sm"
          rows={1}
          placeholder="質問を入力…"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              send(input);
            }
          }}
        />
        <button
          type="submit"
          disabled={loading || !input.trim()}
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-orange-500 text-white disabled:opacity-50"
          aria-label="送信"
        >
          <Send className="h-4 w-4" />
        </button>
      </form>

      <p className="mt-2 text-center text-[10px] text-gray-400">
        ※AIによる参考情報です。投資助言ではありません。
      </p>
    </div>
  );
};

export default ChatBot;
