import type { Meta, StoryObj } from '@storybook/react-vite';

import { Timestamp } from './timestamp';

/** 時刻。指を載せる・焦点を当てると JST と UTC の正確な時刻が出る。 */
const meta = {
  title: 'Features/Timestamp',
  component: Timestamp,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof Timestamp>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Relative: Story = { args: { at: '2026-09-29T20:48:07Z', label: '3 分前' } };
/** `label` を渡さないときは JST の月日と時分。 */
export const Absolute: Story = { args: { at: '2026-09-29T20:48:07Z' } };
/** 読めない値は生の値をそのまま出す。 */
export const Invalid: Story = { args: { at: 'not-a-date' } };
