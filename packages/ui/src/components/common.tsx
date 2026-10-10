import { AlertTriangle } from 'lucide-react';
import type {
  ButtonHTMLAttributes,
  HTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  KeyboardEvent,
  TextareaHTMLAttributes,
} from 'react';
import { useEffect, useLayoutEffect, useRef } from 'react';

import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge as ShadcnBadge } from '@/components/ui/badge';
import { Button as ShadcnButton } from '@/components/ui/button';
import { Card as ShadcnCard } from '@/components/ui/card';
import { Input as ShadcnInput } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { Spinner as ShadcnSpinner } from '@/components/ui/spinner';
import { Textarea as ShadcnTextarea } from '@/components/ui/textarea';
import { useDisplayText } from '@/lib/display-text';
import { isMacPlatform, submitShortcutLabel, useKeyboardHintsVisible } from '@/lib/platform';
import { cn } from '@/lib/utils';

import { isImeComposing, isSubmitShortcut } from './features/chat/ime';

export const TAB_TRIGGER_CLASS =
  'border-b-2 border-transparent px-3 py-1.5 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground pointer-coarse:py-3';
export const TAB_TRIGGER_ACTIVE_CLASS = 'border-primary text-foreground';

// 余白を消す（`gap-0 py-0`）: 画面が `CardHeader` と中身の余白を自分で持つので、shadcn の既定を足すと二重になるため
// `overflow-hidden` にしない: 長い生ログや横に広い表を枠で黙って切らないため
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

// `default` は `secondary` ではなく縁のある `outline` にする: `secondary` は縁が無く、暗い地の上では押せることが形から読めないため
const BUTTON_VARIANTS = {
  primary: { shadcn: 'default', className: 'shadow-sm shadow-primary/20' },
  default: { shadcn: 'outline', className: 'dark:border-foreground/20' },
  ghost: { shadcn: 'ghost', className: '' },
  danger: { shadcn: 'destructive', className: 'border-destructive/40' },
} as const;

const BUTTON_SIZES = {
  // 狭い画面ではタップ標的を 44px（`h-11`）にする: 指で押す先は 44px 以上が下限のため
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
      // type を明示する: 省略すると form の中で submit になり、押した覚えのない送信を作るため
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
        // 折り返しを許す: 中身は長さの上限が無い文字列で、折り返さないとはみ出しを作るため
        'h-auto shrink-0 overflow-visible break-words whitespace-normal',
        BADGE_TONES[tone].className,
        className,
      )}
      {...props}
    >
      {children}
    </ShadcnBadge>
  );
}

// `field-sizing: content` を使わず `scrollHeight` から決める: Firefox などが対応していないため
function fitHeight(el: HTMLTextAreaElement): void {
  el.style.height = 'auto';
  if (el.scrollHeight === 0) return;
  el.style.height = `${el.scrollHeight + (el.offsetHeight - el.clientHeight)}px`;
}

