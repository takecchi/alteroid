import { FilterNote } from '~/components/filter-note';
import { WorkTabs } from '~/components/group-tabs';
import { LoadError } from '~/components/load-error';
import { EditedBadge } from '~/components/task-parts';
import { clipRawValue } from '~/lib/clip-raw-value';
import { duplicateParamNotice } from '~/lib/duplicate-param-notice';
import { useReplaceSearchParams } from '~/lib/use-replace-search-params';
import { formatRelativeAtMinute, useMinuteNow } from '~/lib/use-now';
import { unreadableIdsNote } from '~/lib/unreadable-ids-note';
import { useState } from 'react';

import {
  Markdown,
  Page,
  Badge,
  Button,
  Card,
  CardHeader,
  Empty,
  Spinner,
  WarnNote,
} from '@alteroid/ui';
import { useCommitments, useCommitment } from '@alteroid/swr';
import { formatDateTime, redactBody } from '@alteroid/logic';
import type { CommitmentClosedBy } from '@alteroid/core';
import type { Commitment, UnreadableCommitment, UnreadableJob } from '@alteroid/logic';

import { AnsweredStateBadge, InProgressBadge, OriginBadge } from './commitments-badges';
import { CommitmentBody } from './commitments-body';

const CLOSED_PARAM = 'closed';

// 台帳へ書く口は無い（台帳の撤去の段2b）: 読むだけの一覧。仕事を足す・直す・片付けるのは待ち行列（task）の画面。
// 並べ替えや優先度の札を足さない: 足すと「やることの一覧」になってしまうため。
export default function Commitments() {
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

  return (
    <Page
      tabs={<WorkTabs />}
      title="未了の仕事"
      description="読むだけの旧い台帳。仕事を足す・直す・片付けるのは「待ち行列」の画面で行う"
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

      {isLoading && data === undefined ? (
        <Spinner />
      ) : listUnavailable ? null : (
        <>
          <UnreadableNote unreadable={unreadable} />
          <UnreadableJobsNote unreadableJobs={data?.unreadableJobs ?? []} />
          <TrimmedClosedNote trimmedClosed={trimmedClosed} />

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
                  <OpenRow key={commitment.id} commitment={commitment} />
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
function UnreadableNote({ unreadable }: { unreadable: UnreadableCommitment[] }) {
  if (unreadable.length === 0) return null;
  const idsAll = unreadable.map((entry) => entry.id).filter((id): id is string => id != null);
  return (
    <WarnNote className="mb-4" block>
      読めない行が {unreadable.length} 件ある
      {unreadableIdsNote('id', idsAll)}。<strong>片付いたのではない。</strong>
    </WarnNote>
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

function OpenRow({ commitment }: { commitment: Commitment }) {
  const now = useMinuteNow();
  return (
    <li className="border-b border-border px-4 py-3 last:border-b-0">
      <div className="mb-1.5 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
        <OriginBadge commitment={commitment} />
        <EditedBadge editedAt={commitment.editedAt} />
        <AnsweredStateBadge commitment={commitment} />
        <InProgressBadge commitment={commitment} />
        <span>{formatDateTime(commitment.at)}</span>
        <span>({formatRelativeAtMinute(commitment.at, now)})</span>
      </div>
      <CommitmentBody commitment={commitment} />
    </li>
  );
}

// 一覧は片付いた行の本文・閉じた理由を先頭に切って返す（#5089）。切られた行だけ「全文を見る」を出し、押したときに `GET /commitments/{id}` で全文を取る
function ClosedRow({ commitment }: { commitment: Commitment }) {
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
