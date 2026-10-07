import type { Meta, StoryObj } from '@storybook/react-vite';

import { BrandMark } from './brand-mark';

const meta = {
  title: 'Layout/BrandMark',
  component: BrandMark,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof BrandMark>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const MarkOnly: Story = { args: { withWordmark: false } };
