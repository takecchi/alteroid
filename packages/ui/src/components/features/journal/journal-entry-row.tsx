import { ChevronRight } from 'lucide-react';
import { useState, type ReactNode } from 'react';

import { cn } from '@/lib/utils';

import { Badge } from '../../common';
import { CodeBlock } from '../code-block';
import { Timestamp } from '../timestamp';

export type JournalEntryTone = 'neutral' | 'ok' | 'warn' | 'danger' | 'accent';

/**
 * 日誌の1件（日誌の画面・ダッシュボードの「最近の動き」）。
 *
 * 閉じているときは1行（時刻・種別・要旨・どれだけ前か）。押すと開いて、
 * **行が指している実体へのリンク**（`links`）と**生の中身**（`raw` の JSON）を出す。
 * 要約で止めず、掘れば生の中身まで降りられること（PRD 可観測性）。
 *
 * - 要旨は1行で切る（`truncate`）。**一覧の1行は Markdown にしない**
 *   （`markdown.tsx` の doc）
 * - 種別の札の色（`tone`）は画面が決める（種別ごとの重さは画面側の知識）
 * - 開閉は行全体の `<button>`。リンクは開いた後の領域に置く（ボタンの中にリンクを
 *   入れない）
 */
export function JournalEntryRow({
  at,
  atLabel,
  relativeLabel,
  type,
  tone = 'neutral',
  summary,
  links,
  raw,
  isLast = false,
  defaultOpen = false,
}: {
  at: string;
  /** 行頭の時刻の表示（整形は呼ぶ側。`formatDateTime`）。 */
  atLabel: string;
  /** 右端の「3 分前」（整形は呼ぶ側。`formatRelative`）。 */
  relativeLabel: string;
  type: string;
  tone?: JournalEntryTone;
  summary: string;
  links?: ReactNode;
  /** 開いたときに JSON で出す生の中身。 */
  raw: unknown;
  isLast?: boolean;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div className={cn('px-4 py-2', !isLast && 'border-b border-border')}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-start gap-3 rounded-sm text-left"
      >
        <ChevronRight
          className={cn(
            'mt-0.5 size-3.5 shrink-0 text-muted-foreground transition-transform',
            open && 'rotate-90',
          )}
          aria-hidden
        />
        <span className="w-24 shrink-0 font-mono text-[11px] text-muted-foreground">{atLabel}</span>
        <Badge tone={tone}>{type}</Badge>
        <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">{summary}</span>
        <span className="shrink-0 text-[11px] text-muted-foreground">
          <Timestamp at={at} label={relativeLabel} />
        </span>
      </button>

      {open && (
        <div className="mt-2 space-y-2 pl-6">
          {links}
          <CodeBlock label={type} maxHeight="24rem">
            {JSON.stringify(raw, null, 2)}
          </CodeBlock>
        </div>
      )}
    </div>
  );
}
