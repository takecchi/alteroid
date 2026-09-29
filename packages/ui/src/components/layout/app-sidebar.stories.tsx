import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
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

import { Badge } from '../common';

import { AppSidebar, type AppSidebarItem } from './app-sidebar';

const SAMPLE_NAV_ITEMS: AppSidebarItem[] = [
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

/**
 * 行き先の一覧（脇の面）。ルーターを知らない層なので、見本では `<a>` と手元の
 * 状態で現在地を再現している（画面では `NavLink`）。
 */
const meta = {
  title: 'Layout/AppSidebar',
  component: AppSidebar,
  parameters: { layout: 'fullscreen' },
  tags: ['autodocs'],
} satisfies Meta<typeof AppSidebar>;

export default meta;
type Story = StoryObj<typeof meta>;

function Footer() {
  return (
    <div className="border-t border-border px-4 py-3 text-[11px] text-muted-foreground">
      <span className="block truncate">記憶: postgres://db:5432/alteroid</span>
      <span className="block truncate">pid 48211</span>
    </div>
  );
}

function Demo({ inDrawer }: { inDrawer: boolean }) {
  const [active, setActive] = useState('/');
  return (
    <div className="flex h-[640px] w-fit">
      <AppSidebar
        status="live"
        items={SAMPLE_NAV_ITEMS}
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
    </div>
  );
}

const baseArgs = { status: 'live' as const, items: SAMPLE_NAV_ITEMS, renderLink: () => null };

export const Default: Story = { args: baseArgs, render: () => <Demo inDrawer={false} /> };

/** ドロワーの中（狭い画面）。行が 44px 以上になり、枠と幅はドロワーが持つ。 */
export const InDrawer: Story = { args: baseArgs, render: () => <Demo inDrawer /> };
