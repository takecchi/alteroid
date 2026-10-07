import type { Meta, StoryObj } from '@storybook/react-vite';

import { AgentModelTag } from './agent-model-tag';

/** 担当のモデルの札。層は常に Claude で動くので、取れない値は「不明」とだけ出し、既定の値で埋めない。 */
const meta = {
  title: 'Features/AgentModelTag',
  component: AgentModelTag,
  parameters: { layout: 'padded' },
  tags: ['autodocs'],
} satisfies Meta<typeof AgentModelTag>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Manager: Story = { args: { model: 'opus' } };

export const Worker: Story = { args: { model: 'sonnet' } };

/** 名乗りを受けていない（旧い runner・古いデーモン）。「不明」だけで、札は破線になる。 */
export const Unknown: Story = { args: {} };

/** 長い表記は切り詰め、title で全文が読める。 */
export const LongModel: Story = {
  args: { model: 'claude-opus-4-1-20250805-with-a-very-long-suffix', className: 'max-w-32' },
};
