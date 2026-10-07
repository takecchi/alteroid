import { classifyLoadError } from '@alteroid/logic';
import { LoadFailure } from '@alteroid/ui';

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
