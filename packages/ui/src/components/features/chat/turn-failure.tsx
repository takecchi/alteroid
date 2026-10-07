import { AlertTriangle, RotateCw } from 'lucide-react';
import type { ReactNode } from 'react';

import { Alert, AlertDescription } from '@/components/ui/alert';
import { useDisplayText } from '@/lib/display-text';
import { cn } from '@/lib/utils';

import { Button } from '../../common';

export type TurnFailureKind = 'auth' | 'quota' | 'other';

// 種類を構造で運ぶ口が `error` イベントに無い（`message` 1本、#3953）ので、デーモンが組む
// `結果なしで終了: <code>（<via>） / <本文>` の頭の印だけを読む。本文の自由文は見ない:
// ツールの出力・件数・ディスクの quota などの 401 / quota で誤った案内が出るため。
// `overloaded` を `quota` に入れない: サーバ側の一時的な混雑で、利用者の上限ではないため
const FAILURE_HEAD =
  /^結果なしで終了: ([^\s（）]+)（(assistant_error|result_subtype|result_is_error)） \/ ([\s\S]*)$/;

const ASSISTANT_ERROR_KIND: Record<string, TurnFailureKind> = {
  authentication_failed: 'auth',
  billing_error: 'quota',
  rate_limit: 'quota',
};

// 本文の先頭が SDK の固定文のときだけ。途中に現れる語では決めない
const AUTH_TEXT_HEAD =
  /^(not logged in|invalid (api key|bearer token|x-api-key)|oauth token (has )?(expired|revoked)|invalid authentication credentials)/i;
const QUOTA_TEXT_HEAD = /^you['’]ve hit your .{0,80}limit/i;

function kindOfText(text: string): TurnFailureKind {
  const trimmed = text.trimStart();
  if (AUTH_TEXT_HEAD.test(trimmed)) return 'auth';
  if (QUOTA_TEXT_HEAD.test(trimmed)) return 'quota';
  return 'other';
}

export function classifyTurnFailure(message: string): TurnFailureKind {
  const head = FAILURE_HEAD.exec(message);
  if (head === null) return kindOfText(message);
  const [, code = '', via = '', body = ''] = head;
  if (via === 'assistant_error') return ASSISTANT_ERROR_KIND[code] ?? kindOfText(body);
  // `<subtype>/<HTTP の状態番号>`（SDK の `api_error_status`）
  const status = /\/(\d{3})$/.exec(code)?.[1];
  if (status === '401') return 'auth';
  if (status === '429') return 'quota';
  return kindOfText(body);
}

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
  message,
  action,
  className,
}: {
  message: string;
  action?: (kind: TurnFailureKind) => ReactNode;
  className?: string;
}) {
  const display = useDisplayText();
  const kind = classifyTurnFailure(message);
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
  text,
  onRetry,
  retrying = false,
}: {
  kind: 'failed' | 'held';
  text: string;
  onRetry?: () => void;
  retrying?: boolean;
}) {
  const { body } = useDisplayText();
  const shown = body(text);
  return (
    <li
      data-turn-failure={kind}
      className="flex min-w-0 flex-col items-start gap-2 border-l-4 border-destructive bg-destructive/5 py-2 pl-3 pr-2 text-sm"
    >
      <div className="flex min-w-0 max-w-[46rem] items-start gap-2 text-destructive">
        <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
        {kind === 'failed' ? (
          <div className="min-w-0 break-words">
            <p className="font-medium">この発言には返事を作れませんでした。</p>
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
