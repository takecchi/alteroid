import type { ReactNode } from 'react';

import { Card, CardHeader, ErrorNote, Spinner } from '../../common';
import { SystemTopology, type SystemTopologyProps } from '../topology/system-topology';

export type LiveMapConnection = 'connecting' | 'live' | 'offline';

/**
 * 「いま動いているもの」—— 稼働の地図のカード。**接続の状態を正直に言う。**
 *
 * - まだ何も届いていない: 接続中は読み込み、切れていれば失敗として言う（空の地図を出さない）
 * - 地図が在るが**切れている / デーモンが組めていない**: 最後の地図は出すが、
 *   **古いと断る**（光は時刻の窓で決まるので、古い地図は動いていないように見えるだけで、
 *   状態の札は「いまの状態」に読めてしまう）
 * - 切った件数（`omittedNote`）は地図の下で言う（隠さない）
 *
 * 地図の場面（`scene`）を作るのは上の層（`@alteroid/logic` の `topologySceneFromSnapshot`）。
 */
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
  /** デーモンが地図を組めなかった理由（種別だけ）。 */
  unavailable?: string;
  /** 最後に地図を受け取った時刻の表示（古いと断るときに添える）。 */
  staleAt?: string;
  omittedNote?: ReactNode;
  action?: ReactNode;
  /** 見本帳で配置を固定したいとき。 */
  layout?: SystemTopologyProps['layout'];
}) {
  const stale = connection === 'offline' || unavailable !== undefined;

  return (
    <Card className="min-w-0">
      <CardHeader
        title="いま動いているもの"
        subtitle="光は直近の指示（紫）と報告（青）。札を押すと詳細"
        action={action}
      />
      {scene === undefined ? (
        unavailable !== undefined ? (
          <ErrorNote
            error={new Error(`デーモンが稼働の地図を組めていない（${unavailable}）`)}
            className="m-4"
          />
        ) : connection === 'offline' ? (
          <ErrorNote
            error={new Error('稼働の地図に繋がらない（繋ぎ直している）')}
            className="m-4"
          />
        ) : (
          <Spinner label="稼働の地図を読み込み中" />
        )
      ) : (
        <div className="px-3 py-3">
          {stale && (
            <p
              role="status"
              className="mb-3 rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-xs text-warn"
            >
              {unavailable !== undefined
                ? `デーモンが稼働の地図を組めていない（${unavailable}）。`
                : '稼働の地図への接続が切れている（繋ぎ直している）。'}
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
