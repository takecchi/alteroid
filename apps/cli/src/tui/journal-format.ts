import { formatDateTime, summarizeJournalEntry as summarizeLogic } from '@alteroid/logic';
import { codePointBoundary } from '@alteroid/core/cli-light';
import type { JournalEntry } from '@alteroid/core';

import { JOURNAL_DETAIL_CHARS } from './journal-window.js';
import { redactBody, sanitizeForTerminal } from '../redact.js';

export type JournalType = JournalEntry['type'];

// 欄の形が合わない行・知らない種別で画面を落とさない: logic の側は例外を投げるか `undefined` を返すため
export function summarizeJournalEntry(entry: JournalEntry): string {
  try {
    const text: string | undefined = summarizeLogic(entry);
    if (typeof text === 'string') return redactBody(text);
  } catch {
    return '（要旨を作れなかった。全文は Enter で読める）';
  }
  const unknown: { type: string } = entry;
  return sanitizeForTerminal(`（この画面が知らない種別: ${unknown.type}）`);
}

export function oneLine(text: string, limit: number): string {
  const single = text.replace(/\s+/g, ' ').trim();
  return single.length > limit ? `${single.slice(0, codePointBoundary(single, limit))}…` : single;
}

// 一覧 1 行の要旨に字数の上限を置く: 長い本文を毎フレーム渡さないため
export const SUMMARY_LIMIT = 300;

export function journalListLine(entry: JournalEntry, now: number): string {
  // 組み立てたあとで掃除する: 種別・時刻は redactBody を通らない欄のため
  return sanitizeForTerminal(
    `${formatDateTime(entry.at, now)} [${entry.type}] ${oneLine(summarizeJournalEntry(entry), SUMMARY_LIMIT)}`,
  );
}

export function filterText(types: readonly JournalType[], q: string): string {
  const parts: string[] = [];
  if (types.length > 0) parts.push(`type=${types.join(',')}`);
  if (q !== '') parts.push(`「${q}」`);
  return parts.length === 0 ? 'すべて' : parts.join(' ');
}

// 絞った結果の 0 件を、絞っていないときの 0 件と同じ文言で出さない
export function journalEmptyMessage(types: readonly JournalType[], q: string): string {
  const typeLabel = types.length > 0 ? `type=${types.join(',')}` : undefined;
  if (typeLabel === undefined && q === '') return 'この条件では何も記録されていない。';
  if (typeLabel === undefined) return `「${q}」に当たる記録は無い（この条件の中では）。`;
  if (q === '') return `${typeLabel} に当たる記録は無い（絞り込みを外せば見えるかもしれない）。`;
  return `${typeLabel} に絞った上で、「${q}」に当たる記録は無い（絞り込みを外せば見えるかもしれない）。`;
}

// JSON のまま出さない: 改行が `\n` で潰れて読めないため
export function journalDetailText(entry: JournalEntry): string {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(entry as unknown as Record<string, unknown>)) {
    if (key === 'type' || key === 'id' || key === 'at') continue;
    if (typeof value === 'string') {
      lines.push(value.includes('\n') ? `${key}:\n${indent(value)}` : `${key}: ${value}`);
    } else {
      const json = JSON.stringify(value, null, 2) ?? String(value);
      lines.push(json.includes('\n') ? `${key}:\n${indent(json)}` : `${key}: ${json}`);
    }
  }
  const text = redactBody(lines.join('\n'));
  return text.length > JOURNAL_DETAIL_CHARS
    ? `${text.slice(0, codePointBoundary(text, JOURNAL_DETAIL_CHARS))}\n…（全 ${String(text.length)} 字のうち先頭 ${String(JOURNAL_DETAIL_CHARS)} 字だけ）`
    : text;
}

function indent(text: string): string {
  return text
    .split('\n')
    .map((line) => `  ${line}`)
    .join('\n');
}
