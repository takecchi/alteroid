export { formatElapsedAgo } from '@alteroid/core/cli-light';
import { redactError } from './redact.js';

export async function errorReason(response: {
  json: () => Promise<unknown>;
}): Promise<string | null> {
  try {
    const body: unknown = await response.json();
    if (typeof body === 'object' && body !== null && 'error' in body) {
      const { error } = body as { error?: unknown };
      if (typeof error === 'string' && error.length > 0) return redactError(error);
    }
  } catch {
    // 空文字を返さない: 理由が無いのと読めないのを混ぜないため
  }
  return null;
}

export async function withErrorReason(
  message: string,
  response: { json: () => Promise<unknown> },
): Promise<string> {
  const reason = await errorReason(response);
  return reason === null ? message : `${message}: ${reason}`;
}

export function describeUnreadableRowsList(params: {
  noun: string;
  removeCommand: string;
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
