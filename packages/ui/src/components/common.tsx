/**
 * 画面の部品。**見た目は shadcn の部品（`./ui/*`）の既定のまま**で、ここは画面が
 * 使ってきた呼び方（`variant="primary"` / `tone="warn"` / `loading` など）を
 * shadcn の呼び方へ渡すだけの薄い層である。
 *
 * 画面が shadcn の部品を直に使いたいときは `@alteroid/ui/shadcn` から取る
 * （`Button` などの名前がここと衝突するので、本体のバレルからは出していない）。
 *
 * ここは**ルーターに依存しない**。リンクにしたいときは `asChild` を使わず、
 * 呼ぶ側が `<Link>` を置いて `className` を渡す形にしてある（部品を増やすより
 * 素の要素で済ませたほうが読みやすい規模なので）。
 */
import { AlertTriangle } from 'lucide-react';
import type {
  ButtonHTMLAttributes,
  HTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from 'react';

import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge as ShadcnBadge } from '@/components/ui/badge';
import { Button as ShadcnButton } from '@/components/ui/button';
import { Card as ShadcnCard } from '@/components/ui/card';
import { Input as ShadcnInput } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { Spinner as ShadcnSpinner } from '@/components/ui/spinner';
import { Textarea as ShadcnTextarea } from '@/components/ui/textarea';
import { useDisplayText } from '@/lib/display-text';
import { cn } from '@/lib/utils';

/**
 * `radix-ui` の `Tabs.Trigger` に付ける見た目。
 *
 * **`memory-detail.tsx` から移設**（`schedule.tsx` の編集タブと共有するため）。
 * 移設は「載る時機を変える」ことであって「読めるものを減らす」ことではないので、
 * クラス文字列は1文字も変えていない（AGENTS.md「スキルへ移すときは移すだけで、
 * 要約も短縮もしない」と同じ考え方）。**色の名前だけは shadcn の既定の名前へ
 * 置き換えた**（`text-muted` → `text-muted-foreground` など。意味は同じ）。
 */
export const TAB_TRIGGER_CLASS =
  'border-b-2 border-transparent px-3 py-1.5 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground pointer-coarse:py-3';
export const TAB_TRIGGER_ACTIVE_CLASS = 'border-primary text-foreground';

/**
 * 枠。shadcn の `Card` の見た目（面の色・角丸・縁）をそのまま使う。
 *
 * **内側の余白と間隔は消してある**（`gap-0 py-0`）。画面は `CardHeader` と中身の
 * 余白を自分で持つ作りなので、shadcn の既定の余白を足すと二重になる。
 * **`overflow-visible`**: shadcn の既定は `overflow-hidden` だが、中身（長い生ログ・
 * 横に広い表）を枠で黙って切らない。
 */
export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <ShadcnCard className={cn('gap-0 overflow-visible py-0', className)}>{children}</ShadcnCard>
  );
}

export function CardHeader({
  title,
  subtitle,
  action,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-3 border-b border-border px-4 py-3">
      <div className="min-w-0">
        <h2 className="truncate text-sm font-medium">{title}</h2>
        {subtitle !== undefined && (
          <p className="mt-0.5 text-xs text-muted-foreground">{subtitle}</p>
        )}
      </div>
      {action !== undefined && <div className="shrink-0">{action}</div>}
    </div>
  );
}

/**
 * 画面の呼び方 → shadcn の `variant` と、押せることを形で言うための上書き。
 *
 * **塗りか縁のどちらかを必ず持たせる**（`ghost` を除く）。shadcn の `secondary` は地と
 * ほぼ同じ明るさの面だけで縁が無く、暗い地の上では「押せる」ことが形から読めなかった
 * （人間の言葉で「ぱっと見押せそうなかんじがしない」）。だから `default` は縁のある
 * `outline` へ、`danger` には縁を足してある。
 */
const BUTTON_VARIANTS = {
  primary: { shadcn: 'default', className: 'shadow-sm shadow-primary/20' },
  default: { shadcn: 'outline', className: 'dark:border-foreground/20' },
  ghost: { shadcn: 'ghost', className: '' },
  danger: { shadcn: 'destructive', className: 'border-destructive/40' },
} as const;

