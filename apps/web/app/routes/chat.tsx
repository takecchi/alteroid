import { PanelLeft, Plus, Send, Square } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router';

import { Drawer } from '~/components/drawer';
import { Badge, Button, Card, Empty, ErrorNote, Spinner, Textarea } from '~/components/ui';
import { useEndConversation, useRecordOwnMessage } from '~/hooks/mutations';
import { useConversation, useConversations } from '~/hooks/queries';
import { useIsMobile } from '~/hooks/use-is-mobile';
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

  /*
   * 狭い画面では会話一覧も畳む。**shell の nav と2枚重なると本文が残らない** —
   * 幅 375px で nav 208px ＋ 会話一覧 256px なので、そのままでは足りない。
   */
  const isMobile = useIsMobile();
  const [listOpen, setListOpen] = useState(false);
  const closeList = () => setListOpen(false);

  return (
    /*
     * **`h-dvh` ではなく `h-full`。** 高さの出どころは shell（`AuthedShell`）の
     * `h-dvh` 1つにまとめてある。ここでも viewport を取ると、狭い画面で上端に
     * 出す帯のぶんだけ画面からはみ出す（帯は shell が持っていて、この部品からは
     * 見えない）。
     */
    <div className="flex h-full">
      {isMobile ? (
        <Drawer open={listOpen} onClose={closeList} label="会話一覧">
          <ConversationList activeId={conversationId} onNavigate={closeList} />
        </Drawer>
      ) : (
        <ConversationList activeId={conversationId} />
      )}
      {/*
        **`key` を付けてはいけない。** 新しい会話は受信の途中（`open`）で id が決まり、
        URL をそこへ揃える。`key={conversationId}` にすると、その同期で作り直しが起きて
        受信中のストリームが中断され、続く text / done が画面に出ない。
        会話の切り替えは ChatPane が自分で見分ける。
      */}
      <ChatPane
        routeId={conversationId}
        onOpenList={isMobile ? () => setListOpen(true) : undefined}
      />
    </div>
  );
}

/**
 * 会話の一覧。
 *
 * **広い画面では脇に、狭い画面ではドロワーの中に、同じものを置く**（`shell.tsx`
 * の `Nav` と同じ形）。別々に書くと、一覧に何か足したときに片方だけ増える。
 */
