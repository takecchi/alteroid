import type { AgentToolAuditFailureRecord } from './agent-hooks.js';
import { redactErrorText } from './denial-input-head.js';
import { clipWithEllipsis, excerptLine } from './excerpt.js';

// 切らずに残さない: `error` は上限の無い自由文で、巨大な失敗メッセージが日誌の1行を埋め尽くしうるため
export const TOOL_USE_FAILURE_ERROR_EXCERPT = 500;

// 欄ごとに上限を持つ: 全体は 500 字で切るので、長いコマンド（heredoc のスクリプトなど）が後ろの出力（落ちた理由）を押し出さないため。合わせて 500 字に収まる
export const COMMAND_FAILURE_HEAD_CHARS = { command: 120, cwd: 100, output: 200 } as const;

/**
 * `tool_use_failure` の note の `error=` に載せる文。伏せてから切る（Claude の Bash の失敗と同じ順）。
 * `commandFailure` を持つ記録（Codex の `commandExecution`）は、コマンド・cwd・出力の先頭を欄ごとに伏せて切り、`error` の後ろへ足す。
 */
export function toolFailureErrorText(
  record: AgentToolAuditFailureRecord,
  env: NodeJS.ProcessEnv,
  alwaysSecretValues: readonly string[],
): string {
  if (typeof record.error !== 'string') return '(不明)';
  const redact = (text: string): string => redactErrorText(text, env, alwaysSecretValues);
  const head = (text: string, limit: number): string =>
    clipWithEllipsis(redact(text).replace(/\s+/g, ' ').trim(), limit);
  const parts = [redact(record.error)];
  const detail = record.commandFailure;
  if (detail?.command !== undefined)
    parts.push(`コマンド=${head(detail.command, COMMAND_FAILURE_HEAD_CHARS.command)}`);
  if (detail?.cwd !== undefined)
    parts.push(`cwd=${head(detail.cwd, COMMAND_FAILURE_HEAD_CHARS.cwd)}`);
  if (detail?.output !== undefined) {
    const output = head(detail.output, COMMAND_FAILURE_HEAD_CHARS.output);
    parts.push(`出力=${output === '' ? '(空)' : output}`);
  }
  return excerptLine(parts.join('・'), TOOL_USE_FAILURE_ERROR_EXCERPT);
}
