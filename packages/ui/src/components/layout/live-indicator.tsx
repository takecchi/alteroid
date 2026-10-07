import { cn } from '@/lib/utils';

// 型をここで持つ: この層は `@alteroid/swr` を import できないため
export type LiveIndicatorStatus = 'live' | 'connecting' | 'offline';

const VIEW = {
  live: { dot: 'bg-ok', ring: 'bg-ok', text: '受信中', pulse: true },
  connecting: { dot: 'bg-warn', ring: 'bg-warn', text: '接続中', pulse: true },
  offline: { dot: 'bg-destructive', ring: 'bg-destructive', text: '切断', pulse: false },
} as const satisfies Record<
  LiveIndicatorStatus,
  { dot: string; ring: string; text: string; pulse: boolean }
>;

// 動きはここ1か所だけに置く: 画面の中で自分から動くのがここだけなら、動いていることがそのまま「受信している」の合図になるため
export function LiveIndicator({
  status,
  className,
}: {
  status: LiveIndicatorStatus;
  className?: string;
}) {
  const view = VIEW[status];
  return (
    <div
      className={cn(
        'mt-1.5 flex items-center gap-1.5 text-[11px] text-muted-foreground',
        className,
      )}
    >
      <span className="relative flex size-1.5" aria-hidden>
        {view.pulse && (
          <span
            className={cn(
              'absolute inset-0 rounded-full opacity-60 motion-safe:animate-ping',
              view.ring,
            )}
          />
        )}
        <span className={cn('relative size-1.5 rounded-full', view.dot)} />
      </span>
      {view.text}
    </div>
  );
}
