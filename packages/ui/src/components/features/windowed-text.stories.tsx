import type { Meta, StoryObj } from '@storybook/react-vite';

import { WindowedText } from './windowed-text';

const meta = {
  title: 'Features/WindowedText',
  component: WindowedText,
  parameters: { layout: 'padded' },
  tags: ['autodocs'],
} satisfies Meta<typeof WindowedText>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Long: Story = {
  args: {
    text: Array.from({ length: 400 }, (_, i) => `line ${i} ${'x'.repeat(40)}`).join('\n'),
    chunkChars: 4000,
  },
};

export const Short: Story = { args: { text: 'short' } };
