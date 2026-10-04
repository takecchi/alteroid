import type { Meta, StoryObj } from '@storybook/react-vite';
import { BookText, CalendarClock, Coins, Hourglass } from 'lucide-react';
import { useState, type ComponentType, type ReactNode } from 'react';

import { Badge, Card, CardHeader } from '../common';
import { Stat } from '../features/stat';
import { busyScene, idleScene } from '../features/topology/samples';
import { SystemTopology } from '../features/topology/system-topology';
import { Page } from '../page';

import { AppSidebar } from './app-sidebar';
import { MobileTopBar } from './mobile-top-bar';
import { PROPOSED_NAV_ITEMS } from './nav-samples';

/**
 * ホーム（ダッシュボード）とサイドバーの整理の**提案**。画面（`apps/web`）にはまだ無い。
 *
 * ホームの役割を「**いま動いているか・何をしているか・自分を待っているものは何か**」に絞る。
 * 上から順に:
 *
 * 1. **あなたを待っている** —— 承認待ちと、人間の番の未了の仕事。人間が手を動かすものだけ
 * 2. **いま動いているもの** —— 稼働の地図（主役）。「動いているか」を日報で確かめに行かなくて済む
 * 3. **小さなカード** —— 最新の日報・作業の進捗・次の自動実行・今日の利用（各ページへの入口）
 *
 * いまのダッシュボードから外すもの: 「稼働中のマネージャー」（地図が同じものを見せる）と
 * 「いま届いている出来事」（日誌の生の流れ。日誌のページへ）。
 */
