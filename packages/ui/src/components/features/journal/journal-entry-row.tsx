import { ChevronRight } from 'lucide-react';
import { useState, type ReactNode } from 'react';

import { useDisplayText } from '@/lib/display-text';
import { cn } from '@/lib/utils';

import { Badge } from '../../common';
import { CodeBlock } from '../code-block';
import { Timestamp } from '../timestamp';

export type JournalEntryTone = 'neutral' | 'ok' | 'warn' | 'danger' | 'accent';

// ボタンの中にリンクを入れず、リンクは開いた後の領域に置く
export function JournalEntryRow({
  at,
  atLabel,
  relativeLabel,
  time,
  type,
  typeLabel,
  tone = 'neutral',
  summary,
  links,
  raw,
  isLast = false,
  defaultOpen = false,
  rawBar = true,
}: {
  at?: string;
  atLabel: string;
  relativeLabel?: string;
  time?: ReactNode;
  type: string;
  typeLabel?: string;
  tone?: JournalEntryTone;
  summary: string;
  links?: ReactNode;
  raw: unknown;
  isLast?: boolean;
  defaultOpen?: boolean;
  rawBar?: boolean;
}) {
  const { body } = useDisplayText();
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div className={cn('px-4 py-2', !isLast && 'border-b border-border')}>
      {/* 要旨は button の外に置く: Chromium は button の中の文字をドラッグ選択できないため */}
      <div className="flex flex-wrap items-start gap-x-3 gap-y-1 sm:flex-nowrap">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
          className="flex shrink-0 items-start gap-3 rounded-sm text-left"
        >
          <ChevronRight
            className={cn(
              'mt-0.5 size-3.5 shrink-0 text-muted-foreground transition-transform',
              open && 'rotate-90',
            )}
            aria-hidden
          />
          <span className="w-24 shrink-0 font-mono text-[11px] text-muted-foreground">
            {atLabel}
          </span>
          <Badge tone={tone} title={typeLabel === undefined ? undefined : type}>
            {typeLabel ?? type}
          </Badge>
        </button>
        <span className="ml-auto shrink-0 text-[11px] text-muted-foreground sm:order-3 sm:ml-0">
          {time !== undefined ? (
            time
          ) : at !== undefined ? (
            <Timestamp at={at} label={relativeLabel} />
          ) : null}
        </span>
        <span
          data-testid="journal-row-summary"
          className="line-clamp-3 w-full min-w-0 break-words pl-[1.625rem] text-sm text-muted-foreground sm:order-2 sm:w-auto sm:flex-1 sm:truncate sm:pl-0"
        >
          {body(summary)}
        </span>
      </div>

      {open && (
        <div className="mt-2 space-y-2 pl-6">
          {links}
          <CodeBlock label={rawBar ? type : undefined} copyable={rawBar} maxHeight="24rem">
            {body(JSON.stringify(raw, null, 2))}
          </CodeBlock>
        </div>
      )}
    </div>
  );
}
