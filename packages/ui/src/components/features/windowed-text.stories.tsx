import type { Meta, StoryObj } from '@storybook/react-vite';

import { WindowedText } from './windowed-text';

/** 長い文字列を窓で区切って出す。「続きを表示」で伸ばす。伏せ字は呼び手が全体に掛けてから渡す。 */
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
