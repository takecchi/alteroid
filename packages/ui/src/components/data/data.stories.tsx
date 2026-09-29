import type { Meta, StoryObj } from '@storybook/react-vite';
import { Inbox } from 'lucide-react';

import { Button, Card, CardHeader } from '../common';

import { CodeBlock } from './code-block';
import { EmptyState } from './empty-state';
import { KeyValueList } from './key-value-list';
import { Stat } from './stat';
import { StatusDot } from './status-dot';

/** 値の見せ方（`components/data/`）。 */
const meta = {
  title: 'App/Data',
  parameters: { layout: 'padded' },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

export const Stats: Story = {
  render: () => (
    <Card className="max-w-3xl">
      <CardHeader title="今日" subtitle="2026-09-30（JST）" />
      <div className="grid grid-cols-1 gap-6 p-4 sm:grid-cols-4">
        <Stat label="費用" value="$4.18" hint="上限 $20.00" />
        <Stat label="承認待ち" value="3" unit="件" tone="warn" />
        <Stat label="完了した委譲" value="12" unit="件" tone="ok" />
        <Stat label="作業者の費用" value="—" hint="台帳に site が無いので取れない" />
      </div>
    </Card>
  ),
};

export const KeyValues: Story = {
  render: () => (
    <Card className="max-w-xl">
      <CardHeader title="接続先" />
      <div className="p-4">
        <KeyValueList
          items={[
            { label: 'URL', value: 'http://localhost:4280/api', mono: true },
            { label: '記憶', value: 'postgres://db:5432/alteroid', mono: true },
            { label: 'pid', value: '48211', mono: true },
            { label: '資格', value: '持ち主（ALTEROID_OPERATOR_TOKEN）' },
            {
              label: '作業ツリー',
              value: '/workspace/mgr-7f3c2a91-4b1e-4d6a-9c0f-2e8b1a5d3c7e/repo/apps/web/app/routes',
              mono: true,
            },
          ]}
        />
      </div>
    </Card>
  ),
};

export const Code: Story = {
  render: () => (
    <div className="max-w-2xl space-y-4">
      <CodeBlock label="alteroid manager logs mgr-7f3c">
        {`2026-09-30T02:14:07Z  start   依頼: apps/web の見た目を差し替える
2026-09-30T02:14:09Z  tool    Bash: pnpm --filter @alteroid/ui typecheck
2026-09-30T02:15:41Z  tool    Bash: pnpm --filter @alteroid/web test
2026-09-30T02:18:02Z  done    exit 0（52 files, 1184 tests）`}
      </CodeBlock>
      <CodeBlock copyable={false} maxHeight="6rem">
        {Array.from({ length: 12 }, (_, i) => `line ${i + 1}: 高さを抑えて中でスクロールする`).join(
          '\n',
        )}
      </CodeBlock>
    </div>
  ),
};

export const Status: Story = {
  render: () => (
    <div className="flex flex-wrap gap-6">
      <StatusDot tone="ok">完了</StatusDot>
      <StatusDot tone="accent">実行中</StatusDot>
      <StatusDot tone="warn">承認待ち</StatusDot>
      <StatusDot tone="danger">失敗</StatusDot>
      <StatusDot>待機</StatusDot>
    </div>
  ),
};

export const EmptyStates: Story = {
  render: () => (
    <Card className="max-w-xl">
      <EmptyState
        icon={Inbox}
        title="受信箱は空"
        description="外部イベント（POST /events）が届くと、クローンが読むまでここに残る。"
        action={<Button size="sm">イベントの送り方を見る</Button>}
      />
    </Card>
  ),
};
