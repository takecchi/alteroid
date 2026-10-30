import type { ReactNode } from 'react';

import { Button } from '@alteroid/ui';

import { LoadError } from '~/components/load-error';

// 出すかどうかは呼び元が決める: ListDetail は listFooter が undefined でないと枠（border-t）を描くため、この部品は常に枠ごと描く。
// `notice` は読み込みの案内の前に置く行（p）。
export function OlderFooter({
  noun,
  unit,
  loadedCount,
  hasMore,
  loading,
  error,
  onLoadOlder,
  notice,
}: {
  noun: string;
  unit: string;
  loadedCount: number;
  hasMore: boolean;
  loading: boolean;
  error: unknown;
  onLoadOlder: () => unknown;
  notice?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2 px-4 py-2">
      {notice}
      <LoadError
        what={`もっと古い${noun}`}
        error={error}
        onRetry={onLoadOlder}
        retrying={loading}
      />
      {hasMore && (
        <>
          <p className="text-[11px] text-muted-foreground">
            いま読んでいるのは {loadedCount} {unit}ぶん。これより古い{noun}があるかもしれない。
          </p>
          <Button variant="default" size="sm" loading={loading} onClick={onLoadOlder}>
            {`もっと古い${noun}を読む`}
          </Button>
        </>
      )}
    </div>
  );
}
