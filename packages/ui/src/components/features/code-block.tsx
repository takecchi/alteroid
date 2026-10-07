import { Check, Copy } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { cn } from '@/lib/utils';

// 写せなかったときは「写せなかった」と言う: 黙って何もしないと、写したつもりのまま貼って初めて気づくため
export function CodeBlock({
  children,
  label,
  copyable = true,
  maxHeight,
  className,
}: {
  children: string;
  label?: string;
  copyable?: boolean;
  maxHeight?: string;
  className?: string;
}) {
  const [copied, setCopied] = useState<'idle' | 'done' | 'failed'>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // unmount の後に写しの Promise が解決しても、`done()` はタイマーも状態も触らない
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      clearTimeout(timer.current);
    };
  }, []);

  const copy = () => {
    const done = (state: 'done' | 'failed') => {
      if (!mounted.current) return;
      setCopied(state);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied('idle'), 1600);
    };
    if (typeof navigator === 'undefined' || navigator.clipboard === undefined) {
      done('failed');
      return;
    }
    navigator.clipboard.writeText(children).then(
      () => done('done'),
      () => done('failed'),
    );
  };

  const showBar = label !== undefined || copyable;

  return (
    <div
      className={cn(
        'overflow-hidden rounded-md border border-border bg-muted/40 text-xs',
        className,
      )}
    >
      {showBar && (
        <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-1.5">
          <span className="min-w-0 truncate font-mono text-muted-foreground">{label}</span>
          {copyable && (
            <button
              type="button"
              onClick={copy}
              className="inline-flex shrink-0 items-center gap-1 rounded-sm px-1.5 py-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              {copied === 'done' ? (
                <Check className="size-3.5 text-ok" aria-hidden />
              ) : (
                <Copy className="size-3.5" aria-hidden />
              )}
              <span aria-live="polite">
                {copied === 'done' ? '写した' : copied === 'failed' ? '写せなかった' : '写す'}
              </span>
            </button>
          )}
        </div>
      )}
      <pre
        className="overflow-auto p-3 font-mono leading-relaxed text-foreground/90"
        style={maxHeight === undefined ? undefined : { maxHeight }}
      >
        {children}
      </pre>
    </div>
  );
}
