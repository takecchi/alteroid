import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentType,
  type ReactNode,
} from 'react';

import { Card } from '../../common';

// `min-w-0` を枠にも本文にも置く: 広い表や長い行がある日報で、親の grid を押し広げないため
export const HOME_REPORT_MAX_HEIGHT = '24rem';

export function HomeReportCard({
  icon: Icon,
  title,
  meta,
  action,
  footer,
  children,
}: {
  icon: ComponentType<{ className?: string; 'aria-hidden'?: boolean }>;
  title: string;
  meta?: ReactNode;
  action?: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
}) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const bodyId = useId();
  const [truncated, setTruncated] = useState(false);
  const [expanded, setExpanded] = useState(false);

  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (el === null) return;
    // 広げている間は測らない: 枠が頭打ちでなく、はみ出しは測れないため
    const measure = () => {
      if (!expanded) setTruncated(el.scrollHeight > el.clientHeight + 1);
    };
    measure();
    // 子も observe する: 枠自身は max-h で頭打ちのため
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    for (const child of Array.from(el.children)) observer.observe(child);
    return () => observer.disconnect();
  }, [children, expanded]);

  return (
    <Card className="min-w-0">
      <div className="flex items-center gap-2 px-4 pt-3 text-xs text-muted-foreground">
        <Icon className="size-4 shrink-0" aria-hidden />
        <h2 className="truncate text-sm font-medium text-foreground">{title}</h2>
        {meta !== undefined && <span className="shrink-0">{meta}</span>}
        <span className="flex-1" />
        {action}
      </div>
      <div className="relative min-w-0 px-4 pt-3 pb-2">
        <div
          ref={bodyRef}
          id={bodyId}
          data-slot="home-report-body"
          data-truncated={truncated ? 'true' : 'false'}
          className={`min-w-0 leading-relaxed [&>div]:text-base ${expanded ? '' : 'max-h-96 overflow-hidden'}`}
        >
          {children}
        </div>
        {truncated && !expanded && (
          <div
            aria-hidden
            data-slot="home-report-fade"
            className="pointer-events-none absolute inset-x-0 bottom-2 h-12"
            style={{ backgroundImage: 'linear-gradient(to top, var(--card), transparent)' }}
          />
        )}
      </div>
      {(truncated || expanded) && (
        <div className="px-4 pb-3 text-xs">
          <button
            type="button"
            data-slot="home-report-toggle"
            aria-expanded={expanded}
            aria-controls={bodyId}
            onClick={() => setExpanded((v) => !v)}
            className="rounded-sm text-primary hover:underline outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            {expanded ? '畳む' : '全文を表示'}
          </button>
        </div>
      )}
      {footer !== undefined && <div className="px-4 pb-3 text-xs">{footer}</div>}
    </Card>
  );
}
