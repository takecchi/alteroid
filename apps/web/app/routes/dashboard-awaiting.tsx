import { AlertTriangle } from 'lucide-react';
import { Link } from 'react-router';

import { useMinuteNow } from '~/lib/use-now';

import {
  AwaitingApprovalRow,
  AwaitingCountRow,
  AwaitingYouCalm,
  AwaitingYouCard,
  ErrorNote,
  HOME_LINK_CLASS,
  Spinner,
  TruncationNote,
} from '@alteroid/ui';
import { useApprovals, useProgress } from '@alteroid/swr';
import { formatRelative, redactBody } from '@alteroid/logic';

/**
 * 承認待ちの行に出す件数。**切ること自体は要件である**（ここは一目で見る場所で、全件は
 * `/approvals` が持つ）。要件でないのは**切ったことが消えること**なので、定数は
 * `TruncationNote` と必ず対で使う。
 */
const APPROVAL_LIMIT = 5;
const APPROVALS_MALFORMED_MESSAGE = '承認待ちを読めていない（応答の形が想定と違う）';

/**
 * 読めない承認待ちの警告（issue #3062）。**「承認待ちはない」とは言わない**——読めない行は
 * 回答済みでも取り下げ済みでもなく、待っているものかもしれない。文言と語は `/approvals` の
 * `UnreadableApprovalNote` に揃える。0件なら描かない。
 */
function UnreadableApprovalsWarn({ count, className }: { count: number; className?: string }) {
  if (count === 0) return null;
  return (
    <div
      role="status"
      className={`flex items-start gap-2 rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-sm text-warn ${className ?? ''}`}
    >
      <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
      <span className="min-w-0 break-words">
        読めない承認待ちが {count} 件ある。
        <strong>壊れた行であって、回答済みでも取り下げ済みでもない。</strong>
        この一覧には載っていない。
      </span>
    </div>
  );
}

/**
 * 「承認待ち一覧」—— 人間が手を動かすものだけ。承認待ちと、未了の仕事の件数。
 * 何も待っていなければ1行に畳む。
 *
 * ## 守っていること（旧ダッシュボードの「承認待ち」カードから引き継いだもの）
 *
 * - **読み込み中（まだ一度も取れていない）に「なし」と描かない**（issue #2325）。失敗は
 *   `error` が先に拾う
 * - **形の違う応答（`approvals` が配列でない・`null`）を `?? []` で0件にしない**（issue #2308）。
 *   デーモンと画面は版がずれうる。読めていないのに「ない」と描くと嘘になる
 * - **一度取れたあとの取り直しの失敗**（SWR は直前の `data` を残す）は、古い件数のまま黙って
 *   「答える」を出し続けない（issue #2138 の2）。件数は残し、注記で失敗を言う（issue #3346。
 *   進捗のタイルの #3069 と同じ形）。`data` が無いときだけエラーにする
 * - **読めない行（`unreadable`）だけのときも「承認待ちはない」と描かない**（issue #3062）。
 *   `calm` の代わりに警告を出す。読める承認待ちと混在するときも、一覧の上に同じ警告を足す
 * - 読めていないとき（読み込み中・失敗・形が違う）は、**警告色にしない**（待っているものが
 *   あるように見せない）
 *
 * ## 未了の仕事の件数について
 *
 * 台帳の未了の総数（`GET /progress` の `backlog.total`）を出す。**「人間の番」の件数ではない**
 * （API は未了を「人間が動かすもの」と「そうでないもの」に分けて持たない）ので、分けた数を
 * 作らない。数が欠けうる（読めない行）ときは下限として言う。進捗を読めなければ
 * この行は出さない（0 件と描かない）。
 */
export function AwaitingYou() {
  const approvals = useApprovals(true);
  const progress = useProgress();
  // 「N分前」を古いまま残さない。進捗の取り直しが失敗し続けても止まらない（#3700。#3596 と同じ形）。
  const now = useMinuteNow();

  // 配列でない応答は「読めていない」へ倒す（`?? []` で0件にしない）。
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
  // 取り直しの失敗は、前に読めた件数を残したまま、その場で言う（issue #3346。進捗のタイルの #3069 と同じ形）。
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
            meta={formatRelative(approval.createdAt, now)}
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
