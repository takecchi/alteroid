/**
 * CLI 共通の時刻整形（issue #2141 段1）。
 *
 * **ISO の文字列はそのまま残す。** 曖昧さが無く、コピーしてほかの道具へ渡せる
 * ——書き換えると表示の意味が変わる。ここが返すのは、その ISO の横に添える
 * 「どれだけ前か」の注釈だけである。
 *
 * 元は `apps/cli/src/chat.ts` の `/commitments` にだけあった実装
 * （`formatElapsed(iso, now)`）を、ほかの一覧（`access` / `conversations` /
 * `runners` / `memory list` / `daemon status`）からも使えるようここへ引き
 * 上げた（#2141）。**`/commitments` の出力は1文字も変えていない** — 呼び先が
 * 変わっただけで、字面・分岐は逐語のまま移した。
 */

/**
 * 受け取ってからの経過（＝齢）。実体は core（`packages/core/src/format-elapsed.ts`）に引き上げた
 * ——進捗の文（`describeProgress`）をクローンの道具と共有するため。字面・分岐は逐語のまま。
 */
export { formatElapsed } from '@alteroid/core';
