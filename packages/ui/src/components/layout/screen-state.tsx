import type { ReactNode } from 'react';

import { Spinner as ShadcnSpinner } from '@/components/ui/spinner';
import { cn } from '@/lib/utils';

import { DocumentTitle } from '../document-title';
import { BrandMark } from './brand-mark';

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
        {typeof title === 'string' && <DocumentTitle>{title}</DocumentTitle>}
        {title !== undefined && <h1 className="mb-3 text-sm font-semibold">{title}</h1>}
        {children}
      </div>
    </div>
  );
}

export function ScreenLoading({ label = '読み込み中' }: { label?: string }) {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-4">
      <DocumentTitle>{label}</DocumentTitle>
      <BrandMark withWordmark={false} className="opacity-80" />
      <div className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
        <ShadcnSpinner aria-hidden role={undefined} aria-label={undefined} />
        {label}
      </div>
    </div>
  );
}
