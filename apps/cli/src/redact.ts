/**
 * 入口（CLI・TUI）が画面へ出す文字列に掛ける伏せ字の口（issue #2600）。
 *
 * デーモンは会話・委譲の生ログ・承認待ち・日誌を素のまま返す。だから出す側で通す。
 * 2つに分ける理由は `@alteroid/core/redact` の doc のとおり:
 * - 本文（人や agent が書いた自由文）: {@link redactBody}。sha・UUID・枝名を化かさない狭い網
 * - error の文（API の `error`・例外の message）: {@link redactError}。取りこぼしより誤伏せを選ぶ
 *
 * id・時刻・URL の欄には掛けない。
 *
 * **env は渡さない（Web と同じく字面の規則だけ）。** core の環境変数の値の網は、名前に
 * `AUTH` などを部分に含む変数（`GIT_AUTHOR_NAME` など）の値まで伏せるので、本文や error に
 * 出るオーナー名・repo 名が化ける。名前の規則は #1834 と一緒に決める（判断待ち）。
 */
import { redactErrorText, redactSecretsInBody } from '@alteroid/core/redact';

/** 本文（会話・委譲・承認待ち・日誌の自由文）。 */
export function redactBody(text: string): string {
  return redactSecretsInBody(text, undefined);
}

/** error の文。 */
export function redactError(text: string): string {
  return redactErrorText(text, undefined);
}

/** `unknown` の例外・値を error の文にして伏せる（`Error` なら message）。 */
export function redactedErrorMessage(error: unknown): string {
  return redactError(error instanceof Error ? error.message : String(error));
}
