import type { Meta, StoryObj } from '@storybook/react-vite';
import {
  Activity,
  BellRing,
  BookText,
  Brain,
  DollarSign,
  LayoutDashboard,
  ListChecks,
  MessageSquare,
  Settings,
  Users,
} from 'lucide-react';
import { useState } from 'react';

import { Badge, Button, ErrorNote } from '../common';
import { Page } from '../page';
import { Stat } from '../data/stat';

import { AppSidebar, type AppSidebarItem } from './app-sidebar';
import { BrandMark } from './brand-mark';
import { LiveIndicator } from './live-indicator';
import { MobileTopBar } from './mobile-top-bar';
import { ScreenLoading, ScreenState } from './screen-state';

/**
 * 画面の骨組み（`components/layout/`）。ルーターを知らない層なので、見本では
 * `<a>` と手元の状態でリンクの見た目を再現している（画面では `NavLink`）。
 */
const meta = {
  title: 'App/Layout',
  parameters: { layout: 'fullscreen' },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

const ITEMS: AppSidebarItem[] = [
  { to: '/', label: 'ダッシュボード', icon: LayoutDashboard },
  { to: '/chat', label: '会話', icon: MessageSquare },
  { to: '/approvals', label: '承認待ち', icon: BellRing, badge: <Badge tone="warn">3</Badge> },
  { to: '/commitments', label: '未了の仕事', icon: ListChecks },
  { to: '/managers', label: 'マネージャー', icon: Users },
  { to: '/journal', label: '日誌', icon: Activity },
  { to: '/reports', label: '日報', icon: BookText },
  { to: '/usage', label: '利用状況', icon: DollarSign },
  { to: '/memory', label: '記憶', icon: Brain },
  { to: '/settings', label: '設定', icon: Settings },
];

function Footer() {
  return (
    <div className="border-t border-border px-4 py-3 text-[11px] text-muted-foreground">
      <span className="block truncate">記憶: postgres://db:5432/alteroid</span>
      <span className="block truncate">pid 48211</span>
    </div>
  );
}

function SidebarDemo({ inDrawer = false }: { inDrawer?: boolean }) {
  const [active, setActive] = useState('/');
  return (
    <AppSidebar
      status="live"
      items={ITEMS}
      inDrawer={inDrawer}
      footer={<Footer />}
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

function ShellDemo() {
  return (
    <div className="flex h-dvh">
      <SidebarDemo />
      <main className="flex min-h-0 min-w-0 flex-1 flex-col">
        <Page title="ダッシュボード" description="いま何が動いていて、何が人間を待っているか">
          <div className="grid grid-cols-1 gap-6 sm:grid-cols-3">
            <Stat
              label="承認待ち"
              value="3"
              unit="件"
              tone="warn"
              hint="いちばん古いのは 42 分前"
            />
            <Stat label="稼働中のマネージャー" value="2" unit="件" />
            <Stat label="今日の費用" value="$4.18" hint="日報の締めまで 6 時間" />
          </div>
        </Page>
      </main>
    </div>
  );
}

export const Shell: Story = { render: () => <ShellDemo /> };

export const Sidebar: Story = {
  render: () => (
    <div className="flex h-dvh">
      <SidebarDemo />
    </div>
  ),
};

export const MobileBar: Story = {
  parameters: { viewport: { defaultViewport: 'mobile1' } },
  render: () => (
    <div className="max-w-sm">
      <MobileTopBar
        status="connecting"
        onOpenNav={() => undefined}
        trailing={
          <a href="/approvals" className="flex min-h-11 shrink-0 items-center px-2">
            <Badge tone="warn">承認待ち 3</Badge>
          </a>
        }
      />
    </div>
  ),
};

export const Brand: Story = {
  render: () => (
    <div className="flex flex-col gap-6 p-8">
      <BrandMark />
      <BrandMark withWordmark={false} />
      <div className="flex gap-6">
        <LiveIndicator status="live" />
        <LiveIndicator status="connecting" />
        <LiveIndicator status="offline" />
      </div>
    </div>
  ),
};

export const Unreachable: Story = {
  render: () => (
    <ScreenState title="デーモンに繋がらない">
      <ErrorNote error={new Error('fetch failed: http://localhost:4280/api/health')} />
      <p className="mt-3 text-xs text-muted-foreground">
        接続先を直すとこの画面は自動で進む。デーモンが起きていないだけなら
        <code className="mx-1 font-mono">alteroid daemon start</code>。
      </p>
      <div className="mt-4">
        <Button variant="primary">接続先を直す</Button>
      </div>
    </ScreenState>
  ),
};

export const Loading: Story = { render: () => <ScreenLoading label="接続を確認中" /> };
