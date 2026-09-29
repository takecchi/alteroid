import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

const JST = new Intl.DateTimeFormat('ja-JP', {
  timeZone: 'Asia/Tokyo',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

/** 表示の既定（`label` が無いとき）: JST の月日と時分。 */
const JST_SHORT = new Intl.DateTimeFormat('ja-JP', {
  timeZone: 'Asia/Tokyo',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

/**
 * 時刻。画面には短い形（「3 分前」など）を出し、指を載せる・焦点を当てると
 * **JST と UTC の正確な時刻**を出す。
 *
 * - 「3 分前」の文言は呼ぶ側が `label` で渡す（整形の正本は `@alteroid/logic` の
 *   `formatRelative`。この層は logic を import できないので、写しを持たない）。
 *   渡さなければ JST の月日と時分を出す
 * - **JST と UTC を両方出す。** 人間は JST で読み、ログと CI は UTC で書く。9時間の
 *   差を読み違えないように（AGENTS.md「時刻の扱い」）
 * - `<time dateTime>` に ISO 8601 を持つ（機械が読める）
 * - 読めない値（`Invalid Date`）は、その生の値をそのまま出す（黙って空にしない）
 *
 * `TooltipProvider` を自分で持つ（画面の根に置いていないので）。
 */
export function Timestamp({
  at,
  label,
  className,
}: {
  at: string | number | Date;
  label?: string;
  className?: string;
}) {
  const date = at instanceof Date ? at : new Date(at);
  if (Number.isNaN(date.getTime())) {
    return <span className={cn('font-mono text-[11px]', className)}>{String(at)}</span>;
  }
  const iso = date.toISOString();
  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <time
            dateTime={iso}
            tabIndex={0}
            className={cn(
              'cursor-default rounded-sm tabular-nums underline decoration-dotted decoration-muted-foreground/40 underline-offset-2',
              className,
            )}
          >
            {label ?? JST_SHORT.format(date)}
          </time>
        </TooltipTrigger>
        <TooltipContent>
          <dl className="grid grid-cols-[auto_1fr] gap-x-2 font-mono text-[11px]">
            <dt className="opacity-70">JST</dt>
            <dd>{JST.format(date)}</dd>
            <dt className="opacity-70">UTC</dt>
            <dd>{iso.replace('.000Z', 'Z')}</dd>
          </dl>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
