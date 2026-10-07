import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import {
  Activity,
  BellRing,
  BookText,
  Brain,
  CalendarClock,
  LayoutDashboard,
  ListChecks,
  MessageSquare,
  Settings,
  Users,
} from 'lucide-react';

import { Badge } from '../common';

import { AppSidebar, type AppSidebarItem } from './app-sidebar';

const SAMPLE_NAV_ITEMS: AppSidebarItem[] = [
  { to: '/', label: 'ホーム', icon: LayoutDashboard },
  {
    to: '/chat',
    label: '会話',
    icon: MessageSquare,
    badge: (
      <Badge tone="accent" aria-label="未読のある会話 2 件">
        2
      </Badge>
    ),
  },
  { to: '/approvals', label: '承認待ち', icon: BellRing, badge: <Badge tone="warn">3</Badge> },
  { to: '/commitments', label: '仕事', icon: ListChecks, section: '仕事' },
  { to: '/managers', label: 'マネージャー', icon: Users, section: '仕事' },
  { to: '/reports', label: '日報', icon: BookText, section: '記録' },
  { to: '/journal', label: '日誌', icon: Activity, section: '記録' },
  { to: '/memory', label: '記憶とやり方', icon: Brain, section: 'クローンの中身' },
  { to: '/schedule', label: '予定と受信箱', icon: CalendarClock, section: 'クローンの中身' },
  { to: '/settings', label: '設定', icon: Settings, section: '' },
];

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

export const InDrawer: Story = { args: baseArgs, render: () => <Demo inDrawer /> };
