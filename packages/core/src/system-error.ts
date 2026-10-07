import { z } from 'zod';

import { formatSystemErrorFacts, formatSystemErrorUnknownNote } from './system-error-format.js';

export const systemErrorFactsSchema = z.object({
  code: z.string(),
  // optional にする: SDK が包み直した回には errno / syscall が移されないため
  errno: z.number().optional(),
  syscall: z.string().optional(),
});

export type SystemErrorFacts = z.infer<typeof systemErrorFactsSchema>;

// '' や 'unknown' で埋めない: 「取れなかった」と「取れて空だった」が同じ形になるため。
// 文字列でない code も undefined に倒す: 取れないものを取れた顔で出さないため
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

export function withSystemErrorNote(
  base: string,
  systemError: SystemErrorFacts | undefined,
): string {
  // systemError が無くても行を省かない: 止まったと確定した事象について「分類が取れなかった」は実在する観測結果で、省くと読む側が「器の資源ではなかった」と読むため
  if (systemError === undefined) {
    return `${base}\n（分類: ${SYSTEM_ERROR_UNKNOWN_NOTE}）`;
  }
  return `${base}\n（分類: 器の資源で落ちた可能性 —— ${formatSystemErrorFacts(systemError)}）`;
}

// 「分類が取れなかった」とだけ書かない: 枠（429）で落ちた回にも出て、読む側が本文の枠の文言まで何も分からないと読むため
export const SYSTEM_ERROR_UNKNOWN_NOTE = formatSystemErrorUnknownNote(' lastFailure を見ること');

export { formatSystemErrorFacts };
