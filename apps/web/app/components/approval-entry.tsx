import { describeAnsweredVia } from '@alteroid/core/answered-via';
import { describeTraceAction } from '@alteroid/core/trace-action';
import { useState } from 'react';
import { Link } from 'react-router';

import { ApprovalCard as ApprovalCardView, Button, ErrorNote, Spinner, cn } from '@alteroid/ui';
import type { ApprovalQuestionsAnswer } from '@alteroid/ui';
import { useAnswerApproval, useApprovalTrace, useConversation } from '@alteroid/swr';
import {
  formatDateTime,
  formatRelative,
  journalTypeLabel,
  redactBody,
  summarizeQuestions,
} from '@alteroid/logic';
import type { PendingApproval } from '@alteroid/logic';

export function isAnswered(approval: PendingApproval): boolean {
  return approval.answeredAt !== undefined && approval.answeredAt !== null;
}

/**
 * クローンが `approval_withdraw` で取り下げたか（issue #963）。
 *
 * **`isAnswered` と排他的な想定である。** 正常な経路では両方 true になる
 * 行は無い（回答済みは取り下げられず、取り下げ済みは答えられない——
 * `packages/core/src/schema.ts` の `pendingApprovalSchema.withdrawnAt` の
 * doc、`apps/daemon/src/app.ts` の `/approvals/:id/answer` の `withdrawn`
 * ガード）。
 */
export function isWithdrawn(approval: PendingApproval): boolean {
  return approval.withdrawnAt !== undefined && approval.withdrawnAt !== null;
}

function noop(): void {}

/**
 * 承認の1件。見た目は `@alteroid/ui` の `ApprovalCard`（Twin Plate）に任せ、ここは
 * データの取り方と送り方だけを持つ。
 *
 * **今の画面の表示をそのまま出すために、部品の省略可能な口を使っている。**
 * - `time`: 時刻は `formatDateTime` と `formatRelative`（`@alteroid/logic`）の2つの
 *   span のまま。時間帯は閲覧者の端末に任せる（部品の `Timestamp` は JST 固定）
 * - 回答欄の送るキーは部品が持つ（`Textarea` の `onSubmitShortcut`）。IME の確定の
 *   ⌘/Ctrl + Enter は送信に数えない（issue #2259。会話と約束の入力欄と同じ）
 * - `trailing`: 会話のパネルは、エラーの後ろ（カードのいちばん下）に置く
 */
