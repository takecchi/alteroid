import type { Meta, StoryObj } from '@storybook/react-vite';

import { Button, ErrorNote } from '../common';

import { ScreenLoading, ScreenState } from './screen-state';

const meta = {
  title: 'Layout/ScreenState',
  component: ScreenState,
  parameters: { layout: 'fullscreen' },
  tags: ['autodocs'],
} satisfies Meta<typeof ScreenState>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Unreachable: Story = {
  args: {
    title: '接続先のサーバに繋がらない',
    children: (
      <>
        <ErrorNote error={new Error('fetch failed: http://localhost:4280/api/health')} />
        <p className="mt-3 text-xs text-muted-foreground">
          接続先を直すとこの画面は自動で進む。サーバが起きていないだけなら
          <code className="mx-1 font-mono">alteroid daemon start</code>。
        </p>
        <div className="mt-4">
          <Button variant="primary">接続先を直す</Button>
        </div>
      </>
    ),
  },
};

export const Loading: Story = { render: () => <ScreenLoading label="接続を確認中" /> };