const BUTTON_SIZES = {
  // 狭い画面（`md` 未満）ではタップ標的を 44px（`h-11`）まで持ち上げる。
  // 指で押す先は 44px 以上（WCAG 2.5.5 / Apple HIG の下限。同じ基準を
  // `apps/web/app/routes/shell.tsx` の `size-11` が既に使っている）。
  // `md:` の境目は `packages/ui/src/hooks/use-is-mobile.ts` の
  // `MOBILE_BREAKPOINT`（768）と揃えてある。広い画面の見た目は変えない
  // （依頼は「スマホ表示」であって、デスクトップまで背を高くするのは
  // 依頼より広い）。
  //
  // shadcn の `size` の上から高さと横の余白だけを差し替えている
  // （`cn` の後勝ちで shadcn 側の `h-7` / `h-8` は消える）。
  sm: { shadcn: 'sm', className: 'h-11 px-3 text-xs md:h-7 md:px-2' },
  md: { shadcn: 'default', className: 'h-11 px-3 text-sm md:h-9' },
} as const;

export function Button({
  variant = 'default',
  size = 'md',
  className,
  loading = false,
  disabled,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: keyof typeof BUTTON_VARIANTS;
  size?: keyof typeof BUTTON_SIZES;
  loading?: boolean;
}) {
  return (
    <ShadcnButton
      // 明示しないと form の中で submit になる。押した覚えのない送信を作らない。
      type="button"
      variant={BUTTON_VARIANTS[variant].shadcn}
      size={BUTTON_SIZES[size].shadcn}
      className={cn(
        'disabled:cursor-not-allowed',
        BUTTON_VARIANTS[variant].className,
        BUTTON_SIZES[size].className,
        className,
      )}
      disabled={disabled === true || loading}
      {...props}
    >
      {loading && <ShadcnSpinner className="size-3.5" aria-hidden role={undefined} />}
      {children}
    </ShadcnButton>
  );
}

/**
 * 画面の呼び方 → shadcn の `variant` と、shadcn に無い状態の色。
 *
 * shadcn の `Badge` は注意（`warn`）・成功（`ok`）を持たないので、`outline` の上に
 * 状態の色（`styles.css` の `--warn` / `--ok`）を載せる。
 */
const BADGE_TONES = {
  neutral: { variant: 'secondary', className: '' },
  ok: { variant: 'outline', className: 'border-ok/30 bg-ok/10 text-ok' },
  warn: { variant: 'outline', className: 'border-warn/30 bg-warn/10 text-warn' },
  danger: { variant: 'destructive', className: '' },
  accent: { variant: 'default', className: '' },
} as const;

export function Badge({
  tone = 'neutral',
  className,
  children,
  ...props
}: HTMLAttributes<HTMLSpanElement> & {
  tone?: keyof typeof BADGE_TONES;
  className?: string;
  children: ReactNode;
}) {
  return (
    <ShadcnBadge
      variant={BADGE_TONES[tone].variant}
      className={cn(
        // `shrink-0`: 横並びの flex 行の中で潰されて文字が読めなくなる幅まで
        // 縮まないようにする（shadcn の既定にも入っている）。
        //
        // **折り返しを許す**（`h-auto whitespace-normal overflow-visible`。shadcn の
        // 既定は `h-5 whitespace-nowrap overflow-hidden`）。`commitments.tsx` の
        // `OriginBadge` は `commitment.source`（`z.string().optional()`、長さの制約
        // なし）を、`settings.tsx` の資格情報一覧は `credential.name`
        // （`CREDENTIAL_NAME` 正規表現に長さの上限が無い）をそのまま中身にしており、
        // 折り返さない指定は可変の長文が来たときにはみ出しを直すどころか作る側へ振れる。
        'h-auto shrink-0 overflow-visible break-words whitespace-normal',
        BADGE_TONES[tone].className,
        className,
      )}
      // `aria-label` / `title` を通す口（issue #2105）——「読めていない」など
      // 中身の短い記号だけでは伝わらない事情を、呼び出し側が乗せられるように
      // する。`Button` の `...props` と同じ形（素の HTML 属性はここで名前を
      // 決め打ちしない）。
      {...props}
    >
      {children}
    </ShadcnBadge>
  );
}

/**
 * **`field-sizing-fixed resize-y`**: shadcn の既定（`field-sizing-content`）は中身に
 * 合わせて伸び続けるが、画面は `rows` で高さを決めて人間が引き伸ばす作りにしてある
 * （チャットの入力欄など）。
 */
export function Textarea({ className, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <ShadcnTextarea className={cn('field-sizing-fixed resize-y', className)} {...props} />;
}

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <ShadcnInput className={className} {...props} />;
}

