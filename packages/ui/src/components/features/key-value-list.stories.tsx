import type { Meta, StoryObj } from '@storybook/react-vite';

import { KeyValueList } from './key-value-list';

/** 名前と値の組の並び。狭い画面では1列に積む。 */
const meta = {
  title: 'Features/KeyValueList',
  component: KeyValueList,
  parameters: { layout: 'padded' },
  tags: ['autodocs'],
  decorators: [
    (Story) => (
      <div className="max-w-xl">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof KeyValueList>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {
    items: [
      { label: 'URL', value: 'http://localhost:4280/api', mono: true },
      { label: '記憶', value: 'postgres://db:5432/alteroid', mono: true },
      { label: 'pid', value: '48211', mono: true },
      { label: '資格', value: '持ち主（ALTEROID_OPERATOR_TOKEN）' },
      {
        label: '作業ツリー',
        value: '/workspace/mgr-7f3c2a91-4b1e-4d6a-9c0f-2e8b1a5d3c7e/repo/apps/web/app/routes',
        mono: true,
      },
    ],
  },
};
