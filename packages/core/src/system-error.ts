import { z } from 'zod';

/**
 * 投げられた例外から、Node が構造として持っている失敗の分類を取り出す。
 *
 * ## なぜこれが要るのか
 *
 * `runner.ts` の `#read()` の catch は `String(error)` で人が読む一文を作り、それを
 * `closed` の `reason` として運ぶ。**語そのものは文字列にも残る** —— Node の `Error`
 * は `message` に `syscall` と `code` を織り込むので、実際に届いた一文は
 * `マネージャーのセッションが落ちた: Error: Failed to spawn Claude Code process: spawn …/claude EAGAIN`
 * の形で `EAGAIN` を含んでいた（クローンの受信箱での実測、2026-09-08）。
 *
 * **失われるのは語ではなく、判定できる形である。** 受け取った側に届くのは1本の文字列
 * だけなので、「枠（429）で落ちたのか、器の資源（`EAGAIN`）で落ちたのか」を決めるには
 * その文字列を解釈するしかなくなる。**それは `runner-protocol.ts` が別の欄
 * （`permission_denied` の `reason` / `reasonType`）について既に禁じている形である**
 * —— 逐語は `grep -Fn -- '**`reason` の文字列を解釈して分類し直さないこと。**' packages/core/src/runner-protocol.ts`。
 *
 * だから**発生点で分類を作る**。`reason` は人が読む一文のまま1文字も変えず、分類は
 * 別の構造化欄として並べて運ぶ（`sdk-failure.ts` の「検知は構造化された印だけで
 * 行う」と同じ作法）。
 *
 * ## SDK が包み直しても `code` は残る
 *
 * 起動そのものに失敗した回、SDK は元の spawn エラーを包み直した別の `Error` を投げる
 * が、**包んだ側にも `code` を付け直している**（`@anthropic-ai/claude-agent-sdk@0.3.263`
 * 同梱の `sdk.mjs`。`Error('Failed to spawn Claude Code process: …')` を作った直後に
 * `code` を含むメタデータを `Object.assign` する）。だから包み直された回でも
 * `error.code` は読める。**ただし `errno` / `syscall` は包んだ側へは移されない** ——
 * この2つが取れないことは普通に起こる。だから `.optional()` である。
 *
 * ## 「取れなかった」を値で埋めない
 *
 * `code` を持たない例外（素の `Error`、投げられた文字列）では**何も返さない**。
 * `''` や `'unknown'` で埋めると、**「取れなかった」と「取れて空だった」が同じ形に
 * なる**（`AGENTS.md`「取れない軸に 0 の行を作る」）。呼ぶ側は「欄が無い＝分類が
 * 取れなかった」と読めばよい。
 */
export const systemErrorFactsSchema = z.object({
  /** Node の `code`（`'EAGAIN'` / `'ENOENT'` など）。**言い換えない。** */
  code: z.string(),
  /** Node の `errno`（`EAGAIN` なら `-11`）。包み直された回には無い。 */
  errno: z.number().optional(),
  /** Node の `syscall`（`'spawn …'` など）。包み直された回には無い。 */
  syscall: z.string().optional(),
});

export type SystemErrorFacts = z.infer<typeof systemErrorFactsSchema>;

/**
 * 例外から `code` / `errno` / `syscall` を読む。**`code` が無ければ `undefined`。**
 *
 * `code` が文字列でない回（数値の `code` を持つ別系統のエラー）も `undefined` に
 * 倒す —— この欄が名乗るのは「Node が付けた文字列の分類」であって、「何か code
 * らしきものが在った」ではない。**取れないものを取れた顔で出さない。**
 */
export function systemErrorFactsOf(error: unknown): SystemErrorFacts | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const candidate = error as { code?: unknown; errno?: unknown; syscall?: unknown };
  if (typeof candidate.code !== 'string' || candidate.code.length === 0) return undefined;
  return {
    code: candidate.code,
    ...(typeof candidate.errno === 'number' ? { errno: candidate.errno } : {}),
    ...(typeof candidate.syscall === 'string' && candidate.syscall.length > 0
      ? { syscall: candidate.syscall }
      : {}),
  };
}

