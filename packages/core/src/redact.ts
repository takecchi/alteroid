/**
 * 応答の本文・例外の文を、人の画面や stderr へ出せる形にする口
 * （issue #2418。`@alteroid/core/redact`）。
 *
 * ## なぜ別の口か（`mask-url.ts` などと同じ理由）
 *
 * `packages/api-client` は `@alteroid/core` を実行時の依存に持たず、
 * `packages/swr` 経由で **Web の画面も**読む。`@alteroid/core` 本体から値を
 * import すると、Node の組み込みと SDK を含む本体がブラウザのバンドルへ入る。
 * ここは `denial-input-head.ts`（と、それが読む `excerpt.ts` / `usage-probe.ts`
 * の型だけ）を再公開するだけで、**`process.env` を自分では読まない**——
 * 環境変数の値を伏せたいときは、呼ぶ側が `env` を渡す（Node の呼び出し側だけ。
 * ブラウザでは `undefined` を渡し、字面の規則だけを使う）。
 *
 * ## 伏せてから切る
 *
 * 先に切ると、切り口で割れたトークンの断片がどの規則にも合わずに残る
 * （`denial-input-head.ts` の doc）。{@link redactedExcerpt} はこの順を固定する。
 */

import { codePointBoundary } from './excerpt.js';
import { redactErrorText } from './denial-input-head.js';

export { redactErrorText, redactSecretsInText } from './denial-input-head.js';

/** 伏せ字を通す前に読む本文の上限。巨大な本文で走査が伸びないように。 */
export const REDACTED_EXCERPT_READ_LIMIT = 8192;

/**
 * `text` を {@link redactErrorText} で伏せてから `limit` 字に切る。
 * 切ったときは末尾に `…` を付ける（切っていないものと区別する）。
 *
 * - 読む長さは {@link REDACTED_EXCERPT_READ_LIMIT} まで。超えて読まなかった
 *   ぶんは「切った」に数える。
 * - 切り口はコードポイントの境界へ寄せる（絵文字の片割れを残さない）。
 *
 * @param env 値を伏せる対象の環境変数。ブラウザからは `undefined`。
 */
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
