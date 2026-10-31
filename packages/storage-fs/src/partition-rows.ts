import { describeSkippedRow, summarizeInvalidFields, writeStderrLine } from '@alteroid/core';
import type { z } from 'zod';

// 載せるのは `keyName` の欄の値だけ: ほかの欄には人間の依頼文・トークン本体などがそのまま入りうるため。
// 読めない行は生のまま返す: 書き戻しに入れないと、人間が手で書いた不正な行が次の書き込みで黙って消えるため
export function partitionRows<T>(
  rows: readonly unknown[],
  schema: z.ZodType<T>,
  table: string,
  keyName = 'id',
): { valid: T[]; invalid: unknown[] } {
  const valid: T[] = [];
  const invalid: unknown[] = [];
  rows.forEach((raw, index) => {
    const result = schema.safeParse(raw);
    if (result.success) {
      valid.push(result.data);
      return;
    }
    invalid.push(raw);
    const value =
      typeof raw === 'object' && raw !== null
        ? (raw as Record<string, unknown>)[keyName]
        : undefined;
    writeStderrLine(
      `${describeSkippedRow(table, keyName, {
        index,
        reason: summarizeInvalidFields(result.error.issues),
        key: typeof value === 'string' ? value : undefined,
      })}\n`,
    );
  });
  return { valid, invalid };
}
