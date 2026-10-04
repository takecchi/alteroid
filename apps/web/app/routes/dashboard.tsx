import { Page } from '@alteroid/ui';

import { useMinWidth } from '~/lib/use-min-width';

import { AwaitingYou } from './dashboard-awaiting';
import { LiveMap } from './dashboard-map';
import { LatestReport } from './dashboard-report';
import { HomeTiles } from './dashboard-tiles';

/**
 * 横に並べ始める幅（Tailwind の `xl`）。**サイドバーが出る `md`（768px）や `lg`（1024px）では
 * 並べない**: サイドバーを引いた本体は 1024px の画面で 770px ほどしか無く、地図と一覧を
 * 並べると両方が窮屈になる。`HomeTiles` が3列になる幅（`xl:grid-cols-3`）と同じ境目にして
 * あり、「ホームが広い配置になる幅」は1つに揃う。
 */
const SIDE_BY_SIDE_MIN_WIDTH = 1280;

/**
 * ホーム（`/`）。役割は「**いま動いているか・何をしているか・自分を待っているものは何か**」。
 *
 * 1. **稼働の地図**（`dashboard-map.tsx`）と **承認待ち一覧**（`dashboard-awaiting.tsx`）
 *    - 広い画面（`xl` 以上）: **地図が左・一覧が右の横並び**。地図は横幅を使う部品なので広く
 *      （3:2）、一覧は承認の質問を2行で畳む行なので 2 で足りる
 *    - それより狭い画面: 縦積みで **承認待ち一覧が上**（人間が手を動かすものを先に）
 * 2. **最新の日報**（`dashboard-report.tsx`）—— 全幅の枠で、本文を Markdown で読ませる。
 *    主役のひとつだが、地図・承認待ちの下に置く（それらは「いま」の状態、日報は読み物。上の段の
 *    横並び・縦積みの方針を崩さず、どの幅でも全幅の1段として足せる）
 * 3. **小さなカード** —— 作業の進捗・次の自動実行・今日の利用。各ページへの入口
 *    （`dashboard-tiles.tsx`）
 *
 * **並びの入れ替えは DOM の順ごと JS で替える**（`useMinWidth`）。CSS の `order-*` だけで
 * 見た目を替えると、Tab 順と読み上げ順は DOM のまま（承認待ち → 地図）になり、横並びのとき
 * 「左（地図）より先に右へ飛ぶ」食い違いになる。DOM の順を見た目に合わせれば食い違わない。
 *
 * **日誌の生の流れ（旧「いま届いている出来事」）はここに置かない。** 日誌のページが持つ
 * （購読は `AuthedShell` の1本のまま。ここは `useJournalLive` も `useJournalFeed` も呼ばない）。
 * 稼働中のマネージャーの一覧も、地図が同じものを見せるので置かない。
 *
 * ⚠️ #295: 横並びの grid は `minmax(0, …)` で列を引いてあり（生の `fr` は `minmax(auto, …)` で、
 * 広い地図の中身に列が押し広げられる）、子の枠は `min-w-0` を持つ。カードを並べる grid は
 * `HomeTiles`（`grid-cols-1` が基底に在る）。縦積みは1列の flex で各枠は `min-w-0`。
 */
export default function Dashboard() {
  const sideBySide = useMinWidth(SIDE_BY_SIDE_MIN_WIDTH);
  return (
    <Page
      title="ホーム"
      description="いま動いているか、何をしているか、あなたを待っているものは何か"
    >
      <div className="flex min-w-0 flex-col gap-4">
        {sideBySide ? (
          <div
            data-testid="home-main"
            data-layout="side-by-side"
            className="grid grid-cols-[minmax(0,3fr)_minmax(0,2fr)] items-start gap-4"
          >
            <LiveMap />
            <AwaitingYou />
          </div>
        ) : (
          <div
            data-testid="home-main"
            data-layout="stacked"
            className="flex min-w-0 flex-col gap-4"
          >
            <AwaitingYou />
            <LiveMap />
          </div>
        )}
        <LatestReport />
        <HomeTiles />
      </div>
    </Page>
  );
}
