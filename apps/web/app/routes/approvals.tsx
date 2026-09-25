import { useMemo, useState } from 'react';

import { Markdown } from '~/components/markdown';
import { Page } from '~/components/page';
import { Badge, Button, Card, Empty, ErrorNote, Spinner, Textarea } from '~/components/ui';
import { useAnswerApproval, useAnswerApprovals } from '~/hooks/mutations';
import { useApprovalTrace, useApprovals, useConversation } from '~/hooks/queries';
import { cn } from '~/lib/cn';
import { formatDateTime, formatRelative } from '~/lib/format';
import type { PendingApproval } from '~/lib/types';

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

export default function Approvals() {
  const [showAnswered, setShowAnswered] = useState(false);
  const { data, error, isLoading } = useApprovals(!showAnswered);
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
        (data?.approvals ?? [])
          .filter((approval) => !isAnswered(approval) && !isWithdrawn(approval))
          .map((a) => a.id),
      ),
    [data],
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
      action={
        <Button size="sm" onClick={() => setShowAnswered((v) => !v)}>
          {showAnswered ? '未回答だけ' : '回答済み・取り下げ済みも見る'}
        </Button>
      }
    >
      <ErrorNote error={error} className="mb-4" />

      {unansweredIds.size > 0 && (
        <div className="mb-4 flex flex-wrap items-center gap-3 rounded-md border border-border bg-surface px-3 py-2">
          <span className="text-sm text-muted">
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
      ) : data === undefined || data.approvals.length === 0 ? (
        <Card>
          <Empty>
            {showAnswered
              ? '記録がまだない。'
              : '答えを待っているものはない。クローンは進んでいる。'}
          </Empty>
        </Card>
      ) : (
        <ul className="flex flex-col gap-3">
          {data.approvals.map((approval) => (
            <li key={approval.id}>
              <ApprovalCard
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

function ApprovalCard({
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

  async function submit(text: string) {
    if (text.trim() === '') return;
    setBusy(true);
    setFailure(undefined);
    try {
      await answerApproval(approval.id, text);
      onAnswered();
    } catch (caught) {
      setFailure(caught);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="p-4">
      {/*
        **本3 で `Badge` に `shrink-0` が入り、縮まなくなった。** メタ行の
        バッジ（未回答/回答済/取り下げ済）は文字数を持たないので普段は
        問題ないが、`job {jobId}` は `z.string()` に長さの上限が無く、他の
        バッジ・時刻表示と合わせて `flex-wrap` が無いと押し出す側へ振れる。
        同じ画面の `:98`（`flex flex-wrap items-center gap-3 ...`）に既に
        在る流儀へ揃える。

        **取り下げ済み（`accent`）を回答済み（`neutral`）と別のトーンにする
        （#963）。** 両方とも「もう待っていない」点は同じだが、次の一手が
        違う——回答済みは人間が既に応えた終端、取り下げ済みはクローンが
        自分で不要と判断した終端で、混同すると「答えたのに何も起きて
        いない」ように見える。
      */}
      <div className="mb-2 flex flex-wrap items-center gap-2 text-[11px] text-muted">
        <Badge tone={withdrawn ? 'accent' : answered ? 'neutral' : 'warn'}>
          {withdrawn ? '取り下げ済' : answered ? '回答済' : '未回答'}
        </Badge>
        <span>{formatDateTime(approval.createdAt)}</span>
        <span>({formatRelative(approval.createdAt)})</span>
        {approval.jobId !== undefined && approval.jobId !== null && (
          <span className="font-mono">job {approval.jobId}</span>
        )}
      </div>

      {/*
        **クローン（AI）が書いた文字列だけを Markdown で描く。** `question` は
        クローンが書いた設問なのでこの線の内側である（線そのものの根拠は下の
        `answer` の側のコメントに在る）。

        **`whitespace-pre-wrap` は外してよい。** `Markdown` は `remark-breaks` を
        積んでいて単独の改行を `<br>` にするので、行区切りはこれまでどおり保たれる
        （`apps/web/app/components/markdown.tsx` の doc に理由が逐語で在る）。
      */}
      <Markdown>{approval.question}</Markdown>

      {approval.context !== undefined && approval.context !== null && approval.context !== '' && (
        /*
          `context` もクローンが書いた文字列なので Markdown で描く。

          **スクロールの箱（`max-h-48 overflow-y-auto`）は残す。** 外すと長い背景が
          回答欄を画面外へ押し出す。`apps/web/app/components/page.tsx`
          （`grep -Fn -- 'スクロールへ閉じ込める' apps/web/app/components/page.tsx`）と
          `apps/web/app/routes/manager-detail.tsx` の `RequestCard` が同じ流儀 —
          **文字は1つも捨てず、スクロールへ閉じ込める。**

          `min-w-0` は中の表・コードブロックが `overflow-x-auto` で収まるため
          （`markdown.tsx` の `table` / `pre` が横スクロールを持つ）。`text-xs` は
          落とす — `Markdown` のルートが `text-sm` を持つので、外から掛けても効かない。
        */
        <div className="mt-2 max-h-48 min-w-0 overflow-y-auto rounded border border-border bg-bg p-2 text-muted">
          <Markdown>{approval.context}</Markdown>
        </div>
      )}

      {withdrawn ? (
        /*
          **クローンが取り下げた件（#963）。** 回答欄は出さない——`answered`の
          分岐と同じ理由で、取り下げも「もう入力を受け付ける状態ではない」
          終端である。`withdrawnReason` はクローンが書いた自由文だが、
          `answer`（人間の発言）と同じ枠に置くので素のテキストのままにする
          （Markdown にするかどうかで枠の意味を変えない）。
        */
        <p className="mt-3 rounded border border-border bg-bg p-2 text-sm break-words whitespace-pre-wrap">
          <span className="mr-2 text-[11px] text-muted">取り下げた理由</span>
          {approval.withdrawnReason ?? '（理由の記録なし）'}
        </p>
      ) : answered ? (
        /*
          **`answer` は Markdown にしない。** これは人間が打った文だからである。
          repo の既存方針が `apps/web/app/routes/chat.tsx`
          （`grep -Fn -- 'クローンの行だけを Markdown にする' apps/web/app/routes/chat.tsx`）
          に逐語で在る —
          「**クローンの行だけを Markdown にする。** 人間が打った本文
          （`role === 'human'`）は素のテキストのままにする — 自分が書いた文字が
          勝手に化けないため」。`question` / `context` はクローンが書いた文字列
          なので線の内側だが、`answer` は外側である。**「承認待ちも全部 Markdown に
          しよう」と思ったら、まずその行を読むこと**（`approvals.test.tsx` の
          「answer は Markdown の描画経路を通らない」がこの判断を押さえている）。

          **`whitespace-pre-wrap` は Markdown 化とは別の、不具合の修正である。**
          `apps/web/app/app.css` の `white-space` 指定は `pre` に対する1件だけで
          `p` を狙う規則が無いため、ここは CSS 既定の `white-space: normal` で
          描かれていた — 人間が改行を入れて答えても1行に潰れていた（`question` /
          `context` には効いていたのに `answer` だけ無いという見落としである）。
        */
        <>
          <p className="mt-3 rounded border border-border bg-bg p-2 text-sm break-words whitespace-pre-wrap">
            <span className="mr-2 text-[11px] text-muted">回答</span>
            {approval.answer}
          </p>
          {/*
            **回答経路（Issue #1479）。** 記録が無い（`answeredVia` を持たない古い
            経路で答えられた）行では出さない——「わからない」を「operator では
            ない」に化けさせない（`packages/core/src/schema.ts` の
            `answeredViaSchema` の doc）。`describeAnsweredVia` はこの画面が
            `@alteroid/core` を import できないため独立に持つ
            （`describeAction` と同じ理由・同じパターン）。
          */}
          {approval.answeredVia && (
            <p className="mt-1 text-[11px] text-muted">
              回答経路: {describeAnsweredVia(approval.answeredVia)}
            </p>
          )}
        </>
      ) : (
        <div className="mt-3">
          <Textarea
            rows={2}
            value={draft}
            placeholder="答える（書いておくと「まとめて送る」の対象になる。この場ですぐ送ってもよい）"
            onChange={(event) => onDraftChange(event.target.value)}
            onKeyDown={(event) => {
              // 長文になりうるので Enter は改行のまま。送信は Cmd/Ctrl+Enter。
              if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                event.preventDefault();
                void submit(draft);
              }
            }}
          />
          {/*
            **本3 で `Button` が狭い画面で `h-11`（44px）になり、以前より
            横幅を食う。** ボタン3つ＋ショートカット表示が横一列に並ぶこの行は
            折り返さないと画面外へ出る側へ振れるので `flex-wrap` を足す。
          */}
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Button
              variant="primary"
              size="sm"
              loading={busy}
              disabled={draft.trim() === ''}
              onClick={() => void submit(draft)}
            >
              回答する
            </Button>
            <Button size="sm" disabled={busy} onClick={() => void submit('はい、進めてよい')}>
              許可
            </Button>
            <Button size="sm" disabled={busy} onClick={() => void submit('いいえ、やらないで')}>
              却下
            </Button>
            <span className="text-[11px] text-muted">⌘/Ctrl + Enter</span>
          </div>
        </div>
      )}

      {/*
        **答えの後にクローンが何をしたか（issue #847 の案B）。** 答え済みの件だけに
        出し、開いたときだけ読む（`useApprovalTrace` の doc）。
      */}
      {answered && !withdrawn && <TracePanel approvalId={approval.id} />}

      <ErrorNote error={failure} className="mt-2" />
      {bulkError !== undefined && (
        <ErrorNote error={`まとめて送った回答は通らなかった: ${bulkError}`} className="mt-2" />
      )}

      {/*
        **この確認が上がった会話（issue #782 の3）。** 承認だけを見ていると、
        クローンが実際にこの人間と何を話していたかが分からない。4状態を
        別々に出す（`ConversationPanel` の doc）。
      */}
      <div className="mt-3 border-t border-border pt-3">
        {approval.conversationId === undefined || approval.conversationId === null ? (
          <p className="text-[11px] text-muted italic">
            この確認は会話に紐づいていない（マネージャー発・内部ターンには紐づけられる会話が存在しない）
          </p>
        ) : (
          <ConversationPanel conversationId={approval.conversationId} />
        )}
      </div>
    </Card>
  );
}

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
      <p className="mt-2 text-[11px] text-muted italic">
        {TRACE_MISSING[data.state] ?? `対が無い（${data.state}）`}
        {data.truncated ? `（答えの後 ${data.scanned} 行までしか見ていない）` : ''}
      </p>
    );
  }
  return (
    <div className="mt-2">
      <p className="mb-1 text-[11px] font-semibold text-muted">
        答えの後の行動（この承認の印を持つもの。古い順）
      </p>
      <ul className="flex flex-col gap-1">
        {data.actions.map((entry) => (
          <li
            key={entry.id}
            className="rounded border border-border bg-surface-2 p-2 text-xs break-words whitespace-pre-wrap"
          >
            <span className="mr-1 text-[10px] text-muted">
              {formatDateTime(entry.at)} {entry.type}
            </span>
            {describeAction(entry)}
          </li>
        ))}
      </ul>
      {data.actionsOmitted > 0 && (
        <p className="mt-1 text-[11px] text-muted">
          ほか {data.actionsOmitted} 件は数えただけで持っていない
        </p>
      )}
      {data.unstampedInTurn > 0 && (
        <p className="mt-1 text-[11px] text-muted">
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
 * `approval.answeredVia`（Issue #1479）を人間が読む1行にする（core の
 * `describeAnsweredVia` と同じ規則。画面は `@alteroid/core` の値を import
 * しない——`~/lib/types.ts` 冒頭の約束——ので、ここで独立に持つ）。
 */
function describeAnsweredVia(via: NonNullable<PendingApproval['answeredVia']>): string {
  if (via.kind === 'account') return `account（${via.accountId}）`;
  return via.auth === 'disabled' ? 'operator（認証無効）' : 'operator（operator token）';
}

/** 行動1件の要旨（core の `describeTraceAction` と同じ欄を読む。画面は core を import しない）。 */
function describeAction(entry: { type: string } & Record<string, unknown>): string {
  const str = (key: string) => (typeof entry[key] === 'string' ? (entry[key] as string) : '');
  switch (entry.type) {
    case 'decision':
      return `判断: ${str('decision')}（根拠: ${str('grounds')}）`;
    case 'memory_update':
      return `記憶の更新 ${str('action') || 'write'} ${str('slug')}: ${str('summary')}`;
    case 'tool_use':
      return `道具 ${str('tool')}${entry.input === undefined ? '' : `: ${JSON.stringify(entry.input)}`}`;
    case 'exchange':
      return str('text');
    default:
      return entry.type;
  }
}

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
    return <p className="text-[11px] text-muted italic">この会話にはまだクローンの発言が無い</p>;
  }

  // ④ 在る。
  return (
    <div>
      <p className="mb-2 text-[11px] font-semibold text-muted">この確認が上がった会話</p>
      <ul className="flex flex-col gap-2">
        {messages.map((message) => (
          <li
            key={message.id}
            className={cn(
              'rounded border border-border p-2 text-xs break-words whitespace-pre-wrap',
              message.role === 'inbound' ? 'bg-bg' : 'bg-surface-2',
            )}
          >
            <span className="mr-1 text-[10px] text-muted">
              {message.role === 'inbound' ? '人間' : 'クローン'}
            </span>
            {message.text}
          </li>
        ))}
      </ul>
    </div>
  );
}
