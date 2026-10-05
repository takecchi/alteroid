import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState, type ReactNode } from 'react';

import { Badge, Button, Input } from '@/components/common';
import { BrandMark } from '@/components/layout/brand-mark';
import { LiveIndicator } from '@/components/layout/live-indicator';
import { cn } from '@/lib/utils';

/**
 * **Twin Plate** —— alteroid のデザインの基礎。
 *
 * クローンは人間の写しで、画面はその写しが働く様子を見守る計器盤である。
 * 未来感は発光の量ではなく**規律**で出す:
 *
 * 1. **光の縁**（`lumen-edge`）—— 光ってよいのは「いまここ」を示す1本の線と焦点の輪だけ
 * 2. **心拍**（`LiveIndicator`）—— 画面の中で自分から動くのは受信の印だけ
 *
 * 面取り（`corner-shape: bevel`）は試して外した（`styles.css` の注記）。角は角丸のまま。
 *
 * 値の正本は `styles.css`。ここはそれを並べて見るための場所で、値を持たない。
 * 上の帯の Theme で明るい側・暗い側を切り替えて見比べる。
 */
const meta = {
  title: 'Foundations',
  parameters: { layout: 'fullscreen' },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

/** 名前は見本の中だけの呼び名。class は shadcn の既定の名前のまま（`styles.css` の冒頭）。 */
const SWATCHES = [
  { name: 'Abyss', token: 'background', className: 'bg-background', role: '画面の地' },
  { name: 'Hull', token: 'card', className: 'bg-card', role: '枠の面' },
  { name: 'Ink', token: 'foreground', className: 'bg-foreground', role: '本文の文字' },
  {
    name: 'Haze',
    token: 'muted-foreground',
    className: 'bg-muted-foreground',
    role: '補足の文字',
  },
  { name: 'Lumen', token: 'primary', className: 'bg-primary', role: '主な操作・現在地・焦点' },
  { name: 'Signal', token: 'ok', className: 'bg-ok', role: '成功・受信中' },
  { name: 'Flare', token: 'warn', className: 'bg-warn', role: '注意・人間を待っている' },
  {
    name: 'Fault',
    token: 'destructive',
    className: 'bg-destructive',
    role: '失敗・取り返しのつかない操作',
  },
] as const;

const SURFACES = [
  { token: 'background', className: 'bg-background' },
  { token: 'card', className: 'bg-card' },
  { token: 'popover', className: 'bg-popover' },
  { token: 'muted', className: 'bg-muted' },
  { token: 'accent', className: 'bg-accent' },
] as const;

function Section({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
  return (
    <section className="space-y-4">
      <div>
        <h2 className="text-sm font-semibold">{title}</h2>
        {note !== undefined && <p className="mt-1 text-xs text-muted-foreground">{note}</p>}
      </div>
      {children}
    </section>
  );
}

function Colors() {
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        {SWATCHES.map((swatch) => (
          <div key={swatch.name} className="space-y-2">
            <div className={cn('h-16 rounded-md ring-1 ring-foreground/10', swatch.className)} />
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
      <div>
        <p className="mb-2 text-xs text-muted-foreground">
          面の段差。地から浮くほど少しずつ明るくなる（暗い側）。
        </p>
        <div className="flex overflow-hidden rounded-md ring-1 ring-foreground/10">
          {SURFACES.map((surface) => (
            <div
              key={surface.token}
              className={cn('flex h-14 flex-1 items-end p-2', surface.className)}
            >
              <span className="font-mono text-[11px] text-muted-foreground">{surface.token}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function Motif({ name, note, children }: { name: string; note: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-4 rounded-lg bg-card p-4 ring-1 ring-foreground/10">
      <div className="flex h-24 items-center justify-center">{children}</div>
      <div>
        <div className="text-sm font-medium">{name}</div>
        <div className="text-xs text-muted-foreground">{note}</div>
      </div>
    </div>
  );
}

function Motifs() {
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <Motif name="光の縁" note="光るのは「いまここ」の1本だけ">
        <div className="w-40 space-y-1 text-sm">
          <div className="rounded-sm px-2.5 py-1.5 text-muted-foreground">日誌</div>
          <div className="lumen-edge rounded-sm bg-accent px-2.5 py-1.5 text-accent-foreground">
            マネージャー
          </div>
          <div className="rounded-sm px-2.5 py-1.5 text-muted-foreground">日報</div>
        </div>
      </Motif>
      <Motif name="心拍" note="自分から動くのは受信の印だけ。動きを減らす設定では止まる">
        <div className="flex flex-col gap-2">
          <LiveIndicator status="live" className="mt-0" />
          <LiveIndicator status="connecting" className="mt-0" />
          <LiveIndicator status="offline" className="mt-0" />
        </div>
      </Motif>
    </div>
  );
}

function Shapes() {
  return (
    <div className="grid gap-4 sm:grid-cols-3">
      <Motif name="面" note="枠・浮く面・警告。縁と明るさの段で重なりを言う">
        <div className="h-16 w-28 rounded-xl bg-card ring-1 ring-foreground/15" />
      </Motif>
      <Motif name="押せるもの" note="ボタン・札は見慣れた角丸のまま。塗りか縁を必ず持つ">
        <div className="flex items-center gap-2">
          <Button variant="primary" size="sm">
            承認する
          </Button>
          <Badge tone="warn">承認待ち 3</Badge>
        </div>
      </Motif>
      <Motif name="書く先" note="入力欄は縁だけ。塗りの無い枠が「書ける」の合図">
        <Input placeholder="日誌を絞り込む" className="w-40" />
      </Motif>
    </div>
  );
}

function Typography() {
  return (
    <div className="space-y-5 rounded-lg bg-card p-5 ring-1 ring-foreground/10">
      <div className="space-y-1">
        <p className="text-xs text-muted-foreground">
          印：Michroma（<code className="font-mono">font-display</code>
          、ブランドの印だけ）。右の数字は本文の書体の等幅数字（
          <code className="font-mono">tabular-nums</code>）— Michroma では 0 と O の見分けがつかない
        </p>
        <div className="flex flex-wrap items-baseline gap-6">
          <BrandMark className="[&>span:last-child]:text-2xl [&>svg]:size-8" />
          <span data-numeric className="text-3xl font-medium">
            $4.18
          </span>
          <span data-numeric className="text-3xl font-medium text-warn">
            03
          </span>
        </div>
      </div>
      <div className="space-y-1">
        <p className="text-xs text-muted-foreground">
          本文と見出し：IBM Plex Sans JP（<code className="font-mono">font-sans</code>）
        </p>
        <p className="text-base font-semibold">画面の見出し（16px / 600）</p>
        <p className="text-sm font-medium">枠の見出し（14px / 500）</p>
        <p className="max-w-prose text-sm">
          本文（14px / 400）。クローンの様子を見て、指示を出し、記憶を直す。人間の役目は
          価値観の伝達と最終承認だけに縮む。
        </p>
        <p className="text-xs text-muted-foreground">補足（12px）</p>
      </div>
      <div className="space-y-1">
        <p className="text-xs text-muted-foreground">
          識別子と生ログ：IBM Plex Mono（<code className="font-mono">font-mono</code>）
        </p>
        <pre className="rounded-md bg-muted p-3 font-mono text-xs">
          {'2026-09-30T02:14:09Z  mgr-7f3c2a91  Bash: pnpm --filter @alteroid/ui typecheck'}
        </pre>
      </div>
    </div>
  );
}

function Controls() {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button variant="primary">承認する</Button>
      <Button>あとで</Button>
      <Button variant="ghost">やめる</Button>
      <Button variant="danger">失効させる</Button>
      <Badge>待機</Badge>
      <Badge tone="accent">実行中</Badge>
      <Badge tone="ok">完了</Badge>
      <Badge tone="warn">承認待ち</Badge>
      <Badge tone="danger">失敗</Badge>
    </div>
  );
}

function Overview() {
  return (
    <div className="min-h-dvh bg-background p-6 text-foreground sm:p-10">
      <div className="mx-auto flex max-w-4xl flex-col gap-12">
        <header className="space-y-3">
          <BrandMark />
          <h1 className="font-display text-2xl tracking-[0.04em]">Twin Plate</h1>
          <p className="max-w-xl text-sm leading-relaxed text-muted-foreground">
            人間の写しが働く様子を見守る計器盤。未来感は光の量ではなく、規律で出す。
            押せるものは見慣れた形のまま、光ってよいのは現在地と焦点だけ、
            自分から動くのは受信の印だけにする。
          </p>
        </header>
        <Section title="色" note="光る色は Lumen だけ。状態の3色は色相を離して、主色と紛れない">
          <Colors />
        </Section>
        <Section title="モチーフ">
          <Motifs />
        </Section>
        <Section title="形の階層" note="形で役割を言う。同じ角を全部に付けない">
          <Shapes />
        </Section>
        <Section title="文字">
          <Typography />
        </Section>
        <Section title="操作と状態">
          <Controls />
        </Section>
      </div>
    </div>
  );
}

export const Default: Story = { render: () => <Overview /> };

export const Color: Story = {
  render: () => (
    <div className="p-6">
      <Colors />
    </div>
  ),
};

export const Type: Story = {
  render: () => (
    <div className="p-6">
      <Typography />
    </div>
  ),
};

/** 何も置かない地。地の色と、そこに1枚だけ置いた面の段差を見る。 */
export const Ground: Story = {
  render: () => (
    <div className="flex h-[600px] items-center justify-center bg-background">
      <div className="h-40 w-72 rounded-xl bg-card ring-1 ring-foreground/10" />
    </div>
  ),
};

/** 現在地が移る瞬間。押すと光の縁が移る（キーボードでも動く）。 */
export const Interactive: Story = {
  render: function Render() {
    const items = ['ダッシュボード', '承認待ち', 'マネージャー', '日誌'];
    const [active, setActive] = useState(2);
    return (
      <div className="flex h-[600px] items-center justify-center bg-background">
        <ul className="w-56 space-y-0.5 rounded-lg bg-card p-2 ring-1 ring-foreground/10">
          {items.map((label, index) => (
            <li key={label}>
              <button
                type="button"
                onClick={() => setActive(index)}
                aria-current={active === index ? 'page' : undefined}
                className={cn(
                  'flex w-full items-center rounded-sm px-2.5 py-1.5 text-left text-sm transition-colors',
                  active === index
                    ? 'lumen-edge bg-accent text-accent-foreground'
                    : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                )}
              >
                {label}
              </button>
            </li>
          ))}
        </ul>
      </div>
    );
  },
};
