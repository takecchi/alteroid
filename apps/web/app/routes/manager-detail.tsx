import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';

import {
  DocumentTitle,
  Button,
  Card,
  CardHeader,
  CodeBlock,
  Empty,
  ConfirmDialog,
  ErrorNote,
  Spinner,
  SubmitHint,
  Textarea,
  WindowedText,
} from '@alteroid/ui';
import {
  useAbortManager,
  useSendManagerMessage,
  useManager,
  useManagerTranscript,
} from '@alteroid/swr';
import { formatBytes, formatDateTime, formatRelative, redactBody } from '@alteroid/logic';
import { RemovedBody } from '~/components/load-error';
import { clipLine } from '~/lib/clip-line';
import { isNotFound } from '~/lib/is-not-found';
import { LeaveGuardScope, useIsMounted, useReportDirty } from '~/lib/leave-guard';
import { unsentInput } from '~/lib/unsent-input';
import type { ManagerSummary } from '@alteroid/logic';

import type { Route } from './+types/manager-detail';
import { DenialsCard, DiagnosticsCard, LastReportBody } from './manager-detail-notes';
import { ManagerStatusCard } from './manager-status-card';

export function clientLoader({ params }: Route.ClientLoaderArgs) {
  return { id: params.id };
}

// 依頼の全文（`manager.request`）を渡さない: header は `shrink-0` なので、長いと本文が画面の外へ押し出される。
const PAGE_DESCRIPTION = 'この仕事1本の状態と、走行中に割り込む口。依頼の全文は下';

const NOT_FOUND_DESCRIPTION = '指定されたマネージャーはありません';

