import type { Meta, StoryObj } from '@storybook/react-vite';
import { BookText, CalendarClock, Coins, Hourglass } from 'lucide-react';
import type { ReactNode } from 'react';

import { Markdown } from '../../markdown';
import { Page } from '../../page';
import { Stat } from '../stat';
import { busyScene, idleScene, unknownScene } from '../topology/samples';

import {
  AwaitingApprovalRow,
  AwaitingCountRow,
  AwaitingYouCalm,
  AwaitingYouCard,
  HOME_LINK_CLASS,
  type HomeRenderLink,
} from './awaiting-you';
import { HomeReportCard } from './home-report-card';
import { HomeTile, HomeTileNote } from './home-tile';
import { LiveMapCard, type LiveMapConnection } from './live-map-card';

/**
 * ホーム。役割は「**いま動いているか・何をしているか・承認待ちは何か**」。
 * 上から: 承認待ち一覧（承認待ち・未了の仕事。無ければ1行に畳む）→ 稼働状況
 * （稼働状況の図。接続の状態を正直に言う）→ 小さなカード4枚（各ページへの入口）。
 *
 * 画面（`apps/web/app/routes/dashboard.tsx`）は同じ部品に実データを渡す。ここは見た目だけ。
 */
const meta = {
  title: 'Features/Home/Home',
  parameters: { layout: 'fullscreen' },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

const REPORT_BODY = `## 今日やったこと

- 稼働状況の図の API を足した。**持ち越し**は SSE の再接続の試験。
- ホームの配置を、広い画面では地図と承認待ちの横並びにした。

## 明日やること

1. 再接続の試験を書く
2. 日報の表示を大きくした件の見た目を確かめる

> 承認待ちは 2 件。どちらも朝のうちに答えが要る。`;

const LONG_REPORT_BODY = Array.from(
  { length: 12 },
  (_, i) => `## 項目 ${i + 1}\n\n${'長い日報の本文。'.repeat(14)}`,
).join('\n\n');

const renderLink: HomeRenderLink = ({ className, children }) => (
  <a href="#" onClick={(e) => e.preventDefault()} className={className}>
    {children}
  </a>
);

const link = (text: string) => (
  <a href="#" onClick={(e) => e.preventDefault()} className={HOME_LINK_CLASS}>
    {text}
  </a>
);

function Awaiting() {
  return (
    <AwaitingYouCard action={link('答える')}>
      <ul>
        <AwaitingApprovalRow
          question="PR #2695 を main へ squash マージしてよいか"
          meta="3分前"
          renderLink={renderLink}
        />
        <AwaitingApprovalRow
          question="Railway の本番の環境変数 ALTEROID_BIND を :: へ変えてよいか"
          meta="12分前"
          renderLink={renderLink}
        />
        <AwaitingCountRow label="未了" action={link('仕事へ')}>
          未了の仕事 <span className="text-foreground">5</span> 件
        </AwaitingCountRow>
      </ul>
    </AwaitingYouCard>
  );
}

/** 最新の日報。全幅の枠で、長い本文は高さで切り、「全文を表示」でその場に広げる。 */
function ReportCard({ long }: { long?: boolean }) {
  return (
    <HomeReportCard icon={BookText} title="最新の日報" meta="2026-10-03" action={link('日報一覧')}>
      <Markdown>{long ? LONG_REPORT_BODY : REPORT_BODY}</Markdown>
    </HomeReportCard>
  );
}

function Tiles({ narrow }: { narrow?: boolean }) {
  return (
    <div
      className={
        narrow ? 'grid grid-cols-1 gap-4' : 'grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3'
      }
    >
      <HomeTile icon={Hourglass} title="作業の進捗" action={link('詳しく')}>
        <Stat label="実行中の委譲" value="3" unit="件" hint="未了の仕事 5 件・7日で 12 件閉じた" />
      </HomeTile>
      <HomeTile icon={CalendarClock} title="次の自動実行" action={link('予定へ')}>
        <Stat label="日報を書く" value="21:00" hint="ほか 2 件" />
      </HomeTile>
      <HomeTile icon={Coins} title="今日の利用" action={link('詳しく')}>
        <Stat label="推定" value="$4.20" />
        <HomeTileNote>推定値。請求明細ではない</HomeTileNote>
      </HomeTile>
    </div>
  );
}

function Home({
  calm,
  map,
  connection = 'live',
  unavailable,
  narrow = false,
  wide = false,
  longReport = false,
  footer,
}: {
  calm: boolean;
  map?: typeof busyScene;
  connection?: LiveMapConnection;
  unavailable?: string;
  narrow?: boolean;
  /** 広い画面の配置（地図が左・承認待ちが右）。 */
  wide?: boolean;
  longReport?: boolean;
  footer?: ReactNode;
}) {
  const mapCard = (
    <LiveMapCard
      scene={map}
      connection={connection}
      unavailable={unavailable}
      staleAt={connection === 'offline' || unavailable !== undefined ? '10/04 07:52' : undefined}
      action={link('マネージャー一覧')}
      layout={narrow ? 'narrow' : 'auto'}
      omittedNote={footer}
    />
  );
  return (
    <Page title="ホーム" description="稼働状況・承認待ち・最新の日報・各機能の概況">
      <div className="flex flex-col gap-4">
        <div
          className={
            wide
              ? 'grid grid-cols-[minmax(0,1fr)_24rem] items-start gap-4'
              : 'flex min-w-0 flex-col gap-4'
          }
        >
          {wide ? mapCard : null}
          {calm ? <AwaitingYouCalm /> : <Awaiting />}
          {wide ? null : mapCard}
        </div>
        <ReportCard long={longReport} />
        <Tiles narrow={narrow} />
      </div>
    </Page>
  );
}

const frame = (children: ReactNode, height = 960) => (
  <div className="flex bg-background" style={{ height }}>
    <main className="flex min-w-0 flex-1 flex-col">{children}</main>
  </div>
);

/** 広い画面（1800px 以上）。地図が左・承認待ちが右の横並び。承認待ちがあり、マネージャーが走っている。 */
export const Desktop: Story = {
  render: () => frame(<Home calm={false} map={busyScene} wide />),
};

/** タブレット幅。縦積みで承認待ちが上。 */
export const Tablet: Story = {
  render: () => (
    <div className="mx-auto flex h-[1500px] w-[900px] bg-background">
      <main className="flex min-w-0 flex-1 flex-col">
        <Home calm={false} map={busyScene} />
      </main>
    </div>
  ),
};

/** 本文が長い日報。枠の高さで切れ、下端が薄れ、「続きを読む」が残る。 */
export const LongReport: Story = {
  render: () => frame(<Home calm map={idleScene} wide longReport />, 1100),
};

/** 何も待っていない・何も走っていない。「待っている」の段は1行に畳まれる。 */
export const Calm: Story = { render: () => frame(<Home calm map={idleScene} />, 860) };

/** 確かめられない軸は「不明」。待機・正常とは描かない。 */
export const UnknownAxes: Story = {
  render: () => frame(<Home calm map={unknownScene} />, 860),
};

/** 地図に繋がっていない（まだ何も届いていない）。 */
export const MapConnecting: Story = {
  render: () => frame(<Home calm connection="connecting" />, 700),
};

export const MapOffline: Story = {
  render: () => frame(<Home calm connection="offline" />, 700),
};

/** 切れたあと。最後の地図は残すが、古いと断る。 */
export const MapStale: Story = {
  render: () => frame(<Home calm connection="offline" map={busyScene} />),
};

/** デーモンが地図を組めていない（理由は種別だけ）。 */
export const MapUnavailable: Story = {
  render: () => frame(<Home calm map={busyScene} unavailable="ECONNREFUSED" />),
};

/** 地図に載せきれない分は件数で言う。 */
export const MapOmitted: Story = {
  render: () => frame(<Home calm map={busyScene} footer="ほか 4 本のマネージャーは載せていない" />),
};

/** 狭い画面。上から 待っている → 地図（縦の木）→ カード の順に積む。 */
export const Mobile: Story = {
  render: () => (
    <div className="mx-auto flex h-[1500px] w-[375px] flex-col border border-border bg-background">
      <main className="flex min-h-0 flex-1 flex-col">
        <Home calm={false} map={busyScene} narrow />
      </main>
    </div>
  ),
};