export function ApprovalEntry({
  approval,
  draft = '',
  onDraftChange = noop,
  onAnswered = noop,
  bulkError,
}: {
  approval: PendingApproval;
  /**
   * まとめて送るための下書き。親が持つので、カードをまたいで数えられる。**未回答の画面
   * （`approvals.tsx`）だけが渡す。** 回答済みの画面（`approvals-answered.tsx`）は決着した件
   * だけを出すので、下書きも送信も持たない（渡さない）。
   */
  draft?: string;
  onDraftChange?: (text: string) => void;
  /** この id に答えが通った（個別送信・まとめ送信どちらでも呼ぶ）。 */
  onAnswered?: () => void;
  /** 直前のまとめ送信でこの id が駄目だった理由（無ければ何も出さない）。 */
  bulkError?: string;
}) {
  const answerApproval = useAnswerApproval();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(undefined);

  const answered = isAnswered(approval);
  const withdrawn = isWithdrawn(approval);
  // 取り下げ済み（#963）は回答済みと別の終端。両方 true の行は無い想定だが、
  // 来たら今までどおり取り下げを優先する。
  const state = withdrawn ? 'withdrawn' : answered ? 'answered' : 'unanswered';

  async function submit(text: string) {
    if (text.trim() === '') return;
    await send(() => answerApproval(approval.id, text));
  }

  /**
   * 設問のフォームの「回答」（issue #2525）。選んだ設問ごとの `selections` と、補足があれば
   * `answer`（補足になる）を1回で送る。畳んだ文はサーバが作る（ここでは作らない）。
   */
  async function submitQuestions({ selections, supplement }: ApprovalQuestionsAnswer) {
    if (selections.length === 0 && supplement === undefined) return;
    await send(() =>
      answerApproval(approval.id, supplement, selections.length === 0 ? undefined : selections),
    );
  }

  async function send(request: () => Promise<void>) {
    setBusy(true);
    setFailure(undefined);
    try {
      await request();
      onAnswered();
    } catch (caught) {
      setFailure(caught);
    } finally {
      setBusy(false);
    }
  }

  // エラーは今までどおり、個別の失敗 → まとめ送信の失敗の順に、それぞれ別の
  // ErrorNote で出す。どちらも無いときは何も渡さない（部品は `error` が在ると
  // 余白の箱を出すので、空の箱を作らない）。
  const hasFailure = failure !== undefined && failure !== null;
  const errors =
    hasFailure || bulkError !== undefined ? (
      <>
        <ErrorNote error={failure} />
        {bulkError !== undefined && (
          <ErrorNote
            error={`まとめて送った回答は通らなかった: ${bulkError}`}
            className={hasFailure ? 'mt-2' : undefined}
          />
        )}
      </>
    ) : undefined;

  return (
    <ApprovalCardView
      state={state}
      time={
        <>
          <span>{formatDateTime(approval.createdAt)}</span>
          <span>({formatRelative(approval.createdAt)})</span>
        </>
      }
      /*
        **`jobId` を委譲の詳細へつなぐ（issue #2041）。** `jobId` はマネージャー id
        である（`packages/core/src/schema.ts` の `pendingApprovalSchema` の doc
        「どのマネージャーの件か（= manager_id）」。積むのは
        `packages/core/src/tools.ts` の `jobId: managerId` だけ）。
        `commitments.tsx` の `OriginBadge`（issue #2028）と同じ作法で、文言は
        1文字も変えず id の部分だけを `<Link>` にする。
      */
      jobLink={
        approval.jobId !== undefined && approval.jobId !== null ? (
          <>
            {'委譲: '}
            <Link to={`/managers/${approval.jobId}`} className="hover:underline">
              詳細を見る
            </Link>
          </>
        ) : undefined
      }
      question={approval.question}
      context={approval.context ?? undefined}
      answer={approval.answer ?? undefined}
      /*
        **回答経路（Issue #1479）。** 記録が無い（`answeredVia` を持たない古い
        経路で答えられた）行では渡さない——「わからない」を「operator では
        ない」に化けさせない（`packages/core/src/schema.ts` の
        `answeredViaSchema` の doc）。部品は `!== undefined` で判定するので、
        今の画面の truthy 判定はここで保つ。`describeAnsweredVia` は
        `@alteroid/core/answered-via`（ブラウザが読む軽い口）から import する——
        `@alteroid/core` バレルからの値 import はサーバ専用のドメイン層を
        引き込むので禁じている。
      */
      answeredVia={approval.answeredVia ? describeAnsweredVia(approval.answeredVia) : undefined}
      withdrawnReason={approval.withdrawnReason ?? undefined}
      draft={draft}
      onDraftChange={onDraftChange}
      onSubmit={(text) => void submit(text)}
      questions={approval.questions ?? undefined}
      questionsSummary={
        approval.questions && approval.questions.length > 0
          ? summarizeQuestions(approval.questions)
          : undefined
      }
      onSubmitQuestions={(answer) => void submitQuestions(answer)}
      busy={busy}
      // 長文になりうるので Enter は改行のまま。送信は Cmd/Ctrl+Enter（部品の既定
      // `isSubmitShortcut`）。IME の確定の Enter は送信に数えない（issue #2259）。
      /*
        **答えの後にクローンが何をしたか（issue #847 の案B）。** 答え済みの件だけに
        出し、開いたときだけ読む（`useApprovalTrace` の doc）。
      */
      footer={state === 'answered' ? <TracePanel approvalId={approval.id} /> : undefined}
      error={errors}
      /*
        **この確認が上がった会話（issue #782 の3）。** 承認だけを見ていると、
        クローンが実際にこの人間と何を話していたかが分からない。4状態を
        別々に出す（`ConversationPanel` の doc）。
      */
      trailing={
        <div className="mt-3 border-t border-border pt-3">
          {approval.conversationId === undefined || approval.conversationId === null ? (
            <p className="text-[11px] text-muted-foreground italic">
              この確認は会話に紐づいていない（マネージャー発・内部ターンには紐づけられる会話が存在しない）
            </p>
          ) : (
            <ConversationPanel conversationId={approval.conversationId} />
          )}
        </div>
      }
    />
  );
}