export default function ManagerDetail({ loaderData }: Route.ComponentProps) {
  const { id } = loaderData;
  const { data, error, isLoading } = useManager(id);
  const navigate = useNavigate();
  const mounted = useIsMounted();
  const { search } = useLocation();
  const abortManager = useAbortManager();
  const [busy, setBusy] = useState(false);
  const [confirmingStop, setConfirmingStop] = useState(false);
  const [failure, setFailure] = useState<unknown>(undefined);
  /** 停止を頼んだが、止まったと確かめられなかったときの断り（`not_stopped`・`unknown`）。 */
  const [stopNotice, setStopNotice] = useState<string | undefined>(undefined);

  const manager = data?.manager;
  // 質問への答えの書きかけは行ではなくここで持つ: 行は `waiting` から外れると unmount するので、
  // 答えている間にほかで決着すると書いたものが黙って消える。外れた分は下の `LeftoverAnswers` で見せる
  const [answerDrafts, setAnswerDrafts] = useState<
    Record<string, { summary: string; text: string }>
  >({});
  const waitingIds = new Set(manager?.waiting.map((request) => request.requestId) ?? []);
  const leftoverAnswers =
    manager === undefined
      ? []
      : Object.entries(answerDrafts).flatMap(([requestId, draft]) =>
          !waitingIds.has(requestId) && draft.text.trim() !== '' ? [{ requestId, ...draft }] : [],
        );
  useReportDirty('question-answer-leftovers', leftoverAnswers.length > 0);
  function updateAnswerDraft(
    requestId: string,
    summary: string,
    update: (current: string) => string,
  ): void {
    setAnswerDrafts((current) => ({
      ...current,
      [requestId]: { summary, text: update(current[requestId]?.text ?? '') },
    }));
  }
  function discardAnswerDraft(requestId: string): void {
    setAnswerDrafts((current) =>
      Object.fromEntries(Object.entries(current).filter(([key]) => key !== requestId)),
    );
  }
  // 「見つからない」は 404 のときだけ言う: 500・409（壊れているだけ）で言うと、読めていないのに委譲が存在しないように読める。
  const notFound = data === undefined && isNotFound(error);
  const detailUnavailable = data === undefined && error !== undefined && !notFound;

  return (
    // ブロッカーはこの画面に1つだけ。親の `managers.tsx` は持たない（最後に登録したものが勝つため）。
    <LeaveGuardScope>
      <DocumentTitle>マネージャーの詳細</DocumentTitle>
      <header className="mb-4 flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="text-base font-semibold">マネージャーの詳細</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {notFound ? NOT_FOUND_DESCRIPTION : PAGE_DESCRIPTION}
          </p>
          <p className="mt-0.5 break-all font-mono text-[11px] text-muted-foreground">{id}</p>
        </div>
        <div className="shrink-0">
          {/*
            状態で出し分けない: CLI の `/stop` もデーモンも status を見ずに止めるので、画面だけ絞ると入口の等価性が崩れる。
            `done`（待機中）も止めたい場面があり、状態を列挙すると増えた日に黙って締め出す。
            押せない理由は非表示ではなく `failure` の `ErrorNote` で出す（消すと「できない」と「扱っていない」を区別できない）。
          */}
          {manager !== undefined ? (
            <Button
              variant="danger"
              size="sm"
              loading={busy}
              onClick={() => setConfirmingStop(true)}
            >
              停止する
            </Button>
          ) : undefined}
          <ConfirmDialog
            open={confirmingStop}
            onOpenChange={setConfirmingStop}
            title="このマネージャーを停止しますか"
            description="セッションを止めます（待機中のセッションも畳まれます）。進行中の作業は失われ、答えを待っている確認は畳まれます。止まったと確かめられたら一覧へ戻ります。"
            confirmLabel="停止する"
            destructive
            onConfirm={() => {
              setBusy(true);
              setFailure(undefined);
              setStopNotice(undefined);
              abortManager(id, '人間が画面から停止した')
                .then((result) => {
                  // 応答待ちに別のマネージャーへ移っていたら、その画面を動かさない。
                  if (!mounted.current) return;
                  // 止まったと言えるのは `stopped` のときだけ: `not_stopped`・`unknown` で一覧へ戻ると、止まっていない委譲を止めたと読ませる（CLI も同じく分ける）
                  if (result.outcome === 'stopped') {
                    navigate({ pathname: '/managers', search });
                    return;
                  }
                  setStopNotice(
                    redactBody(
                      `${result.outcome === 'not_stopped' ? '止まっていない' : '止まったか確かめられなかった'}（${result.outcome}）: ${result.detail}`,
                    ),
                  );
                })
                .catch(setFailure)
                .finally(() => setBusy(false));
            }}
          />
        </div>
      </header>

      {/* 404 は下のカードが日本語で言う。応答の素の文（英語の `not found`）を重ねて出さない。 */}
      <ErrorNote error={notFound ? failure : (error ?? failure)} className="mb-4" />
      {stopNotice !== undefined && (
        <p role="alert" className="mb-4 rounded-lg border border-warn/50 p-3 text-sm text-warn">
          停止を頼んだが、止まったと確かめられていない。{stopNotice}
        </p>
      )}

      {isLoading ? (
        <Spinner />
      ) : detailUnavailable ? null : manager === undefined ? (
        <Card>
          <Empty>
            このマネージャーは見つかりません（削除されたか、id が違います）。
            <Link to="/managers" className="ml-2 underline">
              マネージャー一覧へ戻る
            </Link>
          </Empty>
        </Card>
      ) : (
        <div className="flex flex-col gap-4">
          <RequestCard request={manager.request} />

          <ManagerStatusCard manager={manager} id={id} />

          <DiagnosticsCard manager={manager} />

          <DenialsCard denials={manager.denials} lastReportAt={manager.lastReportAt} />

          <LeftoverAnswers leftovers={leftoverAnswers} onDiscard={discardAnswerDraft} />

          {manager.waiting.length > 0 && (
            <Card>
              <CardHeader
                title="このマネージャーが待っていること"
                subtitle="答えるまでこの仕事だけが止まる"
              />
              <ul>
                {manager.waiting.map((request) => (
                  <li key={request.requestId} className="border-b border-border last:border-b-0">
                    <WaitingRow
                      id={id}
                      requestId={request.requestId}
                      summary={request.summary}
                      kind={request.kind}
                      askedAt={request.askedAt}
                      answerText={answerDrafts[request.requestId]?.text ?? ''}
                      onAnswerChange={(update) =>
                        updateAnswerDraft(request.requestId, request.summary, update)
                      }
                    />
                  </li>
                ))}
              </ul>
            </Card>
          )}

          {manager.lastReport !== undefined && manager.lastReport !== null && (
            <Card className="min-w-0">
              {/* 失敗で終わった回を「報告」と呼ばない: 見出しが「最後の報告」のままだと、包みの内側だけが報告として読まれる。 */}
              <CardHeader
                title={
                  manager.lastFailure === undefined || manager.lastFailure === null
                    ? '最後の報告'
                    : '最後のターンの中身（報告ではない）'
                }
                subtitle={
                  manager.lastFailure === undefined || manager.lastFailure === null
                    ? undefined
                    : 'SDK が「これは応答ではない」と言った回。以下はマネージャーのまとめではなく、失敗の中身である'
                }
              />
              <div className="min-w-0 px-4 py-3">
                <LastReportBody lastReport={manager.lastReport} lastFailure={manager.lastFailure} />
              </div>
            </Card>
          )}

          <SendMessage id={id} live={manager.live} sessionId={manager.sessionId} />
          <Transcript id={id} />
        </div>
      )}
    </LeaveGuardScope>
  );
}

