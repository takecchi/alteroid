import { z } from 'zod';

import { decodeCursor, encodeCursor, type DecodeCursorResult } from './cursor-codec.js';
import type { AgentToken } from './token-pool.js';

// order 単体を錨にしない: order は一意ではなく、同値の行を飛ばしうるため。
// value を錨に入れない: カーソルは応答に平文で出るため。
// index.ts へ export しない: token_list にはカーソル付きの HTTP 対応物が無いため
const tokenCursorSchema = z.object({ id: z.string().min(1), order: z.number().int() });

export type TokenCursor = z.infer<typeof tokenCursorSchema>;

export function encodeTokenCursor(cursor: TokenCursor): string {
  return encodeCursor(cursor);
}

export type DecodeTokenCursorResult = DecodeCursorResult<TokenCursor>;

export function decodeTokenCursor(raw: string): DecodeTokenCursorResult {
  return decodeCursor(tokenCursorSchema, raw);
}

export function resolveTokenCursor(
  entries: readonly AgentToken[],
  cursorRaw: string | undefined,
): { kind: 'ok'; view: AgentToken[] } | { kind: 'malformed' } {
  if (cursorRaw === undefined) return { kind: 'ok', view: [...entries] };
  const decoded = decodeTokenCursor(cursorRaw);
  if (!decoded.ok) return { kind: 'malformed' };
  const { id, order } = decoded.cursor;
  const index = entries.findIndex((entry) => entry.id === id);
  if (index !== -1) return { kind: 'ok', view: entries.slice(index + 1) };
  // `>` にしない: 錨と同じ order を持つ別の行が静かに飛ぶため
  return { kind: 'ok', view: entries.filter((entry) => entry.order >= order) };
}
