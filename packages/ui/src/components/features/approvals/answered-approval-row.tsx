import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';

import { Badge } from '../../common';

// リンクを `renderLink` で受ける: この層はルーターを知らないため
export function AnsweredApprovalRow({
  state,
  time,
  question,
  answer,
  withdrawnReason,
  renderLink,
}: {
  state: 'answered' | 'withdrawn';
  time: ReactNode;
  question: string;
  answer?: string;
  withdrawnReason?: string;
  renderLink: (props: { className: string; children: ReactNode }) => ReactNode;
}) {
  return renderLink({
    className: cn(
      'block rounded-md border border-border bg-card px-3 py-2 text-sm transition-colors',
      'hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
    ),
    children: (
      <>
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
          <Badge tone={state === 'withdrawn' ? 'accent' : 'neutral'}>
            {state === 'withdrawn' ? '取り下げ済' : '回答済'}
          </Badge>
          <span>{time}</span>
        </span>
        <span className="mt-1 line-clamp-2 block break-words whitespace-pre-line">{question}</span>
        {state === 'answered' && answer !== undefined && (
          <span className="mt-1 line-clamp-2 block break-words whitespace-pre-line text-xs text-muted-foreground">
            <span className="mr-1">答え</span>
            {answer}
          </span>
        )}
        {state === 'withdrawn' && withdrawnReason !== undefined && (
          <span className="mt-1 line-clamp-2 block break-words whitespace-pre-line text-xs text-muted-foreground">
            <span className="mr-1">取り下げた理由</span>
            {withdrawnReason}
          </span>
        )}
      </>
    ),
  });
}