// 切り詰めず、Markdown にも解釈しない: 見せたいのはクローンが渡した文字列そのもの。長いときは `max-h` でカード内をスクロールさせ、他のカードを押し出さない。
function RequestCard({ request }: { request: string }) {
  return (
    <Card className="min-w-0">
      <CardHeader title="依頼" subtitle="この仕事を起こしたときに渡した指示（全文）" />
      <div className="max-h-72 min-w-0 overflow-y-auto px-4 py-3">
        <p className="text-sm break-words whitespace-pre-wrap">{redactBody(request)}</p>
      </div>
    </Card>
  );
}

function AskedAtNote({ askedAt }: { askedAt: string }) {
  return (
    <p className="mt-1 text-xs text-muted-foreground">
      {formatDateTime(askedAt)}（{formatRelative(askedAt)}）から
    </p>
  );
}

// 受け付けた側（入力を空にしてよい）は `answered` / `delivered` / `held` だけ（許可リスト）。知らない値は未達の側へ倒し、識別子を出さず `detail` だけを出す。
// `held` を受け付けた側に入れる: デーモンが伝言を台帳に預かり、届けられるようになったら自動で届けるので、書いた文を残すと送り直しで二重に届く（CLI も同じく受け付けた側に数える）
const SEND_OUTCOME_LABELS: Record<string, { label: string; reached: boolean }> = {
  answered: { label: '確認に答えた', reached: true },
  delivered: { label: '追加指示を届けた', reached: true },
  held: {
    label:
      '預かった（いまは届けられないので台帳に預け、届けられるようになったら届ける。送り直すと二重に届く）',
    reached: true,
  },
  session_missing: {
    label: '届いていない（担当がこの仕事の会話を持っておらず、入り直せなかった）',
    reached: false,
  },
  declined: {
    label: '届けていない（世代が食い違う待機中の仕事を畳めなかったため、古い会話へも送らなかった）',
    reached: false,
  },
  unknown: { label: '届いたか確かめられなかった', reached: false },
  unreadable: { label: '届けていない（台帳の行が読めない形で入っている）', reached: false },
};

function describeSendResult(result: { outcome: string; detail: string }): {
  text: string;
  reached: boolean;
} {
  const known = Object.hasOwn(SEND_OUTCOME_LABELS, result.outcome)
    ? SEND_OUTCOME_LABELS[result.outcome]
    : undefined;
  if (known === undefined) return { text: redactBody(result.detail), reached: false };
  return { text: redactBody(`${known.label}: ${result.detail}`), reached: known.reached };
}

function SendOutcomeNote({ note }: { note: { text: string; reached: boolean } | undefined }) {
  if (note === undefined) return null;
  return (
    <p className={`mt-2 text-xs ${note.reached ? 'text-muted-foreground' : 'text-warn'}`}>
      {note.reached ? '' : '⚠ '}
      {note.text}
    </p>
  );
}

const WAITING_LABEL_MAX = 20;

function waitingLabel(summary: string): string {
  return `「${clipLine(summary, WAITING_LABEL_MAX)}」`;
}

