import { Link, Navigate } from 'react-router';

import { LoadError } from '~/components/load-error';
import { Page, Spinner } from '@alteroid/ui';
import { useApprovalById } from '@alteroid/swr';

import type { Route } from './+types/approvals-item';

export function clientLoader({ params }: Route.ClientLoaderArgs) {
  return { approvalId: params.approvalId };
}

// 日を計算も推測もしない: ブラウザにはデーモンの TZ が分からないため
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
  } else if (
    lookup.data !== undefined &&
    approvalId !== undefined &&
    // 「未回答」は、この mount の取り直しが済むまで信用しない: キャッシュに前の「未回答」が残っていても、
    // そのあと別の経路で答えられていれば決着した日の詳細へ行くため。決着した日は変わらないのですぐ移る
    (lookup.data.settledOn !== null || lookup.revalidated)
  ) {
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
