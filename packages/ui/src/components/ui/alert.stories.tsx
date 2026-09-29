import type { Meta, StoryObj } from '@storybook/react-vite';
import { AlertTriangleIcon, InfoIcon } from 'lucide-react';

import { Alert, AlertTitle, AlertDescription, AlertAction } from './alert';
import { Button } from './button';

const meta = {
  title: 'UI/Alert',
  component: Alert,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof Alert>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => (
    <Alert className="w-80">
      <InfoIcon />
      <AlertTitle>保存しました</AlertTitle>
      <AlertDescription>設定は自動で反映されます。</AlertDescription>
    </Alert>
  ),
};

export const Destructive: Story = {
  render: () => (
    <Alert variant="destructive" className="w-80">
      <AlertTriangleIcon />
      <AlertTitle>エラーが発生しました</AlertTitle>
      <AlertDescription>マネージャーへの接続に失敗しました。</AlertDescription>
    </Alert>
  ),
};

export const WithAction: Story = {
  render: () => (
    <Alert className="w-80">
      <InfoIcon />
      <AlertTitle>更新があります</AlertTitle>
      <AlertDescription>再起動すると反映されます。</AlertDescription>
      <AlertAction>
        <Button size="sm" variant="outline">
          再起動する
        </Button>
      </AlertAction>
    </Alert>
  ),
};
