import { Page } from '@alteroid/ui';

import { useMinWidth } from '~/lib/use-min-width';

import { AwaitingYou } from './dashboard-awaiting';
import { LiveMap } from './dashboard-map';
import { LatestReport } from './dashboard-report';
import { SessionRefusalBand } from './dashboard-session-refusal';
import { HomeTiles } from './dashboard-tiles';

// 横並びを xl（1280）から始めない: 地図の列が 920px に届かず縦の木へ倒れて、見た目が変わってしまうため
const SIDE_BY_SIDE_MIN_WIDTH = 1800;

// 一覧の幅を比率（3:2 など）にしない: 広い画面で一覧だけが間延びするため
// 並びを CSS の order-* だけで替えない: Tab 順と読み上げ順が DOM のままになり、横並びのとき食い違うため
// useJournalLive / useJournalFeed を呼ばない: 日誌の購読は AuthedShell の1本のままにするため
// 横並びの grid の列を生の fr で引かない: minmax(auto, …) になり、広い地図の中身に列が押し広げられるため
export default function Dashboard() {
  const sideBySide = useMinWidth(SIDE_BY_SIDE_MIN_WIDTH);
  return (
    <Page title="ホーム" description="稼働状況・承認待ち・最新の日報・各機能の概況">
      <div className="flex min-w-0 flex-col gap-4">
        <SessionRefusalBand />
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
