import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';

import {
  Badge,
  Button,
  Card,
  CardHeader,
  Empty,
  ErrorNote,
  Input,
  Row,
  Select,
  Spinner,
  SubmitHint,
  Textarea,
  TruncationNote,
} from './common';

/**
 * 画面が使う部品（`@alteroid/ui`）。見た目は shadcn の既定で、呼び方だけ画面に合わせてある
 * （`common.tsx` の冒頭）。
 */
const meta = {
  title: 'UI/Common',
  parameters: { layout: 'padded' },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

function ButtonsShowcase() {
  const [loading, setLoading] = useState(false);
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="primary">primary</Button>
        <Button>default</Button>
        <Button variant="ghost">ghost</Button>
        <Button variant="danger">danger</Button>
        <Button disabled>disabled</Button>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="primary">
          sm primary
        </Button>
        <Button size="sm">sm default</Button>
        <Button size="sm" variant="ghost">
          sm ghost
        </Button>
        <Button size="sm" variant="danger">
          sm danger
        </Button>
      </div>
      <Button
        variant="primary"
        loading={loading}
        onClick={() => {
          setLoading(true);
          setTimeout(() => setLoading(false), 1500);
        }}
      >
        押すと1.5秒 loading
      </Button>
      <p className="text-xs text-muted-foreground">
        狭い画面（768px 未満）では押しやすさのため高さ 44px になる。
      </p>
    </div>
  );
}

export const Buttons: Story = { render: () => <ButtonsShowcase /> };

export const Badges: Story = {
  render: () => (
    <div className="flex flex-wrap items-center gap-2">
      <Badge>neutral</Badge>
      <Badge tone="accent">accent</Badge>
      <Badge tone="ok">ok</Badge>
      <Badge tone="warn">warn</Badge>
      <Badge tone="danger">danger</Badge>
      <Badge className="max-w-40">長い文字列は折り返す：mcp-server-with-a-very-long-name</Badge>
    </div>
  ),
};

export const Cards: Story = {
  render: () => (
    <div className="max-w-xl space-y-4">
      <Card>
        <CardHeader
          title="マネージャー"
          subtitle="稼働状況"
          action={
            <Button size="sm" variant="ghost">
              更新
            </Button>
          }
        />
        <ul>
          <Row className="px-4 py-3 text-sm">mgr-1 — 調査中</Row>
          <Row className="px-4 py-3 text-sm">mgr-2 — レビュー待ち</Row>
        </ul>
        <TruncationNote shown={2} total={5} />
      </Card>
      <Card>
        <CardHeader title="空のとき" />
        <Empty>まだ何も無い</Empty>
      </Card>
    </div>
  ),
};

export const FormControls: Story = {
  render: () => (
    <div className="max-w-md space-y-3">
      <Input placeholder="Input" />
      <Select defaultValue="b">
        <option value="a">選択肢 A</option>
        <option value="b">選択肢 B</option>
      </Select>
      <Textarea rows={3} placeholder="Textarea（rows で高さを決め、縦にだけ引き伸ばせる）" />
    </div>
  ),
};

/** 送るキーつきのテキストエリア。⌘/Ctrl + Enter で送り、内容に合わせて上限（ここでは 10rem）まで伸びる。案内は OS に合わせる。 */
export const SubmitTextarea: Story = {
  render: function Render() {
    const [value, setValue] = useState('');
    const [sent, setSent] = useState<string[]>([]);
    return (
      <div className="max-w-md space-y-2">
        <Textarea
          rows={2}
          value={value}
          placeholder="書いて ⌘/Ctrl + Enter"
          maxHeight="10rem"
          submitDisabled={value.trim() === ''}
          onChange={(event) => setValue(event.target.value)}
          onSubmitShortcut={() => {
            setSent((all) => [...all, value]);
            setValue('');
          }}
        />
        <div className="flex items-center gap-2">
          <Button variant="primary" size="sm" disabled={value.trim() === ''}>
            送信
          </Button>
          <SubmitHint action="送信" />
        </div>
        <ul className="text-xs text-muted-foreground">
          {sent.map((text, index) => (
            <li key={index} className="whitespace-pre-wrap">
              送った: {text}
            </li>
          ))}
        </ul>
      </div>
    );
  },
};

export const Feedback: Story = {
  render: () => (
    <div className="max-w-md space-y-3">
      <Spinner />
      <ErrorNote error={new Error('接続先のサーバに繋がらない（http://127.0.0.1:4517）')} />
    </div>
  ),
};