/**
 * `closed_failed` の受信箱本文へ、`event.systemError` を運ぶ（#713 段2）。
 *
 * ## 形は `usage-limits.ts` の `withRecoveryNote` に倣う
 *
 * `base`（＝ `event.reason`）を1文字も変えず、末尾に改行1本と1行を足すだけ。
 * `reason` は既に読んでいる側が居るので、意味を動かすと静かに壊れる
 * （`runner-protocol.ts` の `closed.reason` の doc が禁じる「`reason` の文字列を
 * 解釈して分類し直さないこと。」と同じ理由 —— 逐語は
 * `grep -Fn -- '**`reason` の文字列を解釈して分類し直さないこと。**' packages/core/src/runner-protocol.ts`）。
 *
 * ## `withRecoveryNote` と違い、`systemError` が無くても行を省かない
 *
 * `withRecoveryNote` は `recovery === 'unknown'` のとき何も足さない。ここでは
 * それを真似ない —— `AGENTS.md`「取れない軸に 0 の行を作る」の地雷は「**観測して
 * いない軸に、観測したふりの 0 を置くこと**」を禁じているのであって、この場合は
 * 事情が違う。`closed_failed` は「止まった」と**確定して観測されている**——確定
 * した事象について、器の資源で落ちたかどうかの分類の材料だけが無い、という状態
 * である。**これは「0の行」ではなく「この事象については分類が取れなかった」と
 * いう実在する観測結果であり、書くべき情報である。** 書かなければ、読む側は
 * 「systemError 無し」を「B（器の資源）ではなかった」と引き算で読む。
 *
 * ## D（分類が取れなかった）が A（枠）を飲み込まないこと
 *
 * 区別したいのは4つ —— A: 枠（429）で落ちた（`systemError` には乗らない。
 * `reason` 本文と `lastFailure` が持つ）／B: 器の資源で起動できなかった
 * （`systemError` が在る）／C: セッションが切れた（`selfFenced` の枝で早期
 * return されるのでここへ来ない）／D: この軸の材料が取れなかった（`code` を
 * 持たない例外・signal で畳まれた回）。
 *
 * **A と D はどちらも `systemError` が無い**（枠で落ちた回には `code` が付かない
 * ので、B の判定材料としては D と同じ「無い」に見える）。だから D の行を
 * 「分類が取れなかった」とだけ書くと、A で落ちた回にもその行が出て、読む側は
 * 「（A も含めて）何も分からない」と読んでしまう —— 実際には `reason` の本文に
 * `You've hit your …` のような枠の文言がそのまま入っている。**だから D の行は
 * 「器の資源による落ち方かどうかは、この欄では判定できなかった」の形にし、
 * 他の軸（枠・セッション切断）はこの欄の対象外であることと、本文 /
 * `lastFailure` を見るよう、行の中で明示する。** スコープを「器の資源の軸」
 * だけに絞ることで、A の情報（`reason` 本文）を上書きしない。
 *
 * ## 出す2形とも `code` / `errno` / `syscall` を言い換えない
 *
 * `systemError` が在る回は、SDK が出した `code` / `errno` / `syscall` をそのまま
 * 連ねる（人間が検索できる形で残す。要約や意訳をしない）。
 */
export function withSystemErrorNote(
  base: string,
  systemError: SystemErrorFacts | undefined,
): string {
  if (systemError === undefined) {
    return (
      `${base}\n` +
      '（分類: 器の資源による落ち方かどうかは、この欄では判定できなかった。' +
      '枠に当たった場合・セッションが切れた場合もこの欄には出ない —— ' +
      '本文と lastFailure を見ること）'
    );
  }
  const facts = [`code=${systemError.code}`];
  if (systemError.errno !== undefined) facts.push(`errno=${systemError.errno}`);
  if (systemError.syscall !== undefined) facts.push(`syscall=${systemError.syscall}`);
  return `${base}\n（分類: 器の資源で落ちた可能性 —— ${facts.join(' ')}）`;
}
