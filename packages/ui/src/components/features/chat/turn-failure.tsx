import { AlertTriangle, RotateCw } from 'lucide-react';
import type { ReactNode } from 'react';

import { Alert, AlertDescription } from '@/components/ui/alert';
import { useDisplayText } from '@/lib/display-text';
import { cn } from '@/lib/utils';

import { Button } from '../../common';

export type TurnFailureKind = 'auth' | 'quota' | 'other';

export const TURN_FAILURE_COPY: Record<TurnFailureKind, { what: string; next: string }> = {
  auth: {
    what: 'クローンの認証が通らず、返事を作れませんでした。',
    next: '認証トークンの画面で、使えるトークンが登録されているか確かめてください。',
  },
  quota: {
    what: '利用上限に当たっていて、返事を作れませんでした。',
    next: '上限が開いたあとに、もう一度送ってください。',
  },
  other: {
    what: '返事を作れませんでした。',
    next: '少し待ってから、もう一度送ってください。',
  },
};

// 導線（`action`）は呼ぶ側が受ける: ここはルーターに依存しないため
export function TurnFailureNote({
  kind,
  message,
  action,
  className,
}: {
  kind: TurnFailureKind;
  message: string;
  action?: (kind: TurnFailureKind) => ReactNode;
  className?: string;
}) {
  const display = useDisplayText();
  const copy = TURN_FAILURE_COPY[kind];
  return (
    <Alert variant="destructive" className={cn('border-destructive/40', className)}>
      <AlertTriangle aria-hidden />
      <AlertDescription className="min-w-0 break-words">
        <p>
          {copy.what}
          {copy.next}
        </p>
        {action?.(kind)}
        <details className="mt-1 text-xs">
          <summary className="cursor-pointer py-1">詳細</summary>
          <p className="whitespace-pre-wrap break-words">{display.error(message)}</p>
        </details>
      </AlertDescription>
    </Alert>
  );
}

// 返答の見た目（地の上の本文）を使わない: クローンの返答と見分けるため
export function ChatTurnFailure({
  kind,
  failureKind = 'other',
  text,
  action,
  onRetry,
  retrying = false,
}: {
  kind: 'failed' | 'held';
  failureKind?: TurnFailureKind;
  text: string;
  action?: (kind: TurnFailureKind) => ReactNode;
  onRetry?: () => void;
  retrying?: boolean;
}) {
  const { body } = useDisplayText();
  const shown = body(text);
  const copy = TURN_FAILURE_COPY[failureKind];
  return (
    <li
      data-turn-failure={kind}
      className="flex min-w-0 flex-col items-start gap-2 border-l-4 border-destructive bg-destructive/5 py-2 pl-3 pr-2 text-sm"
    >
      <div className="flex min-w-0 max-w-[46rem] items-start gap-2 text-destructive">
        <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
        {kind === 'failed' ? (
          <div className="min-w-0 break-words">
            <p className="font-medium">
              {copy.what}
              {copy.next}
            </p>
            {action?.(failureKind)}
            <details className="text-xs text-muted-foreground">
              <summary className="cursor-pointer py-1">詳細</summary>
              <p className="whitespace-pre-wrap break-words">{shown}</p>
            </details>
          </div>
        ) : (
          <p className="min-w-0 whitespace-pre-wrap break-words font-medium">{shown}</p>
        )}
      </div>
      {kind === 'failed' && onRetry !== undefined && (
        <Button variant="default" loading={retrying} onClick={onRetry}>
          <RotateCw className="size-3.5" aria-hidden />
          もう一度送る
        </Button>
      )}
    </li>
  );
}
