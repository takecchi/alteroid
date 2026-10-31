import { z } from 'zod';

import { cursorCodec } from './cursor-codec.js';
import type { ScheduledRequest } from './schema.js';

const scheduleCursorSchema = z.object({ kind: z.string().min(1) });

export type ScheduleCursor = z.infer<typeof scheduleCursorSchema>;

export const { encode: encodeScheduleCursor, decode: decodeScheduleCursor } =
  cursorCodec(scheduleCursorSchema);

export function resolveScheduleCursor(
  entries: readonly ScheduledRequest[],
  cursorRaw: string | undefined,
): { kind: 'ok'; view: ScheduledRequest[] } | { kind: 'malformed' } {
  if (cursorRaw === undefined) return { kind: 'ok', view: [...entries] };
  const decoded = decodeScheduleCursor(cursorRaw);
  // 壊れた cursor を先頭からへ倒さない: 呼び手が同じ行を繰り返し読むため
  if (!decoded.ok) return { kind: 'malformed' };
  const pivotKind = decoded.cursor.kind;
  const index = entries.findIndex((entry) => entry.kind === pivotKind);
  if (index !== -1) return { kind: 'ok', view: entries.slice(index + 1) };
  // 比較は錨が消えたときだけにする: JS の文字列比較は pg の照合順序と一致する保証が無いため
  const view = entries.filter((entry) => entry.kind > pivotKind);
  return { kind: 'ok', view };
}
