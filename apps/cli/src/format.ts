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
 * 受け取ってから（あるいは、その時刻になってから）の経過（＝齢）。
 *
 * **台帳は優先度も締切も持たない**ので、人間が急ぎ方を決める材料はこれだけで
 * ある。ISO の時刻だけを出すと、読むたびに引き算をさせることになる。
 *
 * 未来の時刻（時計のずれ）は 0 に丸める。ここで負の齢を出しても人間には直せ
 * ない。読めない ISO（パース不能）は「不明」——0分前のように読める値を作らない。
 */
export function formatElapsed(iso: string, now: number): string {
  const at = new Date(iso).getTime();
  if (Number.isNaN(at)) return '不明';
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 3600) return `${Math.round(seconds / 60)}分`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}時間`;
  return `${Math.round(seconds / 86_400)}日`;
}
