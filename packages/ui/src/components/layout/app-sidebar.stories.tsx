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

/**
 * 画面（`apps/web/app/routes/shell.tsx`）と同じ整理: よく使う3つ＋まとまり（仕事・記録・
 * クローンの中身）＋設定。**行き先は1つも消していない** —— 畳んだ先（仕事の中の未了・進捗、
 * 設定の中の利用状況など）は各ページ先頭のタブ（`SectionTabs`）から行く。
 */
const SAMPLE_NAV_ITEMS: AppSidebarItem[] = [
  { to: '/', label: 'ホーム', icon: LayoutDashboard },
  {
    to: '/chat',
    label: '会話',
    icon: MessageSquare,
    // 未読のある会話の数（読めていないときは danger の「?」。承認待ちの札と同じ作法）。
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
