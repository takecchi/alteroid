import type { ComponentType, ReactNode } from 'react';

import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { cn } from '@/lib/utils';

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className,
}: {
  icon?: ComponentType<{ className?: string; 'aria-hidden'?: boolean }>;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <Empty className={cn('py-10', className)}>
      <EmptyHeader>
        {Icon !== undefined && (
          <EmptyMedia variant="icon" className="bg-accent text-accent-foreground">
            <Icon aria-hidden />
          </EmptyMedia>
        )}
        <EmptyTitle className="text-sm">{title}</EmptyTitle>
        {description !== undefined && (
          <EmptyDescription className="text-xs">{description}</EmptyDescription>
        )}
      </EmptyHeader>
      {action !== undefined && <EmptyContent>{action}</EmptyContent>}
    </Empty>
  );
}
