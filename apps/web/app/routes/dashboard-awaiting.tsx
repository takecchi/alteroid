import { Link } from 'react-router';

import { formatRelativeAtMinute, useMinuteNow } from '~/lib/use-now';

import {
  AwaitingApprovalRow,
  AwaitingCountRow,
  AwaitingYouCalm,
  AwaitingYouCard,
  ErrorNote,
  HOME_LINK_CLASS,
  Spinner,
  TruncationNote,
  WarnNote,
} from '@alteroid/ui';
import { useApprovals, useProgress } from '@alteroid/swr';
import { redactBody } from '@alteroid/logic';

// TruncationNote と必ず対で使う: 切ったことが消えるのは要件でないため
const APPROVAL_LIMIT = 5;
const APPROVALS_MALFORMED_MESSAGE = '承認待ちを読めていない（応答の形が想定と違う）';

// 「承認待ちはない」と言わない: 読めない行は待っているものかもしれないため
function UnreadableApprovalsWarn({ count, className }: { count: number; className?: string }) {
  if (count === 0) return null;
  return (
    <WarnNote className={className}>
      読めない承認待ちが {count} 件ある。
      <strong>壊れた行であって、回答済みでも取り下げ済みでもない。</strong>
      この一覧には載っていない。
    </WarnNote>
  );
}

// 未了の仕事の件数を「人間の番」の件数にしない: API は未了を「人間が動かすもの」と「そうでないもの」に分けて持たないため
export function AwaitingYou() {
  const approvals = useApprovals(true);
  const progress = useProgress();
  const now = useMinuteNow();

  // ?? [] で0件にしない: 配列でない応答は、デーモンと画面の版ずれで読めていないことがあるため
  const list = Array.isArray(approvals.data?.approvals) ? approvals.data.approvals : undefined;
  const malformed = approvals.data !== undefined && list === undefined;
  const pending = list ?? [];

  if (approvals.error !== undefined && approvals.data === undefined) {
    return (
      <AwaitingYouCard tone="plain">
        <ErrorNote error={approvals.error} className="m-4" />
      </AwaitingYouCard>
    );
  }
  if (approvals.data === undefined) {
    return (
      <AwaitingYouCard tone="plain">
        <Spinner />
      </AwaitingYouCard>
    );
  }
  if (malformed) {
    return (
      <AwaitingYouCard tone="plain">
        <ErrorNote error={new Error(APPROVALS_MALFORMED_MESSAGE)} className="m-4" />
      </AwaitingYouCard>
    );
  }
  const unreadableCount = Array.isArray(approvals.data.unreadable)
    ? approvals.data.unreadable.length
    : 0;
  const staleNote =
    approvals.error !== undefined ? (
      <p className="mx-4 mt-3 text-xs text-warn">
        最新の承認待ちを取り直せなかった。下は前に読めたときのもの。
      </p>
    ) : null;
  if (pending.length === 0) {
    if (unreadableCount === 0) {
      if (staleNote === null) return <AwaitingYouCalm />;
      return (
        <AwaitingYouCard tone="plain">
          {staleNote}
          <p className="px-4 py-3 text-sm text-muted-foreground">
            前に読めたときは、承認待ちはなかった。
          </p>
        </AwaitingYouCard>
      );
    }
    return (
      <AwaitingYouCard
        action={
          <Link to="/approvals" className={HOME_LINK_CLASS}>
            見る
          </Link>
        }
      >
        {staleNote}
        <UnreadableApprovalsWarn count={unreadableCount} className="m-4" />
      </AwaitingYouCard>
    );
  }

  const backlog = progress.error === undefined ? progress.data?.backlog : undefined;
  const backlogPartial = backlog !== undefined && backlog.completeness.unreadable !== 0;

  return (
    <AwaitingYouCard
      action={
        <Link to="/approvals" className={HOME_LINK_CLASS}>
          答える
        </Link>
      }
    >
      {staleNote}
      <UnreadableApprovalsWarn count={unreadableCount} className="m-4 mb-0" />
      <ul>
        {pending.slice(0, APPROVAL_LIMIT).map((approval) => (
          <AwaitingApprovalRow
            key={approval.id}
            question={redactBody(approval.question)}
            meta={formatRelativeAtMinute(approval.createdAt, now)}
            renderLink={({ className, children }) => (
              <Link to="/approvals" className={className}>
                {children}
              </Link>
            )}
          />
        ))}
        {backlog !== undefined && (
          <AwaitingCountRow
            label="未了"
            action={
              <Link to="/commitments" className={HOME_LINK_CLASS}>
                仕事へ
              </Link>
            }
          >
            未了の仕事 <span className="text-foreground">{backlog.total}</span> 件
            {backlogPartial ? '（読めない行があり、下限）' : ''}
          </AwaitingCountRow>
        )}
      </ul>
      <TruncationNote shown={APPROVAL_LIMIT} total={pending.length} />
    </AwaitingYouCard>
  );
}
