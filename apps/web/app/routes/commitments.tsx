import { DiscardConfirmDialog } from '~/components/discard-confirm-dialog';
import { FilterNote } from '~/components/filter-note';
import { WorkTabs } from '~/components/group-tabs';
import { LoadError } from '~/components/load-error';
import { ReopenForm } from '~/components/reopen-form';
import { EditedBadge } from '~/components/task-parts';
import { clipRawValue } from '~/lib/clip-raw-value';
import { duplicateParamNotice } from '~/lib/duplicate-param-notice';
import { useReportDirty, LeaveGuardScope } from '~/lib/leave-guard';
import { useDiscardGuard } from '~/lib/use-discard-guard';
import { useLatest } from '~/lib/use-latest';
import { useReplaceSearchParams } from '~/lib/use-replace-search-params';
import { formatRelativeAtMinute, useMinuteNow } from '~/lib/use-now';
import { UNREADABLE_IDS_SHOWN, unreadableIdsNote } from '~/lib/unreadable-ids-note';
import { unsentInput } from '~/lib/unsent-input';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useLocation } from 'react-router';

import {
  Markdown,
  Page,
  Badge,
  Button,
  Card,
  CardHeader,
  CodeBlock,
  Empty,
  ErrorNote,
  FieldHint,
  Spinner,
  SubmitHint,
  Textarea,
  WarnNote,
} from '@alteroid/ui';
import {
  useReopenCommitment,
  usePushCommitment,
  useCommitments,
  useCommitment,
  ApiError,
} from '@alteroid/swr';
import { formatDateTime, redactBody } from '@alteroid/logic';
import type { CommitmentClosedBy } from '@alteroid/core';
import type { Commitment, UnreadableCommitment, UnreadableJob } from '@alteroid/logic';

import { AnsweredStateBadge, InProgressBadge, OriginBadge } from './commitments-badges';
import { CommitmentBody } from './commitments-body';
import { CloseReasonForm, planFocusAfterRemoval } from './commitments-close-reason';
import { CommitmentBodyEditor } from './commitments-edit';
import {
  isEmptyNote,
  sameNote,
  snippet,
  withoutKey,
  type RowNote,
  type RowNotePatch,
} from './commitments-row-note';

/** 並べ替えや優先度の札を足さない: 足すと「やることの一覧」になってしまうため。 */
export default function Commitments() {
  const { pathname } = useLocation();
  return (
    <LeaveGuardScope staysOn={(next) => next === pathname}>
      <CommitmentsPage />
    </LeaveGuardScope>
  );
}

const CLOSED_PARAM = 'closed';

