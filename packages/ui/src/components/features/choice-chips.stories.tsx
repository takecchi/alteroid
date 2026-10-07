import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';

import { ChoiceChips } from './choice-chips';

const meta = {
  title: 'Features/ChoiceChips',
  component: ChoiceChips,
  parameters: { layout: 'padded' },
  tags: ['autodocs'],
} satisfies Meta<typeof ChoiceChips>;

export default meta;
type Story = StoryObj<typeof meta>;

const WINDOWS = [
  { value: '24h', label: '24時間' },
  { value: '7d', label: '7日' },
  { value: '30d', label: '30日' },
] as const;

function Demo() {
  const [value, setValue] = useState<string>('7d');
  return (
    <div className="max-w-2xl space-y-3">
      <ChoiceChips label="集計の窓" options={WINDOWS} value={value} onChange={setValue} />
      <p className="font-mono text-xs text-muted-foreground">{value}</p>
    </div>
  );
}

export const Default: Story = {
  args: { label: '集計の窓', options: WINDOWS, value: '7d', onChange: () => undefined },
  render: () => <Demo />,
};

export const UnknownValue: Story = {
  args: { label: '集計の窓', options: WINDOWS, value: '90d', onChange: () => undefined },
};
