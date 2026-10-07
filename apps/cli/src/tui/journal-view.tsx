import type { JournalEntry } from '@alteroid/core';
import {
  JOURNAL_TONE,
  JOURNAL_TYPES,
  SEARCH_SCOPE_NOTE,
  formatDateTime,
  type JournalTone,
} from '@alteroid/logic';
import { Box, Text } from 'ink';
import type { FC } from 'react';

import { formatElapsedAgo } from '../format.js';
import type { LiveStatus } from './header-feed.js';
import {
  filterText,
  journalDetailText,
  journalEmptyMessage,
  journalListLine,
  oneLine,
  summarizeJournalEntry,
} from './journal-format.js';
import type { JournalState } from './journal-controller.js';
import { selectedIndex } from './journal-controller.js';
import { sanitizeForTerminal } from '../redact.js';
import { listWindow } from './journal-window.js';
import type { DisplayLine } from './log.js';
import { glyph, theme } from './theme.js';
import { wrapDisplayLines } from './wrap.js';

export const LIST_FIXED_ROWS = 3;

export function listFixedRows(state: JournalState): number {
  return LIST_FIXED_ROWS + (state.q !== '' ? 1 : 0);
}
export const JOURNAL_DETAIL_HEAD_ROWS = 3;

const toneColor = (tone: JournalTone): string | undefined => {
  switch (tone) {
    case 'warn':
      return theme.warn;
    case 'danger':
      return theme.error;
    case 'accent':
      return theme.accent;
    case 'ok':
      return theme.ok;
    case 'neutral':
      return undefined;
  }
};

export function olderLineText(state: JournalState): string {
  const n = state.entries.length;
  if (state.error !== null) return `⚠ ${state.error}`;
  switch (state.older) {
    case 'progress':
    case 'retryLarger':
      return state.olderLoading
        ? '古い側を読んでいる…'
        : `↑ 古い側はまだ在る（先頭まで上がるか m で読み足す · いま ${String(n)} 件）`;
    case 'end':
      return n === 0
        ? ' '
        : `これより古い記録は無い（全 ${String(n)} 件）。${state.horizonNote ?? ''}`.trim();
    case 'blocked':
      return `同じ時刻の記録が多く並んでいて、これより古い記録へ自動では進めない（いま ${String(n)} 件）。終端ではない`;
    case 'budget':
      return (
        `持てる量の上限に達した（いま ${String(n)} 件${state.trimmed > 0 ? `・古い側 ${String(state.trimmed)} 件を手放した` : ''}）。` +
        '古い側は残っている — f で絞ると先頭から読み直す'
      );
  }
}

export function bottomLineText(state: JournalState, live: LiveStatus): string {
  const liveText =
    live === 'live' ? '' : live === 'offline' ? ' · ライブ切断（再接続中）' : ' · ライブ接続中…';
  if (state.newerFailed) {
    return `新着の取りこぼし確認に失敗した。切れていた間の記録が欠けている。r で読み直す${liveText}`;
  }
  if (state.newerBlocked) {
    return `新着の取りこぼし確認が、同じ時刻の記録の詰まりで止まった。r で読み直す${liveText}`;
  }
  // 追従中と言わない: 再読込に失敗している間は新着を一覧へ入れていない（`ingest` は error で捨てる）ため
  if (state.status === 'error') {
    return `⚠ 読み込みに失敗していて、新着を一覧に入れていない。r で読み直す${liveText}`;
  }
  const at = selectedIndex(state);
  if (state.follow || at <= 0) return `● 末尾に追従中${liveText}`;
  return `⏸ 位置を止めている（新しい側にあと ${String(at)} 件 · n で最新へ戻って追従）${liveText}`;
}

export function bottomLines(state: JournalState, live: LiveStatus): string[] {
  const lines = [bottomLineText(state, live)];
  if (state.q !== '') lines.push(SEARCH_SCOPE_NOTE);
  return lines;
}

