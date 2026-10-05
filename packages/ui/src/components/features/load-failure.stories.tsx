import type { Meta, StoryObj } from '@storybook/react-vite';

import { Card } from '../common';
import { LoadFailure } from './load-failure';

/**
 * 読み込みに失敗したときの帯。何を・なぜ・どうすればを言い、「もう一度試す」を置く。
 * 生の応答文は「詳細」の中に小さく添える。
 */
const meta = {
  title: 'Features/LoadFailure',
  component: LoadFailure,
  parameters: { layout: 'padded' },
} satisfies Meta<typeof LoadFailure>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Network: Story = {
  args: {
    title: '日報を読み込めませんでした',
    summary: '接続先のサーバにつながっていません。',
    hint: 'サーバが起きているか、接続先が合っているかを確かめて、もう一度試してください。',
    detail: 'Failed to fetch',
    onRetry: () => undefined,
  },
};

export const Server: Story = {
  args: {
    title: 'マネージャー一覧を読み込めませんでした',
    summary: 'サーバの側で処理に失敗しました。',
    hint: '少し待ってから、もう一度試してください。',
    detail: 'HTTP 500: boom',
    onRetry: () => undefined,
  },
};

export const Retrying: Story = {
  args: {
    title: 'マネージャー一覧を読み込めませんでした',
    summary: 'サーバの側で処理に失敗しました。',
    detail: 'HTTP 500: boom',
    onRetry: () => undefined,
    retrying: true,
  },
};

/** カードの中に置いても、帯が左右の余白の内側に収まる（#2798）。 */
export const InsideCard: Story = {
  args: {
    title: '失敗した記録を読み込めませんでした',
    summary: 'サーバの側で処理に失敗しました。',
    detail: 'HTTP 500: boom',
    onRetry: () => undefined,
  },
  render: (args) => (
    <Card>
      <LoadFailure {...args} className="m-4" />
    </Card>
  ),
};

export const NoRetry: Story = {
  args: {
    title: '使用量を読み込めませんでした',
    summary: 'この画面を見る許可がありません。',
    detail: 'HTTP 403: forbidden',
  },
};
