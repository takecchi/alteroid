/**
 * 記憶・やり方の slug の規則（純粋な定数と関数だけ。`@alteroid/core/cli-light` からも出す）。
 *
 * **規則の持ち主はここである。** `memorySlugSchema` / `practiceSlugSchema`（`schema.ts`）は
 * この定数から作り、CLI は一時ファイルを作る前（`memory edit` / `practice edit`）に
 * `describeSlugViolation` で同じ規則を通す（#3728）。zod を読まないので CLI の起動を重くしない。
 *
 * 記憶とやり方を別の定数にしてあるのは意図である（`practiceSlugSchema` の doc）。
 * 今は同じ値だが、片方を緩めても黙って道連れにならない。
 */
export const MEMORY_SLUG_RULE = {
  maxLength: 128,
  pattern: /^[a-z0-9][a-z0-9._-]*$/,
  message: 'slug は英小文字・数字・. _ - のみ',
} as const;

export const PRACTICE_SLUG_RULE = {
  maxLength: 128,
  pattern: /^[a-z0-9][a-z0-9._-]*$/,
  message: 'slug は英小文字・数字・. _ - のみ',
} as const;

interface SlugRule {
  readonly maxLength: number;
  readonly pattern: RegExp;
  readonly message: string;
}

/** 規則に合わなければ、使える形を言う文。合えば null。 */
export function describeSlugViolation(slug: string, rule: SlugRule): string | null {
  if (slug.length === 0 || slug.length > rule.maxLength || !rule.pattern.test(slug)) {
    return `${rule.message}（先頭は英小文字か数字、1〜${String(rule.maxLength)}文字。渡されたのは ${JSON.stringify(slug)}）`;
  }
  return null;
}
