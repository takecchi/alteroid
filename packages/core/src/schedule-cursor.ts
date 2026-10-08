import { z } from 'zod';

import type { ScheduledRequest } from './schema.js';

const scheduleCursorSchema = z.object({ kind: z.string().min(1) });

export type ScheduleCursor = z.infer<typeof scheduleCursorSchema>;

export function encodeScheduleCursor(cursor: ScheduleCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

export type DecodeScheduleCursorResult = { ok: true; cursor: ScheduleCursor } | { ok: false };

export function decodeScheduleCursor(raw: string): DecodeScheduleCursorResult {
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    return { ok: false };
  }
  const parsed = scheduleCursorSchema.safeParse(json);
  if (!parsed.success) return { ok: false };
  return { ok: true, cursor: parsed.data };
}

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
