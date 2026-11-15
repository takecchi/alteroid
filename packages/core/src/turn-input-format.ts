import type { JournalEntry } from './schema.js';

// `turn_input` を人が読む形にする（`journal_read` の1行と本文）。読むのは文字数・件数・識別子だけで、本文も注記の文面も行に無い。
export type TurnInputJournalEntry = Extract<JournalEntry, { type: 'turn_input' }>;

function n(value: number): string {
  return value.toLocaleString('en-US');
}

function ranked(record: Record<string, number>): string {
  return Object.entries(record)
    .sort((a, b) => b[1] - a[1])
    .map(([name, chars]) => `${name} ${n(chars)}`)
    .join(' / ');
}

export function describeTurnInputHead(entry: TurnInputJournalEntry): string {
  return (
    `[turn_input ${entry.kind} ${entry.triggers.join('+') || '?'}]` +
    ` 入力 ${n(entry.totalChars)} 字（本文 ${n(entry.bodyChars)}）`
  );
}

export function describeTurnInputBody(entry: TurnInputJournalEntry): string {
  const noticeTotal = Object.values(entry.notices).reduce((sum, chars) => sum + chars, 0);
  const lines = [
    `- 内訳: 本文 ${n(entry.bodyChars)} / 人間の操作 ${n(entry.humanActionsChars)} / ` +
      `記憶の載せ直し ${n(entry.freshMemoryChars)} / 断り書き ${n(noticeTotal)}`,
  ];
  if (Object.keys(entry.notices).length > 0) {
    lines.push(`- 断り書き（字）: ${ranked(entry.notices)}`);
  }
  if (entry.situationParts !== undefined) {
    lines.push(`- いまの全体の中身（字）: ${ranked(entry.situationParts)}`);
  }
  const shown = entry.signals.map(
    (signal) =>
      `${signal.kind}${signal.managerId === undefined ? '' : `(${signal.managerId})`} ${n(signal.chars)}`,
  );
  const omitted =
    entry.signalsOmitted === undefined ? '' : `（ほか ${n(entry.signalsOmitted)} 件は省略）`;
  lines.push(
    `- 合図の本文（字。切る前）: ${shown.length === 0 ? 'なし' : shown.join(' / ')}${omitted}`,
  );
  if (entry.templates !== undefined) {
    lines.push(`- 本文の中の定型（字）: ${ranked(entry.templates)}`);
  }
  lines.push(
    `- 枠組み（導出値。切り詰めがあると小さく出る）: ${n(entry.framingChars)} 字` +
      (entry.attachments === 0 ? '' : `・添付 ${n(entry.attachments)} 件`),
  );
  return lines.join('\n');
}
