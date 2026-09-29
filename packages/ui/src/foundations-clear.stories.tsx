import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState, type ReactNode } from 'react';

import { Badge, Button, Card, CardHeader, Input } from '@/components/common';
import { Meter } from '@/components/features/charts/meter';
import { Stat } from '@/components/features/stat';
import { StatusDot } from '@/components/features/status-dot';
import { BrandMark } from '@/components/layout/brand-mark';
import { LiveIndicator } from '@/components/layout/live-indicator';
import { cn } from '@/lib/utils';

/**
 * **Clear Signal** —— 2つ目の案。
 *
 * 優先の順は **分かりやすさ → 見た目**。
 *
 * 1. **押せるものは青** —— 主色は空色1つ。「青は押せる」という慣れた約束をそのまま
 *    使い、新しい色の意味を覚えさせない
 * 2. **状態は色と言葉の両方で** —— 緑・琥珀・赤の慣れた意味。色だけにしない
 * 3. **形は1つ** —— 角丸 12px。重なりは明るさと縁で言う（形で言わない）
 * 4. **読みやすさを先に** —— 補足の文字も 7:1。全体の文字を 6% 大きく
 * 5. **未来感は1か所だけ** —— 面の上端のガラスの縁（1px）。光るものは作らない
 *
 * 値の正本は `styles.css` の `[data-design='clear']`。
 */
