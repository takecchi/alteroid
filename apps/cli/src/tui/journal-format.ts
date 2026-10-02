/**
 * 日誌 1 件の文言（一覧の 1 行・詳細の本文）。純粋（I/O 無し）。
 *
 * **要旨は Web の `summarizeJournalEntry`（`packages/swr/src/hooks/queries.ts`）と同じ文言**。
 * 写してあるのは、apps/cli から `@alteroid/swr` を引けない（react と swr を持ち込む）ためで、
 * 4 種の診断（`worker_wait` / `turn_usage` / `context_usage` / `inbox_flow`）は CLI `/journal`
 * と同じ共有の口（`@alteroid/core/journal-diagnostics-format`）から取る。**Web 側の文言を
 * 変えたらここも直すこと。**
 */
import {
  summarizeJournalDiagnosticsEntry,
  type JournalDiagnosticsEntryLike,
} from '@alteroid/core/journal-diagnostics-format';
import type { JournalEntry } from '@alteroid/core';

import { JOURNAL_DETAIL_CHARS } from './journal-window.js';

export type JournalType = JournalEntry['type'];

/** 種別ごとの見た目の強さ（Web の `TONE`）。`Record` で縛るので、種別が増えたら型で落ちる。 */
export type Tone = 'neutral' | 'ok' | 'warn' | 'danger' | 'accent';

const TONE: Record<JournalType, Tone> = {
  exchange: 'neutral',
  decision: 'accent',
  escalation: 'warn',
  tool_use: 'neutral',
  memory_update: 'ok',
  daily_report: 'accent',
  external_event: 'warn',
  worker_wait: 'neutral',
  turn_usage: 'neutral',
  context_usage: 'neutral',
  token_rotation: 'warn',
  subagent_stall: 'warn',
  inbox_flow: 'neutral',
};

/** 絞り込みに出す種別（Web のチップと同じ並び = `TONE` の宣言順）。 */
export const JOURNAL_TYPES = Object.keys(TONE) as [JournalType, ...JournalType[]];

export function toneOf(type: JournalType): Tone {
  return TONE[type];
}

/**
 * 日誌エントリを人間が読む 1 行に潰す。**欄の形が合わない行（古い形・壊れた行）で画面を落とさない**
 * — 要旨を作れなかったと言い、種別と id は一覧の別の欄に出ている。
 */
export function summarizeJournalEntry(entry: JournalEntry): string {
  try {
    return summarize(entry);
  } catch {
    return '（要旨を作れなかった。全文は Enter で読める）';
  }
}

function summarize(entry: JournalEntry): string {
  switch (entry.type) {
    case 'exchange':
      return `${entry.with} ${entry.role === 'inbound' ? '←' : '→'} ${entry.text}`;
    case 'decision':
      return `${entry.decision}（根拠: ${entry.grounds}）`;
    case 'escalation':
      // 取り下げを先に見る（`withdrawnAt` と `answeredAt` は両立しない）。
      if (entry.withdrawnAt !== undefined) return `取り下げ済み: ${entry.question}`;
      return entry.answeredAt === undefined
        ? `確認: ${entry.question}`
        : `回答済: ${entry.question}`;
    case 'tool_use':
      return `${entry.actor} が ${entry.tool}`;
    case 'memory_update': {
      // 取れない軸を 0 と見せない: 旧形式（バイト数なし）は「不明」と言う。
      const action = entry.action === undefined ? '' : `/${entry.action}`;
      const bytes =
        entry.bytesBefore === undefined || entry.bytesAfter === undefined
          ? '前後バイト数不明（旧形式）'
          : `${String(entry.bytesBefore)}→${String(entry.bytesAfter)} バイト`;
      return `記憶 ${entry.slug} を更新（${entry.cause}${action} / ${bytes}）: ${entry.summary}`;
    }
    case 'daily_report':
      // 印の付いた行を「日報」と呼ばない。
      return entry.unavailable === undefined
        ? `${entry.date} の日報`
        : `⚠ ${entry.date} の日報は作れなかった: ${entry.unavailable}`;
    case 'external_event':
      return `${entry.source}: ${entry.summary}`;
    case 'worker_wait':
    case 'turn_usage':
    case 'context_usage':
    case 'inbox_flow':
      return summarizeJournalDiagnosticsEntry(entry as unknown as JournalDiagnosticsEntryLike);
    case 'token_rotation':
      // 見出しの `event` は落とさない（`exhausted` と `not_rotated` を見分けられなくなる）。
      return `[${entry.event}] ${entry.text}`;
    case 'subagent_stall': {
      const agentType = entry.agentType === undefined ? '' : `/${entry.agentType}`;
      const outcome =
        entry.outcome === 'woken'
          ? `起こし直した（${String(entry.wakeupCount)}回目）`
          : `上限に達し、起こし直さなかった（要対応。既に${String(entry.wakeupCount)}回起こし直し済み）`;
      return (
        `作業者 ${entry.agentId}${agentType} が自分で起こした背景処理を ` +
        `${String(entry.ownedTaskCount)}件 残したまま畳もうとした（セッション全体 ${String(entry.sessionTaskCount)}件）: ` +
        outcome
      );
    }
    default: {
      // 知らない種別（新しいデーモンが流した種別を古い画面が受ける）。落とさず、種別だけ言う。
      const unknown: { type: string } = entry;
      return `（この画面が知らない種別: ${unknown.type}）`;
    }
  }
}

/** 改行と連続する空白を 1 つの空白にし、`limit` 字で切る（切ったら `…`）。 */
export function oneLine(text: string, limit: number): string {
  const single = text.replace(/\s+/g, ' ').trim();
  return single.length > limit ? `${single.slice(0, limit)}…` : single;
}

/** 一覧 1 行の要旨の字数の上限（端末の幅でさらに切られる）。長い本文を毎フレーム渡さない。 */
export const SUMMARY_LIMIT = 300;

const dateTime = new Intl.DateTimeFormat('ja-JP', {
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
});
const dateTimeWithYear = new Intl.DateTimeFormat('ja-JP', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
});
const yearOnly = new Intl.DateTimeFormat('ja-JP', { year: 'numeric' });

/** Web の `formatDateTime` と同じ。今年でない時刻にだけ年を足す（読めない値はそのまま）。 */
export function formatDateTime(iso: string, now: number = Date.now()): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const isThisYear = yearOnly.format(date) === yearOnly.format(new Date(now));
  return isThisYear ? dateTime.format(date) : dateTimeWithYear.format(date);
}

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

/** 語で探しているとき、探す対象に入っていない欄が在ることの断り（Web と同じ）。 */
export const SEARCH_SCOPE_NOTE =
  'tool_use の input・worker_wait・turn_usage は探す対象に入っていない（そこにだけ書かれている語は当たらない）。';

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
  const text = lines.join('\n');
  return text.length > JOURNAL_DETAIL_CHARS
    ? `${text.slice(0, JOURNAL_DETAIL_CHARS)}\n…（全 ${String(text.length)} 字のうち先頭 ${String(JOURNAL_DETAIL_CHARS)} 字だけ）`
    : text;
}

function indent(text: string): string {
  return text
    .split('\n')
    .map((line) => `  ${line}`)
    .join('\n');
}
