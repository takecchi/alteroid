import { z } from 'zod';

import { cursorCodec } from './cursor-codec.js';
import type { RunnerOverview } from './manager.js';

/**
 * 錨は `label` 単体にする。`runnerId` は器が名乗るまで `undefined` なので、錨にすると
 * 継続点が組めなくなる。`index.ts` へは export しない（`runner_list` に HTTP 対応物が無い）。
 */
const runnerCursorSchema = z.object({ label: z.string().min(1) });

export type RunnerCursor = z.infer<typeof runnerCursorSchema>;

/** decode は実在検査をしない: 「壊れた cursor」と「消えた器」を同じ文言に潰さないため。 */
export const { encode: encodeRunnerCursor, decode: decodeRunnerCursor } =
  cursorCodec(runnerCursorSchema);

export type ResolvedRunnerCursor =
  { kind: 'ok'; view: RunnerOverview[]; restarted: boolean } | { kind: 'malformed' };

/**
 * 錨が消えていたら先頭から全部を出し直す（`restarted`）。並びは登録順の `Map` で、
 * 比較に使える鍵が無く、1台も落とさないと言い切れる出し方がこれしか無いから。
 * 壊れた cursor を黙って先頭からへ倒さない（呼び手が同じ器を繰り返し読む）。
 */
export function resolveRunnerCursor(
  entries: readonly RunnerOverview[],
  cursorRaw: string | undefined,
): ResolvedRunnerCursor {
  if (cursorRaw === undefined) return { kind: 'ok', view: [...entries], restarted: false };
  const decoded = decodeRunnerCursor(cursorRaw);
  if (!decoded.ok) return { kind: 'malformed' };
  const index = entries.findIndex((entry) => entry.label === decoded.cursor.label);
  if (index !== -1) return { kind: 'ok', view: entries.slice(index + 1), restarted: false };
  return { kind: 'ok', view: [...entries], restarted: true };
}
