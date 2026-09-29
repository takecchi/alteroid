import type { Meta, StoryObj } from '@storybook/react-vite';

import { Markdown } from './markdown';

/**
 * クローンの応答・日報・マネージャーの報告を描く Markdown（`markdown.tsx`）。
 *
 * 置き場は `components/ui/` ではなく `components/markdown.tsx` のまま——`ui/` は
 * shadcn が生成した部品だけを置く約束（`shadcn-setup.test.ts` が見ている）なので、
 * 見本帳の見出しだけ `UI/` に並べてある。
 */
const meta = {
  title: 'UI/Markdown',
  component: Markdown,
  parameters: { layout: 'padded' },
  tags: ['autodocs'],
  decorators: [
    (Story) => (
      <div className="max-w-2xl">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof Markdown>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Report: Story = {
  args: {
    children: `## 今日の日報

- 委譲 **12 件**（完了 10・失敗 1・実行中 1）
- 承認待ち 3 件。いちばん古いのは 42 分前
- 費用 $4.18（上限 $20.00）

### 失敗した委譲

\`mgr-7f3c2a91\` が \`pnpm --filter @alteroid/web test\` で落ちた。
詳細は [日誌](/journal) から辿れる。

| 層 | 費用 |
| --- | ---: |
| クローン | $1.02 |
| マネージャー | $2.64 |
| 作業者 | $0.52 |

> 確かめていないこと: Safari での見え方。

\`\`\`bash
pnpm --filter @alteroid/ui typecheck
\`\`\`

- [x] 検証一式を最後の変更の後に通す
- [ ] ready にする`,
  },
};

export const LineBreaks: Story = {
  args: {
    children: '単独の改行も\nそのまま改行として見える（remark-breaks）。\n\n空行は段落の区切り。',
  },
};

export const RawHtmlStaysText: Story = {
  args: {
    children: '生の HTML は要素にならない: <script>alert(1)</script> <img src=x onerror=alert(1)>',
  },
};
