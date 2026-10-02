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
 * 受け取ってからの経過（＝齢）を「N分前」の形まで。実体は core
 * （`packages/core/src/format-elapsed.ts`）に引き上げた——進捗の文（`describeProgress`）を
 * クローンの道具と共有するため。字面・分岐・doc は逐語のまま移した。
 */
export { formatElapsedAgo } from '@alteroid/core';

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

/**
 * 読めない行（`GET /permission-grants` / `GET /access` の `rowsUnreadable`。issue #2536）の断り。
 * 0件・無いときは空文字。
 *
 * **「消えたのではなく、読めない形で入っている」と言う**（トークンの `describeRowsUnreadable` と
 * 同じ向き）。行の中身は出さない（デーモンが返さない。id と不正な欄名だけ）。`count` が
 * `rows` より多いぶんは id が取れない行で、`removeCommand` では消せない（手で直す）。
 */
export function describeUnreadableRowsList(params: {
  /** 「許可」「アカウント」。 */
  noun: string;
  /** 消す口（`alteroid permission remove-unreadable` など）。 */
  removeCommand: string;
  /** 手で直すファイル。 */
  file: string;
  rowsUnreadable: { count: number; rows: { id: string; reason: string }[] } | undefined;
}): string {
  const unreadable = params.rowsUnreadable;
  if (unreadable === undefined || unreadable.count === 0) return '';
  const lines = unreadable.rows.map((row) => `  id=${row.id}  ${row.reason}\n`);
  const noId = unreadable.count - unreadable.rows.length;
  return (
    `読めない${params.noun}の行が ${String(unreadable.count)} 件ある` +
    `（消えたのではなく、読めない形で入っている）。この一覧には載っていない:\n` +
    lines.join('') +
    (noId > 0
      ? `  （id が取れない行が ${String(noId)} 件。この口では消せない。${params.file} を手で直す）\n`
      : '') +
    (unreadable.rows.length > 0 ? `消すには、id を指す: ${params.removeCommand} <id>\n` : '')
  );
}
