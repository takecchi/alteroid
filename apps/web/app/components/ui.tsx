/**
 * 画面の部品。
 *
 * ここは**ルーターに依存しない**。リンクにしたいときは `asChild` を使わず、
 * 呼ぶ側が `<Link>` を置いて `className` を渡す形にしてある（部品を増やすより
 * 素の要素で済ませたほうが読みやすい規模なので）。
 */
import { AlertTriangle, Loader2 } from 'lucide-react';
import type { ButtonHTMLAttributes, ReactNode, TextareaHTMLAttributes } from 'react';

import { cn } from '~/lib/cn';

/**
 * `radix-ui` の `Tabs.Trigger` に付ける見た目。
 *
 * **`memory-detail.tsx` から移設**（`schedule.tsx` の編集タブと共有するため）。
 * 移設は「載る時機を変える」ことであって「読めるものを減らす」ことではないので、
 * クラス文字列は1文字も変えていない（AGENTS.md「スキルへ移すときは移すだけで、
 * 要約も短縮もしない」と同じ考え方）。
 */
export const TAB_TRIGGER_CLASS =
  'border-b-2 border-transparent px-3 py-1.5 text-sm font-medium text-muted transition-colors hover:text-fg';
export const TAB_TRIGGER_ACTIVE_CLASS = 'border-accent text-fg';

export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div className={cn('rounded-lg border border-border bg-surface', className)}>{children}</div>
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
        <h2 className="truncate text-sm font-semibold">{title}</h2>
        {subtitle !== undefined && <p className="mt-0.5 text-xs text-muted">{subtitle}</p>}
      </div>
      {action !== undefined && <div className="shrink-0">{action}</div>}
    </div>
  );
}

const BUTTON_VARIANTS = {
  primary: 'bg-accent text-accent-fg hover:opacity-90',
  default: 'bg-surface-2 text-fg hover:bg-border',
  ghost: 'bg-transparent text-muted hover:bg-surface-2 hover:text-fg',
  danger: 'bg-transparent text-danger hover:bg-danger/10',
} as const;

const BUTTON_SIZES = {
  // 狭い画面（`md` 未満）ではタップ標的を 44px（`h-11`）まで持ち上げる。
  // 指で押す先は 44px 以上（WCAG 2.5.5 / Apple HIG の下限。同じ基準を
  // `apps/web/app/routes/shell.tsx` の `size-11` が既に使っている）。
  // `md:` の境目は `apps/web/app/hooks/use-is-mobile.ts` の
  // `MOBILE_BREAKPOINT`（768）と揃えてある。広い画面の見た目は変えない
  // （依頼は「スマホ表示」であって、デスクトップまで背を高くするのは
  // 依頼より広い）。
  sm: 'h-11 px-3 text-xs md:h-7 md:px-2',
  md: 'h-11 px-3 text-sm md:h-9',
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
    <button
      // 明示しないと form の中で submit になる。押した覚えのない送信を作らない。
      type="button"
      className={cn(
        'inline-flex items-center justify-center gap-1.5 rounded-md font-medium transition-colors',
        'disabled:cursor-not-allowed disabled:opacity-50',
        BUTTON_VARIANTS[variant],
        BUTTON_SIZES[size],
        className,
      )}
      disabled={disabled === true || loading}
      {...props}
    >
      {loading && <Loader2 className="size-3.5 animate-spin" aria-hidden />}
      {children}
    </button>
  );
}

const BADGE_TONES = {
  neutral: 'bg-surface-2 text-muted',
  ok: 'bg-ok/15 text-ok',
  warn: 'bg-warn/15 text-warn',
  danger: 'bg-danger/15 text-danger',
  accent: 'bg-accent/15 text-accent',
} as const;

export function Badge({
  tone = 'neutral',
  className,
  children,
}: {
  tone?: keyof typeof BADGE_TONES;
  className?: string;
  children: ReactNode;
}) {
  return (
    <span
      className={cn(
        // `shrink-0`: 横並びの flex 行の中で潰されて文字が読めなくなる幅まで
        // 縮まないようにする。**`whitespace-nowrap` は入れていない** —
        // `commitments.tsx` の `OriginBadge` は `commitment.source`
        // （`z.string().optional()`、長さの制約なし）を、`settings.tsx` の
        // 資格情報一覧は `credential.name`（`CREDENTIAL_NAME` 正規表現に
        // 長さの上限が無い）をそのまま中身にしており、折り返さない指定は
        // 可変の長文が来たときにはみ出しを直すどころか作る側へ振れる。
        'inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium',
        BADGE_TONES[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

export function Textarea({ className, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      className={cn(
        'w-full resize-y rounded-md border border-border bg-bg px-3 py-2 text-sm',
        'placeholder:text-muted focus:outline-none focus-visible:border-accent',
        className,
      )}
      {...props}
    />
  );
}

export function Input({ className, ...props }: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cn(
        'h-9 w-full rounded-md border border-border bg-bg px-3 text-sm',
        'placeholder:text-muted focus:outline-none focus-visible:border-accent',
        className,
      )}
      {...props}
    />
  );
}

/**
 * 選択肢が決まっている絞り込み用。**`Input` と同じ見た目に揃えてある**
 * （並べたときに片方だけ浮くと、同じ役割のものに見えなくなる）。
 */
export function Select({ className, ...props }: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={cn(
        'h-9 w-full rounded-md border border-border bg-bg px-3 text-sm',
        'focus:outline-none focus-visible:border-accent',
        className,
      )}
      {...props}
    />
  );
}

export function Spinner({ label = '読み込み中' }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 p-6 text-sm text-muted">
      <Loader2 className="size-4 animate-spin" aria-hidden />
      {label}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="p-6 text-sm text-muted">{children}</p>;
}

/**
 * 失敗を必ず見せる。
 *
 * **握り潰して「読み込み中」のままにしない。** 接続先が違う・デーモンが落ちて
 * いる、のどちらも、ここが出ないと「静かなだけ」に見えてしまう。
 */
export function ErrorNote({ error, className }: { error: unknown; className?: string }) {
  if (error === undefined || error === null) return null;
  const message = error instanceof Error ? error.message : String(error);
  return (
    <div
      role="alert"
      className={cn(
        'flex items-start gap-2 rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger',
        className,
      )}
    >
      <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
      <span className="min-w-0 break-words">{message}</span>
    </div>
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
    <p className="border-t border-border px-4 py-2 text-[11px] text-muted">
      …残り {total - shown} 件は出していない
    </p>
  );
}
