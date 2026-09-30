/**
 * CLI 共通の時刻整形（issue #2141 段1）。
 *
 * **ISO の文字列はそのまま残す。** 曖昧さが無く、コピーしてほかの道具へ渡せる
 * ——書き換えると表示の意味が変わる。ここが返すのは、その ISO の横に添える
 * 「どれだけ前か」の注釈だけである。
 *
 * 元は `apps/cli/src/chat.ts` の `/commitments` にだけあった実装
 * （`formatElapsedAgo(iso, now)`）を、ほかの一覧（`access` / `conversations` /
 * `runners` / `memory list` / `daemon status`）からも使えるようここへ引き
 * 上げた（#2141）。**`/commitments` の出力は1文字も変えていない** — 呼び先が
 * 変わっただけで、字面・分岐は逐語のまま移した。
 */

/**
 * 受け取ってから（あるいは、その時刻になってから）の経過（＝齢）を、
 * **「N分前」の形まで**返す。呼び出し側は括弧（`（${formatElapsedAgo(...)}）`）だけ
 * 持つ。
 *
 * **「前」をここが持つ理由（PR #2151 の欠陥）。** 単位だけを返して呼び出し側
 * が `${...}前` と書く形だと、読めない時刻で画面に `（不明前）` と出た。「前」を
 * 付けてよいのは読めた時刻のときだけで、それを知っているのはこの関数だけで
 * ある。読めないときは「前」の付かない `経過不明` を返す。
 *
 * **台帳は優先度も締切も持たない**ので、人間が急ぎ方を決める材料はこれだけで
 * ある。ISO の時刻だけを出すと、読むたびに引き算をさせることになる。
 *
 * 未来の時刻（時計のずれ）は 0 に丸める。ここで負の齢を出しても人間には直せ
 * ない。読めない ISO（パース不能）は「経過不明」——0分前のように読める値を
 * 作らない。
 *
 * **丸めは単位の上限を越えない。** `Math.round` だけだと 3570〜3599 秒が
 * `60分`、84,600〜86,399 秒が `24時間` になっていた（次の単位へ上がるのは境目
 * ちょうど）。
 */
export function formatElapsedAgo(iso: string, now: number): string {
  const at = new Date(iso).getTime();
  if (Number.isNaN(at)) return '経過不明';
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 3600) return `${Math.min(59, Math.round(seconds / 60))}分前`;
  if (seconds < 86_400) return `${Math.min(23, Math.round(seconds / 3600))}時間前`;
  return `${Math.round(seconds / 86_400)}日前`;
}

/**
 * 失敗した応答の本文から、デーモンが書いた理由（`{ error: string }`）を取り出す。
 * 読めなければ `null`（**黙って空文字を返さない** — 理由が無いのと読めないのを混ぜない）。
 *
 * `chat.ts` の `errorDetail`（PR #2175 / issue #2172）の、状態コードを別に持つ口向けの
 * 対。あちらは「理由か、読めなかった旨」を1本の文で返し、こちらは既存の文言（状態
 * コード入り）の後ろへ理由を足すために「読めたか」を区別して返す。
 */
export async function errorReason(response: {
  json: () => Promise<unknown>;
}): Promise<string | null> {
  try {
    const body: unknown = await response.json();
    if (typeof body === 'object' && body !== null && 'error' in body) {
      const { error } = body as { error?: unknown };
      if (typeof error === 'string' && error.length > 0) return error;
    }
  } catch {
    // 本文が JSON でない（プロキシの HTML 等）、または読めない。理由なしへ倒す。
  }
  return null;
}

/** 既存の文言（状態コード入り）の後ろへ、読めたときだけデーモンの理由を足す。 */
export async function withErrorReason(
  message: string,
  response: { json: () => Promise<unknown> },
): Promise<string> {
  const reason = await errorReason(response);
  return reason === null ? message : `${message}: ${reason}`;
}
