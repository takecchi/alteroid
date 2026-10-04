import type { Meta, StoryObj } from '@storybook/react-vite';
import { BookText, CalendarClock, Coins, Hourglass } from 'lucide-react';
import type { ReactNode } from 'react';

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
import { HomeTile, HomeTileNote } from './home-tile';
import { LiveMapCard, type LiveMapConnection } from './live-map-card';

/**
 * ホーム。役割は「**いま動いているか・何をしているか・自分を待っているものは何か**」。
 * 上から: あなたを待っている（承認待ち・未了の仕事。無ければ1行に畳む）→ いま動いているもの
 * （稼働の地図。接続の状態を正直に言う）→ 小さなカード4枚（各ページへの入口）。
 *
 * 画面（`apps/web/app/routes/dashboard.tsx`）は同じ部品に実データを渡す。ここは見た目だけ。
 */
const meta = {
  title: 'Features/Home/Home',
  parameters: { layout: 'fullscreen' },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

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

function Tiles({ narrow }: { narrow?: boolean }) {
  return (
    <div
      className={
        narrow ? 'grid grid-cols-1 gap-4' : 'grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4'
      }
    >
      <HomeTile icon={BookText} title="最新の日報" action={link('開く')}>
        <p className="text-xs text-muted-foreground">10/03</p>
        <p className="mt-1 line-clamp-4 text-sm">
          今日やったこと 稼働の地図の API を足した。持ち越しは SSE の再接続の試験。
        </p>
      </HomeTile>
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
  footer,
}: {
  calm: boolean;
  map?: typeof busyScene;
  connection?: LiveMapConnection;
  unavailable?: string;
  narrow?: boolean;
  footer?: ReactNode;
}) {
  return (
    <Page
      title="ホーム"
      description="いま動いているか、何をしているか、あなたを待っているものは何か"
    >
      <div className="flex flex-col gap-4">
        {calm ? <AwaitingYouCalm /> : <Awaiting />}
        <LiveMapCard
          scene={map}
          connection={connection}
          unavailable={unavailable}
          staleAt={
            connection === 'offline' || unavailable !== undefined ? '10/04 07:52' : undefined
          }
          action={link('マネージャー一覧')}
          layout={narrow ? 'narrow' : 'auto'}
          omittedNote={footer}
        />
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

/** 承認待ちがあり、マネージャーが走っている。 */
export const Desktop: Story = { render: () => frame(<Home calm={false} map={busyScene} />) };

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
