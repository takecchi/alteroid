import { Link, Navigate } from 'react-router';

import { LoadError } from '~/components/load-error';
import { Page, Spinner } from '@alteroid/ui';
import { useApprovalTrace, useApprovalsAnsweredOn } from '@alteroid/swr';

import type { Route } from './+types/approvals-item';

export function clientLoader({ params }: Route.ClientLoaderArgs) {
  return { approvalId: params.approvalId };
}

/** `YYYY-MM-DD`（UTC の暦）に日数を足す。TZ に依らない純粋な暦の計算。 */
function shiftUtcDate(iso: string, days: number): string {
  const at = new Date(Date.parse(iso));
  at.setUTCDate(at.getUTCDate() + days);
  return at.toISOString().slice(0, 10);
}

/**
 * 日付なしで承認1件を開く入口（`/approvals/item/:approvalId`。`approvalDetailPath` が返す）。
 * 会話の画面など、id しか持たない側から回答済みの詳細へ飛ぶために在る。**表示は何も持たず、
 * 正しい行き先へ `replace` で移すだけ。**
 *
 * - 未回答なら未回答のページ（`/approvals`）へ
 * - 決着済みなら `/approvals/answered/:date/:approvalId` へ。**日付はデーモンの `localDate()`
 *   で決まり、ブラウザには デーモンの TZ が分からない**。そこで、決着の日時（`answeredAt`、
 *   無ければ `withdrawnAt`）の UTC の日の前後1日（TZ の差は最大でも ±1 日に収まる）を
 *   `GET /approvals?answeredOn=` で引き、**その承認を実際に返した日**を採る。日付はデーモンの
 *   応答（その日の件にその id が在ること）で決まり、ここで `localDate` を再実装していない
 * - どの日にも見つからなければ、推測で日を選ばず、読めなかったと言って回答済みのページへの
 *   リンクを出す
 */
export default function ApprovalsItem({ loaderData }: Route.ComponentProps) {
  const { approvalId } = loaderData;
  const trace = useApprovalTrace(approvalId ?? null);
  const approval = trace.data?.approval;
  const settledAt = approval?.answeredAt ?? approval?.withdrawnAt ?? undefined;

  const base = settledAt === undefined ? undefined : new Date(settledAt).toISOString().slice(0, 10);
  const candidates =
    base === undefined ? [] : [base, shiftUtcDate(base, -1), shiftUtcDate(base, 1)];
  const day0 = useApprovalsAnsweredOn(candidates[0] ?? null);
  const day1 = useApprovalsAnsweredOn(candidates[1] ?? null);
  const day2 = useApprovalsAnsweredOn(candidates[2] ?? null);
  const days = [day0, day1, day2];

  let body: React.ReactNode = <Spinner label="承認を探している" />;
  if (trace.error !== undefined && approval === undefined) {
    body = (
      <LoadError what="承認" error={trace.error} onRetry={() => trace.mutate()} className="m-4" />
    );
  } else if (approval !== undefined && approvalId !== undefined) {
    if (settledAt === undefined) {
      return <Navigate to="/approvals" replace />;
    }
    const found = candidates.findIndex((_, index) =>
      days[index]?.data?.approvals?.some((entry) => entry.id === approvalId),
    );
    if (found >= 0) {
      return (
        <Navigate
          to={`/approvals/answered/${candidates[found]!}/${encodeURIComponent(approvalId)}`}
          replace
        />
      );
    }
    const failed = days.find((day) => day.error !== undefined && day.data === undefined);
    const pending = days.some((day, index) => candidates[index] !== undefined && day.isLoading);
    if (failed !== undefined) {
      body = <LoadError what="承認の日付" error={failed.error} className="m-4" />;
    } else if (!pending) {
      body = (
        <p className="m-4 text-sm text-muted-foreground">
          この承認が決着した日を特定できなかった。回答済みのページから探せる。
          <Link to="/approvals/answered" className="ml-1 text-primary hover:underline">
            回答済みの承認へ
          </Link>
        </p>
      );
    }
  }

  return (
    <Page title="承認を開いている" description="決着した日を調べて、その日の詳細へ移る">
      {body}
    </Page>
  );
}
