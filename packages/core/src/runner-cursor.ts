import { z } from 'zod';

import type { RunnerOverview } from './manager.js';

/**
 * 錨は `label` 単体にする。`runnerId` は器が名乗るまで `undefined` なので、錨にすると
 * 継続点が組めなくなる。`index.ts` へは export しない（`runner_list` に HTTP 対応物が無い）。
 */
const runnerCursorSchema = z.object({ label: z.string().min(1) });

export type RunnerCursor = z.infer<typeof runnerCursorSchema>;

export function encodeRunnerCursor(cursor: RunnerCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

export type DecodeRunnerCursorResult = { ok: true; cursor: RunnerCursor } | { ok: false };

/** 実在検査はしない: 「壊れた cursor」と「消えた器」を同じ文言に潰さないため。 */
export function decodeRunnerCursor(raw: string): DecodeRunnerCursorResult {
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    return { ok: false };
  }
  const parsed = runnerCursorSchema.safeParse(json);
  if (!parsed.success) return { ok: false };
  return { ok: true, cursor: parsed.data };
}

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
