import { Link, Navigate } from 'react-router';

import { LoadError } from '~/components/load-error';
import { Page, Spinner } from '@alteroid/ui';
import { useApprovalById } from '@alteroid/swr';

import type { Route } from './+types/approvals-item';

export function clientLoader({ params }: Route.ClientLoaderArgs) {
  return { approvalId: params.approvalId };
}

/**
 * 日付なしで承認1件を開く入口（`/approvals/item/:approvalId`。`approvalDetailPath` が返す）。
 * 会話の画面など、id しか持たない側から回答済みの詳細へ飛ぶために在る。**表示は何も持たず、
 * 正しい行き先へ `replace` で移すだけ。**
 *
 * 呼ぶのは `GET /approvals/{id}` の1回だけ。応答の `settledOn`（デーモンの `localDate()` で切った
 * 決着の日。ブラウザには デーモンの TZ が分からないので、ここで日を計算も推測もしない）で決める。
 *
 * - `settledOn` が `null`（未回答）なら未回答のページ（`/approvals`）へ
 * - 日付が在れば `/approvals/answered/:date/:approvalId` へ
 * - 404 なら、見つからないと言う（回答済みのページへのリンクつき）
 * - 404 以外の失敗は、見つからないとは言わず、読めなかったと言う（取り直せる）
 */
export default function ApprovalsItem({ loaderData }: Route.ComponentProps) {
  const { approvalId } = loaderData;
  const lookup = useApprovalById(approvalId ?? null);

  let body: React.ReactNode = <Spinner label="承認を探している" />;
  if (lookup.data === null) {
    body = (
      <p className="m-4 text-sm text-muted-foreground">
        この承認は見つからなかった。回答済みのページから探せる。
        <Link to="/approvals/answered" className="ml-1 text-primary hover:underline">
          回答済みの承認へ
        </Link>
      </p>
    );
  } else if (lookup.data !== undefined && approvalId !== undefined) {
    if (lookup.data.settledOn === null) {
      return <Navigate to="/approvals" replace />;
    }
    return (
      <Navigate
        to={`/approvals/answered/${lookup.data.settledOn}/${encodeURIComponent(approvalId)}`}
        replace
      />
    );
  } else if (lookup.error !== undefined) {
    body = (
      <LoadError what="承認" error={lookup.error} onRetry={() => lookup.mutate()} className="m-4" />
    );
  }

  return (
    <Page title="承認を開いている" description="決着した日を調べて、その日の詳細へ移る">
      {body}
    </Page>
  );
}
