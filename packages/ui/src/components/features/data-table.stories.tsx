import type { Meta, StoryObj } from '@storybook/react-vite';

import { Card } from '../common';

import { DataTable, type DataTableColumn } from './data-table';
import { StatusBadge, type StatusMap } from './status-badge';
import { Timestamp } from './timestamp';

/** 並べ替えられる表。狭い画面では行ごとに積んだ札になる。 */
const meta = {
  title: 'Features/DataTable',
  component: DataTable,
  parameters: { layout: 'padded' },
  tags: ['autodocs'],
} satisfies Meta<typeof DataTable>;

export default meta;
type Story = StoryObj<typeof meta>;

interface ManagerRow {
  id: string;
  status: 'running' | 'waiting_human' | 'done' | 'failed';
  request: string;
  costUsd: number | null;
  startedAt: string;
  startedLabel: string;
}

const STATUS: StatusMap<ManagerRow['status']> = {
  running: { tone: 'ok', label: '実行中' },
  waiting_human: { tone: 'warn', label: '人間待ち' },
  done: { tone: 'neutral', label: '待機中' },
  failed: { tone: 'danger', label: '失敗' },
};

const ROWS: ManagerRow[] = [
  {
    id: 'mgr-7f3c2a91',
    status: 'running',
    request: 'apps/web の見た目を差し替える',
    costUsd: 1.92,
    startedAt: '2026-09-29T20:14:07Z',
    startedLabel: '34 分前',
  },
  {
    id: 'mgr-2b8e1c04',
    status: 'waiting_human',
    request: '本番の DB へ migrate を当ててよいか確かめてから進める',
    costUsd: 0.88,
    startedAt: '2026-09-29T19:02:44Z',
    startedLabel: '2 時間前',
  },
  {
    id: 'mgr-9d4f6a17',
    status: 'failed',
    request: 'SDK の更新 PR の CI を直す',
    costUsd: null,
    startedAt: '2026-09-29T11:40:00Z',
    startedLabel: '9 時間前',
  },
  {
    id: 'mgr-0c1e7b55',
    status: 'done',
    request: '日報の締め時刻を 23:30 にする',
    costUsd: 0.2,
    startedAt: '2026-09-28T13:10:00Z',
    startedLabel: '昨日',
  },
];

const COLUMNS: DataTableColumn<ManagerRow>[] = [
  {
    key: 'id',
    header: 'マネージャー',
    cell: (row) => (
      <a href="#" className="font-mono text-xs text-primary hover:underline">
        {row.id}
      </a>
    ),
    sortValue: (row) => row.id,
  },
  {
    key: 'status',
    header: '状態',
    cell: (row) => <StatusBadge status={row.status} map={STATUS} />,
    sortValue: (row) => row.status,
  },
  { key: 'request', header: '依頼', cell: (row) => row.request, className: 'max-w-md' },
  {
    key: 'cost',
    header: '費用',
    align: 'right',
    // 取れない費用は 0 にしない。並べ替えでは末尾へ回る。
    cell: (row) =>
      row.costUsd === null ? (
        <span className="text-muted-foreground">記録なし</span>
      ) : (
        `$${row.costUsd.toFixed(2)}`
      ),
    sortValue: (row) => row.costUsd,
  },
  {
    key: 'started',
    header: '開始',
    align: 'right',
    cell: (row) => <Timestamp at={row.startedAt} label={row.startedLabel} />,
    sortValue: (row) => row.startedAt,
  },
];

export const Managers: Story = {
  args: { columns: [], rows: [], getRowKey: () => '' },
  render: () => (
    <Card className="max-w-4xl">
      <DataTable
        caption="マネージャー"
        columns={COLUMNS}
        rows={ROWS}
        getRowKey={(row) => row.id}
        initialSort={{ key: 'started', direction: 'desc' }}
      />
    </Card>
  ),
};

export const Empty: Story = {
  args: { columns: [], rows: [], getRowKey: () => '' },
  render: () => (
    <Card className="max-w-4xl">
      <DataTable
        columns={COLUMNS}
        rows={[]}
        getRowKey={(row) => row.id}
        empty="まだ委譲していない。"
      />
    </Card>
  ),
};
