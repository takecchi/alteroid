import { classifyLoadError, formatBytes, formatDateTime } from '@alteroid/logic';
import { Badge, LoadFailure } from '@alteroid/ui';

// アーカイブの本文と生ログで同じ文言にする: 同じ「本文を消した」を画面ごとに違う言い方で出さないため
// ここに置く: 専用のファイルにすると、それだけで1本のチャンクが増えるため
export function RemovedBody({ removedAt, bytes }: { removedAt: string; bytes: number }) {
  return (
    <div className="p-4 text-sm">
      <Badge tone="warn">本文は削除済み</Badge>
      <p className="mt-2 text-muted-foreground">
        {formatDateTime(removedAt)} に本文を消しました（消した本文は {formatBytes(bytes)}）。
        一覧の行は残っていますが、中身は戻せません。
      </p>
    </div>
  );
}

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
