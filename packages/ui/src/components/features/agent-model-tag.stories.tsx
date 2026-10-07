import type { Meta, StoryObj } from '@storybook/react-vite';

import { AgentModelTag } from './agent-model-tag';

/** 担当の provider とモデルの札。取れない値は「不明」と出し、既定の値で埋めない。 */
const meta = {
  title: 'Features/AgentModelTag',
  component: AgentModelTag,
  parameters: { layout: 'padded' },
  tags: ['autodocs'],
} satisfies Meta<typeof AgentModelTag>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Claude: Story = { args: { provider: 'claude', model: 'opus' } };

export const Codex: Story = { args: { provider: 'codex', model: 'gpt-5.1-codex' } };

export const UnknownProvider: Story = { args: { provider: 'other-agent', model: 'model-x' } };

/** provider だけ名乗られている。札全体は破線にしない。 */
export const ModelUnknown: Story = { args: { provider: 'claude' } };

export const ProviderUnknown: Story = { args: { model: 'opus' } };

/** どちらも名乗られていない（旧い runner・古いデーモン）。 */
export const Unknown: Story = { args: {} };

/** 長い表記は切り詰め、title で全文が読める。 */
export const LongModel: Story = {
  args: { provider: 'codex', model: 'Codex の既定のモデル', className: 'max-w-32' },
};
