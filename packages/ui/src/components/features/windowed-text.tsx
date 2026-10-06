import { useState } from 'react';

import { cn } from '@/lib/utils';

import { Button } from '../common';

/** 1回に出す文字数。退避の本文の画面（`archive-detail.tsx`）と同じ。 */
export const WINDOWED_TEXT_CHUNK_CHARS = 100_000;

/** `limit` 文字以内で、できれば行の切れ目（改行の直後）まで。切れ目が窓の半分より前にしか無ければ硬く切る。 */
export function cutAt(text: string, from: number, limit: number): number {
  const hard = from + limit;
  if (hard >= text.length) return text.length;
  const newline = text.lastIndexOf('\n', hard - 1);
  return newline >= from + limit / 2 ? newline + 1 : hard;
}

/**
 * 長い文字列を、先頭から窓で区切って出す `<pre>`。「続きを表示」で窓を伸ばす。
 *
 * **数 MB になりうる生ログを一度に DOM へ載せない**ための部品。**`text` は呼び手が伏せ字を
 * 掛け終えたもの**を渡す（この層は `@alteroid/logic` を知らない）。**伏せ字は切る前に全体へ
 * 一度だけ掛けること** — 窓で切った後に掛けると、切れ目をまたぐ秘密（鍵のブロック等）を
 * 取りこぼす。呼び手は `useMemo` で、元のデータが変わったときだけ計算し直す。
 *
 * `text` が取り直しで入れ替わっても、使い手が広げた窓は縮めない（上限だけ `text` の長さへ詰める）。
 * 窓の末尾が行の途中でも、`text` が伸びたあとに表示範囲が勝手に動くことはない。
 */
export function WindowedText({
  text,
  chunkChars = WINDOWED_TEXT_CHUNK_CHARS,
  totalNote,
  testId,
  className,
}: {
  /** 伏せ字を掛け終えた全文。 */
  text: string;
  chunkChars?: number;
  /** 全部を出し終えたときに「全体を表示しています（…）」の括弧へ入れる文（例: 使用量）。既定は文字数。 */
  totalNote?: string;
  testId?: string;
  /** `<pre>` の class。 */
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
