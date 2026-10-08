import { cn } from '@/lib/utils';

// 型をここで持つ: この層は `@alteroid/swr` を import できないため
export type LiveIndicatorStatus = 'live' | 'connecting' | 'offline';

// 名前を引くのは呼ぶ側: 接続先の一覧はこの層の外（`@alteroid/swr`）に在るため
export interface LiveIndicatorConnection {
  name: string;
  title: string;
}

const VIEW = {
  live: { dot: 'bg-ok', ring: 'bg-ok', text: '受信中', pulse: true },
  connecting: { dot: 'bg-warn', ring: 'bg-warn', text: '接続中', pulse: true },
  offline: { dot: 'bg-destructive', ring: 'bg-destructive', text: '切断', pulse: false },
} as const satisfies Record<
  LiveIndicatorStatus,
  { dot: string; ring: string; text: string; pulse: boolean }
>;

// 動きはここ1か所だけに置く: 画面の中で自分から動くのがここだけなら、動いていることがそのまま「受信している」の合図になるため
// 名前だけを縮める: 長い名前で札（受信中）やロゴが押し出されると、いちばん見たい「繋がっているか」が読めなくなるため
export function LiveIndicator({
  status,
  connection,
  className,
}: {
  status: LiveIndicatorStatus;
  connection?: LiveIndicatorConnection;
  className?: string;
}) {
  const view = VIEW[status];
  return (
    <div
      className={cn(
        'mt-1.5 flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground',
        className,
      )}
    >
      <span className="relative flex size-1.5 shrink-0" aria-hidden>
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
      <span className="shrink-0">{view.text}</span>
      {connection !== undefined && (
        <>
          <span className="shrink-0" aria-hidden>
            ·
          </span>
          <span className="min-w-0 truncate text-foreground/80" title={connection.title}>
            <span className="sr-only">接続先 </span>
            {connection.name}
          </span>
        </>
      )}
    </div>
  );
}
