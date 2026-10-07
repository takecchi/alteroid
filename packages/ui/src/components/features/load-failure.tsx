import { AlertTriangle } from 'lucide-react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/common';
import { useDisplayText } from '@/lib/display-text';
import { cn } from '@/lib/utils';

// `className` は外側の枠に付ける: 帯へ直に余白を付けると、幅 100% に余白が足されて親の右端からはみ出すため
// 要約・取り直しは呼ぶ側が受ける: この層は logic も swr も import できないため
export function LoadFailure({
  title,
  summary,
  hint,
  detail,
  onRetry,
  retrying = false,
  className,
}: {
  title: string;
  summary: string;
  hint?: string | undefined;
  detail?: string | undefined;
  onRetry?: (() => void) | undefined;
  retrying?: boolean;
  className?: string;
}) {
  const display = useDisplayText();
  return (
    <div className={cn('min-w-0', className)}>
      <Alert variant="destructive" className="border-destructive/40">
        <AlertTriangle aria-hidden />
        <AlertTitle className="min-w-0 break-words">{title}</AlertTitle>
        <AlertDescription className="min-w-0 break-words">
          <p>
            {summary}
            {hint !== undefined && <span className="block">{hint}</span>}
          </p>
          {detail !== undefined && (
            <details className="mt-2 text-[11px]">
              <summary className="cursor-pointer select-none">詳細</summary>
              <p className="mt-1 font-mono break-all whitespace-pre-wrap">
                {display.error(detail)}
              </p>
            </details>
          )}
          {onRetry !== undefined && (
            <div className="mt-3">
              <Button size="sm" loading={retrying} onClick={onRetry}>
                もう一度試す
              </Button>
            </div>
          )}
        </AlertDescription>
      </Alert>
    </div>
  );
}
