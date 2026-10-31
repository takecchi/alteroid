import { decodeCursor as decodeCoreCursor, encodeCursor } from '@alteroid/core';
import type { z } from 'zod';

// 存在しない・壊れたカーソルは 400 で断る: 「判定できない」を黙って「先頭から」へ倒さないため。
// 実在検査はここでしない: 口ごとにデータが違い、`/approvals` のように比較で辿る口では要求すると続きが取れなくなる別の穴になるため。
// `offset` という名前を使わず `cursor` にする: 同じ名前が本文のオフセットと一覧のオフセットの2つの意味を持つ状態をこれ以上広げないため。
// 文字列にする・読み戻す部分は core の `cursor-codec.ts` と共通: ここは HTTP の口の都合（例外で断る）だけを持つ。
export { encodeCursor };

export class InvalidCursorError extends Error {
  constructor(message = 'カーソルが不正') {
    super(message);
    this.name = 'InvalidCursorError';
  }
}

export function decodeCursor<T extends z.ZodType>(raw: string, schema: T): z.output<T> {
  const decoded = decodeCoreCursor(schema, raw);
  if (!decoded.ok) throw new InvalidCursorError();
  return decoded.cursor;
}
