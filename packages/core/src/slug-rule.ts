export const MEMORY_SLUG_RULE = {
  maxLength: 128,
  pattern: /^[a-z0-9][a-z0-9._-]*$/,
  message: 'slug は英小文字・数字・. _ - のみ',
} as const;

// 記憶と共通の定数にしない: 片方を緩めても黙って道連れにならないため
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

export function describeSlugViolation(slug: string, rule: SlugRule): string | null {
  if (slug.length === 0 || slug.length > rule.maxLength || !rule.pattern.test(slug)) {
    return `${rule.message}（先頭は英小文字か数字、1〜${String(rule.maxLength)}文字。渡されたのは ${JSON.stringify(slug)}）`;
  }
  return null;
}
