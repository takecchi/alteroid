import { z } from 'zod';

// 存在しない・壊れたカーソルは 400 で断る: 「判定できない」を黙って「先頭から」へ倒さないため。
// 実在検査はここでしない: 口ごとにデータが違い、`/approvals` のように比較で辿る口では要求すると続きが取れなくなる別の穴になるため。
// `offset` という名前を使わず `cursor` にする: 同じ名前が本文のオフセットと一覧のオフセットの2つの意味を持つ状態をこれ以上広げないため。
export function encodeCursor(payload: Record<string, string>): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

export class InvalidCursorError extends Error {
  constructor(message = 'カーソルが不正') {
    super(message);
    this.name = 'InvalidCursorError';
  }
}

export function decodeCursor<T extends z.ZodTypeAny>(raw: string, schema: T): z.infer<T> {
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw new InvalidCursorError();
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) throw new InvalidCursorError();
  return parsed.data;
}
