// 記憶とやり方の「名前」の形。新しい名前の入力欄（NewSlugForm）と、詳細の画面が URL の名前を取得の前に見る所が、同じ規則を使う
const SLUG_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
const SLUG_MAX_LENGTH = 128;

export function isValidSlug(slug: string): boolean {
  return SLUG_PATTERN.test(slug) && slug.length <= SLUG_MAX_LENGTH;
}

export const SLUG_USABLE_FORM =
  '使えるのは半角の英小文字・数字と . _ - で、先頭は英数字。128 文字まで。';