export function Textarea({
  className,
  style,
  onKeyDown,
  onSubmitShortcut,
  submitDisabled = false,
  refocusAfterSubmit = false,
  maxHeight,
  ...props
}: TextareaHTMLAttributes<HTMLTextAreaElement> & {
  onSubmitShortcut?: () => void;
  submitDisabled?: boolean;
  refocusAfterSubmit?: boolean;
  maxHeight?: string;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const refocus = useRef<'idle' | 'armed' | 'sending'>('idle');
  const disabled = props.disabled === true;
  useEffect(() => {
    const el = ref.current;
    if (disabled) {
      if (refocus.current === 'armed') refocus.current = 'sending';
      return;
    }
    const was = refocus.current;
    refocus.current = 'idle';
    if (was !== 'sending' || el === null) return;
    const active = document.activeElement;
    if (active === null || active === document.body || active === el) el.focus();
  });
  const grows = maxHeight !== undefined;
  const value = props.value;
  useLayoutEffect(() => {
    const el = ref.current;
    if (!grows || el === null) return;
    fitHeight(el);
    const refit = () => fitHeight(el);
    window.addEventListener('resize', refit);
    // 窓の大きさが変わらなくても欄の幅は変わる（入力欄の並びの組み替えなど）ので、幅の変化でも測り直す。
    // 高さの変化では測り直さない: 自分で入れた高さでまた呼ばれるため
    let width = el.clientWidth;
    const observer =
      typeof ResizeObserver === 'undefined'
        ? undefined
        : new ResizeObserver(() => {
            if (el.clientWidth === width) return;
            width = el.clientWidth;
            fitHeight(el);
          });
    observer?.observe(el);
    return () => {
      window.removeEventListener('resize', refit);
      observer?.disconnect();
    };
  }, [grows, value]);
  return (
    <ShadcnTextarea
      ref={ref}
      className={cn(
        'field-sizing-fixed',
        grows ? 'resize-none overflow-y-auto' : 'resize-y',
        className,
      )}
      style={grows ? { ...style, maxHeight } : style}
      onKeyDown={(event: KeyboardEvent<HTMLTextAreaElement>) => {
        onKeyDown?.(event);
        if (event.defaultPrevented || onSubmitShortcut === undefined) return;
        if (isSubmitShortcut(event)) {
          event.preventDefault();
          if (!submitDisabled) {
            if (refocusAfterSubmit) refocus.current = 'armed';
            onSubmitShortcut();
          }
        }
      }}
      {...props}
    />
  );
}

export function SubmitHint({
  action,
  id,
  className,
}: {
  action: string;
  id?: string;
  className?: string;
}) {
  const visible = useKeyboardHintsVisible();
  if (!visible) return null;
  return (
    <span id={id} className={cn('text-[11px] text-muted-foreground select-none', className)}>
      {submitShortcutLabel(isMacPlatform())} で{action}
    </span>
  );
}

export { useKeyboardHintsVisible };

// 修飾キーの無い Enter（Shift + Enter も）では送らない: form の中だとブラウザの暗黙の送信が走り、選択肢を選んだ直後の Enter が押した覚えのない送信になったため。
// 送るのはチャットと同じ Cmd/Ctrl + Enter だけにそろえる
export function Input({
  className,
  onKeyDown,
  onSubmitShortcut,
  submitDisabled = false,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & {
  onSubmitShortcut?: () => void;
  submitDisabled?: boolean;
}) {
  return (
    <ShadcnInput
      className={className}
      onKeyDown={(event: KeyboardEvent<HTMLInputElement>) => {
        onKeyDown?.(event);
        if (event.defaultPrevented || event.key !== 'Enter' || isImeComposing(event)) return;
        event.preventDefault();
        if (!isSubmitShortcut(event) || submitDisabled) return;
        if (onSubmitShortcut !== undefined) onSubmitShortcut();
        else event.currentTarget.form?.requestSubmit();
      }}
      {...props}
    />
  );
}

// プレースホルダへ書かず常時出す: プレースホルダは入力を始めると消え、欄の幅で切れるため
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

// `size` を受けない: shadcn の `size`（高さの段）と名前が衝突するため
export function Select({
  className,
  ...props
}: Omit<SelectHTMLAttributes<HTMLSelectElement>, 'size'>) {
  return <NativeSelect className={cn('w-full', className)} {...props} />;
}

export function Spinner({ label = '読み込み中' }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 p-6 text-sm text-muted-foreground">
      {/* 輪を読み上げから外す: 読み上げの本体は `label` で、shadcn の既定は輪自身が英語の `aria-label` を持つため */}
      <ShadcnSpinner aria-hidden role={undefined} aria-label={undefined} />
      {label}
    </div>
  );
}

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

// 握り潰して「読み込み中」のままにしない: ここが出ないと、接続先違いやデーモン停止が「静かなだけ」に見えるため
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

// 本文の入れ物を span と div で選べるようにする: 段落や一覧を入れる呼び出し側があり、span の中へ入れると DOM の入れ子が変わるため
export function WarnNote({
  className,
  children,
  block = false,
  small = false,
}: {
  className?: string;
  children: ReactNode;
  block?: boolean;
  small?: boolean;
}) {
  const Body = block ? 'div' : 'span';
  return (
    <div
      role="status"
      className={cn(
        'flex items-start gap-2 rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-warn',
        small ? 'text-xs' : 'text-sm',
        className,
      )}
    >
      <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
      <Body className="min-w-0 break-words">{children}</Body>
    </div>
  );
}

export function Row({ className, children }: { className?: string; children: ReactNode }) {
  return <li className={cn('border-b border-border last:border-b-0', className)}>{children}</li>;
}

// `total` が `shown` 以下なら何も描かない: 常に出る但し書きは、出ていることが情報にならないため
export function TruncationNote({ shown, total }: { shown: number; total: number }) {
  if (total <= shown) return null;
  return (
    <p className="border-t border-border px-4 py-2 text-[11px] text-muted-foreground">
      …残り {total - shown} 件は出していない
    </p>
  );
}
