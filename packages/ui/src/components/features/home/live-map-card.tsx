import type { ReactNode } from 'react';

import { Card, CardHeader, ErrorNote, Spinner } from '../../common';
import { SystemTopology, type SystemTopologyProps } from '../topology/system-topology';

export type LiveMapConnection = 'connecting' | 'live' | 'offline';

// 切れている・組めていないときは最後の地図に古いと断る: 状態の札が「いまの状態」に読めてしまうため
export function LiveMapCard({
  scene,
  connection,
  unavailable,
  staleAt,
  omittedNote,
  action,
  layout,
}: {
  scene?: SystemTopologyProps;
  connection: LiveMapConnection;
  unavailable?: string;
  staleAt?: string;
  omittedNote?: ReactNode;
  action?: ReactNode;
  layout?: SystemTopologyProps['layout'];
}) {
  const stale = connection === 'offline' || unavailable !== undefined;

  return (
    <Card className="min-w-0">
      <CardHeader
        title="稼働状況"
        subtitle="光は直近の指示（紫）と報告（青）。札を押すと詳細"
        action={action}
      />
      {scene === undefined ? (
        unavailable !== undefined ? (
          <ErrorNote
            error={new Error(`サーバが稼働状況の図を組めていない（${unavailable}）`)}
            className="m-4"
          />
        ) : connection === 'offline' ? (
          <ErrorNote
            error={new Error('稼働状況の図に繋がらない（繋ぎ直している）')}
            className="m-4"
          />
        ) : (
          <Spinner label="稼働状況の図を読み込み中" />
        )
      ) : (
        <div className="px-3 py-3">
          {stale && (
            <p
              role="status"
              className="mb-3 rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-xs text-warn"
            >
              {unavailable !== undefined
                ? `サーバが稼働状況の図を組めていない（${unavailable}）。`
                : '稼働状況の図への接続が切れている（繋ぎ直している）。'}
              {staleAt === undefined
                ? '出しているのは最後に受け取った状態で、いまの状態ではない。'
                : `出しているのは ${staleAt} に受け取った状態で、いまの状態ではない。`}
            </p>
          )}
          <SystemTopology {...scene} layout={layout} />
          {omittedNote !== undefined && (
            <p className="mt-2 text-xs text-muted-foreground">{omittedNote}</p>
          )}
        </div>
      )}
    </Card>
  );
}
