import { Link } from 'react-router';

import { AgentModelTag, Badge, Card, CardHeader, KeyValueList } from '@alteroid/ui';
import { formatDateTime, formatRelative, usageHref } from '@alteroid/logic';
import type { ManagerSummary } from '@alteroid/logic';

import { DisconnectedNote, FailureNote, LostNote, denialTotal } from './manager-detail-notes';
// 注記は書き写さず一覧から借りる: 文言の核はクローン・CLI と逐語で揃える約束なので、写すと片方だけ直る。
import {
  ManagerAwaitingBackgroundNote,
  ManagerRunnerLostNote,
  ManagerRunnerVanishedNote,
  ManagerSessionMissingNote,
  ManagerStatusBadge,
} from './managers';

export function ManagerStatusCard({ manager, id }: { manager: ManagerSummary; id: string }) {
  return (
    <Card>
      <CardHeader
        title="状態"
        action={
          // 使用量を集計し直さず飛ぶだけにする: 数字の意味は `/usage` が持つ。
          <Link
            // 全期間で開く: 画面の既定（直近 30 日）だと、それより前に走った委譲の使用量が 0 に見える
            to={usageHref({ managerId: id, allTime: true })}
            className="text-xs text-primary hover:underline"
          >
            使用量を見る
          </Link>
        }
      />
      <KeyValueList
        className="px-4 py-3"
        labelWidth="8rem"
        items={[
          {
            label: '状態',
            value: (
              <div className="flex items-center gap-2">
                <ManagerStatusBadge status={manager.status} />
                {manager.live ? (
                  <Badge tone="ok">接続あり</Badge>
                ) : (
                  <Badge tone="danger">セッション切断</Badge>
                )}
                {/* 札は差し替えず隣に並べる: 拒否で止まった仕事は「実行中」のままなので、差し替えるとその事実が消える。 */}
                {denialTotal(manager.denials) > 0 && (
                  <Badge tone="warn">
                    ⚠ 確認へ上がらず止められた {denialTotal(manager.denials)} 件
                  </Badge>
                )}
                {manager.lastFailure !== undefined && manager.lastFailure !== null && (
                  <Badge tone="danger">⚠ 直近のターンは失敗で終わった</Badge>
                )}
              </div>
            ),
          },
          { label: '作業ディレクトリ', value: manager.cwd, mono: true },
          {
            label: '作成',
            value: `${formatDateTime(manager.startedAt)}（${formatRelative(manager.startedAt)}）`,
          },
          {
            label: '更新',
            value: `${formatDateTime(manager.updatedAt)}（${formatRelative(manager.updatedAt)}）`,
          },
          ...(manager.runnerId !== undefined && manager.runnerId !== null
            ? [{ label: 'runner', value: manager.runnerId, mono: true }]
            : []),
          { label: 'モデル', value: <AgentModelTag model={manager.managerModel} /> },
          { label: '作業者', value: <AgentModelTag model={manager.workerModel} /> },
          ...(manager.sessionId !== undefined && manager.sessionId !== null
            ? [{ label: 'セッション', value: manager.sessionId, mono: true }]
            : []),
          // 貸し出しは判定を書かず材料だけ出す: 引き取ってよいかは時刻で変わるので、画面に焼くと古びる。
          ...(manager.lease !== undefined && manager.lease !== null
            ? [
                {
                  label: '貸し出し',
                  value: `${manager.lease.instanceId ?? 'プロセスは未名乗り'} / 世代 ${manager.lease.fence}（生存確認 ${formatDateTime(manager.lease.seenAt)}）`,
                  mono: true,
                },
              ]
            : []),
        ]}
      />
      <DisconnectedNote live={manager.live} />
      {/* 送信可否を推論する文言にしない: 器が `lost` でも送信は届きうるので、「いま話しかけられない」と書くと真下の送信ボタンと矛盾する。 */}
      <ManagerRunnerLostNote
        runnerLostSince={manager.runnerLostSince}
        className="border-t border-border px-4 py-3 text-xs text-destructive"
      />
      <ManagerRunnerVanishedNote
        runnerVanished={manager.runnerVanished}
        className="border-t border-border px-4 py-3 text-xs text-destructive"
      />
      <ManagerSessionMissingNote
        sessionMissingSince={manager.sessionMissingSince}
        sessionMissingKind={manager.sessionMissingKind}
        className="border-t border-border px-4 py-3 text-xs text-warn"
      />
      <ManagerAwaitingBackgroundNote
        awaitingBackground={manager.awaitingBackground}
        className="border-t border-border px-4 py-3 text-xs text-muted-foreground"
      />
      <LostNote status={manager.status} />
      <FailureNote manager={manager} />
    </Card>
  );
}
