import type { Meta, StoryObj } from '@storybook/react-vite';

import { CodeBlock } from './code-block';

/** 生の文字列（ログ・スタック・出力）。写す口つき。 */
const meta = {
  title: 'Features/CodeBlock',
  component: CodeBlock,
  parameters: { layout: 'padded' },
  tags: ['autodocs'],
  decorators: [
    (Story) => (
      <div className="max-w-2xl">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof CodeBlock>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {
    label: 'alteroid manager logs mgr-7f3c',
    children: `2026-09-30T02:14:07Z  start   依頼: apps/web の見た目を差し替える
2026-09-30T02:14:09Z  tool    Bash: pnpm --filter @alteroid/ui typecheck
2026-09-30T02:15:41Z  tool    Bash: pnpm --filter @alteroid/web test
2026-09-30T02:18:02Z  done    exit 0（52 files, 1184 tests）`,
  },
};

export const Scrolling: Story = {
  args: {
    copyable: false,
    maxHeight: '6rem',
    children: Array.from(
      { length: 12 },
      (_, i) => `line ${i + 1}: 高さを抑えて中でスクロールする`,
    ).join('\n'),
  },
};