function PermissionWaitingRow({
  id,
  requestId,
  summary,
  askedAtNote,
}: {
  id: string;
  requestId: string;
  summary: string;
  askedAtNote: ReactNode;
}) {
  const send = useSendManagerMessage();
  // 1本の真偽値にしない: 「拒否」を押しても「許可」が回る。押したほうだけ `loading`、もう片方は `disabled` で塞ぐ。
  const [busy, setBusy] = useState<'allow' | 'deny' | null>(null);
  const [failure, setFailure] = useState<unknown>(undefined);
  const [note, setNote] = useState<{ text: string; reached: boolean } | undefined>(undefined);

  function answer(decision: 'allow' | 'deny') {
    if (busy !== null) return;
    setBusy(decision);
    setFailure(undefined);
    setNote(undefined);
    send(id, {
      text: decision === 'allow' ? '許可する' : '許可しない',
      requestId,
      decision,
    })
      .then((result) => {
        const described = describeSendResult(result);
        if (!described.reached) setNote(described);
      })
      .catch(setFailure)
      .finally(() => setBusy(null));
  }

  return (
    <div className="px-4 py-3">
      <p className="text-sm">{redactBody(summary)}</p>
      {askedAtNote}
      <div className="mt-2 flex items-center gap-2">
        <Button
          size="sm"
          variant="primary"
          loading={busy === 'allow'}
          aria-label={`${waitingLabel(summary)}を許可`}
          disabled={busy === 'deny'}
          onClick={() => answer('allow')}
        >
          許可
        </Button>
        <Button
          size="sm"
          // 「拒否」は取り返しのつく操作なので danger にしない。
          loading={busy === 'deny'}
          aria-label={`${waitingLabel(summary)}を拒否`}
          disabled={busy === 'allow'}
          onClick={() => answer('deny')}
        >
          拒否
        </Button>
      </div>
      <SendOutcomeNote note={note} />
      <ErrorNote error={failure} className="mt-2" />
    </div>
  );
}

function QuestionWaitingRow({
  id,
  requestId,
  summary,
  askedAtNote,
  text,
  onTextChange: setText,
}: {
  id: string;
  requestId: string;
  summary: string;
  askedAtNote: ReactNode;
  text: string;
  onTextChange: (update: (current: string) => string) => void;
}) {
  const send = useSendManagerMessage();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(undefined);
  const [note, setNote] = useState<{ text: string; reached: boolean } | undefined>(undefined);
  useReportDirty(`question-answer:${requestId}`, text.trim() !== '');

  function submit() {
    // ボタンの `disabled` だけに頼らない: Cmd/Ctrl+Enter でもここへ来る。
    if (text.trim() === '') return;
    setBusy(true);
    setFailure(undefined);
    setNote(undefined);
    // `decision` を付けない: 質問に allow/deny は無く、付けると日誌に `[allow]` の接頭辞だけが残って嘘になる。
    const sent = text;
    send(id, { text: sent, requestId })
      .then((result) => {
        const described = describeSendResult(result);
        // 届いていないのに入力を空にしない。届いたときも、応答を待つ間に打ち足した分は残す。
        if (described.reached) setText((current) => unsentInput(current, sent));
        else setNote(described);
      })
      .catch(setFailure)
      .finally(() => setBusy(false));
  }

  return (
    <div className="px-4 py-3">
      <p className="text-sm">{redactBody(summary)}</p>
      {askedAtNote}
      <div className="mt-2">
        <Textarea
          rows={2}
          value={text}
          placeholder="この質問への答えを、自分の言葉で書く"
          aria-label={`${waitingLabel(summary)}への答え`}
          disabled={busy}
          onChange={(event) => {
            const value = event.target.value;
            setText(() => value);
          }}
          maxHeight="12rem"
          onSubmitShortcut={submit}
          submitDisabled={busy || text.trim() === ''}
          refocusAfterSubmit
        />
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="primary"
            loading={busy}
            disabled={text.trim() === ''}
            onClick={submit}
            aria-label={`${waitingLabel(summary)}へ答えを送信`}
          >
            送信
          </Button>
          <SubmitHint action="送信" />
        </div>
      </div>
      <SendOutcomeNote note={note} />
      <ErrorNote error={failure} className="mt-2" />
    </div>
  );
}

