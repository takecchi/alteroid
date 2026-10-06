import { describeAnsweredVia } from '@alteroid/core/answered-via';
import { describeTraceAction } from '@alteroid/core/trace-action';
import { AlertTriangle } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link } from 'react-router';

import {
  ApprovalCard as ApprovalCardView,
  type ApprovalQuestionsAnswer,
  Page,
  Button,
  Card,
  Empty,
  ErrorNote,
  Spinner,
  cn,
} from '@alteroid/ui';
import {
  useAnswerApproval,
  useAnswerApprovals,
  useApprovalTrace,
  useApprovals,
  useConversation,
} from '@alteroid/swr';
import {
  formatDateTime,
  formatRelative,
  journalTypeLabel,
  redactBody,
  summarizeQuestions,
} from '@alteroid/logic';
import type { PendingApproval, UnreadableApproval } from '@alteroid/logic';

function isAnswered(approval: PendingApproval): boolean {
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
function isWithdrawn(approval: PendingApproval): boolean {
  return approval.withdrawnAt !== undefined && approval.withdrawnAt !== null;
}

/** `Record` から1つの key を落とした新しい `Record` を作る（同じ参照は返さない）。 */
function without<T>(record: Record<string, T>, key: string): Record<string, T> {
  if (!(key in record)) return record;
  const next = { ...record };
  delete next[key];
  return next;
}

/**
 * 読めない承認待ちが在ることを、一覧の上で断る（issue #2298。commitments 画面の
 * `UnreadableNote` と同じ形）。**0件なら描かない**（0 の行を作らない）。
 *
 * id が取れない行は件数だけに数える。id の列挙には上限を置き、切ったら言う。
 * **「回答済みでも取り下げ済みでもない」を落とさない**——落とすと、行が消えたのと区別が付かない。
 */
const UNREADABLE_APPROVAL_IDS_SHOWN = 20;

function UnreadableApprovalNote({ unreadable }: { unreadable: UnreadableApproval[] }) {
  if (unreadable.length === 0) return null;
  const idsAll = unreadable.map((entry) => entry.id).filter((id): id is string => id != null);
  const ids = idsAll.slice(0, UNREADABLE_APPROVAL_IDS_SHOWN);
  const idsRest = idsAll.length - ids.length;
  return (
    <div
      role="status"
      className="mb-4 flex items-start gap-2 rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-sm text-warn"
    >
      <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
      <span className="min-w-0 break-words">
        読めない承認待ちが {unreadable.length} 件ある
        {ids.length > 0 &&
          `（id: ${ids.join(', ')}${idsRest > 0 ? ` …ほか ${idsRest} 件は省略` : ''}）`}
        。<strong>壊れた行であって、回答済みでも取り下げ済みでもない。</strong>
        この一覧には載っていない。
      </span>
    </div>
  );
}

export default function Approvals() {
  const [showAnswered, setShowAnswered] = useState(false);
  const { data, error, isLoading } = useApprovals(!showAnswered);
  /**
   * **形の違う応答（`approvals` が配列でない）は「0件」ではなく「読めていない」へ倒す**
   * （issue #2308。外枠 `shell.tsx` の PR #2307 と同じ判断）。デーモンと画面は別デプロイで
   * 版がずれうる。`data.approvals.length` のままだと `TypeError` で画面ごと落ち、
   * `?? []` で黙らせると読めていないのに「答えを待っているものはない」と言う。
   * 型は配列と言っているので、ここが守るのは実行時の倒れ先だけである。
   */
  const approvalsList: PendingApproval[] | undefined = Array.isArray(data?.approvals)
    ? data.approvals
    : undefined;
  const approvalsMalformed = data !== undefined && approvalsList === undefined;
  /**
   * **取れなかったのを0件と描かない**（issue #2313）。一覧をまだ一度も読めていないまま
   * 失敗したとき、失敗は上の `ErrorNote` が言う。ここで「答えを待っているものはない」を
   * 並べると、読めていないのに承認待ちが無いように読め、承認を見落とす。再検証の失敗で
   * `data` が残っているときは当たらず、一覧をそのまま出す（#2266 と同じ）。
   */
  const listUnavailable = data === undefined && error !== undefined;
  // `unreadable` は、読めない行が1件以上あるときだけ載る欄（#2298）。形が違えば無いものとして扱う
  // （読めた一覧まで巻き込んで落とさない）。
  const unreadable: UnreadableApproval[] = Array.isArray(data?.unreadable) ? data.unreadable : [];
  const answerApprovals = useAnswerApprovals();

  /**
   * 各カードの下書き。**カードをまたいで持つのは「まとめて送る」の対象を決める
   * ためである。** 個別の「回答する」「許可」「却下」ボタンはこの下書きを直接見て
   * 動くので、1件ずつ内容を見て別々に答える自由はそのまま残る — まとめて送るのは
   * 「書かれた分をまとめて1回で送る」だけの追加であって、答え方を変えない。
   */
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  /** 直前のまとめ送信で駄目だった id ごとの理由。カードの下に出す。 */
  const [bulkErrors, setBulkErrors] = useState<Record<string, string>>({});
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkFailure, setBulkFailure] = useState<unknown>(undefined);

  function setDraft(id: string, text: string): void {
    setDrafts((current) => ({ ...current, [id]: text }));
  }

  function clearDraft(id: string): void {
    setDrafts((current) => without(current, id));
    setBulkErrors((current) => without(current, id));
  }

  // 今読み込めている未回答の一覧に実在するものだけを対象にする。別経路で
  // 先に片付いた下書きを、まとめ送信の対象へ混ぜないため。
  const unansweredIds = useMemo(
    () =>
      new Set(
        (approvalsList ?? [])
          .filter((approval) => !isAnswered(approval) && !isWithdrawn(approval))
          .map((a) => a.id),
      ),
    [approvalsList],
  );
  const pendingDrafts = Object.entries(drafts).filter(
    ([id, text]) => text.trim() !== '' && unansweredIds.has(id),
  );

  async function submitBulk(): Promise<void> {
    if (pendingDrafts.length === 0) return;
    setBulkBusy(true);
    setBulkFailure(undefined);
    try {
      const results = await answerApprovals(pendingDrafts.map(([id, answer]) => ({ id, answer })));
      const nextErrors: Record<string, string> = {};
      for (const result of results) {
        if (result.ok) {
          clearDraft(result.id);
        } else {
          nextErrors[result.id] = result.error ?? '不明な失敗';
        }
      }
      if (Object.keys(nextErrors).length > 0) {
        setBulkErrors((current) => ({ ...current, ...nextErrors }));
      }
    } catch (caught) {
      // 通信そのものが失敗した場合（サーバへ届いていない）。個々の id の成否は
      // まだ分からないので、下書きは消さずに残す。
      setBulkFailure(caught);
    } finally {
      setBulkBusy(false);
    }
  }

  return (
    <Page
      title="承認待ち"
      description="記憶に根拠が無かったこと。ここで答えると、同じ判断は次から聞かれなくなる"
    >
      {/*
        **表示の切り替えは見出しの `action` ではなく本文の先頭に置く（#2765）。**
        `Page` の見出し帯は横並び1行固定で、`action` は `shrink-0` のまま幅を取る。
        390px では「回答済み・取り下げ済みも見る」（194px）が居座り、題と説明文が
        残りの約148pxに押し込まれて説明文が4行（末尾が1文字残り）になった。
        これは一覧の絞り込みであって見出しの操作ではないので、本文の側で右寄せにする。
      */}
      <div className="mb-4 flex justify-end">
        <Button size="sm" onClick={() => setShowAnswered((v) => !v)}>
          {showAnswered ? '未回答だけ' : '回答済み・取り下げ済みも見る'}
        </Button>
      </div>
      <ErrorNote error={error} className="mb-4" />
      <UnreadableApprovalNote unreadable={unreadable} />

      {unansweredIds.size > 0 && (
        <div className="mb-4 flex flex-wrap items-center gap-3 rounded-md border border-border bg-card px-3 py-2">
          <span className="text-sm text-muted-foreground">
            {pendingDrafts.length === 0
              ? 'まとめて送る答えはまだ書かれていない（各カードに書くとここに数が出る）'
              : `${pendingDrafts.length} 件に答えを書いた（送るとまとめて1回で届く）`}
          </span>
          <Button
            variant="primary"
            size="sm"
            loading={bulkBusy}
            disabled={pendingDrafts.length === 0}
            onClick={() => void submitBulk()}
          >
            まとめて送る
          </Button>
        </div>
      )}
      <ErrorNote error={bulkFailure} className="mb-4" />

      {isLoading ? (
        <Spinner />
      ) : listUnavailable ? null : approvalsMalformed ? (
        // **0件と描かない**（issue #2308）。応答は届いたが、一覧の形をしていない。
        <ErrorNote
          error={
            new Error(
              '承認待ちの一覧が読めない形で届いた（サーバと画面の版がずれている可能性がある）。' +
                '答えを待っているものが無いという意味ではない。',
            )
          }
          className="mb-4"
        />
      ) : approvalsList === undefined || approvalsList.length === 0 ? (
        <Card>
          <Empty>
            {showAnswered
              ? '記録がまだない。'
              : unreadable.length > 0
                ? '読めた範囲では、答えを待っているものはない。'
                : '答えを待っているものはない。クローンは進んでいる。'}
          </Empty>
        </Card>
      ) : (
        <ul className="flex flex-col gap-3">
          {approvalsList.map((approval) => (
            <li key={approval.id}>
              <ApprovalEntry
                approval={approval}
                draft={drafts[approval.id] ?? ''}
                onDraftChange={(text) => setDraft(approval.id, text)}
                onAnswered={() => clearDraft(approval.id)}
                bulkError={bulkErrors[approval.id]}
              />
            </li>
          ))}
        </ul>
      )}
    </Page>
  );
}

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
function ApprovalEntry({
  approval,
  draft,
  onDraftChange,
  onAnswered,
  bulkError,
}: {
  approval: PendingApproval;
  /** まとめて送るための下書き。親が持つので、カードをまたいで数えられる。 */
  draft: string;
  onDraftChange: (text: string) => void;
  /** この id に答えが通った（個別送信・まとめ送信どちらでも呼ぶ）。 */
  onAnswered: () => void;
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
