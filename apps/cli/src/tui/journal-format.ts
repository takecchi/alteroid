/**
 * 日誌 1 件の文言（一覧の 1 行・詳細の本文）。純粋（I/O 無し）。
 *
 * 要旨（`summarizeJournalEntry`）と時刻（`formatDateTime`）の規則は Web と共有の
 * `@alteroid/logic` のものをそのまま使う（#2558。以前は写しだった）。ここに残すのは TUI だけの事情:
 * 欄の形が合わない行・知らない種別で画面を落とさない包み（下の `summarizeJournalEntry`）、
 * 絞り込みの並び・色・検索の断り・頁の大きさも `@alteroid/logic` の定数をそのまま読む（呼ぶ側が直接 import する）、
 * 一覧の 1 行・詳細の本文の組み立て。
 */
import { formatDateTime, summarizeJournalEntry as summarizeLogic } from '@alteroid/logic';
import { codePointBoundary, type JournalEntry } from '@alteroid/core';

import { JOURNAL_DETAIL_CHARS } from './journal-window.js';
import { redactBody } from '../redact.js';

export type JournalType = JournalEntry['type'];

/**
 * 日誌エントリを人間が読む 1 行に潰す。文言は logic の `summarizeJournalEntry`（Web と同じ）。
 * **TUI だけの包み:** 欄の形が合わない行（古い形・壊れた行）と、知らない種別（新しいデーモンが流した種別を
 * 古い画面が受ける）で画面を落とさない — logic の側は例外を投げるか `undefined` を返すので、ここで受ける。
 * 種別と id は一覧の別の欄に出ている。
 */
export function summarizeJournalEntry(entry: JournalEntry): string {
  try {
    const text: string | undefined = summarizeLogic(entry);
    if (typeof text === 'string') return redactBody(text);
  } catch {
    return '（要旨を作れなかった。全文は Enter で読める）';
  }
  const unknown: { type: string } = entry;
  return `（この画面が知らない種別: ${unknown.type}）`;
}

/**
 * 改行と連続する空白を 1 つの空白にし、`limit` 字で切る（切ったら `…`）。
 * 切り口は補助面の文字（絵文字など）を割らない位置へ寄せる（#2592）。
 */
export function oneLine(text: string, limit: number): string {
  const single = text.replace(/\s+/g, ' ').trim();
  return single.length > limit ? `${single.slice(0, codePointBoundary(single, limit))}…` : single;
}

/** 一覧 1 行の要旨の字数の上限（端末の幅でさらに切られる）。長い本文を毎フレーム渡さない。 */
export const SUMMARY_LIMIT = 300;

/** 一覧の 1 行（選択の印は付けない）。 */
export function journalListLine(entry: JournalEntry, now: number): string {
  return `${formatDateTime(entry.at, now)} [${entry.type}] ${oneLine(summarizeJournalEntry(entry), SUMMARY_LIMIT)}`;
}

/** 絞りの表示（0 件の文言とタイトルで使う）。 */
export function filterText(types: readonly JournalType[], q: string): string {
  const parts: string[] = [];
  if (types.length > 0) parts.push(`type=${types.join(',')}`);
  if (q !== '') parts.push(`「${q}」`);
  return parts.length === 0 ? 'すべて' : parts.join(' ');
}

/**
 * 0 件のときの文言。**絞った結果の 0 件を、絞っていないときの 0 件と同じ文言で出さない**
 * （Web の `journalEmptyMessage`、CLI `/journal` の `type=` 0 件と同じ扱い）。
 */
export function journalEmptyMessage(types: readonly JournalType[], q: string): string {
  const typeLabel = types.length > 0 ? `type=${types.join(',')}` : undefined;
  if (typeLabel === undefined && q === '') return 'この条件では何も記録されていない。';
  if (typeLabel === undefined) return `「${q}」に当たる記録は無い（この条件の中では）。`;
  if (q === '') return `${typeLabel} に当たる記録は無い（絞り込みを外せば見えるかもしれない）。`;
  return `${typeLabel} に絞った上で、「${q}」に当たる記録は無い（絞り込みを外せば見えるかもしれない）。`;
}

/**
 * 詳細の本文（全文）。上位の欄ごとに `名前: 値` で並べ、文字列は改行を保ったまま字下げして出す
 * （JSON のままだと改行が `\n` で潰れて読めない）。文字数の予算を超えたら省いた字数を言う。
 */
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
