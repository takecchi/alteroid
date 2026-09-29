import type { Meta, StoryObj } from '@storybook/react-vite';

import { ScrollArea } from './scroll-area';
import { Separator } from './separator';

const meta = {
  title: 'shadcn/ScrollArea',
  component: ScrollArea,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof ScrollArea>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => (
    <ScrollArea className="h-48 w-64 rounded-md border p-4">
      <div className="flex flex-col gap-2">
        {Array.from({ length: 20 }, (_, i) => (
          <div key={i}>
            <p className="text-sm">日誌 {i + 1} 件目</p>
            <Separator className="mt-2" />
          </div>
        ))}
      </div>
    </ScrollArea>
  ),
};
