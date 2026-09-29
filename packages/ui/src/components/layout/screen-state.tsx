import type { ReactNode } from 'react';

import { Spinner as ShadcnSpinner } from '@/components/ui/spinner';
import { cn } from '@/lib/utils';

import { BrandMark } from './brand-mark';

/**
 * 画面全体を1つの用件で占めるときの枠（繋がらない・確認中・ログイン）。
 *
 * 中身は真ん中の1列に置く。上に印を小さく出す——**どの道具の画面なのか**が、
 * 壊れているときほど要る（接続先を間違えて別のデーモンを見ている、など）。
 */
export function ScreenState({
  title,
  children,
  className,
}: {
  title?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'flex min-h-dvh items-center justify-center p-6 pt-[calc(1.5rem+var(--safe-top))] pb-[calc(1.5rem+var(--safe-bottom))]',
        className,
      )}
    >
      <div className="w-full max-w-lg">
        <BrandMark className="mb-6 text-muted-foreground" />
        {title !== undefined && <h1 className="mb-3 text-sm font-semibold">{title}</h1>}
        {children}
      </div>
    </div>
  );
}

/**
 * 画面全体の「確認中」。文言が読み上げの本体で、輪は飾り（`common.tsx` の
 * `Spinner` と同じ扱い）。
 */
export function ScreenLoading({ label = '読み込み中' }: { label?: string }) {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-4">
      <BrandMark withWordmark={false} className="opacity-80" />
      <div className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
        <ShadcnSpinner aria-hidden role={undefined} aria-label={undefined} />
        {label}
      </div>
    </div>
  );
}
