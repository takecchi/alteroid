import { existsSync, readFileSync } from 'node:fs';

// 固定の `sleep` にしない: 待つ長さを決め打ちにすると、CI が混んで遅いときに書き終わっていない状態を「届いていない」と誤読むため
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

export function controlResponseDelivered(content: string, requestId = 'ask-1'): boolean {
  return content.includes(`GOT_CONTROL_RESPONSE request_id=${requestId}`);
}
