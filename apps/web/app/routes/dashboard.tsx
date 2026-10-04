import { Page } from '@alteroid/ui';

import { AwaitingYou } from './dashboard-awaiting';
import { LiveMap } from './dashboard-map';
import { HomeTiles } from './dashboard-tiles';

/**
 * ホーム（`/`）。役割は「**いま動いているか・何をしているか・自分を待っているものは何か**」。
 * 上から順に:
 *
 * 1. **あなたを待っている** —— 承認待ちと未了の仕事の件数。人間が手を動かすものだけ
 *    （`dashboard-awaiting.tsx`）
 * 2. **いま動いているもの** —— 稼働の地図（主役）。「動いているか」を日報で確かめに行かなくて
 *    済む（`dashboard-map.tsx`）
 * 3. **小さなカード** —— 最新の日報・作業の進捗・次の自動実行・今日の利用。各ページへの入口
 *    （`dashboard-tiles.tsx`）
 *
 * **日誌の生の流れ（旧「いま届いている出来事」）はここに置かない。** 日誌のページが持つ
 * （購読は `AuthedShell` の1本のまま。ここは `useJournalLive` も `useJournalFeed` も呼ばない）。
 * 稼働中のマネージャーの一覧も、地図が同じものを見せるので置かない。
 *
 * ⚠️ #295: カードを並べる grid は `HomeTiles`（`grid-cols-1` が基底に在る）の中だけで、
 * 暗黙トラックの grid は無い。1列の flex 縦積みの各枠は `min-w-0` を持つ。
 */
export default function Dashboard() {
  return (
    <Page
      title="ホーム"
      description="いま動いているか、何をしているか、あなたを待っているものは何か"
    >
      <div className="flex min-w-0 flex-col gap-4">
        <AwaitingYou />
        <LiveMap />
        <HomeTiles />
      </div>
    </Page>
  );
}
