import { AlertTriangle } from 'lucide-react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/common';
import { useDisplayText } from '@/lib/display-text';
import { cn } from '@/lib/utils';

/**
 * 読み込み（GET）に失敗したときの帯。**何を読めなかったか・なぜ・どうすればを言う。**
 *
 * `ErrorNote`（`common.tsx`）は応答の素の文を1行で出すだけで、書き込みの失敗の脇に置く
 * 用途に残してある。**一覧・画面の本文を読めなかったときはこちらを使う。**
 *
 * - `title` —— 何を読めなかったか（「日報を読み込めませんでした」）。呼ぶ側が画面ごとに書く
 * - `summary` / `hint` —— 原因の要約と次の一手。分類は `@alteroid/logic` の `classifyLoadError`
 *   が持つ（この層は logic を import できないので文字列で受ける）
 * - `detail` —— 生の応答文。「詳細」を開いた先へ小さく出す。伏せ字は `DisplayTextProvider` が掛ける
 * - `onRetry` —— 省略すると「もう一度試す」を出さない。`swr` はこの層から import できないので
 *   取り直しは呼ぶ側が渡す（`mutate` など）。`retrying` の間は押せない
 *
 * **`className` は外側の枠に付く。** 帯そのものは枠の幅いっぱい（`w-full`）なので、
 * 余白（`m-4` など）は枠が受ける。帯へ直に余白を付けると、幅 100% に余白が足されて
 * 親の右端からはみ出す（#2798）。
 */
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
