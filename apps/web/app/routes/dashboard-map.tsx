import { useMemo } from 'react';
import { Link } from 'react-router';

import { HOME_LINK_CLASS, LiveMapCard } from '@alteroid/ui';
import { useManagers, useTopology } from '@alteroid/swr';
import { formatDateTime, topologySceneFromSnapshot } from '@alteroid/logic';

import { useNowMs } from '~/lib/use-now';

import { UnreadableJobNote } from './managers';

/** 光の窓（数秒）を進める刻み。細かすぎると再描画が増え、粗いと光の消えが遅れる。 */
const TICK_MS = 1000;

/**
 * 「いま動いているもの」—— 稼働の地図。`GET /topology/stream` の購読（`useTopology`。ホームだけが
 * 開く）から場面を作って `SystemTopology` へ渡す。
 *
 * ## 時間の進め方
 *
 * 「いま流れている」は時刻の窓で決まる（`topologySceneFromSnapshot`）。**基準はブラウザの
 * 時計ではなく、スナップショットの `observedAt`（デーモンの時計）に、受け取ってからの経過を
 * 足したもの**にする——ブラウザとデーモンの時計がずれていても、光が出っぱなしになったり
 * 一度も出なかったりしない。デーモンは変わったときしか送らないので、窓が過ぎたら画面の側で
 * 時間を進めて光を消す（`useNowMs`）。
 *
 * ## 正直さ
 *
 * 接続の状態・組めない理由・古いことは `LiveMapCard` が言う。地図に載せきれなかった委譲の
 * 件数（`managersOmitted`）はここで地図の下に言う。
 *
 * **読めない委譲の行（#2345）は、地図からは見えない**（デーモンの地図は読めた行だけで組む）。
 * 地図が「走っているマネージャーはいません」と言うとき、壊れた行が居ないことにならないよう、
 * 一覧の読み取り（`useManagers`）の `unreadable` を地図の下で断る。旧ダッシュボードの
 * 「稼働中のマネージャー」カードが持っていた約束を、そのカードを外したあとも落とさない。
 */
export function LiveMap() {
  const topology = useTopology();
  const managers = useManagers();
  const { snapshot, receivedAt } = topology;
  const nowTick = useNowMs(TICK_MS, snapshot !== undefined);

  const scene = useMemo(() => {
    if (snapshot === undefined || receivedAt === undefined) return undefined;
    // デーモンの時計での「いま」。受け取った時刻より前（時計の巻き戻し）には戻さない。
    const elapsed = Math.max(0, nowTick - receivedAt);
    return topologySceneFromSnapshot(snapshot, Date.parse(snapshot.observedAt) + elapsed);
  }, [snapshot, receivedAt, nowTick]);

  const omitted = snapshot?.managersOmitted ?? 0;
  const unreadable = Array.isArray(managers.data?.managers) ? (managers.data.unreadable ?? []) : [];

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