// `kind` が `'question'` 以外はすべて実行許可として扱う: api-client は実行時検証を持たず、未知の文字列が届きうる。倒れ先は何も消さない2ボタン。
function WaitingRow({
  id,
  requestId,
  summary,
  kind,
  askedAt,
  answerText,
  onAnswerChange,
}: {
  id: string;
  requestId: string;
  summary: string;
  kind: ManagerSummary['waiting'][number]['kind'];
  askedAt: string;
  answerText: string;
  onAnswerChange: (update: (current: string) => string) => void;
}) {
  const askedAtNote = <AskedAtNote askedAt={askedAt} />;

  if (kind === 'question') {
    return (
      <QuestionWaitingRow
        id={id}
        requestId={requestId}
        summary={summary}
        askedAtNote={askedAtNote}
        text={answerText}
        onTextChange={onAnswerChange}
      />
    );
  }

  return (
    <PermissionWaitingRow
      id={id}
      requestId={requestId}
      summary={summary}
      askedAtNote={askedAtNote}
    />
  );
}

/**
 * 質問が待ちから外れた（ほかで答えられた・取り下げられた・マネージャーが終わった）のに、書いた答えが残っているもの。
 * **黙って消さない。** 残った文をここへ出す。写してから閉じられる（承認の画面の `LeftoverDrafts` と同じ扱い）。
 */
function LeftoverAnswers({
  leftovers,
  onDiscard,
}: {
  leftovers: { requestId: string; summary: string; text: string }[];
  onDiscard: (requestId: string) => void;
}) {
  if (leftovers.length === 0) return null;
  return (
    <ul className="flex flex-col gap-3" aria-label="送らなかった答えが残っている質問">
      {leftovers.map(({ requestId, summary, text }) => (
        <li
          key={requestId}
          className="rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-sm"
        >
          <p className="mb-2 break-words">
            <strong>この質問は待ちから外れた（ほかで決着した）。書きかけは残してある。</strong>
            もう待っていないので、ここから答えとして送ることはできない。必要なら写してから閉じる。
            <span className="mt-1 block text-xs text-muted-foreground">
              {/* 伏せる: 待ちの行は同じ本文を伏せて出すので、ここだけ秘密が素のまま出るため */}
              対象: {redactBody(summary)}
            </span>
          </p>
          <CodeBlock label="残った文" maxHeight="12rem">
            {text}
          </CodeBlock>
          <div className="mt-2">
            <Button size="sm" onClick={() => onDiscard(requestId)}>
              閉じる（捨てる）
            </Button>
          </div>
        </li>
      ))}
    </ul>
  );
}

const REASON_ID = 'send-message-disabled-reason';

