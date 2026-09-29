import type { Meta, StoryObj } from '@storybook/react-vite';
import { ChevronsUpDown } from 'lucide-react';

import { Button } from './button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from './collapsible';

const meta = {
  title: 'UI/Collapsible',
  component: Collapsible,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof Collapsible>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => (
    <Collapsible className="w-80 space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-sm">道具の呼び出し 14 件</span>
        <CollapsibleTrigger asChild>
          <Button variant="ghost" size="icon-sm" aria-label="開閉する">
            <ChevronsUpDown />
          </Button>
        </CollapsibleTrigger>
      </div>
      <CollapsibleContent className="space-y-1 font-mono text-xs text-muted-foreground">
        <p>Bash: pnpm --filter @alteroid/ui typecheck</p>
        <p>Read: packages/ui/src/styles.css</p>
        <p>Edit: packages/ui/src/components/common.tsx</p>
      </CollapsibleContent>
    </Collapsible>
  ),
};
