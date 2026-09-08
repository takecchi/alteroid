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