/** `describeTraceAction` が本文を持つ4種。それ以外は種別名（英語の識別子）を返すだけ。 */
const TRACE_TYPES_WITH_BODY = new Set(['decision', 'memory_update', 'tool_use', 'exchange']);

/**
 * 行動1件の本文。本文を持たない種別は使わず、頭に出す日本語の種別名（`journalTypeLabel`）に
 * 任せる（issue #3061）。core の `describeTraceAction` は CLI と共有なので変えず、ここで包む。
 */
function traceActionBody(entry: Parameters<typeof describeTraceAction>[0]): string | null {
  if (!TRACE_TYPES_WITH_BODY.has(entry.type)) return null;
  if (entry.type === 'tool_use' && entry.outcome !== undefined) {
    // core は `道具 <名前>（failed）: <入力>` と英語の値を括弧に入れる（CLI と共有で固定）。
    // Web では括弧の中だけ日本語にする。未知の値は素の値のまま出して情報を消さない（issue #3077）。
    const head = `道具 ${entry.tool}`;
    const rest = describeTraceAction({ ...entry, outcome: undefined }).slice(head.length);
    return `${head}（${TOOL_OUTCOME_LABELS[entry.outcome] ?? entry.outcome}）${rest}`;
  }
  return describeTraceAction(entry);
}

/** `tool_use` の `outcome`（`failed` / `interrupted`）の日本語名。 */
const TOOL_OUTCOME_LABELS: Record<string, string> = {
  failed: '失敗',
  interrupted: '中断',
};

/**
 * 承認の答えと、答えを受けたターンでクローンが取った行動を対で出す（issue #847 の案B）。
 *
 * **「対が無い」を1つの顔にしない。** 理由の文言はデーモンが返す `state` ごとに
 * 出し分ける（core の `approval-trace.ts` の doc と同じ分け方。`TRACE_MISSING`）。
 * 行動の本文は日誌の行の要旨で、解釈や一般化は足さない。
 */
function TracePanel({ approvalId }: { approvalId: string }) {
  const [open, setOpen] = useState(false);
  const trace = useApprovalTrace(open ? approvalId : null);

  if (!open) {
    return (
      <div className="mt-2">
        <Button size="sm" onClick={() => setOpen(true)}>
          答えの後の行動を見る
        </Button>
      </div>
    );
  }
  if (trace.isLoading) return <Spinner label="答えの後の行動を読み込み中" />;
  if (trace.error !== undefined) return <ErrorNote error={trace.error} className="mt-2" />;
  const data = trace.data;
  if (data === undefined) return null;
  if (data.state !== 'paired') {
    return (
      <p className="mt-2 text-[11px] text-muted-foreground italic">
        {TRACE_MISSING[data.state] ?? `対が無い（${data.state}）`}
        {data.truncated ? `（答えの後 ${data.scanned} 行までしか見ていない）` : ''}
      </p>
    );
  }
  return (
    <div className="mt-2">
      <p className="mb-1 text-[11px] font-semibold text-muted-foreground">
        答えの後の行動（この承認の印を持つもの。古い順）
      </p>
      <ul className="flex flex-col gap-1">
        {data.actions.map((entry) => (
          <li
            key={entry.id}
            className="rounded border border-border bg-muted p-2 text-xs break-words whitespace-pre-wrap"
          >
            <span className="mr-1 text-[10px] text-muted-foreground">
              {formatDateTime(entry.at)} {journalTypeLabel(entry.type)}
            </span>
            {traceActionBody(entry)}
          </li>
        ))}
      </ul>
      {data.actionsOmitted > 0 && (
        <p className="mt-1 text-[11px] text-muted-foreground">
          ほか {data.actionsOmitted} 件は数えただけで持っていない
        </p>
      )}
      {data.unstampedInTurn > 0 && (
        <p className="mt-1 text-[11px] text-muted-foreground">
          同じターンの区間に、印を持たないクローンの行動が {data.unstampedInTurn}{' '}
          件在る（区間の終わりは推定）
        </p>
      )}
    </div>
  );
}

/**
 * 対が無い理由の言い方。**キーは `state` の全値ではない**（`paired` は一覧を出す）。
 * 知らない値が来たら（デーモンが先に新しい値を返す版ずれ）、上の `??` が値を
 * そのまま出す——空欄にしない。
 */
