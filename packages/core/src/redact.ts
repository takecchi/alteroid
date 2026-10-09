// `@alteroid/core` 本体から import しない: Web の画面も読むので、Node の組み込みと SDK がブラウザのバンドルへ入る。`process.env` も自分では読まない。

import { codePointBoundary } from './excerpt.js';
import { redactErrorText } from './denial-input-head.js';

export { redactErrorText, redactSecretsInBody, redactSecretsInText } from './denial-input-head.js';

export const REDACTED_EXCERPT_READ_LIMIT = 8192;

// 伏せてから切る: 先に切ると、切り口で割れたトークンの断片がどの規則にも合わずに残る。
export function redactedExcerpt(
  text: string,
  limit: number,
  env: NodeJS.ProcessEnv | undefined,
): string {
  const readEnd = codePointBoundary(text, REDACTED_EXCERPT_READ_LIMIT);
  const redacted = redactErrorText(text.slice(0, readEnd), env);
  if (redacted.length <= limit && readEnd >= text.length) return redacted;
  return `${redacted.slice(0, codePointBoundary(redacted, limit))}…`;
}
