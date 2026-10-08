import { describeTraceAction } from '@alteroid/core/trace-action';
import { useState } from 'react';
import { Link } from 'react-router';

import { LoadError } from '~/components/load-error';
import { Button, Spinner, cn } from '@alteroid/ui';
import { useApprovalTrace, useConversation } from '@alteroid/swr';
import { formatDateTime, journalTypeLabel, redactBody } from '@alteroid/logic';
import type { PendingApproval } from '@alteroid/logic';
import type { ApprovalQuestionsDraft } from '@alteroid/ui';

import {
  ApprovalAnswerCard,
  isApprovalAnswered,
  isApprovalWithdrawn,
  type SentApprovalDraft,
} from '~/components/approval-answer-card';

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
  draft,
  onDraftChange,
  questionsDraft,
  onQuestionsDraftChange,
  onAnswered,
  onFailed,
  bulkError,
  bulkBusy,
  onSendingChange,
}: {
  approval: PendingApproval;
  /**
   * まとめて送るための下書き。**未回答の画面（`approvals.tsx`）だけが渡す。** 回答済みの画面
   * （`approvals-answered.tsx`）は決着した件だけを出すので渡さない（カードが自前で持つ）。
   */
  draft?: string;
  onDraftChange?: (text: string) => void;
  /** 設問のフォームの書きかけ。`draft` と同じく未回答の画面だけが渡す（タブを移っても残すため）。 */
  questionsDraft?: ApprovalQuestionsDraft;
  onQuestionsDraftChange?: (draft: ApprovalQuestionsDraft) => void;
  /** この id に答えが通った（個別送信・まとめ送信どちらでも呼ぶ）。 */
  onAnswered?: (sent: SentApprovalDraft) => void;
  /** この id の答えが断られた（409 など）。 */
  onFailed?: (error: unknown) => void;
  /** 直前のまとめ送信でこの id が駄目だった理由（無ければ何も出さない）。 */
  bulkError?: string;
  /** まとめ送信の最中（カードの送信を止める。#3626）。 */
  bulkBusy?: boolean;
  /** このカードの送信中が変わった（#3626）。 */
  onSendingChange?: (sending: boolean) => void;
}) {
  // 状態の導出・回答の送信・エラー表示は会話の画面と共有のカードが持つ（#3259）。
  // ここが足すのは、この画面だけのもの（答えの後の経緯・確認が上がった会話）。
  return (
    <ApprovalAnswerCard
      approval={approval}
      draft={draft}
      onDraftChange={onDraftChange}
      questionsDraft={questionsDraft}
      onQuestionsDraftChange={onQuestionsDraftChange}
      onAnswered={onAnswered}
      onFailed={onFailed}
      bulkError={bulkError}
      bulkBusy={bulkBusy}
      onSendingChange={onSendingChange}
      /*
        **答えの後にクローンが何をしたか（issue #847 の案B）。** 答え済みの件だけに
        出し、開いたときだけ読む（`useApprovalTrace` の doc）。
      */
      footer={
        isApprovalAnswered(approval) && !isApprovalWithdrawn(approval) ? (
          <TracePanel approvalId={approval.id} />
        ) : undefined
      }
      /*
        **この確認が上がった会話（issue #782 の3）。** 4状態を別々に出す
        （`ConversationPanel` の doc）。
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
  const data = trace.data;
  // 読めた後の取り直しの失敗は、前に読めた中身を残したまま注記する（issue #3514。#3346 と同じ形）。
  if (trace.error !== undefined && data === undefined) {
    return (
      <LoadError
        what="答えの後の行動"
        error={trace.error}
        onRetry={() => trace.mutate()}
        retrying={trace.isValidating}
        className="mt-2"
      />
    );
  }
  if (data === undefined) return null;
  const staleNote =
    trace.error !== undefined ? (
      <p className="mt-2 text-xs text-warn">
        最新の行動を取り直せなかった。下は前に読めたときのもの。
      </p>
    ) : null;
  if (data.state !== 'paired') {
    return (
      <>
        {staleNote}
        <p className="mt-2 text-[11px] text-muted-foreground italic">
          {TRACE_MISSING[data.state] ?? `対が無い（${data.state}）`}
          {data.truncated ? `（答えの後 ${data.scanned} 行までしか見ていない）` : ''}
        </p>
      </>
    );
  }
  return (
    <div className="mt-2">
      {staleNote}
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
            {redactBody(traceActionBody(entry) ?? '')}
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
  // 読めた後の取り直しの失敗は、前に読めた会話を残したまま注記する（issue #3514。#3346 と同じ形）。
  if (conversation.error !== undefined && conversation.data === undefined) {
    return (
      <LoadError
        what="この確認が上がった会話"
        error={conversation.error}
        onRetry={() => conversation.mutate()}
        retrying={conversation.isValidating}
      />
    );
  }
  const staleNote =
    conversation.error !== undefined ? (
      <p className="mb-2 text-xs text-warn">
        最新の会話を取り直せなかった。下は前に読めたときのもの。
      </p>
    ) : null;

  const messages = conversation.data?.messages ?? [];
  const hasCloneReply = messages.some((message) => message.role === 'outbound');

  // ③ まだ返答が無い。会話は取れたが、クローンの発言が0件（人間の発言しか
  // 無い場合も含む——「クローンが黙ったまま」という事実そのものを出す）。
  if (!hasCloneReply) {
    return (
      <div>
        {staleNote}
        {/* 窓が先頭に届いていないときの0件は「無い」ではない。言い切ると、同じ状況を「確かめられなかった」と言う台帳・チャットと食い違う（#3871）。 */}
        <p className="text-[11px] text-muted-foreground italic">
          {conversation.data?.reachedStart === false
            ? '取れた窓にはクローンの発言が無かった（窓が会話の先頭に届いていないので、確かめられなかった）'
            : 'この会話にはまだクローンの発言が無い'}
        </p>
        <OpenInChat conversationId={conversationId} />
      </div>
    );
  }

  // ④ 在る。
  return (
    <div>
      {staleNote}
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
            {!!message.attachments?.length && (
              <span className="block text-[11px] text-muted-foreground">
                {attachmentNote(message.attachments)}
              </span>
            )}
          </li>
        ))}
      </ul>
      <OpenInChat conversationId={conversationId} />
    </div>
  );
}

/**
 * 引用の添付は名前だけを添える（中身の取得・プレビューは `MessageAttachments` を lazy で
 * 読む必要があり、この画面のために取りに行かない）。名前が空・読めない形のときは、
 * 推測で埋めず無いと分かる形で出す。名前の扱いはチャット（`MessageAttachments`）に合わせ、そのまま出す。
 */
function attachmentNote(attachments: readonly { name?: unknown }[]): string {
  // 先頭の数件だけ名前を出し、残りは件数にする: 添付の多い1発言が引用を伸ばし続けないため（日誌・台帳の一行表示と揃える）
  const shown = attachments.slice(0, ATTACHMENT_NOTE_NAMES).map(attachmentLabel);
  const rest = attachments.length - shown.length;
  return `［添付 ${attachments.length}件: ${shown.join('、')}${rest > 0 ? `、ほか ${rest} 件` : ''}］`;
}

const ATTACHMENT_NOTE_NAMES = 3;

function attachmentLabel(attachment: { name?: unknown }): string {
  return typeof attachment.name === 'string' && attachment.name.trim() !== ''
    ? attachment.name
    : '名前の無い添付';
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