const TRACE_MISSING: Record<string, string> = {
  unanswered: 'まだ答えが無い',
  withdrawn: '取り下げ済みなので答えは無い',
  no_turn_start: '答えを受けたターンの入口の行が無い（まだ配られていないか、見た窓の外）',
  turn_before_recording:
    '答えを受けたターンは在るが、対で記録し始める前の答えである（行動が無いのではなく、記録していない）',
  unstamped_actions: '⚠️ 答えのターンに印を持たない行動が在る。記録が動いていない疑いがある',
  no_actions: '答えの後にこの承認に紐づいた行動は記録されていない',
};

/**
 * 承認カードに、その確認が上がった会話を出す（issue #782 の3）。
 *
 * **4状態を別々に出す（不変条件A）。** 「機構が無い」（呼び出し元。
 * `approval.conversationId` が無い場合）「読み出せなかった」「まだ返答が
 * 無い」「在る」を同じ表示に潰さない——潰すと、たとえば「読み込み中」が
 * 「まだ返答が無い」に見え、届くはずの発言がまだ届いていないだけなのに
 * 「クローンは黙ったままだ」と誤解される。
 *
 * ⚠️ **見出しは「この確認が上がった会話」であって「この確認への返答」では
 * ない**（不変条件D。ここは変えていない）。outbound の `exchange` には
 * `approvalId` が積まれるようになった（issue #782 の1。PR #1319）が、
 * `packages/core/src/conversation.ts` の `toMessage()` はそれを
 * `ConversationMessage` へ写していない——だから `GET /conversations/:id`
 * の応答にも無く、この画面までは届いていない。ここは会話全体を古い順に
 * 出すだけで、どの発言がこの確認への回答かは特定しない。時刻の近さで
 * 「この返答はこの確認への返答だ」と決めつけない。
 */
function ConversationPanel({ conversationId }: { conversationId: string }) {
  const conversation = useConversation(conversationId);

  // ② 読み出せなかった（読み込み中）。「まだ返答が無い」に潰さない。
  if (conversation.isLoading) {
    return <Spinner label="この確認が上がった会話を読み込み中" />;
  }
  // ② 読み出せなかった（失敗）。理由をそのまま出す。
  if (conversation.error !== undefined) {
    return <ErrorNote error={conversation.error} />;
  }

  const messages = conversation.data?.messages ?? [];
  const hasCloneReply = messages.some((message) => message.role === 'outbound');

  // ③ まだ返答が無い。会話は取れたが、クローンの発言が0件（人間の発言しか
  // 無い場合も含む——「クローンが黙ったまま」という事実そのものを出す）。
  if (!hasCloneReply) {
    return (
      <div>
        <p className="text-[11px] text-muted-foreground italic">
          この会話にはまだクローンの発言が無い
        </p>
        <OpenInChat conversationId={conversationId} />
      </div>
    );
  }

  // ④ 在る。
  return (
    <div>
      <p className="mb-2 text-[11px] font-semibold text-muted-foreground">この確認が上がった会話</p>
      <ul className="flex flex-col gap-2">
        {messages.map((message) => (
          <li
            key={message.id}
            className={cn(
              'rounded border border-border p-2 text-xs break-words whitespace-pre-wrap',
              message.role === 'inbound' ? 'bg-background' : 'bg-muted',
            )}
          >
            <span className="mr-1 text-[10px] text-muted-foreground">
              {message.role === 'inbound' ? '人間' : 'クローン'}
            </span>
            {redactBody(message.text)}
          </li>
        ))}
      </ul>
      <OpenInChat conversationId={conversationId} />
    </div>
  );
}

/**
 * **この会話をチャットの画面で開く（issue #2069）。** パネルに出すのは会話を
 * 読むためだけの写しで、続きを書くにはチャットへ移る必要がある。その会話は
 * `/chat/:conversationId`（`routes.ts`）で開けるので、会話を読めた2状態
 * （③ ④）にだけ出す。②（読み込み中・失敗）には出さない——読めなかった会話を
 * 開けるかのように見せないため。①（会話が無い）には開く先が無い。
 */
function OpenInChat({ conversationId }: { conversationId: string }) {
  return (
    <Link
      to={`/chat/${conversationId}`}
      className="mt-2 inline-block text-[11px] text-primary hover:underline"
    >
      この会話をチャットで開く →
    </Link>
  );
}