/**
 * 入力欄の補足文（書式・条件）。**プレースホルダへ書かず、欄の上か下に常時出す**
 * （プレースホルダは入力を始めると消え、欄の幅で切れる。スマホ幅では後半の条件が読めない）。
 * 折り返せる `<p>`。呼ぶ側が `id` を決め、欄の `aria-describedby` へ同じ値を渡して結ぶ。
 */
export function FieldHint({
  id,
  className,
  children,
}: {
  id: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <p id={id} className={cn('text-xs break-words text-muted-foreground', className)}>
      {children}
    </p>
  );
}

/**
 * 選択肢が決まっている絞り込み用。**`Input` と同じ見た目に揃えてある**
 * （並べたときに片方だけ浮くと、同じ役割のものに見えなくなる）。shadcn の
 * `NativeSelect`（素の `<select>`）を使う——選択肢は呼ぶ側が `<option>` で渡す。
 *
 * `className` は外側の箱に掛かる（幅はそちらで決まる）。既定は `w-full`。
 * **`size`（表示行数）は受けない**——shadcn の `size`（高さの段）と名前が衝突し、
 * 画面にも使っている所が無い。
 */
export function Select({
  className,
  ...props
}: Omit<SelectHTMLAttributes<HTMLSelectElement>, 'size'>) {
  return <NativeSelect className={cn('w-full', className)} {...props} />;
}

export function Spinner({ label = '読み込み中' }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 p-6 text-sm text-muted-foreground">
      {/*
        文言（`label`）が読み上げの本体なので、輪のほうは読み上げから外す
        （shadcn の既定は輪自身が `role="status"` と英語の `aria-label` を持つ）。
      */}
      <ShadcnSpinner aria-hidden role={undefined} aria-label={undefined} />
      {label}
    </div>
  );
}

/**
 * 空状態の文言。
 *
 * `inset` で余白を選ぶ（省略時は従来どおり `p-6`。既存の呼び出しは変わらない）。
 * - 省略（`'default'`）: `p-6`。従来の形。
 * - `'card'`: `px-4 py-3`。`CardHeader` の直下に置くとき、見出し・説明（`px-4`）と
 *   左端をそろえ、上下を詰める。
 * - `'none'`: 余白なし。すでに `px-4 py-3` などを持つ入れ物の中に置くとき
 *   （余白が二重にならない）。
 */
export function Empty({
  children,
  inset = 'default',
}: {
  children: ReactNode;
  inset?: 'default' | 'card' | 'none';
}) {
  return (
    <p
      className={cn(
        'text-sm text-muted-foreground',
        inset === 'default' && 'p-6',
        inset === 'card' && 'px-4 py-3',
      )}
    >
      {children}
    </p>
  );
}

/**
 * 失敗を必ず見せる。shadcn の `Alert`（`variant="destructive"`）。
 *
 * **握り潰して「読み込み中」のままにしない。** 接続先が違う・デーモンが落ちて
 * いる、のどちらも、ここが出ないと「静かなだけ」に見えてしまう。
 */
export function ErrorNote({ error, className }: { error: unknown; className?: string }) {
  const display = useDisplayText();
  if (error === undefined || error === null) return null;
  const message = display.error(error instanceof Error ? error.message : String(error));
  return (
    <Alert variant="destructive" className={cn('border-destructive/40', className)}>
      <AlertTriangle aria-hidden />
      <AlertDescription className="min-w-0 break-words">{message}</AlertDescription>
    </Alert>
  );
}

/** 一覧の行。`<li>` の中身だけを与える。 */
export function Row({ className, children }: { className?: string; children: ReactNode }) {
  return <li className={cn('border-b border-border last:border-b-0', className)}>{children}</li>;
}

/**
 * 打ち切ったことを言う一行。**切るなら、切ったと分かる形で切る。**
 *
 * 黙って切り捨てると「全部でこれだけ」と読める出力になる。読む側はその嘘を自分では
 * 直せない — 隣に一覧へのリンクがあっても、**そこを押す理由が出力から消えている。**
 *
 * `total` が `shown` 以下なら**何も描かない。** 常に出る但し書きは、出ていることが
 * 情報にならない（「残り 0 件」は「取れない軸に 0 の行を作る」と同じ形である）。
 */
export function TruncationNote({ shown, total }: { shown: number; total: number }) {
  if (total <= shown) return null;
  return (
    <p className="border-t border-border px-4 py-2 text-[11px] text-muted-foreground">
      …残り {total - shown} 件は出していない
    </p>
  );
}
