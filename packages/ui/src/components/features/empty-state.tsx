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

/**
 * 空の画面・空の一覧。**空は「次に何をすればよいか」を言う場所である**——
 * 「まだ無い」だけで終わらせず、`description` か `action` で次の一手を置く。
 *
 * 一覧の中の1行ぶんの空なら `common.tsx` の `Empty`（1行の文言）で足りる。
 * こちらは画面や枠の中身が丸ごと空のとき。
 */
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