export const JournalList: FC<{
  state: JournalState;
  height: number;
  live: LiveStatus;
}> = ({ state, height, live }) => {
  const { entries } = state;
  const cap = Math.max(1, height - listFixedRows(state));
  const at = Math.max(0, selectedIndex(state));
  const win = listWindow(entries.length, at, state.follow, cap);
  const shown: { entry: JournalEntry; fromNewest: number }[] = [];
  for (let d = win.start; d < win.end; d += 1) {
    const fromNewest = entries.length - 1 - d;
    const entry = entries[fromNewest];
    if (entry !== undefined) shown.push({ entry, fromNewest });
  }
  const loading = state.status === 'loading' || state.status === 'idle';
  const title = loading
    ? '日誌を読んでいる…'
    : `日誌（絞り: ${filterText(state.types, state.q)} · ${String(entries.length)} 件読み込み済み · 古い→新しい）`;
  const failedFirst = state.status === 'error' && entries.length === 0;
  return (
    <Box flexDirection="column" height={height} overflow="hidden" flexShrink={0}>
      <Text bold wrap="truncate-end">
        {title}
      </Text>
      <Text dimColor wrap="truncate-end">
        {olderLineText(state)}
      </Text>
      {state.status === 'ready' && entries.length === 0 ? (
        <Text dimColor wrap="truncate-end">
          {journalEmptyMessage(state.types, state.q)}
        </Text>
      ) : null}
      {failedFirst ? (
        <Text color={theme.warn} wrap="truncate-end">
          {`⚠ 日誌を読めなかった（空ではない）: ${state.error ?? ''} — r で読み直す`}
        </Text>
      ) : null}
      {shown.map(({ entry, fromNewest }) => {
        const selected = fromNewest === at;
        const color = toneColor(JOURNAL_TONE[entry.type]);
        return (
          <Box key={entry.id} flexShrink={0}>
            <Text wrap="truncate-end" {...(selected ? { inverse: true } : {})}>
              {`${selected ? glyph.caret : ' '} `}
              <Text {...(color === undefined ? {} : { color })}>
                {journalListLine(entry, state.loadedAt)}
              </Text>
            </Text>
          </Box>
        );
      })}
      <Box flexGrow={1} />
      {bottomLines(state, live).map((line, i) => (
        <Text key={i} dimColor wrap="truncate-end">
          {line}
        </Text>
      ))}
    </Box>
  );
};

export const JournalFilter: FC<{ state: JournalState; height: number }> = ({ state, height }) => {
  const cap = Math.max(1, height - 2);
  const start = Math.min(
    Math.max(0, state.filterCursor - cap + 1),
    Math.max(0, JOURNAL_TYPES.length - cap),
  );
  const rows = JOURNAL_TYPES.slice(start, start + cap);
  return (
    <Box flexDirection="column" height={height} overflow="hidden" flexShrink={0}>
      <Text bold wrap="truncate-end">
        種別で絞り込む（選んだ種別だけ。1 つも選ばなければ全部）
      </Text>
      {rows.map((type, i) => {
        const index = start + i;
        const on = state.filterDraft.includes(type);
        return (
          <Box key={type} flexShrink={0}>
            <Text wrap="truncate-end" {...(index === state.filterCursor ? { inverse: true } : {})}>
              {`${index === state.filterCursor ? glyph.caret : ' '} ${on ? '[x]' : '[ ]'} ${type}`}
            </Text>
          </Box>
        );
      })}
      <Box flexGrow={1} />
      <Text dimColor wrap="truncate-end">
        {state.qDraft !== ''
          ? `語: 「${state.qDraft}」（/journal q=<語> で決める。c で語も外れる）`
          : state.q !== ''
            ? '語: 外す（Enter で反映）'
            : ' '}
      </Text>
    </Box>
  );
};

export const JournalDetailHead: FC<{ entry: JournalEntry; now: number }> = ({ entry, now }) => (
  <Box flexDirection="column" height={JOURNAL_DETAIL_HEAD_ROWS} flexShrink={0} overflow="hidden">
    <Text wrap="truncate-end">
      <Text bold>{sanitizeForTerminal(`[${entry.type}]`)}</Text>
      {sanitizeForTerminal(` ${entry.id}`)}
    </Text>
    <Text wrap="truncate-end" dimColor>
      {sanitizeForTerminal(
        `${entry.at}（${formatDateTime(entry.at, now)} · ${formatElapsedAgo(entry.at, now)}）`,
      )}
    </Text>
    <Text wrap="truncate-end">{oneLine(summarizeJournalEntry(entry), 300)}</Text>
  </Box>
);

export function journalDetailLines(entry: JournalEntry, width: number): DisplayLine[] {
  const rows = wrapDisplayLines(journalDetailText(entry), Math.max(1, width - 2));
  return rows.map((row, i) => ({
    key: `${entry.id}:${String(i)}`,
    kind: 'assistant' as const,
    text: `  ${row}`,
  }));
}

export const JournalDetailStatus: FC<{ hiddenBelow: number }> = ({ hiddenBelow }) => (
  <Box flexShrink={0}>
    <Text wrap="truncate-end" dimColor>
      {hiddenBelow > 0
        ? `↓ あと ${String(hiddenBelow)} 行（PgDn で進む）`
        : '全文を出した（Esc で一覧へ）'}
    </Text>
  </Box>
);
