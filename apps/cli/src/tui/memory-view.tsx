/**
 * 「記憶」タブの描画（見た目だけ。キー操作は `app.tsx` の 1 つの `useInput` が持つ）。Ink の地雷への
 * 対処は `components.tsx` の冒頭と同じ。
 *
 * **一覧はタイトルと要旨だけ**（1 件 2 行: 種別・タイトル・slug・大きさ・更新 / 要旨）。本文は Enter で
 * 開く詳細で読む（`.claude/skills/listing-and-detail`）。可視窓の行だけを描く。
 */
import { formatBytes } from '@alteroid/logic';
import { Box, Text } from 'ink';
import type { FC } from 'react';

import { formatElapsedAgo } from '../format.js';
import type { MemoryRow } from './api.js';
import { formatCreatedAt, freshnessMarker } from '../memory.js';
import type { MemoryDetailState, MemoryState } from './memory-controller.js';
import { oneLine } from './journal-format.js';
import { glyph, theme } from './theme.js';

/** 一覧 1 件の行数。 */
export const MEMORY_ITEM_ROWS = 2;
/** 詳細の頭の行数（種別と slug・作成と更新・タイトル）。 */
export const MEMORY_DETAIL_HEAD_ROWS = 3;
/** 要旨の字数の上限（端末の幅でさらに切られる）。 */
const DESCRIPTION_LIMIT = 200;

/** 1 行目: 種別・タイトル・slug・大きさ・更新。 */
export function memoryTitleLine(row: MemoryRow, now: number): string {
  const size = row.bytes === undefined ? '' : ` · ${formatBytes(row.bytes)}`;
  return `[${row.kind}] ${row.title}  ${row.slug}${size} · 更新 ${formatElapsedAgo(row.updatedAt, now)}`;
}

/** 2 行目: 要旨（印は要旨の前。`alteroid memory list` と同じ `freshnessMarker`）。 */
export function memoryDescriptionLine(row: MemoryRow): string {
  if (row.description === undefined) return ' ';
  return `    ${freshnessMarker(row.descriptionFreshness)}${oneLine(row.description, DESCRIPTION_LIMIT)}`;
}

/** 一覧。窓は選択が見える範囲だけを描く。 */
export const MemoryList: FC<{ state: MemoryState; height: number }> = ({ state, height }) => {
  const { rows, selected } = state;
  const errorLine = state.error !== null ? `⚠ ${state.error}` : null;
  const fixed = 1 + (errorLine === null ? 0 : 1);
  const cap = Math.max(1, Math.floor((height - fixed) / MEMORY_ITEM_ROWS));
  const start = Math.min(Math.max(0, selected - cap + 1), Math.max(0, rows.length - cap));
  const shown = rows.slice(start, start + cap);
  const loading = state.status === 'idle' || state.status === 'loading';
  const title = loading ? '記憶を読んでいる…' : `記憶（${String(rows.length)} 件 · 読むだけ）`;
  return (
    <Box flexDirection="column" height={height} overflow="hidden" flexShrink={0}>
      <Text bold wrap="truncate-end">
        {title}
      </Text>
      {errorLine !== null ? (
        <Text color={theme.warn} wrap="truncate-end">
          {errorLine}
        </Text>
      ) : null}
      {state.status === 'ready' && rows.length === 0 ? (
        <Text dimColor wrap="truncate-end">
          まだ空。起動直後に人間の登場が多いのは正しい動作で、価値観が溜まるほど確認は減る。
        </Text>
      ) : null}
      {state.status === 'error' && rows.length === 0 ? (
        <Text color={theme.warn} wrap="truncate-end">
          記憶を読めなかった（空ではない）。r で読み直す
        </Text>
      ) : null}
      {shown.map((row, i) => {
        const index = start + i;
        const on = index === selected;
        return (
          <Box key={row.slug} flexDirection="column" flexShrink={0}>
            <Text wrap="truncate-end" {...(on ? { inverse: true } : {})}>
              {`${on ? glyph.caret : ' '} ${memoryTitleLine(row, state.loadedAt)}`}
            </Text>
            <Text wrap="truncate-end" dimColor>
              {memoryDescriptionLine(row)}
            </Text>
          </Box>
        );
      })}
    </Box>
  );
};

/** 詳細の頭（常に `MEMORY_DETAIL_HEAD_ROWS` 行）。 */
export const MemoryDetailHead: FC<{ detail: MemoryDetailState }> = ({ detail }) => {
  const doc = detail.doc;
  const row = detail.row;
  return (
    <Box flexDirection="column" height={MEMORY_DETAIL_HEAD_ROWS} flexShrink={0} overflow="hidden">
      <Text wrap="truncate-end">
        <Text bold>{row === null ? '' : `[${row.kind}] `}</Text>
        {detail.slug}
      </Text>
      <Text wrap="truncate-end" dimColor>
        {doc === null
          ? ' '
          : `作成 ${formatCreatedAt(doc.createdAt)} · 更新 ${doc.updatedAt}（${formatElapsedAgo(doc.updatedAt, detail.loadedAt)}）`}
      </Text>
      <Text wrap="truncate-end">{row === null ? ' ' : row.title}</Text>
    </Box>
  );
};

/** ログ直下の 1 行（常に 1 行）。 */
export function memoryDetailStatus(
  detail: MemoryDetailState,
  hiddenBelow: number,
): { text: string; tone: 'dim' | 'warn' } {
  if (detail.status === 'missing') {
    return { text: 'この記憶は無い（404）。Esc で一覧へ', tone: 'warn' };
  }
  if (detail.status === 'error') {
    return { text: `⚠ 読めなかった（空ではない）: ${detail.error ?? ''}`, tone: 'warn' };
  }
  if (detail.status === 'loading') return { text: '読んでいる…', tone: 'dim' };
  if (hiddenBelow > 0) {
    return { text: `↓ あと ${String(hiddenBelow)} 行（PgDn で進む）`, tone: 'dim' };
  }
  if (detail.cutFrom !== null) {
    return {
      text: `全 ${String(detail.cutFrom)} 字のうち先頭だけを出した。全文は Web か alteroid memory show`,
      tone: 'warn',
    };
  }
  return {
    text: '全文を出した（読むだけ。直すのは Web か alteroid memory edit · Esc で一覧へ）',
    tone: 'dim',
  };
}
