import type { Meta, StoryObj } from '@storybook/react-vite';

import { cn } from '@/lib/utils';

/**
 * テーマの色。**shadcn の既定（`baseColor: neutral`）そのまま**に、shadcn に無い
 * 状態の色（`warn` / `ok`）を足したもの。値は `styles.css` の `:root` / `.dark`。
 *
 * 上の帯の Theme で明るい側・暗い側を切り替えて見比べる。
 */
const SWATCHES = [
  { name: 'background', className: 'bg-background', role: '画面の地' },
  { name: 'foreground', className: 'bg-foreground', role: '本文の文字' },
  { name: 'card', className: 'bg-card', role: '枠（Card）の面' },
  { name: 'popover', className: 'bg-popover', role: '浮く面（Popover・Dropdown）' },
  { name: 'primary', className: 'bg-primary', role: '主な操作' },
  { name: 'secondary', className: 'bg-secondary', role: '従の操作' },
  { name: 'muted', className: 'bg-muted', role: '控えめな面' },
  { name: 'muted-foreground', className: 'bg-muted-foreground', role: '控えめな文字' },
  { name: 'accent', className: 'bg-accent', role: '選択中・hover の面' },
  { name: 'destructive', className: 'bg-destructive', role: '失敗・取り返しのつかない操作' },
  { name: 'warn', className: 'bg-warn', role: '注意（shadcn に無いので足した）' },
  { name: 'ok', className: 'bg-ok', role: '成功（shadcn に無いので足した）' },
  { name: 'border', className: 'bg-border', role: '縁' },
  { name: 'input', className: 'bg-input', role: '入力欄の縁' },
  { name: 'ring', className: 'bg-ring', role: '焦点の輪' },
] as const;

function Colors() {
  return (
    <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
      {SWATCHES.map((swatch) => (
        <div key={swatch.name} className="space-y-2">
          <div className={cn('h-16 rounded-lg ring-1 ring-foreground/10', swatch.className)} />
          <div>
            <div className="font-mono text-xs">{swatch.name}</div>
            <div className="text-xs text-muted-foreground">{swatch.role}</div>
          </div>
        </div>
      ))}
    </div>
  );
}

function Typography() {
  return (
    <div className="space-y-3">
      <h1 className="text-base font-semibold">画面の見出し（text-base font-semibold）</h1>
      <h2 className="text-sm font-medium">枠の見出し（text-sm font-medium）</h2>
      <p className="text-sm">本文（text-sm）。クローンの様子を見て、指示を出し、記憶を直す。</p>
      <p className="text-xs text-muted-foreground">補足（text-xs text-muted-foreground）</p>
      <pre className="rounded-lg bg-muted p-3 font-mono text-xs">生ログ（font-mono text-xs）</pre>
    </div>
  );
}

const meta = {
  title: 'Foundations',
  parameters: { layout: 'padded' },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

export const Color: Story = { render: () => <Colors /> };
export const Type: Story = { render: () => <Typography /> };
