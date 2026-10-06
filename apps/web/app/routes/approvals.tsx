import { AlertTriangle } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { ApprovalEntry } from '~/components/approval-entry';
import {
  isApprovalAnswered,
  isApprovalWithdrawn,
  type SentApprovalDraft,
} from '~/components/approval-answer-card';
import { ApprovalsTabs } from '~/components/group-tabs';
import {
  Page,
  Button,
  Card,
  CodeBlock,
  EMPTY_QUESTIONS_DRAFT,
  Empty,
  ErrorNote,
  Spinner,
  type ApprovalQuestionsDraft,
} from '@alteroid/ui';
import { useAnswerApprovals, useApprovals } from '@alteroid/swr';
import {
  chatDraftEpoch,
  describeApprovalLeftover,
  isEmptyQuestionsDraft,
  loadApprovalDrafts,
  loadApprovalLeftoverSources,
  saveApprovalDrafts,
  saveApprovalLeftoverSources,
  settleApprovalDraft,
  type ApprovalDrafts,
  type ApprovalLeftoverSources,
  type PendingApproval,
  type UnreadableApproval,
} from '@alteroid/logic';

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
        未回答の一覧にも、回答済みの一覧にも載っていない。
      </span>
    </div>
  );
}

/**
 * 答えは通ったが、送らなかった下書きが残っている承認（issue #3515・#3625）。**黙って消さない。**
 * 承認はもう決着していて回答欄が無いので、残った文をここへ出す。写してから閉じられる。
 */
function LeftoverDrafts({
  leftovers,
  onDiscard,
}: {
  leftovers: { id: string; source: { question: string }; text: string }[];
  onDiscard: (id: string) => void;
}) {
  if (leftovers.length === 0) return null;
  return (
    <ul className="mb-4 flex flex-col gap-3" aria-label="送らなかった下書きが残っている承認">
      {leftovers.map(({ id, source, text }) => (
        <li key={id} className="rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-sm">
          <p className="mb-2 break-words">
            <strong>答えは通ったが、送らなかった下書きが残っている。</strong>
            承認はもう決着しているので、ここから送り直すことはできない。必要なら写してから閉じる。
            <span className="mt-1 block text-xs text-muted-foreground">
              対象: {source.question}
            </span>
          </p>
          <CodeBlock label="残った文" maxHeight="12rem">
            {text}
          </CodeBlock>
          <div className="mt-2">
            <Button size="sm" onClick={() => onDiscard(id)}>
              閉じる（捨てる）
            </Button>
          </div>
        </li>
      ))}
    </ul>
  );
}

