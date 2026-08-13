import type { ReactNode } from 'react';

import { cn } from '~/lib/cn';

export function Page({
  title,
  description,
  action,
  className,
  children,
}: {
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex h-dvh flex-col">
      <header className="flex shrink-0 items-start justify-between gap-4 border-b border-border px-6 py-4">
        <div className="min-w-0">
          <h1 className="text-base font-semibold">{title}</h1>
          {description !== undefined && <p className="mt-0.5 text-xs text-muted">{description}</p>}
        </div>
        {action !== undefined && <div className="shrink-0">{action}</div>}
      </header>
      <div className={cn('min-h-0 flex-1 overflow-y-auto p-6', className)}>{children}</div>
    </div>
  );
}
