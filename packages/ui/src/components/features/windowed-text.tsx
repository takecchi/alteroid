import { useState } from 'react';

import { cn } from '@/lib/utils';

import { Button } from '../common';

export const WINDOWED_TEXT_CHUNK_CHARS = 100_000;

export function cutAt(text: string, from: number, limit: number): number {
  const hard = from + limit;
  if (hard >= text.length) return text.length;
  const newline = text.lastIndexOf('\n', hard - 1);
  return newline >= from + limit / 2 ? newline + 1 : hard;
}

// 伏せ字は切る前に全体へ一度だけ掛ける: 窓で切った後に掛けると、切れ目をまたぐ秘密（鍵のブロック等）を取りこぼすため
export function WindowedText({
  text,
  chunkChars = WINDOWED_TEXT_CHUNK_CHARS,
  totalNote,
  testId,
  className,
}: {
  text: string;
  chunkChars?: number;
  totalNote?: string;
  testId?: string;
  className?: string;
}) {
  const [shown, setShown] = useState(() => cutAt(text, 0, chunkChars));
  const end = Math.min(shown, text.length);
  const done = end >= text.length;

  return (
    <div>
      <pre
        data-testid={testId}
        className={cn(
          'max-h-[32rem] overflow-auto rounded border border-border bg-background p-2 text-[11px] break-words whitespace-pre-wrap text-muted-foreground select-text',
          className,
        )}
      >
        {text.slice(0, end)}
      </pre>
      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span>
          {done
            ? `全体を表示しています（${totalNote ?? `${text.length.toLocaleString()} 文字`}）`
            : `先頭の ${end.toLocaleString()} 文字 / 全体 ${text.length.toLocaleString()} 文字を表示しています（長いので少しずつ出します）`}
        </span>
        {!done && (
          <Button size="sm" onClick={() => setShown(cutAt(text, end, chunkChars))}>
            続きを表示
          </Button>
        )}
      </div>
    </div>
  );
}
