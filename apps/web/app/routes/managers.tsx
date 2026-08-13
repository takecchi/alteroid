import { Link } from 'react-router';

import { Page } from '~/components/page';
import { Badge, Card, Empty, ErrorNote, Spinner } from '~/components/ui';
import { useManagers } from '~/hooks/queries';
import { formatRelative } from '~/lib/format';
import type { ManagerStatus } from '~/lib/types';

const STATUS: Record<ManagerStatus, { tone: 'ok' | 'warn' | 'danger' | 'neutral'; label: string }> =
  {
    running: { tone: 'ok', label: '実行中' },
    waiting_human: { tone: 'warn', label: '人間待ち' },
    done: { tone: 'neutral', label: '完了' },
    failed: { tone: 'danger', label: '失敗' },
  };

export function ManagerStatusBadge({ status }: { status: ManagerStatus }) {
  const view = STATUS[status];
  return <Badge tone={view.tone}>{view.label}</Badge>;
}

export default function Managers() {
  const { data, error, isLoading } = useManagers();
  const managers = data?.managers ?? [];

  return (
    <Page
      title="マネージャー"
      description="クローンが起こした仕事。人間が Claude Code に頼んだのと同じ位置にいる"
    >
      <ErrorNote error={error} className="mb-4" />
      {isLoading ? (
        <Spinner />
      ) : managers.length === 0 ? (
        <Card>
          <Empty>まだ1体も起きていない。会話で依頼するか、発意 tick を待つ。</Empty>
        </Card>
      ) : (
        <Card>
          <ul>
            {managers.map((manager) => (
              <li key={manager.managerId} className="border-b border-border last:border-b-0">
                <Link
                  to={`/managers/${manager.managerId}`}
                  className="flex items-start gap-3 px-4 py-3 hover:bg-surface-2"
                >
                  <div className="mt-0.5 shrink-0">
                    <ManagerStatusBadge status={manager.status} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm">{manager.request}</p>
                    <p className="mt-0.5 truncate font-mono text-[11px] text-muted">
                      {manager.cwd}
                    </p>
                    {manager.waiting.length > 0 && (
                      <p className="mt-1 text-[11px] text-warn">
                        {manager.waiting.length} 件の確認待ち: {manager.waiting[0]?.summary}
                      </p>
                    )}
                  </div>
                  <div className="shrink-0 text-right text-[11px] text-muted">
                    <p>{formatRelative(manager.updatedAt)}</p>
                    {/*
                      `live` はデーモンが今この瞬間その runner と繋がっているか。
                      status と別に出す — 「走っている扱いだが繋がっていない」を
                      隠すと、再起動後の引き取りが効いたのか分からなくなる。
                    */}
                    {manager.live && <p className="text-ok">接続あり</p>}
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </Page>
  );
}
