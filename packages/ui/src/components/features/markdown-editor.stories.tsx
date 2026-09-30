import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';

import { MarkdownEditor } from './markdown-editor';

/**
 * Markdown を書く欄（編集 | プレビュー | 並べて）。中身があればプレビュー、空なら
 * 編集で開く。「並べて」は広い画面だけ。
 */
const meta = {
  title: 'Features/MarkdownEditor',
  component: MarkdownEditor,
  parameters: { layout: 'padded' },
  tags: ['autodocs'],
} satisfies Meta<typeof MarkdownEditor>;

export default meta;
type Story = StoryObj<typeof meta>;

const MEMORY = `# 価値観: 社外に出すもの

- 社外の資料には**費用の実測を載せない**（桁の目安までにする）
- 登壇資料は構成案を先に見せてもらう。本文はその後

## 判断に迷ったら

> 取り返しのつかないものだけ人間に聞く。それ以外は自分で決めて、日誌に理由を残す。

| 場面 | 聞くか |
| --- | --- |
| 本番の DB | 聞く |
| SDK の更新 PR | 聞かない（#1053） |`;

function Demo({ initial, saveable = true }: { initial: string; saveable?: boolean }) {
  const [value, setValue] = useState(initial);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  return (
    <div className="flex h-[640px] max-w-5xl flex-col">
      <MarkdownEditor
        value={value}
        onChange={setValue}
        onSave={saveable ? () => setSavedAt(new Date().toLocaleTimeString('ja-JP')) : undefined}
        hint="ここで書き換えたものは memory_update（cause: human）として日誌に残る。"
        minHeight="20rem"
      />
      {savedAt !== null && (
        <p className="mt-2 text-xs text-muted-foreground">
          保存した（{savedAt}、見本なので残らない）
        </p>
      )}
    </div>
  );
}

const args = { value: '', onChange: () => undefined };

/** 中身があるのでプレビューで開く。 */
export const Default: Story = { args, render: () => <Demo initial={MEMORY} /> };

/** 空なので編集で開く。 */
export const Empty: Story = { args, render: () => <Demo initial="" /> };

/** 並べて（広い画面だけ）。 */
export const Split: Story = {
  args,
  render: function Render() {
    const [value, setValue] = useState(MEMORY);
    return (
      <div className="flex h-[640px] max-w-5xl flex-col">
        <MarkdownEditor value={value} onChange={setValue} defaultMode="split" minHeight="20rem" />
      </div>
    );
  },
};

/**
 * 省略可能な口を使った形（記憶の詳細の画面）: タブは「プレビュー → 編集」の2つだけ、
 * 「⌘/Ctrl + S で保存」の一言と空のプレビューの一言と placeholder は出さない。
 */
export const Plain: Story = {
  args,
  render: function Render() {
    const [value, setValue] = useState('');
    return (
      <div className="flex h-[640px] max-w-5xl flex-col">
        <MarkdownEditor
          value={value}
          onChange={setValue}
          onSave={() => undefined}
          modes={['preview', 'edit']}
          defaultMode="edit"
          saveHint={null}
          emptyPreview={null}
          placeholder=""
          minHeight="20rem"
        />
      </div>
    );
  },
};
