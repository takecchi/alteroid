import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';

import { Badge, Card, CardHeader } from '../../common';

// リンクを描く口を受ける: この層はルーターを知らないため
export type HomeRenderLink = (slot: { className: string; children: ReactNode }) => ReactNode;

export const HOME_LINK_CLASS = 'text-xs text-primary hover:underline';

// `plain` では待っているものがあるように見せない: 読めていないのに警告色を出すと、中身の無い警告になるため
export function AwaitingYouCard({
  action,
  tone = 'attention',
  children,
}: {
  action?: ReactNode;
  tone?: 'attention' | 'plain';
  children: ReactNode;
}) {
  return (
    <Card className={cn('min-w-0', tone === 'attention' && 'border-warn/50')}>
      <CardHeader
        title="承認待ち一覧"
        subtitle="答えるまで、その仕事だけが止まる"
        action={action}
      />
      {children}
    </Card>
  );
}

export function AwaitingYouCalm({ children }: { children?: ReactNode }) {
  return (
    <Card className="min-w-0">
      <div className="flex items-center gap-2 px-4 py-3 text-sm text-muted-foreground">
        <span className="size-1.5 shrink-0 rounded-full bg-ok" aria-hidden />
        {children ?? '承認待ちはない'}
      </div>
    </Card>
  );
}

// `line-clamp` の内側へブロック要素を入れない: 畳み方そのものが効かなくなるため
export function AwaitingApprovalRow({
  question,
  meta,
  renderLink,
}: {
  question: ReactNode;
  meta: ReactNode;
  renderLink: HomeRenderLink;
}) {
  return (
    <li className="border-b border-border px-4 py-2.5 last:border-b-0">
      {renderLink({
        className: 'flex items-start gap-3 hover:text-primary',
        children: (
          <>
            <Badge tone="warn">承認</Badge>
            <span className="min-w-0 flex-1">
              <span className="line-clamp-2 text-sm break-words">{question}</span>
              <span className="mt-0.5 block text-[11px] text-muted-foreground">{meta}</span>
            </span>
          </>
        ),
      })}
    </li>
  );
}

export function AwaitingCountRow({
  label,
  children,
  action,
}: {
  label: ReactNode;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <li className="flex items-center gap-3 border-b border-border px-4 py-2.5 text-sm last:border-b-0">
      <Badge>{label}</Badge>
      <span className="min-w-0 flex-1 text-muted-foreground">{children}</span>
      {action}
    </li>
  );
}
