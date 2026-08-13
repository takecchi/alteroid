import { Plus, Send, Square } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router';

import { Badge, Button, Card, Empty, ErrorNote, Spinner, Textarea } from '~/components/ui';
import { useEndConversation } from '~/hooks/mutations';
import { useConversation, useConversations } from '~/hooks/queries';
import { useApi } from '~/lib/api';
import { cn } from '~/lib/cn';
import { formatRelative } from '~/lib/format';

import type { Route } from './+types/chat';

export function clientLoader({ params }: Route.ClientLoaderArgs) {
  return { conversationId: params.conversationId };
}

/** 画面に出す1行。届いた順に並べる。 */
interface Line {
  key: string;
  role: 'human' | 'clone' | 'system';
  text: string;
  /** 進行中の合図（考え中・ツール実行中）。落ち着いたら消す。 */
  transient?: boolean;
}

export default function Chat({ loaderData }: Route.ComponentProps) {
  const { conversationId } = loaderData;

  return (
    <div className="flex h-dvh">
      <ConversationList activeId={conversationId} />
      {/* key を付けて、会話を切り替えたら状態を捨てる（前の会話の続きが混ざらない）。 */}
      <ChatPane key={conversationId ?? 'new'} conversationId={conversationId} />
    </div>
  );
}