function ConversationList({
  activeId,
  onNavigate,
}: {
  activeId: string | undefined;
  /**
   * 行き先を押したとき。ドロワーの中では閉じる。
   *
   * **`useEffect` で URL の変化を見る形にしていない。** いま開いている会話を
   * もう一度押すと URL が変わらず、覆ったまま残る。
   */
  onNavigate?: (() => void) | undefined;
}) {
  const { data, error, isLoading } = useConversations(30);

  return (
    <aside
      className={cn(
        'flex flex-col bg-surface',
        // ドロワーの中では枠と幅は Drawer 側が持っている。
        onNavigate === undefined ? 'w-64 shrink-0 border-r border-border' : 'min-h-0 flex-1',
      )}
    >
      <div className="flex items-center justify-between border-b border-border px-3 py-3">
        <span className="text-sm font-semibold">会話</span>
        <Link to="/chat" onClick={onNavigate}>
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
          <ul aria-label="会話">
            {data.conversations.map((conversation) => (
              <li key={conversation.conversationId}>
                <Link
                  to={`/chat/${conversation.conversationId}`}
                  onClick={onNavigate}
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

/** 会話1つ分の画面。**作り直しに弱いので**、回帰テストから直接組み立てられるようにしてある。 */
export function ChatPane({
  routeId,
  onOpenList,
}: {
  routeId: string | undefined;
  /** 会話一覧を開く口。狭い画面でドロワーに畳んだときだけ渡ってくる。 */
  onOpenList?: (() => void) | undefined;
}) {
  const api = useApi();
  const navigate = useNavigate();
  const endConversation = useEndConversation();
  const recordOwnMessage = useRecordOwnMessage();

  /**
   * この画面が見せている会話。
   *
   * 新しい会話の id は受信の途中（`open`）で決まるので、**URL より先にここが決まる**。
   * URL は後から追いつく。逆にすると、追いついた瞬間が「別の会話に変わった」と
   * 区別できなくなる。
   */
  const [shownId, setShownId] = useState(routeId);
  /** この画面で始めた会話か。始めたなら手元の `lines` が全文なので履歴を読まない。 */
  const [startedHere, setStartedHere] = useState(false);
  const [lines, setLines] = useState<Line[]>([]);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState<unknown>(undefined);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  /** 走っているストリームと、それが**どの会話のものか**。 */
  const streamRef = useRef<{ controller: AbortController; id: string | undefined } | undefined>(
    undefined,
  );
  /**
   * いま見えている会話を、受信の途中からも読めるようにしたもの。
   *
   * ストリームの後片付けは「**この結果を今の画面へ書いてよいか**」で決まるが、
   * 判断する時点は非同期の奥なので、閉じ込めた `shownId` は古くなっている。
   */
  const shownIdRef = useRef(shownId);

  /**
   * 人間が別の会話を選んだときだけ状態を捨てる。
   *
   * **見るのは「URL が変わったか」であって「shownId と一致するか」ではない。**
   * `open` で id を決めてから URL が追いつくまでのあいだ、shownId は URL より
   * 先へ進んでいる。そこで一致だけを見ると、その隙間を「別の会話へ移った」と
   * 誤って読み、送ったばかりの発言ごと消してしまう。
   *
   * （React の「props が変わったら state を調整する」パターン。effect でやると
   * 一度古い内容を描いてから消すことになる。）
   */
  const [lastRouteId, setLastRouteId] = useState(routeId);
  if (routeId !== lastRouteId) {
    setLastRouteId(routeId);
    // URL が自分の採番に追いついただけなら、捨てるものは何も無い。
    if (routeId !== shownId) {
      setShownId(routeId);
      setStartedHere(false);
      setLines([]);
      setFailure(undefined);
    }
  }

  // この画面で始めた会話なら、日誌から再構成した履歴を重ねない（二重に出る）。
  const history = useConversation(startedHere ? null : (shownId ?? null));

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

  /**
   * 別の会話へ移ったら、**前の会話の**ストリームだけを止める。
   *
   * `open` で自分が採番した id へ同期したときは、ストリームの所属も同時に
   * その id へ移してあるので、ここは何もしない（止めると、続く text / done が
   * 画面に出ないまま会話が終わったように見える）。
   */
  useEffect(() => {
    shownIdRef.current = shownId;
    const stream = streamRef.current;
    if (stream !== undefined && stream.id !== shownId) stream.controller.abort();
  }, [shownId]);

  // 画面を離れたら読むのをやめる（クローンのターンは止まらない。購読を外すだけ）。
  useEffect(() => () => streamRef.current?.controller.abort(), []);

  const send = useCallback(
    async (text: string) => {
      if (text.trim() === '' || sending) return;

      const controller = new AbortController();
      // このストリームが属する会話。`open` で確定したらここも移す。
      const stream = { controller, id: shownId };
      streamRef.current = stream;
      setSending(true);
      setFailure(undefined);
      setDraft('');
      setLines((previous) => [
        ...previous,
        { key: `h-${previous.length}-${text.slice(0, 8)}`, role: 'human', text },
      ]);

      /**
       * このストリームの結果を、いま見えている画面へ書いてよいか。
       *
       * **「止まったか」と混ぜてはいけない。** 混ぜると、人間が受信をやめたときに
       * 進行中の合図（考えている… / 実行中…）を片付ける処理まで飛ばしてしまい、
       * 入力欄は戻るのに本文にだけ合図が residue として残り続ける。
       *
       * - `owns()` — まだこの会話を見ている（別の会話へ移っていない）
       * - `stopped()` — 人間が受信をやめた
       */
      const owns = () => stream.id === shownIdRef.current;
      const stopped = () => controller.signal.aborted;
      /** 新しい中身を足してよいのは、見ていて、かつ止めていないときだけ。 */
      const writable = () => owns() && !stopped();

      // クローンの応答は細切れで届く。1行に継ぎ足していく。
      let replyKey: string | undefined;
      const append = (chunk: string) => {
        if (!writable()) return;
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
        if (!writable()) return;
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
          { text, ...(shownId === undefined ? {} : { conversationId: shownId }) },
          { signal: controller.signal },
        )) {
          if (message.event === 'open') {
            if (stream.id === undefined) {
              // **順番が大事。** 先にストリームの所属を新しい id へ移してから
              // state を動かす。逆にすると、上の effect がこのストリームを
              // 「前の会話のもの」と見なして止めてしまう。
              stream.id = message.data.conversationId;
              // ref も同時に進める。effect が回るのは描き直しの後なので、
              // それを待つと、その隙間に届いた分が `owns()` に弾かれる。
              shownIdRef.current = stream.id;
              setShownId(stream.id);
              setStartedHere(true);
              // URL は後から追いつかせるだけ。作り直しは起きない（key を付けていない）。
              void navigate(`/chat/${stream.id}`, { replace: true });
            }
            // 新規・既存どちらでも、ここで会話 id が確定する。会話一覧が
            // SSE の往復を待たずに動くよう、暫定値で先に反映しておく
            // （`useRecordOwnMessage` のコメントに詳細）。
            recordOwnMessage(message.data.conversationId, text);
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
        // 進行中の合図は、**まだこの会話を見ているなら必ず**畳む。人間が止めた
        // 場合も畳む対象である（止めた瞬間に「考えている…」で固まらせない）。
        // 見ていない＝別の会話へ移った場合だけ、向こうの内容を触らない。
        if (owns()) {
          setLines((previous) => previous.filter((line) => line.transient !== true));
        }
        // 入力欄の状態は会話ではなくこの画面のもの。ただし、切り替えた先で既に
        // 別の送信が始まっているなら、そちらの「受信中」を消さない。
        if (streamRef.current === stream) {
          setSending(false);
          streamRef.current = undefined;
        }
      }
    },
    [api, shownId, navigate, sending, recordOwnMessage],
  );

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <header className="flex shrink-0 items-center justify-between gap-4 border-b border-border px-4 py-4 md:px-6">
        {onOpenList !== undefined && (
          <button
            type="button"
            onClick={onOpenList}
            aria-label="会話一覧を開く"
            className="flex size-11 shrink-0 items-center justify-center rounded-md text-muted transition-colors hover:bg-surface-2 hover:text-fg"
          >
            <PanelLeft className="size-5" aria-hidden />
          </button>
        )}
        <div className="min-w-0 flex-1">
          <h1 className="text-base font-semibold">クローンと話す</h1>
          <p className="mt-0.5 truncate font-mono text-[11px] text-muted">
            {shownId ?? '新しい会話'}
          </p>
        </div>
        {shownId !== undefined && (
          <Button
            size="sm"
            className="shrink-0"
            onClick={() => {
              void endConversation(shownId).then(() => navigate('/chat'));
            }}
            title="クローンがここまでの学びを記憶へ蒸留する"
          >
            会話を終える
          </Button>
        )}
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 md:px-6">
        {history.isLoading && shownId !== undefined ? (
          <Spinner label="履歴を読み込み中" />
        ) : all.length === 0 ? (
          <Card>
            <Empty>目的や価値観を伝えると、クローンはそれを記憶に蒸留して次の判断に使う。</Empty>
          </Card>
        ) : (
          <ul aria-label="やりとり" className="flex flex-col gap-3">
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

      <div className="shrink-0 border-t border-border px-4 pt-3 pb-[calc(0.75rem+var(--safe-bottom))] md:px-6">
        <ErrorNote error={failure} className="mb-2" />
        <div className="flex items-end gap-2">
          <div className="min-w-0 flex-1">
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
          </div>
          {sending ? (
            <Button
              variant="default"
              onClick={() => streamRef.current?.controller.abort()}
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
