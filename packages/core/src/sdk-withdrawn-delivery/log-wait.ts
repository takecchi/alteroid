import { existsSync, readFileSync } from 'node:fs';

/**
 * `fake-cli.mjs` が終わる（`EXIT code=…` 行がログに出る）まで、上限付きで
 * ポーリングして待つ。**固定の `sleep` の代わりにこちらを使う** — 待つ長さを
 * 決め打ちにすると、CI が混んでいて遅いときにまだ書き終わっていない状態を
 * 「届いていない」と誤読む（レビュー指摘）。
 *
 * 正常系では `fake-cli.mjs` は SDK の `close()` が送る stdin の EOF を受けて
 * 即座に終わる（`STDIN_END` → `EXIT code=0`）。ここが返した内容の健全性
 * （保険の寿命ではなく stdin end で終わったか、ask を送ったか）は
 * {@link assertHealthyFakeCliExit} で別に確かめること — このポーリング自体は
 * 「プロセスが何らかの理由で終わった」としか言わない。
 */
export async function waitForFakeCliExit(logPath: string, timeoutMs = 5000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (existsSync(logPath)) {
      const content = readFileSync(logPath, 'utf8');
      if (content.includes('EXIT code=')) return content;
    }
    if (Date.now() >= deadline) {
      const content = existsSync(logPath) ? readFileSync(logPath, 'utf8') : '(ログがまだ無い)';
      throw new Error(
        `偽 CLI が ${timeoutMs}ms 以内に終了しなかった（stdin end も保険の寿命も来ていない）。` +
          `足場そのものが壊れている疑いが強い。ログ:\n${content}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/**
 * 偽 CLI のログが「正常系」であることを表明する——**この2つが揃っていなければ、
 * 後続の delivered/not-delivered の判定を「届いていない」の証拠として使わない
 * こと**（レビュー指摘: 偽 CLI が早く死んだ回を、足場の壊れではなく
 * 「正しく届かなかった」として誤って緑にしないため）。
 *
 * - ask を送った形跡（`ASK_SENT request_id=…`）がある
 * - `STDIN_END` で終わっている（`EXIT_BY_LIFETIME` という保険の寿命では
 *   ない——これが出た回は、settle → close() の前に偽 CLI が力尽きたか、
 *   何らかの理由で `close()` が呼ばれなかったことを意味する）
 */
export function assertHealthyFakeCliExit(content: string, askRequestId = 'ask-1'): void {
  if (!content.includes(`ASK_SENT request_id=${askRequestId}`)) {
    throw new Error(
      `偽 CLI が can_use_tool の ask を送った形跡が無い（足場が壊れている）。ログ:\n${content}`,
    );
  }
  if (content.includes('EXIT_BY_LIFETIME')) {
    throw new Error(
      '偽 CLI が stdin end ではなく保険の寿命（EXIT_BY_LIFETIME）で終わった——足場が壊れている ' +
        '（CI が混んでいて settle → close() の前に力尽きたか、close() が呼ばれなかった可能性がある）。' +
        `この回の「届いていない」は前提の裏付けとして使えない。ログ:\n${content}`,
    );
  }
  if (!content.includes('STDIN_END')) {
    throw new Error(`偽 CLI が STDIN_END を記録していない（足場が壊れている）。ログ:\n${content}`);
  }
}

/** その `request_id` への `control_response` が偽 CLI に届いたか。 */
export function controlResponseDelivered(content: string, requestId = 'ask-1'): boolean {
  return content.includes(`GOT_CONTROL_RESPONSE request_id=${requestId}`);
}
