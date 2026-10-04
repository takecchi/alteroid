import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';

import { SectionTabs, type SectionTab } from './section-tabs';

const WORK_TABS: SectionTab[] = [
  { to: '/commitments', label: '未了の仕事' },
  { to: '/progress', label: '作業の進捗' },
];

const SETTINGS_TABS: SectionTab[] = [
  { to: '/settings', label: '接続' },
  { to: '/usage', label: '利用状況' },
  { to: '/tokens', label: '認証トークン' },
  { to: '/access', label: 'アクセス許可' },
  { to: '/permissions', label: '許可（Bash）' },
  { to: '/env-vars', label: '環境変数' },
  { to: '/profile', label: '実行環境プロファイル' },
  { to: '/mcp-servers', label: 'MCP 連携' },
];

/**
 * サイドバーの1行へ畳んだ「まとまり」の中を行き来するタブの帯。各ページの見出しの下に置く
 * （`Page` の `tabs`）。ルーターを知らない層なので、見本は `<a>` と手元の状態で現在地を再現する
 * （画面では `NavLink`）。
 */
const meta = {
  title: 'Layout/SectionTabs',
  component: SectionTabs,
  parameters: { layout: 'padded' },
  tags: ['autodocs'],
} satisfies Meta<typeof SectionTabs>;

export default meta;
type Story = StoryObj<typeof meta>;

function Demo({ label, tabs, width }: { label: string; tabs: SectionTab[]; width?: string }) {
  const [active, setActive] = useState(tabs[0]?.to);
  return (
    <div className="border-b border-border" style={{ width }}>
      <SectionTabs
        label={label}
        tabs={tabs}
        renderLink={(tab, slot) => (
          <a
            href={tab.to}
            aria-current={active === tab.to ? 'page' : undefined}
            className={slot.className(active === tab.to)}
            onClick={(event) => {
              event.preventDefault();
              setActive(tab.to);
            }}
          >
            {slot.children}
          </a>
        )}
      />
    </div>
  );
}

const args = { label: '仕事のページ', tabs: WORK_TABS, renderLink: () => null };

export const Work: Story = { args, render: () => <Demo label="仕事のページ" tabs={WORK_TABS} /> };

/** 8つ並ぶ「設定」。狭い幅では折り返さず、横にスクロールする。 */
export const SettingsNarrow: Story = {
  args,
  render: () => <Demo label="設定のページ" tabs={SETTINGS_TABS} width="360px" />,
};