function CommitmentsPage() {
  const [searchParams, replaceParams] = useReplaceSearchParams();
  const rawClosed = searchParams.get(CLOSED_PARAM);
  const showClosed = rawClosed === '1';
  const invalidClosed =
    rawClosed !== null && rawClosed !== '' && rawClosed !== '1' ? rawClosed : null;
  const duplicateClosed = searchParams.getAll(CLOSED_PARAM).length > 1;
  const toggleClosed = () =>
    replaceParams((params) => {
      if (showClosed) params.delete(CLOSED_PARAM);
      else params.set(CLOSED_PARAM, '1');
    });
  const { data, error, isLoading, isValidating, mutate } = useCommitments(showClosed);

  // ここで並べ直さない: 並べ直すと齢の見え方が CLI・クローンと食い違う。
  const all = data?.entries ?? [];
  const open = all.filter((commitment) => !isClosed(commitment));
  const closed = all.filter(isClosed);
  const unreadable = data?.unreadable ?? [];
  const trimmedClosed = data?.trimmedClosed ?? 0;
  // 取れなかったのを0件と描かない: 読めていないのに「仕事はない」と読めてしまうため。
  const listUnavailable = data === undefined && error !== undefined;

  // 行が裏で片付いて一覧から外れると OpenRow ごと unmount され、書きかけも 409 の本文も消えるので、ここへも写す。
  const [notes, setNotes] = useState<Readonly<Record<string, RowNote>>>({});
  const track = useCallback((commitment: Commitment, patch: RowNotePatch) => {
    setNotes((current) => {
      const before = current[commitment.id];
      const merged: RowNote = { ...before, ...patch, commitment };
      if (isEmptyNote(merged)) {
        if (before === undefined) return current;
        return withoutKey(current, commitment.id);
      }
      if (before !== undefined && sameNote(before, merged)) return current;
      return { ...current, [commitment.id]: merged };
    });
  }, []);
  const [settling, setSettling] = useState<ReadonlySet<string>>(new Set());
  const markSettling = useCallback((id: string, on: boolean) => {
    setSettling((current) => {
      if (current.has(id) === on) return current;
      const next = new Set(current);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);
  const dismissNote = useCallback((id: string) => {
    setNotes((current) => withoutKey(current, id));
  }, []);
  // 一覧を読めているときだけ外れたと見る: 読み込み中・失敗で空に見えるだけのときに、書きかけを断りへ変えないため。
  const orphans = (() => {
    if (data === undefined) return [];
    const openIds = new Set([...open.map((c) => c.id), ...unreadable.map((u) => u.id)]);
    return Object.values(notes)
      .filter((note) => !openIds.has(note.commitment.id) && !settling.has(note.commitment.id))
      .map((note) => ({ note, current: all.find((c) => c.id === note.commitment.id) }));
  })();

  return (
    <Page
      tabs={<WorkTabs />}
      title="未了の仕事"
      description="受信箱でも日誌でもここには残らない。忘れさせないための場所であって、やることの一覧ではない"
      action={
        <Button size="sm" onClick={toggleClosed}>
          {showClosed ? '未了だけ' : '片付けたものも見る'}
        </Button>
      }
    >
      <LoadError
        what="未了の仕事の一覧"
        error={error}
        onRetry={() => mutate()}
        retrying={isValidating}
        className="mb-4"
      />

      {invalidClosed !== null && (
        <p className="mb-4 text-xs text-warn">
          {`指定された値（${clipRawValue(invalidClosed)}）は読めないので、未了だけで表示しています`}
        </p>
      )}
      {duplicateClosed && <FilterNote>{duplicateParamNotice('「片付けたものも見る」')}</FilterNote>}

      <PushForm />

      {isLoading && data === undefined ? (
        <Spinner />
      ) : listUnavailable ? null : (
        <>
          <UnreadableNote unreadable={unreadable} onTrack={track} onSettling={markSettling} />
          <UnreadableJobsNote unreadableJobs={data?.unreadableJobs ?? []} />
          <TrimmedClosedNote trimmedClosed={trimmedClosed} />

          <OrphanNotes orphans={orphans} onDismiss={dismissNote} />

          <Card className="mb-4">
            <div data-open-list-header="">
              <CardHeader
                title="未了"
                subtitle="古い順。齢がそのまま「どれだけ放置されているか」である"
              />
            </div>
            {open.length === 0 ? (
              <Empty>
                {unreadable.length > 0 || (data?.unreadableJobs ?? []).length > 0
                  ? '読めた範囲では、未了の仕事はない。'
                  : '未了の仕事はない。'}
              </Empty>
            ) : (
              <ul>
                {open.map((commitment) => (
                  <OpenRow
                    key={commitment.id}
                    commitment={commitment}
                    onTrack={track}
                    onSettling={markSettling}
                  />
                ))}
              </ul>
            )}
          </Card>

          {showClosed && (
            <Card>
              <CardHeader
                title="完了した仕事"
                subtitle="新しい順。何をもって終わりとしたかを残す"
              />
              {closed.length === 0 && isLoading ? (
                // 閉じた分の初回読み込み中は前のキー（未了だけ）の一覧が data に載っている: ここで「記録はまだない」と言うと、読めていないのに無いと読める。
                <Spinner />
              ) : closed.length === 0 && error !== undefined ? null : closed.length === 0 ? (
                <Empty>
                  {trimmedClosed > 0
                    ? '残っている範囲に、完了した仕事の記録はない。'
                    : unreadable.length > 0
                      ? // 読めない行は片付いた行かもしれないので、完了の側も言い切れない。
                        '読めた範囲では、完了した仕事の記録はない。'
                      : '完了した仕事の記録はまだない。'}
                </Empty>
              ) : (
                <ul>
                  {closed.map((commitment) => (
                    <ClosedRow key={commitment.id} commitment={commitment} />
                  ))}
                </ul>
              )}
            </Card>
          )}
        </>
      )}
    </Page>
  );
}

function isClosed(commitment: Commitment): boolean {
  return commitment.closedAt !== undefined && commitment.closedAt !== null;
}

// 「無い」でも「片付いた」でもない第3の状態を `Empty` の顔にしない: `Empty` は「無い」を表す部品なので、読めない行を混ぜると「特に何も無い」に見えるため。
// 0件なら描かない: 常に出る断りは、出ていることが情報にならない。
function UnreadableNote({
  unreadable,
  onTrack,
  onSettling,
}: {
  unreadable: UnreadableCommitment[];
  onTrack: (commitment: Commitment, patch: RowNotePatch) => void;
  onSettling: (id: string, on: boolean) => void;
}) {
  // 閉じる入口は未了の一覧に載る id にだけ出す: 閉じた読めない行は閉じたかが公開されず、閉じようとすると必ず 409 になるため。
  const unclosed = useCommitments(false).data?.unreadable;
  if (unreadable.length === 0) return null;
  const idsAll = unreadable.map((entry) => entry.id).filter((id): id is string => id != null);
  const closable = idsAll
    .filter((id) => unclosed?.some((entry) => entry.id === id))
    .slice(0, UNREADABLE_IDS_SHOWN);
  return (
    <WarnNote className="mb-4" block>
      読めない行が {unreadable.length} 件ある
      {unreadableIdsNote('id', idsAll)}。<strong>片付いたのではない。</strong>
      {closable.length > 0 && (
        <>
          <p className="mt-2 text-xs">
            閉じても中身は読めないままなので、「片付けたものも見る」に本文は出ない。
          </p>
          <ul>
            {closable.map((id) => (
              <UnreadableClose key={id} id={id} onTrack={onTrack} onSettling={onSettling} />
            ))}
          </ul>
        </>
      )}
    </WarnNote>
  );
}

function UnreadableClose({
  id,
  onTrack,
  onSettling,
}: {
  id: string;
  onTrack: (commitment: Commitment, patch: RowNotePatch) => void;
  onSettling: (id: string, on: boolean) => void;
}) {
  // 毎回作り直すと RowNote の写しが更新され続けるので固定する。
  const stub = useMemo<Commitment>(
    () => ({ id, at: '', updatedAt: '', origin: 'self', body: `読めない行 ${id}` }),
    [id],
  );
  const rowRef = useRef<HTMLLIElement>(null);
  return (
    <li ref={rowRef}>
      <CloseReasonForm
        commitment={stub}
        label={id}
        onTrack={onTrack}
        onSettling={onSettling}
        planFocus={() => planFocusAfterRemoval(rowRef.current, 'input')}
      />
    </li>
  );
}

// 行には何も足さず一覧の上で1回だけ断る: どの行に紐づくかは委譲の行が壊れていて言えず、推測で紐づけないため。
function UnreadableJobsNote({ unreadableJobs }: { unreadableJobs: readonly UnreadableJob[] }) {
  if (unreadableJobs.length === 0) return null;
  const idsAll = unreadableJobs.map((entry) => entry.id).filter((id): id is string => id != null);
  return (
    <WarnNote className="mb-4">
      読めない委譲が {unreadableJobs.length} 件ある
      {unreadableIdsNote('id', idsAll)}。<strong>どの行に紐づくかは分からない</strong>
      ——「進行中（委譲あり）」の印が無い行の中に、本当は委譲が走っているものがあるかもしれない。
    </WarnNote>
  );
}

function TrimmedClosedNote({ trimmedClosed }: { trimmedClosed: number }) {
  if (trimmedClosed === 0) return null;
  return (
    <WarnNote className="mb-4">
      保存できる数の上限を超えたため、古い完了済みの仕事が合わせて {trimmedClosed} 件消えている。
      <strong>消えた分の内容は、ここでは二度と読めない。</strong>
    </WarnNote>
  );
}

// 網羅性チェック専用（引数は never）。never の変数を本文として描かない: string の prop に代入できて型で捕まらず、分岐キーの生の値が出る。
function assertClosedByHandled(closedBy: never): void {
  console.warn(`commitments.tsx: switch が決めていない commitment.closedBy: ${String(closedBy)}`);
}

// @alteroid/core から値として import しない: index がサーバ専用のドメイン層まで再エクスポートしており、
// 値を1つ import するとブラウザバンドルに入ってこのルートが開けなくなる（型は import type で引く）。
// core 側の enum に値が足されてもこの複製は追随しない。新しい値は未知として console.warn 付きの default へ落ちるので、変えたら手で更新する。
const KNOWN_COMMITMENT_CLOSED_BY = [
  'clone',
  'human',
  'daemon',
] as const satisfies readonly CommitmentClosedBy[];

function isKnownCommitmentClosedBy(value: string): value is CommitmentClosedBy {
  return (KNOWN_COMMITMENT_CLOSED_BY as readonly string[]).includes(value);
}

// 書きかけが在るあいだだけ離れる前の確認に載せる: 使い手が書いたものが画面にしか無いため。失敗の本文だけなら読めば済むので載せない。
function OrphanNotes({
  orphans,
  onDismiss,
}: {
  orphans: { note: RowNote; current: Commitment | undefined }[];
  onDismiss: (id: string) => void;
}) {
  if (orphans.length === 0) return null;
  return (
    <ul className="mb-4 flex flex-col gap-3" aria-label="一覧から外れた仕事">
      {orphans.map(({ note, current }) => (
        <OrphanNote key={note.commitment.id} note={note} current={current} onDismiss={onDismiss} />
      ))}
    </ul>
  );
}

function OrphanNote({
  note,
  current,
  onDismiss,
}: {
  note: RowNote;
  current: Commitment | undefined;
  onDismiss: (id: string) => void;
}) {
  const { commitment } = note;
  // 行が持っていた id と同じものを使う: 行の unmount と入れ替わるとき、確認が一瞬も途切れない。
  useReportDirty(commitment.id, note.draft !== undefined);
  useReportDirty(`close-reason:${commitment.id}`, note.reason !== undefined);
  return (
    <li className="rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-sm">
      <p className="mb-2 break-words">
        {note.closedHere === true ? (
          <strong>この仕事は片付けた。編集中だった本文の書きかけは残してある。</strong>
        ) : (
          <>
            <strong>この仕事は既に片付いた（または未了の一覧から外れた）。</strong>
            書きかけは残してある。
          </>
        )}
        ここから保存や片付けはできないので、必要なら写してから閉じる。
        <span className="mt-1 block text-xs text-muted-foreground">
          対象: 「{snippet(commitment.body)}」
        </span>
        {current?.closedReason !== undefined && (
          <span className="mt-1 block text-xs text-muted-foreground">
            片付けた理由: {redactBody(current.closedReason ?? '')}
          </span>
        )}
      </p>
      {note.draft !== undefined && (
        <CodeBlock label="書きかけの本文" maxHeight="12rem">
          {note.draft}
        </CodeBlock>
      )}
      {note.reason !== undefined && (
        <CodeBlock label="書きかけの片付けた理由" maxHeight="12rem" className="mt-2">
          {note.reason}
        </CodeBlock>
      )}
      <ErrorNote error={note.editFailure} className="mt-2" />
      <ErrorNote error={note.closeFailure} className="mt-2" />
      <div className="mt-2">
        <Button size="sm" onClick={() => onDismiss(commitment.id)}>
          閉じる（見送る）
        </Button>
      </div>
    </li>
  );
}

function OpenRow({
  commitment,
  onTrack,
  onSettling,
}: {
  commitment: Commitment;
  onTrack: (commitment: Commitment, patch: RowNotePatch) => void;
  onSettling: (id: string, on: boolean) => void;
}) {
  const now = useMinuteNow();
  const track = useCallback(
    (patch: RowNotePatch) => onTrack(commitment, patch),
    [onTrack, commitment],
  );
  const settling = useCallback(
    (on: boolean) => onSettling(commitment.id, on),
    [onSettling, commitment.id],
  );
  // 編集の入口は origin で隠さず未了の行すべてに出す: 隠すと「なぜ直せないか」が画面から消える。
  // 誰が編集できるかの規則は画面に写さない（断るのはサーバで、403 の本文を ErrorNote に出す）。
  // 編集欄が閉じると押したボタンが消えてフォーカスが文書の先頭へ落ちるので、「本文を編集」のボタンへ戻す。
  const toggleRef = useRef<HTMLButtonElement>(null);
  const rowRef = useRef<HTMLLIElement>(null);
  const restoreToggleFocus = useRef(false);
  const {
    editing,
    setEditing,
    confirmingDiscard,
    setConfirmingDiscard,
    closeEditor,
    requestCloseEditor,
  } = useDiscardGuard(commitment.id, () => {
    restoreToggleFocus.current = true;
    track({ draft: undefined, editFailure: undefined });
  });
  useEffect(() => {
    if (!editing && restoreToggleFocus.current) {
      restoreToggleFocus.current = false;
      toggleRef.current?.focus();
    }
  }, [editing]);

  return (
    <li ref={rowRef} className="border-b border-border px-4 py-3 last:border-b-0">
      <div className="mb-1.5 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
        <OriginBadge commitment={commitment} />
        <EditedBadge editedAt={commitment.editedAt} />
        <AnsweredStateBadge commitment={commitment} />
        <InProgressBadge commitment={commitment} />
        <span>{formatDateTime(commitment.at)}</span>
        <span>({formatRelativeAtMinute(commitment.at, now)})</span>
        <button
          ref={toggleRef}
          data-row-toggle=""
          type="button"
          className="ml-auto text-[11px] text-muted-foreground underline hover:text-foreground pointer-coarse:-my-3.5 pointer-coarse:-mr-3 pointer-coarse:px-3 pointer-coarse:py-3.5"
          aria-label={
            editing
              ? `「${snippet(commitment.body)}」の編集をやめる`
              : `「${snippet(commitment.body)}」の本文を編集`
          }
          onClick={() => (editing ? requestCloseEditor() : setEditing(true))}
        >
          {editing ? '編集をやめる' : '本文を編集'}
        </button>
      </div>

      {/* 編集中の行だけ CommitmentBodyEditor を mount する: Tabs / Textarea の実体が行数に比例して増えないように。 */}
      {editing ? (
        <CommitmentBodyEditor
          commitment={commitment}
          onCancel={closeEditor}
          onRequestCancel={requestCloseEditor}
          onTrack={track}
          onSettling={settling}
        />
      ) : (
        <CommitmentBody commitment={commitment} />
      )}

      <DiscardConfirmDialog
        open={confirmingDiscard}
        onOpenChange={setConfirmingDiscard}
        onConfirm={closeEditor}
      />

      <CloseReasonForm
        commitment={commitment}
        label={snippet(commitment.body)}
        onTrack={onTrack}
        onSettling={onSettling}
        planFocus={() => planFocusAfterRemoval(rowRef.current, '[data-row-toggle]')}
      />
    </li>
  );
}

// 一覧は片付いた行の本文・閉じた理由を先頭に切って返す（#5089）。切られた行だけ「全文を見る」を出し、押したときに `GET /commitments/{id}` で全文を取る
function ClosedRow({ commitment }: { commitment: Commitment }) {
  const reopenCommitment = useReopenCommitment();
  const truncated = commitment.bodyTruncated === true || commitment.closedReasonTruncated === true;
  const [wantFull, setWantFull] = useState(false);
  const full = useCommitment(wantFull ? commitment.id : null);
  const shown: Commitment = full.data?.entry ?? commitment;
  return (
    <li className="border-b border-border px-4 py-3 text-muted-foreground last:border-b-0">
      <div className="mb-1.5 flex flex-wrap items-center gap-2 text-[11px]">
        <Badge tone="ok">片付いた</Badge>
        <OriginBadge commitment={commitment} />
        <EditedBadge editedAt={commitment.editedAt} />
        <span>
          {formatDateTime(commitment.at)} → {formatDateTime(commitment.closedAt ?? '')}
        </span>
      </div>
      <CommitmentBody commitment={shown} />
      <ClosedReasonBody commitment={shown} />
      {truncated && full.data === undefined && (
        <div className="mt-1.5 flex items-center gap-2 text-[11px]">
          {!wantFull ? (
            <Button size="sm" onClick={() => setWantFull(true)}>
              全文を見る
            </Button>
          ) : full.error !== undefined ? (
            <span className="text-destructive">全文を読めなかった</span>
          ) : (
            <span>全文を読み込み中…</span>
          )}
        </div>
      )}
      {/* 閉じた行を否定する口。`commitment` の `at` と起点は変わらないので、積み直さずここから戻す。 */}
      <ReopenForm
        dirtyId={`reopen-reason:${commitment.id}`}
        label={snippet(commitment.body)}
        onReopen={(reason) => reopenCommitment(commitment.id, reason)}
      />
    </li>
  );
}

function PlainClosedReason({ reason }: { reason: string }) {
  return (
    <p className="mt-1 text-xs break-words whitespace-pre-wrap">
      <span className="mr-2 text-[11px]">どう片付いたか</span>
      {reason}
    </p>
  );
}

// human は人間が打った文字を化けさせないよう素テキスト（chat-message.tsx の「クローンの行だけを Markdown にする」と同じ線）。
// 保存層は closedBy を z.string() で緩く持つ（未知の値で一覧が丸ごと読めなくなるのを避ける）ので、表示側で isKnownCommitmentClosedBy で狭める。
function ClosedReasonBody({ commitment }: { commitment: Commitment }) {
  if (commitment.closedReason === undefined || commitment.closedReason === null) return null;
  // 4経路すべてが通る入口で伏せる: 経路ごとに足すと、足し忘れた経路から素のまま出る。
  const reason = redactBody(commitment.closedReason);

  // closedBy が無い行は既定（clone / human）へ倒さない。未知の値とは別扱いで、warn するのは未知の値だけ。
  if (commitment.closedBy === undefined) return <PlainClosedReason reason={reason} />;

  if (!isKnownCommitmentClosedBy(commitment.closedBy)) {
    console.warn(
      `commitments.tsx: 未知の commitment.closedBy が来た（undefined とは別扱い）: ${String(commitment.closedBy)}`,
    );
    return <PlainClosedReason reason={reason} />;
  }

  const closedBy = commitment.closedBy;
  switch (closedBy) {
    case 'clone':
      return (
        <div className="mt-1 text-xs">
          <span className="mr-2 text-[11px]">どう片付いたか</span>
          <Markdown remoteImages={false}>{reason}</Markdown>
        </div>
      );

    case 'human':
      return <PlainClosedReason reason={reason} />;

    // 器が書いた定型文なので Markdown にしない。理由の文頭に「器が自動で閉じた」と入っている
    case 'daemon':
      return <PlainClosedReason reason={reason} />;

    default:
      assertClosedByHandled(closedBy);
      return <PlainClosedReason reason={reason} />;
  }
}

const PUSH_FORM_DIRTY_ID = 'push-form';

// 読めるだけにしない: 積みたい場面は「いま言ったことを忘れられたら困る」ときで、クローンのターンを1回起こさないと書けないのは重い。CLI の `/commit` と同じ経路にする。
function PushForm() {
  const pushCommitment = usePushCommitment();
  const inputId = useId();
  const bodyHintId = useId();
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(undefined);
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const { data, mutate } = useCommitments(false);
  const dataRef = useLatest(data);

  useReportDirty(PUSH_FORM_DIRTY_ID, body !== '');

  async function submit() {
    const text = body.trim();
    if (text === '') return;
    const sent = body;
    const before = dataRef.current && new Set(dataRef.current.entries.map((entry) => entry.id));
    setBusy(true);
    setFailure(undefined);
    setNotice(undefined);
    try {
      await pushCommitment(text);
      setBody((current) => unsentInput(current, sent));
    } catch (caught) {
      // サーバは冪等の鍵を持たず、送り直すと同じ本文が二重に載る。届いたか分からない失敗のときだけ、
      // 取り直した一覧に積む前に無かった同じ本文の行が在るかで確かめる。
      const unknown =
        !(caught instanceof ApiError) || caught.status >= 500 || caught.status === 408;
      const landed =
        unknown &&
        before !== undefined &&
        ((await mutate())?.entries ?? []).some(
          (entry) => !before.has(entry.id) && entry.body.trim() === text,
        );
      if (landed) {
        setBody((current) => unsentInput(current, sent));
        setNotice('応答は届かなかったが、台帳には載っている。送り直さなくてよい。');
      } else {
        setFailure(caught);
        if (unknown)
          setNotice(
            '届いたか分からない。台帳の一覧を確かめてから送り直すこと（二重に載ることがある）。',
          );
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="mb-4">
      <CardHeader title="仕事を登録する" subtitle="引き受けたことを、片付くまで残す" />
      <div className="flex flex-col gap-2 px-4 py-3">
        <label htmlFor={inputId} className="text-xs font-medium text-muted-foreground">
          何を引き受けたか
        </label>
        <Textarea
          id={inputId}
          aria-describedby={bodyHintId}
          rows={3}
          maxHeight="60vh"
          value={body}
          placeholder="例: 金曜までに週次レビューを出す"
          onChange={(event) => setBody(event.target.value)}
          onSubmitShortcut={() => void submit()}
          submitDisabled={body.trim() === '' || busy}
        />
        <FieldHint id={bodyHintId} className="-mt-1">
          何を引き受けたかを全文で書く。クローンへ渡す一覧は長い本文を先頭だけに切るが、台帳には全文が残る。
        </FieldHint>
        <div className="flex items-center gap-2">
          <Button
            variant="primary"
            loading={busy}
            disabled={body.trim() === ''}
            onClick={() => void submit()}
          >
            積む
          </Button>
          <SubmitHint action="登録" />
        </div>
        <ErrorNote error={failure} />
        {notice !== undefined && (
          <p role="status" className="text-xs text-muted-foreground">
            {notice}
          </p>
        )}
      </div>
    </Card>
  );
}