// `live === false` というだけで `disabled` にしない: 繋がっていない相手への送信は resume に化けるので、人間が自分の言葉で繋ぎ直す唯一の手になる。
// 止めるのは「戻る先（`session_id`）が無い」と分かっている相手だけ（`live` だけで判定しない: `live === true` なら `session_id` が無くても届く）。
// 無効にするときは、操作するその場に理由を置く（黙って無効にしない）。
function SendMessage({
  id,
  live,
  sessionId,
}: {
  id: string;
  live: boolean;
  sessionId: string | undefined | null;
}) {
  const noWayBack = !live && (sessionId === undefined || sessionId === null);
  const send = useSendManagerMessage();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<{ text: string; reached: boolean } | undefined>(undefined);
  const [failure, setFailure] = useState<unknown>(undefined);
  useReportDirty('send-message', text.trim() !== '');

  function submit() {
    // ボタンの `disabled` だけに頼らない: ⌘/Ctrl+Enter はボタンを経由しないので、送信中も弾かないと押した数だけ割り込みが飛ぶ。
    if (text.trim() === '' || noWayBack || busy) return;
    setBusy(true);
    setFailure(undefined);
    // 次の送信が失敗しても、前回の「届けた」が今回のものに見えないようにする。
    setOutcome(undefined);
    const sent = text;
    send(id, { text: sent })
      .then((result) => {
        const described = describeSendResult(result);
        setOutcome(described);
        // 届いていないときは入力を残す。届いたときも、応答を待つ間に打ち足した分は残す。
        if (described.reached) setText((current) => unsentInput(current, sent));
      })
      .catch(setFailure)
      .finally(() => setBusy(false));
  }

  return (
    <Card>
      <CardHeader title="話しかける" subtitle="走行中のマネージャーに追加の指示を割り込ませる" />
      <div className="px-4 py-3">
        {noWayBack ? (
          <p id={REASON_ID} className="mb-2 text-xs text-destructive">
            <strong className="font-medium">送れない</strong>—
            この仕事は戻る先（session_id）を持っておらず、送っても runner
            へは何も飛ばない。続きが要るなら
            <strong className="font-medium">新しく起こし直すこと</strong>。
          </p>
        ) : (
          !live && (
            <p className="mb-2 text-xs text-destructive">
              この相手とは繋ぎ直せていないが、
              <strong className="font-medium">送信は止めていない</strong>—
              送ると引き取り（resume）を試み、戻れればそのまま届く。
              <strong className="font-medium">戻れなければ理由がここに出る。</strong>
            </p>
          )
        )}
        <div className="flex items-end gap-2">
          {/* 入力欄までは塞がない: 書きかけの言葉を取り上げる理由が無く、起こし直した後にそのまま送れる。 */}
          <Textarea
            className="min-w-0 flex-1"
            rows={2}
            value={text}
            placeholder="追加の指示"
            aria-label="追加の指示"
            onChange={(event) => setText(event.target.value)}
            maxHeight="12rem"
            onSubmitShortcut={submit}
            submitDisabled={busy || noWayBack || text.trim() === ''}
          />
          <Button
            variant="primary"
            loading={busy}
            disabled={text.trim() === '' || noWayBack}
            {...(noWayBack ? { 'aria-describedby': REASON_ID } : {})}
            onClick={submit}
          >
            送る
          </Button>
        </div>
        <div className="mt-2">
          <SubmitHint action="送る" />
        </div>
        <SendOutcomeNote note={outcome} />
        <ErrorNote error={failure} className="mt-2" />
      </div>
    </Card>
  );
}

function Transcript({ id }: { id: string }) {
  const [open, setOpen] = useState(false);
  const { data, error, isLoading } = useManagerTranscript(open ? id : null);
  // 取れなかったのを空と描かない: 「(空)」を出すと、セッションログが空だったように読める。
  const transcriptUnavailable = data === undefined && error !== undefined;
  // 404 は下で日本語で言う: 応答の素の文（英語の `not found`）を赤い帯に出さないため（アーカイブの本文と同じ）
  const noTranscript = transcriptUnavailable && isNotFound(error);
  // 伏せ字は全体に一度だけ掛け、窓で切るのはその後にする: 切れ目をまたぐ秘密を取りこぼさない。数 MB になりうるので `data` が変わったときだけ計算する。
  const redacted = useMemo(() => {
    if (data?.kind !== 'body' || data.body === '') return undefined;
    const text = redactBody(data.body);
    return { text, size: formatBytes(new Blob([text]).size) };
  }, [data]);

  return (
    <Card>
      <CardHeader
        title="セッションログ（生）"
        subtitle="compaction で潰される前の全文"
        action={
          <Button size="sm" onClick={() => setOpen((value) => !value)}>
            {open ? '閉じる' : '開く'}
          </Button>
        }
      />
      {open && (
        <div className="px-4 py-3">
          <ErrorNote error={noTranscript ? undefined : error} />
          {isLoading ? (
            <Spinner />
          ) : noTranscript ? (
            <Empty>このマネージャーの生ログはありません</Empty>
          ) : transcriptUnavailable ? null : data?.kind === 'removed' ? (
            <RemovedBody removedAt={data.removedAt} bytes={data.bytes} />
          ) : redacted === undefined ? (
            <pre className="max-h-[32rem] overflow-auto rounded border border-border bg-background p-2 text-[11px] text-muted-foreground">
              (空)
            </pre>
          ) : (
            <WindowedText
              text={redacted.text}
              totalNote={redacted.size}
              testId="manager-transcript"
            />
          )}
        </div>
      )}
    </Card>
  );
}
