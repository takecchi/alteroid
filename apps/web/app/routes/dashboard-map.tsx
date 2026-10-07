import { useMemo } from 'react';
import { Link } from 'react-router';

import { HOME_LINK_CLASS, LiveMapCard } from '@alteroid/ui';
import { useTopology } from '@alteroid/swr';
import { formatDateTime, topologySceneFromSnapshot } from '@alteroid/logic';

import { useNowMs } from '~/lib/use-now';

import { UnreadableJobNote } from './managers';

// 刻みを細かくも粗くもしない: 細かすぎると再描画が増え、粗いと光の消えが遅れるため
const TICK_MS = 1000;

// 基準をブラウザの時計にしない: スナップショットの observedAt（デーモンの時計）に受け取ってからの経過を足す。時計がずれると光が出っぱなしや出ないままになるため
export function LiveMap() {
  const topology = useTopology();
  const { snapshot, receivedAt } = topology;
  const nowTick = useNowMs(TICK_MS, snapshot !== undefined);

  const scene = useMemo(() => {
    if (snapshot === undefined || receivedAt === undefined) return undefined;
    // Math.max で下限を取る: 時計が巻き戻っても、受け取った時刻より前に戻さないため
    const elapsed = Math.max(0, nowTick - receivedAt);
    return topologySceneFromSnapshot(snapshot, Date.parse(snapshot.observedAt) + elapsed);
  }, [snapshot, receivedAt, nowTick]);

  const omitted = snapshot?.managersOmitted ?? 0;
  const unreadable = snapshot?.unreadable ?? [];

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <LiveMapCard
        scene={scene}
        connection={topology.status}
        unavailable={topology.unavailable}
        staleAt={
          receivedAt === undefined ? undefined : formatDateTime(new Date(receivedAt).toISOString())
        }
        omittedNote={
          omitted > 0
            ? `ほか ${omitted} 本のマネージャーは地図に載せていない（全件はマネージャー一覧）`
            : undefined
        }
        action={
          <Link to="/managers" className={HOME_LINK_CLASS}>
            マネージャー一覧
          </Link>
        }
      />
      <UnreadableJobNote unreadable={unreadable} />
    </div>
  );
}
