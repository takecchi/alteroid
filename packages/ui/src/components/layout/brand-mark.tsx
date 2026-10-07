import { useId } from 'react';

import { cn } from '@/lib/utils';

// 名前を大文字にしない: 製品名の綴りが小文字のため
export function BrandMark({
  withWordmark = true,
  className,
}: {
  withWordmark?: boolean;
  className?: string;
}) {
  // id を固定にしない: 同じ画面に2つ以上出るため
  const clipId = `alteroid-mark-clone-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  return (
    <span className={cn('inline-flex items-center gap-2 text-foreground', className)}>
      <svg
        viewBox="0 0 24 24"
        className="size-5 shrink-0"
        aria-hidden
        focusable="false"
        fill="none"
      >
        <defs>
          <clipPath id={clipId}>
            <circle cx="14.5" cy="12" r="6.5" />
          </clipPath>
        </defs>
        <circle cx="9.5" cy="12" r="6.5" clipPath={`url(#${clipId})`} className="fill-primary" />
        <circle cx="9.5" cy="12" r="6.5" className="stroke-foreground" strokeWidth="1.5" />
        <circle
          cx="14.5"
          cy="12"
          r="6.5"
          className="stroke-primary"
          strokeWidth="1.5"
          strokeDasharray="2.2 1.8"
        />
      </svg>
      {withWordmark && (
        <span className="font-display text-[13px] leading-none tracking-[0.08em]">alteroid</span>
      )}
    </span>
  );
}
