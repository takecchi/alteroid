import { classifyLoadError } from '@alteroid/logic';
import { LoadFailure } from '@alteroid/ui';

/**
 * 読み込み（GET）の失敗を出す。**「〇〇を読み込めませんでした」＋原因の要約＋「もう一度試す」。**
 *
 * - `what` —— 何を読めなかったか（「日報」「マネージャー一覧」）。画面ごとに書く
 * - `error` —— `undefined` なら何も出さない
 * - `onRetry` —— 取り直し（`useSWR` の `mutate` など）。分類が「取り直しても直らない」
 *   （403）のときはボタンを出さない
 * - `retrying` —— 取り直しの最中（`isValidating`）
 *
 * 要約の分類は `@alteroid/logic` の `classifyLoadError`、見た目は `@alteroid/ui` の
 * `LoadFailure`。**書き込みの失敗**は従来どおり `ErrorNote` を使う。
 */
export function LoadError({
  what,
  error,
  onRetry,
  retrying,
  className,
}: {
  what: string;
  error: unknown;
  onRetry?: () => unknown;
  retrying?: boolean;
  className?: string;
}) {
  if (error === undefined || error === null) return null;
  const info = classifyLoadError(error);
  return (
    <LoadFailure
      title={`${what}を読み込めませんでした`}
      summary={info.summary}
      hint={info.hint}
      detail={info.detail}
      onRetry={onRetry !== undefined && info.retryable ? () => void onRetry() : undefined}
      retrying={retrying ?? false}
      {...(className === undefined ? {} : { className })}
    />
  );
}
