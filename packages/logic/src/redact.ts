/**
 * 画面へ出す文字列を、描画の直前に伏せ字へ通す口。
 *
 * - {@link redactBody} —— 人や agent が書いた自由文（会話・委譲の生ログ・承認待ち・日誌の
 *   本文）。狭い網（`redactSecretsInBody`）なので、40桁の sha・UUID・枝名は化けない。
 * - {@link redactError} —— 例外・SSE の error の文。取りこぼしより誤伏せを選ぶ網
 *   （`redactErrorText`）で、切らない。
 *
 * **データではなく描画の側で掛ける。** 編集の下書きの初期値や回答欄の値は元のまま持つ
 * （伏せ字を人が再送する本文へ入れないため）。ブラウザに `process.env` は無いので env は
 * `undefined`。id・時刻・URL の欄には掛けない。
 *
 * `@alteroid/ui` は logic を import できないので、apps/web の `WebDisplayTextProvider`
 * （`apps/web/app/lib/display-text.tsx`）がこの2つを ui の部品へ渡す。
 */
import { redactErrorText, redactSecretsInBody } from '@alteroid/core/redact';

export function redactBody(text: string): string {
  return redactSecretsInBody(text, undefined);
}

export function redactError(text: string): string {
  return redactErrorText(text, undefined);
}
