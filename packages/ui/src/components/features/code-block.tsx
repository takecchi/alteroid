import { Check, Copy } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { cn } from '@/lib/utils';

/**
 * 生の文字列（ログ・スタック・コマンドの出力・設定ファイル）。
 *
 * **写しを取る口を付ける**（`copyable`）。ここに出るものは、人間が端末や Issue へ
 * そのまま貼りたいものが多い。写せなかった（クリップボードが使えない）ときは
 * 「写せなかった」と言う——黙って何もしないと、写したつもりのまま貼って初めて気づく。
 *
 * 長い行は折り返す（`styles.css` の `pre` の既定）。高さは `maxHeight` で抑え、
 * 中でスクロールさせる——**文字は1つも捨てない**。
 */
export function CodeBlock({
  children,
  label,
  copyable = true,
  maxHeight,
  className,
}: {
  children: string;
  /** 上の帯に出す名前（ファイル名・コマンド）。 */
  label?: string;
  copyable?: boolean;
  /** CSS の長さ。既定は抑えない。 */
  maxHeight?: string;
  className?: string;
}) {
  const [copied, setCopied] = useState<'idle' | 'done' | 'failed'>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  const copy = () => {
    const done = (state: 'done' | 'failed') => {
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
