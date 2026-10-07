import { useId, useLayoutEffect, useRef, useState, type ReactNode, type Ref } from 'react';

import { cn } from '@/lib/utils';

import { DocumentTitle } from './document-title';

// `description` に可変長の本文を渡さない: header は `shrink-0` なので、文字数のぶんだけ本文の領域が縦に潰れるため
export function Page({
  title,
  documentTitle,
  description,
  action,
  actionPlacement = 'below-on-narrow',
  className,
  scrollRef,
  tabs,
  children,
}: {
  title: ReactNode;
  documentTitle?: string;
  description?: ReactNode;
  action?: ReactNode;
  actionPlacement?: 'below-on-narrow' | 'side';
  className?: string;
  scrollRef?: Ref<HTMLDivElement>;
  tabs?: ReactNode;
  children: ReactNode;
}) {
  const docTitle = documentTitle ?? (typeof title === 'string' ? title : undefined);
  return (
    // `h-dvh` ではなく `h-full` にする: ここでも viewport を取ると、狭い画面で shell が上端に出す帯のぶんだけはみ出すため
    <div className="flex h-full flex-col">
      {docTitle !== undefined && <DocumentTitle>{docTitle}</DocumentTitle>}
      <header
        className={cn(
          tabs === undefined && 'border-b border-border',
          'flex shrink-0 gap-4 py-4 md:pt-[calc(1rem+var(--safe-top))] pl-[calc(1rem+var(--safe-left))] pr-[calc(1rem+var(--safe-right))] md:pl-[calc(1.5rem+var(--safe-left))] md:pr-[calc(1.5rem+var(--safe-right))]',
          actionPlacement === 'side'
            ? 'items-start justify-between'
            : 'flex-col md:flex-row md:items-start md:justify-between',
        )}
      >
        <div className="min-w-0">
          <h1 className="text-base font-semibold">{title}</h1>
          {description !== undefined && <PageDescription>{description}</PageDescription>}
        </div>
        {action !== undefined && <div className="shrink-0">{action}</div>}
      </header>
      {tabs !== undefined && (
        <div className="shrink-0 border-b border-border pl-[calc(1rem+var(--safe-left))] pr-[calc(1rem+var(--safe-right))] md:pl-[calc(1.5rem+var(--safe-left))] md:pr-[calc(1.5rem+var(--safe-right))]">
          {tabs}
        </div>
      )}
      <div
        ref={scrollRef}
        data-scroll-body
        className={cn(
          // `relative` を外さない: 本文の中の `sr-only` が文書を基準に付き、body がスクロールするため
          'relative min-h-0 flex-1 overflow-y-auto p-4 pb-[calc(1rem+var(--safe-bottom))] pl-[calc(1rem+var(--safe-left))] pr-[calc(1rem+var(--safe-right))] md:p-6 md:pb-[calc(1.5rem+var(--safe-bottom))] md:pl-[calc(1.5rem+var(--safe-left))] md:pr-[calc(1.5rem+var(--safe-right))]',
          className,
        )}
      >
        {children}
      </div>
    </div>
  );
}

// スクロール枠にしない（`overflow-y-auto` にしない）: Chromium がキーボードで届くものを持たないスクロール枠を Tab の対象にするため
function PageDescription({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLParagraphElement>(null);
  const id = useId();
  const [open, setOpen] = useState(false);
  const [clipped, setClipped] = useState(false);

  useLayoutEffect(() => {
    const el = ref.current;
    if (el === null || open) return;
    const measure = () => setClipped(el.scrollHeight > el.clientHeight + 1);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [children, open]);

  return (
    <>
      <p
        ref={ref}
        id={id}
        className={cn('mt-0.5 text-xs text-muted-foreground', !open && 'line-clamp-3')}
      >
        {children}
      </p>
      {(clipped || open) && (
        <button
          type="button"
          aria-expanded={open}
          aria-controls={id}
          onClick={() => setOpen((v) => !v)}
          className="mt-0.5 text-xs text-muted-foreground underline hover:text-foreground"
        >
          {open ? 'たたむ' : '詳しく'}
        </button>
      )}
    </>
  );
}
