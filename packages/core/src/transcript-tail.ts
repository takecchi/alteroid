import { open } from 'node:fs/promises';
import { redactImagesInTranscriptYielding } from './transcript-image-redaction.js';

// UTF-8 は1字が最大4バイト。`maxChars` 字ぶんを必ず含められる幅に、行の頭を探す余裕を足す
const UTF8_MAX_BYTES_PER_CHAR = 4;
const WINDOW_MARGIN_BYTES = 64 * 1024;

export function initialTailWindowBytes(maxChars: number): number {
  return maxChars * UTF8_MAX_BYTES_PER_CHAR + WINDOW_MARGIN_BYTES;
}

async function readRange(
  handle: Awaited<ReturnType<typeof open>>,
  start: number,
  length: number,
): Promise<Buffer> {
  const buffer = Buffer.allocUnsafe(length);
  let filled = 0;
  while (filled < length) {
    const { bytesRead } = await handle.read(buffer, filled, length - filled, start + filled);
    if (bytesRead === 0) break;
    filled += bytesRead;
  }
  return buffer.subarray(0, filled);
}

/**
 * 生ログの末尾だけを読み、画像を伏せて返す。値は「全文を読んで `redactImagesInTranscriptYielding` へ通し、
 * 長ければ `slice(-(maxChars + 1))`」と同じになる（#5160）。
 *
 * 同じ値になる根拠は、画像を伏せる処理が `\n` で割った行ごとに独立で、行をまたぐ状態を持たないこと
 * （`redactImagesInTranscript` の `redactLine`）。末尾の行の並びを伏せた結果は、全文を伏せた結果の末尾と一致する。
 *
 * - ファイルの頭から読んでいなければ、最初の改行までの欠けた行を捨てる（途中から読んだ行は、JSON としても UTF-8 としても壊れうる）。
 * - 伏せた後の長さが `maxChars` 以下で、まだ頭まで読んでいなければ、幅を倍にして読み直す: 伏せると短くなり、
 *   `maxChars + 1` 字に届かないまま返すと全文を切った値より短くなるため。
 * - `bytesRead` は、読んだバイト数の合計（読み直した分を含む）。大きいファイルで全部を読んでいないことを歯が測る。
 */
export async function readRedactedTranscriptTail(
  path: string,
  maxChars: number,
  options: { initialWindowBytes?: number } = {},
): Promise<{ body: string; bytesRead: number }> {
  const handle = await open(path, 'r');
  try {
    const { size } = await handle.stat();
    let width = options.initialWindowBytes ?? initialTailWindowBytes(maxChars);
    let bytesRead = 0;
    for (;;) {
      const start = Math.max(0, size - width);
      const chunk = await readRange(handle, start, size - start);
      bytesRead += chunk.length;
      let text = chunk.toString('utf8');
      if (start > 0) {
        const newline = text.indexOf('\n');
        text = newline === -1 ? '' : text.slice(newline + 1);
      }
      const redacted = await redactImagesInTranscriptYielding(text);
      if (redacted.length > maxChars) return { body: redacted.slice(-(maxChars + 1)), bytesRead };
      if (start === 0) return { body: redacted, bytesRead };
      width *= 2;
    }
  } finally {
    await handle.close();
  }
}
