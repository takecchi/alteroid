import { stripNul } from './nul-guard.js';

// `tools.ts` から切り出した（文言も判定も1文字も変えていない）: 道具と HTTP が同じ断り文を返す関数（`commitment-close-many.ts`）が、`tools.ts` を import すると循環するため。

// `.describe()` と断り文の両方から同じ関数を呼ぶ: 数値を2箇所へ手で書き写すと片方だけ直して食い違うため
export function formatIntRangeJa(range: { min?: number; max?: number }): string {
  const { min, max } = range;
  if (min !== undefined && max !== undefined) return `${min}以上${max}以下の整数`;
  if (min !== undefined) return `${min}以上の整数`;
  if (max !== undefined) return `${max}以下の整数`;
  return '整数';
}

// 入力スキーマ側（`.int()` / `.min()` 等）へ置かない: SDK の `tool()` がハンドラより前に検証し、英語の zod の JSON が `isError` で返って兄弟の欄と応答の形が食い違うため
export function describeIntRangeViolation(
  field: string,
  value: number | undefined,
  range: { min?: number; max?: number },
): string | null {
  if (value === undefined) return null;
  const { min, max } = range;
  const withinRange = (min === undefined || value >= min) && (max === undefined || value <= max);
  if (Number.isInteger(value) && withinRange) return null;
  return `${field} ${value} は使えない（${formatIntRangeJa(range)}のみ）。`;
}

export function formatStringLengthJa(range: { min?: number; max?: number }): string {
  const { min, max } = range;
  if (min !== undefined && max !== undefined) return `${min}文字以上${max}文字以下`;
  if (min !== undefined) return `${min}文字以上`;
  if (max !== undefined) return `${max}文字以下`;
  return '任意の長さ';
}

export function describeStringLengthViolation(
  field: string,
  value: string | undefined,
  range: { min?: number; max?: number },
): string | null {
  if (value === undefined) return null;
  const { min, max } = range;
  // NUL を落としてから数える: ストアや日誌は NUL を落として残すため、NUL だけの値が「1文字以上」を通って空として残る
  const length = stripNul(value).length;
  const withinRange = (min === undefined || length >= min) && (max === undefined || length <= max);
  if (withinRange) return null;
  return `${field} は使えない（${formatStringLengthJa(range)}のみ）。`;
}

export function describeBlankViolation(field: string, value: string | undefined): string | null {
  if (value === undefined) return null;
  if (stripNul(value).trim().length > 0) return null;
  return `${field} は使えない（空白だけの値は空と同じ。${formatStringLengthJa({ min: 1 })}のみ）。`;
}

export function formatArrayLengthJa(range: { min?: number; max?: number }): string {
  const { min, max } = range;
  if (min !== undefined && max !== undefined) return `${min}件以上${max}件以下`;
  if (min !== undefined) return `${min}件以上`;
  if (max !== undefined) return `${max}件以下`;
  return '任意の件数';
}

export function describeArrayLengthViolation(
  field: string,
  value: readonly unknown[] | undefined,
  range: { min?: number; max?: number },
): string | null {
  if (value === undefined) return null;
  const { min, max } = range;
  const withinRange =
    (min === undefined || value.length >= min) && (max === undefined || value.length <= max);
  if (withinRange) return null;
  return `${field} は使えない（${formatArrayLengthJa(range)}）。`;
}

export function describeStringArrayElementLengthViolation(
  field: string,
  value: readonly string[] | undefined,
): string | null {
  if (value === undefined) return null;
  const emptyIndex = value.findIndex((entry) => stripNul(entry).length === 0);
  if (emptyIndex === -1) return null;
  return (
    `${field} は使えない（${emptyIndex} 番目（0起点）が空文字。各要素とも` +
    `${formatStringLengthJa({ min: 1 })}）。`
  );
}
