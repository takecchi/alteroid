import type { Meta, StoryObj } from '@storybook/react-vite';

import { Timestamp } from './timestamp';

const meta = {
  title: 'Features/Timestamp',
  component: Timestamp,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof Timestamp>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Relative: Story = { args: { at: '2026-09-29T20:48:07Z', label: '3 分前' } };
export const Absolute: Story = { args: { at: '2026-09-29T20:48:07Z' } };
export const Invalid: Story = { args: { at: 'not-a-date' } };
