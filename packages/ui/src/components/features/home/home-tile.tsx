import type { ComponentType, ReactNode } from 'react';

import { Card } from '../../common';

export function HomeTile({
  icon: Icon,
  title,
  action,
  children,
}: {
  icon: ComponentType<{ className?: string; 'aria-hidden'?: boolean }>;
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Card className="min-w-0">
      <div className="flex items-center gap-2 px-4 pt-3 text-xs text-muted-foreground">
        <Icon className="size-3.5 shrink-0" aria-hidden />
        <h2 className="flex-1 truncate font-normal">{title}</h2>
        {action}
      </div>
      <div className="min-w-0 px-4 pt-2 pb-3">{children}</div>
    </Card>
  );
}

export function HomeTileNote({
  tone = 'muted',
  children,
}: {
  tone?: 'muted' | 'warn';
  children: ReactNode;
}) {
  return (
    <p
      className={tone === 'warn' ? 'mt-2 text-xs text-warn' : 'mt-2 text-xs text-muted-foreground'}
    >
      {children}
    </p>
  );
}
