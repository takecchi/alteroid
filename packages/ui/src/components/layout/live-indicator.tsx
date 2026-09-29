import { cn } from '@/lib/utils';

/**
 * 日誌 SSE の状態。`@alteroid/swr` の `LiveStatus` と同じ3値である。
 *
 * **ここで型を持つのは、この層が `@alteroid/swr` を import できないから**
 * （`eslint.config.js` の `WEB_UI_LAYERS`）。値を足すときは両方に足すこと —
 * 片方だけ足すと、画面側の型検査が `LiveIndicator` へ渡すところで落ちる
 * （構造で比べるので、落ちてくれる側の食い違いである）。
 */
export type LiveIndicatorStatus = 'live' | 'connecting' | 'offline';

const VIEW = {
  live: { dot: 'bg-ok', ring: 'bg-ok', text: '受信中', pulse: true },
  connecting: { dot: 'bg-warn', ring: 'bg-warn', text: '接続中', pulse: true },
  offline: { dot: 'bg-destructive', ring: 'bg-destructive', text: '切断', pulse: false },
} as const satisfies Record<
  LiveIndicatorStatus,
  { dot: string; ring: string; text: string; pulse: boolean }
>;

/**
 * 日誌 SSE が生きているか。
 *
 * **これを出さないと「静かなこと」と「切れていること」が区別できない。** 常駐して
 * 動き続ける前提の系なので、無音は正常でもありうるし異常でもありうる。
 *
 * 生きている間は点から輪が広がる（心拍）。**動きはこの1か所だけに置いてある** —
 * 画面の中で自分から動くのはここだけなので、動いていることがそのまま「受信している」
 * の合図になる。`prefers-reduced-motion` のときは止まり、点と文言だけが残る。
 */
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
