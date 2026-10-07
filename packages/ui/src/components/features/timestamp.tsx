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

const JST_SHORT = new Intl.DateTimeFormat('ja-JP', {
  timeZone: 'Asia/Tokyo',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

// `label` は呼ぶ側が渡す: この層は logic を import できず、整形の写しを持たないため
// JST と UTC を両方出す: 人間は JST で読み、ログと CI は UTC で書くので、9時間の差を読み違えないようにするため
// 読めない値（`Invalid Date`）は生の値をそのまま出す: 黙って空にしないため
// `TooltipProvider` を自分で持つ: 画面の根に置いていないため
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