const meta = {
  title: 'Foundations/B Clear Signal',
  parameters: { layout: 'fullscreen' },
  // この頁は2つ目の案を説明する。上の帯の Design に関係なく、この案で描く。
  globals: { design: 'clear' },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

const SWATCHES = [
  { name: 'Graphite', token: 'background', className: 'bg-background', role: '画面の地' },
  { name: 'Panel', token: 'card', className: 'bg-card', role: '枠の面' },
  { name: 'Text', token: 'foreground', className: 'bg-foreground', role: '本文の文字' },
  {
    name: 'Subtext',
    token: 'muted-foreground',
    className: 'bg-muted-foreground',
    role: '補足の文字（7:1）',
  },
  { name: 'Signal', token: 'primary', className: 'bg-primary', role: '押せるもの・現在地・焦点' },
  { name: 'Go', token: 'ok', className: 'bg-ok', role: '成功・動いている' },
  { name: 'Wait', token: 'warn', className: 'bg-warn', role: '注意・人間を待っている' },
  {
    name: 'Stop',
    token: 'destructive',
    className: 'bg-destructive',
    role: '失敗・取り消せない操作',
  },
] as const;

function Section({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
  return (
    <section className="space-y-4">
      <div>
        <h2 className="text-base font-semibold">{title}</h2>
        {note !== undefined && <p className="mt-1 text-sm text-muted-foreground">{note}</p>}
      </div>
      {children}
    </section>
  );
}

function Colors() {
  return (
    <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
      {SWATCHES.map((swatch) => (
        <div key={swatch.name} className="space-y-2">
          <div className={cn('h-16 rounded-xl ring-1 ring-foreground/10', swatch.className)} />
          <div>
            <div className="text-sm font-medium">
              {swatch.name}{' '}
              <span className="font-mono text-xs font-normal text-muted-foreground">
                {swatch.token}
              </span>
            </div>
            <div className="text-xs text-muted-foreground">{swatch.role}</div>
          </div>
        </div>
      ))}
    </div>
  );
}

/** 押せるもの・書く先・読むだけのものを、形と色で見分けられるか。 */
function Affordance() {
  return (
    <div className="grid gap-4 sm:grid-cols-3">
      <Card className="p-4">
        <p className="mb-3 text-sm font-medium">押せるもの</p>
        <div className="flex flex-wrap gap-2">
          <Button variant="primary">承認する</Button>
          <Button>あとで</Button>
        </div>
        <p className="mt-3 text-xs text-muted-foreground">
          主な操作は青で塗る。従の操作は縁。1つの面に塗りは1つだけ
        </p>
      </Card>
      <Card className="p-4">
        <p className="mb-3 text-sm font-medium">書く先</p>
        <Input placeholder="日誌を絞り込む" />
        <p className="mt-3 text-xs text-muted-foreground">縁だけの枠。焦点が当たると青い輪</p>
      </Card>
      <Card className="p-4">
        <p className="mb-3 text-sm font-medium">読むだけのもの</p>
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone="warn">承認待ち 3</Badge>
          <StatusDot tone="ok">実行中</StatusDot>
        </div>
        <p className="mt-3 text-xs text-muted-foreground">札と点は押せない。色と言葉の両方で言う</p>
      </Card>
    </div>
  );
}

function Typography() {
  return (
    <Card className="space-y-4 p-5">
      <div className="flex flex-wrap items-end gap-8">
        <BrandMark />
        <Stat label="今日の費用" value="$4.18" hint="上限 $20.00" />
        <Stat label="承認待ち" value="3" unit="件" tone="warn" />
      </div>
      <div className="space-y-1">
        <p className="text-lg font-semibold">画面の見出し</p>
        <p className="text-base font-medium">枠の見出し</p>
        <p className="max-w-prose text-sm">
          本文。クローンの様子を見て、指示を出し、記憶を直す。M PLUS 1
          の一族だけで、本文・数字・等幅を揃える。
        </p>
        <p className="text-xs text-muted-foreground">補足（7:1 の明るさ）</p>
      </div>
      <pre className="rounded-lg bg-muted p-3 font-mono text-xs">
        {'2026-09-30T02:14:09Z  mgr-7f3c2a91  Bash: pnpm --filter @alteroid/ui typecheck'}
      </pre>
    </Card>
  );
}

function Overview() {
  return (
    <div className="min-h-dvh bg-background p-6 text-foreground sm:p-10">
      <div className="mx-auto flex max-w-4xl flex-col gap-12">
        <header className="space-y-3">
          <BrandMark />
          <h1 className="text-2xl font-semibold">Clear Signal</h1>
          <p className="max-w-xl text-sm leading-relaxed text-muted-foreground">
            迷わせない計器盤。押せるものは青、状態は色と言葉の両方で、形は1つ。未来感は面の上端の
            1px のガラスの縁だけに置き、あとは読みやすさに使う。
          </p>
        </header>
        <Section title="色" note="押せるものの色は1つ。状態の色は慣れた意味のまま">
          <Colors />
        </Section>
        <Section title="押せるか・書けるか・読むだけか" note="形と色で、触る前に見分けられること">
          <Affordance />
        </Section>
        <Section title="文字">
          <Typography />
        </Section>
        <Section title="状態">
          <Card className="grid gap-6 p-5 sm:grid-cols-2">
            <div className="flex flex-col gap-2">
              <LiveIndicator status="live" className="mt-0" />
              <LiveIndicator status="connecting" className="mt-0" />
              <LiveIndicator status="offline" className="mt-0" />
            </div>
            <Meter
              label="今日の費用"
              value={17.4}
              max={20}
              formatValue={(v) => `$${v.toFixed(2)}`}
            />
          </Card>
        </Section>
      </div>
    </div>
  );
}

export const Default: Story = { render: () => <Overview /> };

/** 脇の面と承認待ちの断片を B で見る（現在地・押せるもの・札が一目で分かるか）。 */
export const Panel: Story = {
  render: function Render() {
    const items = ['ダッシュボード', '承認待ち', 'マネージャー', '日誌'];
    const [active, setActive] = useState(1);
    return (
      <div className="flex min-h-dvh items-start gap-6 bg-background p-10">
        <ul className="w-56 space-y-1 rounded-xl bg-card p-2 ring-1 ring-foreground/10">
          {items.map((label, index) => (
            <li key={label}>
              <button
                type="button"
                onClick={() => setActive(index)}
                aria-current={active === index ? 'page' : undefined}
                className={cn(
                  'flex w-full items-center rounded-lg px-3 py-2 text-left text-sm transition-colors',
                  active === index
                    ? 'lumen-edge bg-accent text-accent-foreground'
                    : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                )}
              >
                {label}
                {label === '承認待ち' && (
                  <Badge tone="warn" className="ml-auto">
                    3
                  </Badge>
                )}
              </button>
            </li>
          ))}
        </ul>
        <Card className="w-96">
          <CardHeader title="承認待ち" subtitle="42 分前から待っている" />
          <div className="space-y-3 p-4 text-sm">
            <p>本番の DB へ migrate を当ててよいか。</p>
            <div className="flex gap-2">
              <Button variant="primary" size="sm">
                許可
              </Button>
              <Button size="sm">却下</Button>
            </div>
          </div>
        </Card>
      </div>
    );
  },
};