const meta = {
  title: 'Layout/HomeProposal',
  parameters: { layout: 'fullscreen' },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

const APPROVALS = [
  {
    id: 'a1',
    who: 'mgr-c019',
    question: 'PR #2695 を main へ squash マージしてよいか',
    ago: '3分前',
  },
  {
    id: 'a2',
    who: 'クローン',
    question: 'Railway の本番の環境変数 ALTEROID_BIND を :: へ変えてよいか',
    ago: '12分前',
  },
];

function TextLink({ children }: { children: ReactNode }) {
  return (
    <a
      href="#"
      onClick={(e) => e.preventDefault()}
      className="text-xs text-primary hover:underline"
    >
      {children}
    </a>
  );
}

/** 人間が手を動かすものだけ。無ければ1行で「無い」と言って畳む（場所は空けたままにしない）。 */
function AwaitingYou({ calm }: { calm: boolean }) {
  if (calm) {
    return (
      <Card className="min-w-0">
        <div className="flex items-center gap-2 px-4 py-3 text-sm text-muted-foreground">
          <span className="size-1.5 rounded-full bg-ok" aria-hidden />
          あなたを待っているものはない
        </div>
      </Card>
    );
  }
  return (
    <Card className="min-w-0 border-warn/50">
      <CardHeader
        title="あなたを待っている"
        subtitle="答えるまで、その仕事だけが止まる"
        action={<TextLink>承認待ちへ</TextLink>}
      />
      <ul>
        {APPROVALS.map((a) => (
          <li key={a.id} className="border-b border-border px-4 py-2.5 last:border-b-0">
            <a href="#" onClick={(e) => e.preventDefault()} className="flex items-start gap-3">
              <Badge tone="warn">承認</Badge>
              <span className="min-w-0 flex-1">
                <span className="line-clamp-2 text-sm">{a.question}</span>
                <span className="mt-0.5 block text-[11px] text-muted-foreground">
                  {a.who} · {a.ago}
                </span>
              </span>
            </a>
          </li>
        ))}
        <li className="flex items-center gap-3 px-4 py-2.5 text-sm">
          <Badge>未了</Badge>
          <span className="min-w-0 flex-1 text-muted-foreground">
            人間の番の未了の仕事 <span className="text-foreground">2</span> 件（全体 5 件）
          </span>
          <TextLink>仕事へ</TextLink>
        </li>
      </ul>
    </Card>
  );
}

function LiveMap({ busy, narrow }: { busy: boolean; narrow: boolean }) {
  return (
    <Card className="min-w-0">
      <CardHeader
        title="いま動いているもの"
        subtitle="光は直近の指示（紫）と報告（青）。札を押すと詳細"
        action={<TextLink>マネージャー一覧</TextLink>}
      />
      <div className="px-3 py-3">
        <SystemTopology {...(busy ? busyScene : idleScene)} layout={narrow ? 'narrow' : 'auto'} />
      </div>
    </Card>
  );
}

function Tile({
  icon: Icon,
  title,
  link,
  children,
}: {
  icon: ComponentType<{ className?: string; 'aria-hidden'?: boolean }>;
  title: string;
  link: string;
  children: ReactNode;
}) {
  return (
    <Card className="min-w-0">
      <div className="flex items-center gap-2 px-4 pt-3 text-xs text-muted-foreground">
        <Icon className="size-3.5" aria-hidden />
        <span className="flex-1">{title}</span>
        <TextLink>{link}</TextLink>
      </div>
      <div className="px-4 pt-2 pb-3">{children}</div>
    </Card>
  );
}

function Tiles({ narrow }: { narrow: boolean }) {
  return (
    <div
      className={
        narrow ? 'grid grid-cols-1 gap-4' : 'grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4'
      }
    >
      <Tile icon={BookText} title="最新の日報" link="開く">
        <Stat label="10/03" value="3" unit="件 完了" hint="持ち越し 1 件・承認待ち 1 件" />
      </Tile>
      <Tile icon={Hourglass} title="作業の進捗" link="仕事へ">
        <Stat label="実施中" value="3" unit="件" hint="今週 12 件片付け・積み上がり 5" />
      </Tile>
      <Tile icon={CalendarClock} title="次の自動実行" link="予定へ">
        <Stat label="日報" value="21:00" hint="ほか 2 件が今日のうちに" />
      </Tile>
      <Tile icon={Coins} title="今日の利用" link="利用状況へ">
        <Stat label="推定" value="$4.20" hint="請求明細ではない" />
      </Tile>
    </div>
  );
}

/** `narrow` は見本の枠が狭いとき（画面幅ではなく枠で決まるので、地図の配置を外から固定する）。 */
function Home({ calm, busy, narrow = false }: { calm: boolean; busy: boolean; narrow?: boolean }) {
  return (
    <Page
      title="ホーム"
      description="いま動いているか、何をしているか、あなたを待っているものは何か"
    >
      <div className="flex flex-col gap-4">
        <AwaitingYou calm={calm} />
        <LiveMap busy={busy} narrow={narrow} />
        <Tiles narrow={narrow} />
      </div>
    </Page>
  );
}

/** `calm` のときは承認待ちの札を外す（本文の「待っているものはない」と食い違わせない）。 */
function Sidebar({ inDrawer = false, calm = false }: { inDrawer?: boolean; calm?: boolean }) {
  const [active, setActive] = useState('/');
  return (
    <AppSidebar
      status="live"
      items={
        calm
          ? PROPOSED_NAV_ITEMS.map((item) => ({ ...item, badge: undefined }))
          : PROPOSED_NAV_ITEMS
      }
      inDrawer={inDrawer}
      renderLink={(item, slot) => (
        <a
          href={item.to}
          onClick={(event) => {
            event.preventDefault();
            setActive(item.to);
          }}
          aria-current={active === item.to ? 'page' : undefined}
          className={slot.className(active === item.to)}
        >
          {slot.children}
        </a>
      )}
    />
  );
}

/** 広い画面。承認待ちがあり、マネージャーが走っている。 */
export const Desktop: Story = {
  render: () => (
    <div className="flex h-[960px] bg-background">
      <Sidebar />
      <main className="flex min-w-0 flex-1 flex-col">
        <Home calm={false} busy />
      </main>
    </div>
  ),
};

/** 何も待っていない・何も走っていないとき。「待っている」の段は1行に畳まれる。 */
export const DesktopCalm: Story = {
  render: () => (
    <div className="flex h-[860px] bg-background">
      <Sidebar calm />
      <main className="flex min-w-0 flex-1 flex-col">
        <Home calm busy={false} />
      </main>
    </div>
  ),
};

/** 狭い画面。上から 待っている → 地図（縦の木）→ カード の順に積む。 */
export const Mobile: Story = {
  render: () => (
    <div className="mx-auto flex h-[1500px] w-[375px] flex-col border border-border bg-background">
      <MobileTopBar status="live" onOpenNav={() => undefined} />
      <main className="flex min-h-0 flex-1 flex-col">
        <Home calm={false} busy narrow />
      </main>
    </div>
  ),
};

/** 狭い画面でメニューを開いたときの中身（ドロワーの中）。 */
export const MobileNav: Story = {
  render: () => (
    <div className="mx-auto flex h-[700px] w-[280px] flex-col border border-border bg-card">
      <Sidebar inDrawer />
    </div>
  ),
};
