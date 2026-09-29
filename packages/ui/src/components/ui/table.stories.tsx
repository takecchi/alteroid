import type { Meta, StoryObj } from '@storybook/react-vite';

import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
  TableCaption,
} from './table';

const meta = {
  title: 'shadcn/Table',
  component: Table,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof Table>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => (
    <Table className="w-96">
      <TableCaption>マネージャーの一覧</TableCaption>
      <TableHeader>
        <TableRow>
          <TableHead>名前</TableHead>
          <TableHead>状態</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        <TableRow>
          <TableCell>マネージャーA</TableCell>
          <TableCell>実行中</TableCell>
        </TableRow>
        <TableRow>
          <TableCell>マネージャーB</TableCell>
          <TableCell>待機中</TableCell>
        </TableRow>
      </TableBody>
    </Table>
  ),
};