export default function Approvals() {
  /**
   * **未回答だけを読む**（`GET /approvals?pending=true`）。回答済み・取り下げ済みは別のページ
   * （`approvals-answered.tsx`。タブの「回答済み」）で、日付ごとに読む。
   */
  const { data, error, isLoading } = useApprovals(true);
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
   * 各カードの下書き（自由記述と設問の選択）。**カードをまたいで持つのは「まとめて送る」の対象を
   * 決めるためである。** 個別の「回答する」「許可」「却下」ボタンはこの下書きを直接見て
   * 動くので、1件ずつ内容を見て別々に答える自由はそのまま残る — まとめて送るのは
   * 「書かれた分をまとめて1回で送る」だけの追加であって、答え方を変えない。
   *
   * **`sessionStorage` にも写す**（issue #3295）。「回答済み」タブへ移るとこのページは unmount
   * されるので、state だけでは書きかけが黙って消える。初期値は保存したものから読む。
   */
  const [drafts, setDraftsState] = useState<ApprovalDrafts>(loadApprovalDrafts);
  /**
   * 書きかけを最後に決めた時点の `chatDraftEpoch()`（#3706）。ログアウトで消したあとに、メモリに残った
   * 書きかけが書き戻らないよう、保存はこの値が今と同じときだけ行う。
   */
  const draftsEpoch = useRef(chatDraftEpoch());
  const setDrafts = useCallback((update: React.SetStateAction<ApprovalDrafts>) => {
    draftsEpoch.current = chatDraftEpoch();
    setDraftsState(update);
  }, []);
  /** 答えが通った承認の、本文と設問の控え（残った下書きを見せるため。issue #3515）。 */
  const [leftoverSources, setLeftoverSources] = useState<ApprovalLeftoverSources>(
    loadApprovalLeftoverSources,
  );
  /** 直前のまとめ送信で駄目だった id ごとの理由。カードの下に出す。 */
  const [bulkErrors, setBulkErrors] = useState<Record<string, string>>({});
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkFailure, setBulkFailure] = useState<unknown>(undefined);
  /** 同じ描画の中の2回目の押下を止める（state は次の描画まで古い）。 */
  const bulkBusyRef = useRef(false);
  /**
   * 送信中の id（カードの個別送信とまとめ送信の両方。#3626）。まとめ送信の対象から外し、
   * 保存先の下書きも送信中は落とさない（#3666。一覧から消える描画と、答えが通ったあとに
   * 下書きを畳む・残すまでの間の一瞬）。ref は押下の直後に読むため、state は描画のため。
   */
  const sendingIdsRef = useRef<Set<string>>(new Set());
  const [sendingIds, setSendingIds] = useState<ReadonlySet<string>>(new Set());

  function setSending(ids: readonly string[], sending: boolean): void {
    const next = new Set(sendingIdsRef.current);
    for (const id of ids) {
      if (sending) next.add(id);
      else next.delete(id);
    }
    sendingIdsRef.current = next;
    setSendingIds(next);
  }

  function setDraft(id: string, text: string): void {
    setDrafts((current) => ({
      ...current,
      texts: text === '' ? without(current.texts, id) : { ...current.texts, [id]: text },
    }));
  }

  function setQuestionsDraft(id: string, draft: ApprovalQuestionsDraft): void {
    setDrafts((current) => ({
      ...current,
      questions: isEmptyQuestionsDraft(draft)
        ? without(current.questions, id)
        : { ...current.questions, [id]: draft },
    }));
  }

  /**
   * 答えが通った。**送った時点の下書き（`sent`）と同じ項目だけ**畳み、応答を待つ間に打ち足した
   * 分は残す（issue #3515）。残したものは、承認が未回答の一覧から消えたあとも
   * 「送らなかった下書きが残っている」として見せる（`leftovers`）。
   */
  function settleDraft(approval: PendingApproval, sent: SentApprovalDraft): void {
    setDrafts((current) => settleApprovalDraft(current, approval.id, sent));
    setLeftoverSources((current) => ({
      ...current,
      [approval.id]: { question: approval.question, questions: approval.questions ?? undefined },
    }));
    setBulkErrors((current) => without(current, approval.id));
  }

  /** 残った下書きを使い手が閉じる（写し終えた・要らない）。 */
  function discardLeftover(id: string): void {
    setDrafts((current) => ({
      texts: without(current.texts, id),
      questions: without(current.questions, id),
    }));
    setLeftoverSources((current) => without(current, id));
  }

  // 今読み込めている未回答の一覧に実在するものだけを対象にする。別経路で
  // 先に片付いた下書きを、まとめ送信の対象へ混ぜないため。
  const unansweredIds = useMemo(
    () =>
      new Set(
        (approvalsList ?? [])
          .filter((approval) => !isApprovalAnswered(approval) && !isApprovalWithdrawn(approval))
          .map((a) => a.id),
      ),
    [approvalsList],
  );
  /**
   * 保存するのは、一覧から消えた id（回答済み・取り下げ）を除いたもの。**一覧を読めているときだけ**
   * 除く（`approvalsList` が在るとき）。読み込みに失敗して空に見えるだけのときは除かない
   * （書きかけを黙って失わせない。`approvalsList` は失敗・形の違う応答では `undefined`）。
   */
  const liveDrafts = useMemo<ApprovalDrafts>(() => {
    if (approvalsList === undefined) return drafts;
    // 答えが通ったあとに残した下書き（`leftoverSources` に在る id）は、一覧から消えても保つ。
    const keep = (id: string) =>
      unansweredIds.has(id) || id in leftoverSources || sendingIds.has(id);
    return {
      texts: Object.fromEntries(Object.entries(drafts.texts).filter(([id]) => keep(id))),
      questions: Object.fromEntries(Object.entries(drafts.questions).filter(([id]) => keep(id))),
    };
  }, [drafts, approvalsList, unansweredIds, leftoverSources, sendingIds]);
  useEffect(() => {
    saveApprovalDrafts(liveDrafts, draftsEpoch.current);
  }, [liveDrafts]);
  /**
   * 答えが通ったのに下書きが残っている承認。**まだ未回答の一覧に載っている間は出さない**
   * （カードの回答欄にそのまま見えている。一覧の再取得で消えたら出る）。
   */
  const leftovers = useMemo(
    () =>
      Object.entries(leftoverSources)
        .filter(([id]) => !unansweredIds.has(id))
        .map(([id, source]) => ({ id, source, text: describeApprovalLeftover(source, drafts, id) }))
        .filter((entry) => entry.text !== ''),
    [leftoverSources, unansweredIds, drafts],
  );
  const liveLeftoverSources = useMemo<ApprovalLeftoverSources>(
    () =>
      Object.fromEntries(
        Object.entries(leftoverSources).filter(
          ([id]) => id in drafts.texts || id in drafts.questions,
        ),
      ),
    [leftoverSources, drafts],
  );
  useEffect(() => {
    saveApprovalLeftoverSources(liveLeftoverSources);
  }, [liveLeftoverSources]);
  const pendingDrafts = Object.entries(drafts.texts).filter(
    ([id, text]) => text.trim() !== '' && unansweredIds.has(id) && !sendingIds.has(id),
  );

  async function submitBulk(): Promise<void> {
    // 送信中は何もしない（二重に送らない。#3626）。
    if (bulkBusyRef.current) return;
    // 描画を待たず、いまカードが送信中の id も外す。
    const targets = pendingDrafts.filter(([id]) => !sendingIdsRef.current.has(id));
    if (targets.length === 0) return;
    bulkBusyRef.current = true;
    // 送る id を送信中として持つ。答えが通って一覧から消える描画のあいだも、保存先の下書きを
    // 落とさない（#3666。下の `settleDraft` で畳む・残すが決まるまで）。
    const targetIds = targets.map(([id]) => id);
    setSending(targetIds, true);
    // 送るときに下書きを控える。応答を待つ間に打ち足した分を、成功のあとに消さないため。
    const sentTexts = drafts.texts;
    const sentQuestions = drafts.questions;
    setBulkBusy(true);
    setBulkFailure(undefined);
    try {
      const results = await answerApprovals(targets.map(([id, answer]) => ({ id, answer })));
      const nextErrors: Record<string, string> = {};
      for (const result of results) {
        if (result.ok) {
          const approval = approvalsList?.find((a) => a.id === result.id);
          if (approval !== undefined) {
            settleDraft(approval, {
              text: sentTexts[result.id] ?? '',
              questions: sentQuestions[result.id],
            });
          }
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
      bulkBusyRef.current = false;
      setSending(targetIds, false);
      setBulkBusy(false);
    }
  }

  return (
    <Page
      tabs={<ApprovalsTabs />}
      title="承認待ち"
      description="記憶に根拠が無かったこと。ここで答えると、同じ判断は次から聞かれなくなる"
    >
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
      <LeftoverDrafts leftovers={leftovers} onDiscard={discardLeftover} />

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
            {unreadable.length > 0
              ? '読めた範囲では、答えを待っているものはない。'
              : '答えを待っているものはない。クローンは進んでいる。'}
          </Empty>
        </Card>
      ) : (
        <ul className="flex flex-col gap-3" aria-label="承認待ちの一覧">
          {approvalsList.map((approval) => (
            <li key={approval.id}>
              <ApprovalEntry
                approval={approval}
                draft={drafts.texts[approval.id] ?? ''}
                onDraftChange={(text) => setDraft(approval.id, text)}
                questionsDraft={drafts.questions[approval.id] ?? EMPTY_QUESTIONS_DRAFT}
                onQuestionsDraftChange={(next) => setQuestionsDraft(approval.id, next)}
                onAnswered={(sent) => settleDraft(approval, sent)}
                bulkError={bulkErrors[approval.id]}
                bulkBusy={bulkBusy}
                onSendingChange={(sending) => setSending([approval.id], sending)}
              />
            </li>
          ))}
        </ul>
      )}
    </Page>
  );
}
