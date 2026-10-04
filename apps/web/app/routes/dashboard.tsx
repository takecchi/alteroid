import { Page } from '@alteroid/ui';

import { useMinWidth } from '~/lib/use-min-width';

import { AwaitingYou } from './dashboard-awaiting';
import { LiveMap } from './dashboard-map';
import { LatestReport } from './dashboard-report';
import { HomeTiles } from './dashboard-tiles';

/**
 * 横に並べ始める幅（1800px）。**地図の列に、図の横の配置が余裕をもって収まる幅**から決めた。
 * 本体の幅 = 画面幅 − サイドバー 224 − 余白 48。横並びの地図の列 = 本体 − 隙間 16 − 承認待ち 384
 * （24rem）。図の幅 = 列 − カードの内側 24 ⟹ 画面幅 − 696。図の自然寸は 1152（倍率 1.0）で、
 * 倍率 0.9 以上にするには 画面幅 ≥ 1733。1800 なら図 1104（倍率 0.96）。
 * これより狭い幅は縦積みで、地図は全幅（画面幅 − 296）の横の配置になる（1366px で倍率 0.93、
 * 以前のラップトップ幅の見た目のまま）。`xl`（1280）で横並びにすると、地図の列が 920px に届かず
 * 縦の木へ倒れて、見た目が変わってしまう。
 */
const SIDE_BY_SIDE_MIN_WIDTH = 1800;

/**
 * ホーム（`/`）。役割は「**いま動いているか・何をしているか・承認待ちは何か**」。
 *
 * 1. **稼働状況の図**（`dashboard-map.tsx`）と **承認待ち一覧**（`dashboard-awaiting.tsx`）
 *    - 広い画面（1800px 以上）: **地図が左・一覧が右の横並び**。**一覧を 24rem の固定幅**（承認の
 *      質問を2行で畳む行なので足りる）にして、残りを全部地図へ渡す（地図は横幅を使う部品）。
 *      地図は枠の幅で配置を替える（`SystemTopology`: 920px 以上で横、未満で縦の木。横は倍率 1.0 が上限）。
 *      比率（3:2 など）にしないのは、広い画面で一覧だけが間延びするため
 *    - それより狭い画面: 縦積みで **承認待ち一覧が上**、地図は全幅（人間が手を動かすものを先に）
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
    <Page title="ホーム" description="稼働状況・承認待ち・最新の日報・各機能の概況">
      <div className="flex min-w-0 flex-col gap-4">
        {sideBySide ? (
          <div
            data-testid="home-main"
            data-layout="side-by-side"
            className="grid grid-cols-[minmax(0,1fr)_24rem] items-start gap-4"
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
