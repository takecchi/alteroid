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
    // **「完了」と書かない。** `done` はマネージャー自身のターンが終わって待機して
    // いるだけで、仕事が終わったとは限らない（その下で作業者が走っているかも、
    // ここからは見えていない）。`schema.ts` の定義も「待機中」である — 画面だけが
    // 「完了」と言っていた。
    done: { tone: 'neutral', label: '待機中' },
    failed: { tone: 'danger', label: '失敗' },
    // **「完了」の側に寄せない。** 戻れなかった仕事は `done`（終えて待っている）
    // ではない。人間が画面で見たときに「起こし直す対象」だと分かる言葉にする。
    //
    // **かといって「復旧不能」でもない。** 観測したのは「前のセッションへ戻れ
    // なかった」ことだけで、成果の有無は見ていない（デーモンは PR もブランチも
    // 知らない）。落ちる直前にマージまで届いていた仕事がこの札を貼られている。
    lost: { tone: 'danger', label: 'セッションへ戻れず' },
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
                    {/*
                      札だけでは「で、どうすればいいのか」が伝わらない。クローンは
                      `manager_list` で同じ案内を受け取る — 人間の画面にだけ無いと、
                      同じ状態を見て人間とクローンが違う判断をすることになる。
                    */}
                    {manager.status === 'lost' && (
                      <p className="mt-1 text-[11px] text-danger">
                        前のセッションへ戻れなかっただけで、成果が残っているかは見ていない。起こし直す前にリモート（PR・ブランチ）を確かめること。
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