function ConversationList({ activeId }: { activeId: string | undefined }) {
  const { data, error, isLoading } = useConversations(30);

  return (
    <aside className="flex w-64 shrink-0 flex-col border-r border-border bg-surface">
      <div className="flex items-center justify-between border-b border-border px-3 py-3">
        <span className="text-sm font-semibold">会話</span>
        <Link to="/chat">
          <Button size="sm" variant="ghost" aria-label="新しい会話">
            <Plus className="size-4" aria-hidden />
          </Button>
        </Link>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <ErrorNote error={error} className="m-3" />
        {isLoading ? (
          <Spinner />
        ) : data === undefined || data.conversations.length === 0 ? (
          <Empty>まだ会話がない。</Empty>
        ) : (
          <ul>
            {data.conversations.map((conversation) => (
              <li key={conversation.conversationId}>
                <Link
                  to={`/chat/${conversation.conversationId}`}
                  className={cn(
                    'block border-b border-border px-3 py-2 hover:bg-surface-2',
                    conversation.conversationId === activeId && 'bg-surface-2',
                  )}
                >
                  <p className="truncate text-xs">{conversation.preview}</p>
                  <p className="mt-0.5 text-[11px] text-muted">
                    {formatRelative(conversation.updatedAt)} · {conversation.messages} 往復
                  </p>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/*
        `scanned` は「日誌をどこまで遡ったか」。全部を見たとは限らないので、
        黙って切らずに出す（掘れば降りられる、が要件）。
      */}
      {data !== undefined && (
        <p className="border-t border-border px-3 py-2 text-[11px] text-muted">
          日誌 {data.scanned} 件を走査
        </p>
      )}
    </aside>
  );
}

function ChatPane({ conversationId }: { conversationId: string | undefined }) {
  const api = useApi();
  const navigate = useNavigate();
  const endConversation = useEndConversation();
  const history = useConversation(conversationId ?? null);

  const [lines, setLines] = useState<Line[]>([]);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState<unknown>(undefined);
  const abortRef = useRef<AbortController | undefined>(undefined);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  // 履歴（日誌から再構成されたもの）＋この画面で流れてきた分。
  const historyLines = useMemo<Line[]>(
    () =>
      (history.data?.messages ?? []).map((message) => ({
        key: message.id,
        role: message.role === 'inbound' ? 'human' : 'clone',
        text: message.text,
      })),
    [history.data],
  );

  const all = useMemo(() => [...historyLines, ...lines], [historyLines, lines]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [all.length, lines]);

  // 画面を離れたら読むのをやめる（クローンのターンは止まらない。購読を外すだけ）。
  useEffect(() => () => abortRef.current?.abort(), []);

  const send = useCallback(
    async (text: string) => {
      if (text.trim() === '' || sending) return;

      const controller = new AbortController();
      abortRef.current = controller;
      setSending(true);
      setFailure(undefined);
      setDraft('');
      setLines((previous) => [
        ...previous,
        { key: `h-${previous.length}-${text.slice(0, 8)}`, role: 'human', text },
      ]);

      // クローンの応答は細切れで届く。1行に継ぎ足していく。
      let replyKey: string | undefined;
      const append = (chunk: string) => {
        setLines((previous) => {
          const index = previous.findIndex((line) => line.key === replyKey);
          if (index === -1) return previous;
          const next = [...previous];
          const current = next[index];
          if (current === undefined) return previous;
          next[index] = { ...current, text: current.text + chunk, transient: false };
          return next;
        });
      };

      const setTransient = (text: string) => {
        setLines((previous) => {
          const withoutTransient = previous.filter((line) => line.transient !== true);
          return [
            ...withoutTransient,
            { key: `t-${Date.now()}`, role: 'system', text, transient: true },
          ];
        });
      };

      try {
        for await (const message of api.chat(
          { text, ...(conversationId === undefined ? {} : { conversationId }) },
          { signal: controller.signal },
        )) {
          if (message.event === 'open') {
            // 新しい会話なら、以降の往復が同じ id に乗るよう URL を差し替える。
            if (conversationId === undefined) {
              void navigate(`/chat/${message.data.conversationId}`, { replace: true });
            }
            continue;
          }

          const event = message.data;
          switch (event.type) {
            case 'thinking':
              setTransient('考えている…');
              break;
            case 'tool':
              setTransient(`${event.tool} を実行中…`);
              break;
            case 'text':
              if (replyKey === undefined) {
                replyKey = `c-${Date.now()}`;
                const key = replyKey;
                setLines((previous) => [
                  ...previous.filter((line) => line.transient !== true),
                  { key, role: 'clone', text: '' },
                ]);
              }
              append(event.text);
              break;
            case 'ask_human':
              setLines((previous) => [
                ...previous.filter((line) => line.transient !== true),
                {
                  key: `a-${event.approvalId}`,
                  role: 'system',
                  text: `確認したいことがある: ${event.question}\n（承認待ちの画面から答えられる）`,
                },
              ]);
              break;
            case 'error':
              setFailure(new Error(event.message));
              break;
            case 'done':
              setLines((previous) => previous.filter((line) => line.transient !== true));
              break;
          }
        }
      } catch (caught) {
        if (!controller.signal.aborted) setFailure(caught);
      } finally {
        setLines((previous) => previous.filter((line) => line.transient !== true));
        setSending(false);
        abortRef.current = undefined;
      }
    },
    [api, conversationId, navigate, sending],
  );

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <header className="flex shrink-0 items-center justify-between gap-4 border-b border-border px-6 py-4">
        <div className="min-w-0">
          <h1 className="text-base font-semibold">クローンと話す</h1>
          <p className="mt-0.5 truncate font-mono text-[11px] text-muted">
            {conversationId ?? '新しい会話'}
          </p>
        </div>
        {conversationId !== undefined && (
          <Button
            size="sm"
            onClick={() => {
              void endConversation(conversationId).then(() => navigate('/chat'));
            }}
            title="クローンがここまでの学びを記憶へ蒸留する"
          >
            会話を終える
          </Button>
        )}
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
        {history.isLoading && conversationId !== undefined ? (
          <Spinner label="履歴を読み込み中" />
        ) : all.length === 0 ? (
          <Card>
            <Empty>目的や価値観を伝えると、クローンはそれを記憶に蒸留して次の判断に使う。</Empty>
          </Card>
        ) : (
          <ul className="flex flex-col gap-3">
            {all.map((line) => (
              <li
                key={line.key}
                className={cn('flex', line.role === 'human' ? 'justify-end' : 'justify-start')}
              >
                <div
                  className={cn(
                    'max-w-[46rem] rounded-lg px-3 py-2 text-sm leading-relaxed whitespace-pre-wrap',
                    line.role === 'human' && 'bg-accent text-accent-fg',
                    line.role === 'clone' && 'bg-surface',
                    line.role === 'system' && 'bg-transparent text-muted italic',
                  )}
                >
                  {line.role === 'clone' && line.text === '' ? (
                    <span className="text-muted">…</span>
                  ) : (
                    line.text
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
        <div ref={bottomRef} />
      </div>

      <div className="shrink-0 border-t border-border px-6 py-3">
        <ErrorNote error={failure} className="mb-2" />
        <div className="flex items-end gap-2">
          <Textarea
            rows={2}
            value={draft}
            disabled={sending}
            placeholder="クローンに話しかける（⌘/Ctrl + Enter で送信）"
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                event.preventDefault();
                void send(draft);
              }
            }}
          />
          {sending ? (
            <Button
              variant="default"
              onClick={() => abortRef.current?.abort()}
              title="読むのをやめる。クローンのターンは止まらない"
            >
              <Square className="size-3.5" aria-hidden />
              受信をやめる
            </Button>
          ) : (
            <Button
              variant="primary"
              disabled={draft.trim() === ''}
              onClick={() => void send(draft)}
            >
              <Send className="size-3.5" aria-hidden />
              送る
            </Button>
          )}
        </div>
        {sending && (
          <p className="mt-1.5 text-[11px] text-muted">
            <Badge tone="accent">受信中</Badge> 画面を閉じてもクローンは考え続ける
          </p>
        )}
      </div>
    </div>
  );
}
