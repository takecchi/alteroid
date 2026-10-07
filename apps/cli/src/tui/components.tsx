// 出所: takecchi/codiva（MIT）の `codiva/.claude/rules/ink-components.md` と `codiva/docs/TECH_NOTES.md`
// 空行は半角スペース 1 つにする: 空の `<Text>` は高さ 0 になるため
// 1 行に `<Text>` を 2 つ並べない: 1 行は 1 つの `<Text>` の中に入れ子で組む
// 長い文字列を毎フレーム渡さない: Ink の測定キャッシュは上限なしで伸びるため
import { Box, Text, useCursor } from 'ink';
import type { FC } from 'react';
import stringWidth from 'string-width';

import type { ConversationSummary } from './api.js';
import { formatElapsedAgo } from '../format.js';
import { sanitizeForTerminal } from '../redact.js';
import type { HeaderState } from './header-feed.js';
import { oneLine } from './journal-format.js';
import { TABS, type TabId } from './layout.js';
import type { DisplayLine } from './log.js';
import { glyph, logColor, theme, toneColor } from './theme.js';
import type { ComposerRow } from './text-buffer.js';

const LogLine: FC<{ line: DisplayLine }> = ({ line }) => {
  const color = logColor[line.kind];
  return (
    <Box flexShrink={0}>
      <Text wrap="truncate-end" {...(color === undefined ? {} : { color })}>
        {line.spans
          ? line.spans.map((span, i) => (
              <Text
                key={i}
                {...(span.tone === undefined ? {} : { color: toneColor[span.tone] })}
                {...(span.bold ? { bold: true } : {})}
                {...(span.italic ? { italic: true } : {})}
                {...(span.dim ? { dimColor: true } : {})}
                {...(span.underline ? { underline: true } : {})}
                {...(span.strikethrough ? { strikethrough: true } : {})}
              >
                {sanitizeForTerminal(span.text)}
              </Text>
            ))
          : line.text.length > 0
            ? sanitizeForTerminal(line.text)
            : ' '}
      </Text>
    </Box>
  );
};

export const LogView: FC<{ lines: readonly DisplayLine[]; height: number }> = ({
  lines,
  height,
}) => (
  <Box
    flexDirection="column"
    height={height}
    overflow="hidden"
    justifyContent="flex-end"
    flexShrink={0}
  >
    {lines.map((line) => (
      <LogLine key={line.key} line={line} />
    ))}
  </Box>
);

// 常に 1 行にする: 出入りするとログ全体が 1 行跳ねるため
export const StatusRow: FC<{ hiddenBelow: number; transient: string | null }> = ({
  hiddenBelow,
  transient,
}) => (
  <Box flexShrink={0}>
    <Text wrap="truncate-end" dimColor>
      {hiddenBelow > 0
        ? `↓ あと ${String(hiddenBelow)} 行（PgDn で進む。末尾まで行くと追従に戻る）`
        : transient !== null
          ? transient
          : ' '}
    </Text>
  </Box>
);

// 実際の端末のカーソルをキャレットの位置へ置く: IME の未確定文字列は端末がカーソル位置に描くので、隠したままだと日本語が打てなくなるため
// 出所: takecchi/codiva（MIT）`ui/prompt-input.tsx`
export const PromptInput: FC<{
  rows: readonly ComposerRow[];
  window: { start: number; end: number };
  caret: { row: number; col: number };
  focused: boolean;
  placeholder: string;
  cursorTop: number;
}> = ({ rows, window, caret, focused, placeholder, cursorTop }) => {
  const { setCursorPosition } = useCursor();
  const caretRow = rows[caret.row];
  if (focused) {
    setCursorPosition({
      x: stringWidth(`${glyph.caret} ${(caretRow?.text ?? '').slice(0, caret.col)}`),
      y: cursorTop + (caret.row - window.start),
    });
  } else {
    setCursorPosition(undefined);
  }
  const empty = rows.length === 1 && rows[0]?.text === '';
  return (
    <Box
      flexDirection="column"
      flexShrink={0}
      width="100%"
      borderStyle="single"
      borderColor={theme.dim}
      borderTop
      borderBottom
      borderLeft={false}
      borderRight={false}
    >
      {empty ? (
        <Box>
          <Text color={theme.accent}>{glyph.caret} </Text>
          <Text wrap="truncate-end">
            {focused ? <Text inverse> </Text> : null}
            <Text dimColor>{placeholder}</Text>
          </Text>
        </Box>
      ) : (
        rows.slice(window.start, window.end).map((row, i) => {
          const rowIndex = window.start + i;
          const isCaretRow = focused && rowIndex === caret.row;
          return (
            <Box key={rowIndex}>
              <Text color={theme.accent}>{i === 0 ? `${glyph.caret} ` : '  '}</Text>
              {isCaretRow ? (
                <CaretLine line={row.text} col={caret.col} />
              ) : (
                <Text wrap="truncate-end">{row.text.length > 0 ? row.text : ' '}</Text>
              )}
            </Box>
          );
        })
      )}
    </Box>
  );
};

// 1 コードポイント単位で読む: サロゲートを割らないため
const CaretLine: FC<{ line: string; col: number }> = ({ line, col }) => {
  const cp = line.codePointAt(col);
  const ch = cp === undefined ? ' ' : String.fromCodePoint(cp);
  return (
    <Text wrap="truncate-end">
      {line.slice(0, col)}
      <Text inverse>{ch}</Text>
      {line.slice(col + ch.length)}
    </Text>
  );
};

export const Header: FC<{ baseUrl: string; state: HeaderState }> = ({ baseUrl, state }) => {
  const { counts, live } = state;
  const unreadable = counts?.unreadableApprovals ?? 0;
  const approvals =
    counts === null
      ? '-'
      : `${String(counts.pendingApprovals)}${unreadable > 0 ? `（読めない ${String(unreadable)}）` : ''}`;
  const running = counts === null ? '-' : String(counts.runningManagers);
  return (
    <Box flexShrink={0}>
      <Text wrap="truncate-end">
        <Text bold color={theme.accent}>
          alteroid
        </Text>
        {` ─ ${baseUrl} ─ `}
        <Text
          {...(counts !== null && (counts.pendingApprovals > 0 || unreadable > 0)
            ? { color: theme.warn }
            : {})}
        >
          {`承認待ち ${approvals}`}
        </Text>
        {` ─ 実行中の委譲 ${running}`}
        {live === 'live' ? '' : live === 'offline' ? ' ─ ライブ切断（再接続中）' : ' ─ 接続中…'}
      </Text>
    </Box>
  );
};

export const Tabs: FC<{ active: TabId; counts: HeaderState['counts'] }> = ({ active, counts }) => (
  <Box flexShrink={0}>
    <Text wrap="truncate-end">
      {TABS.map((tab) => {
        const unreadable = tab.id === 'approvals' ? (counts?.unreadableApprovals ?? 0) : 0;
        const badge =
          tab.id === 'approvals' &&
          counts !== null &&
          (counts.pendingApprovals > 0 || unreadable > 0)
            ? `${counts.pendingApprovals > 0 ? ` ${String(counts.pendingApprovals)}` : ''}${unreadable > 0 ? ` ⚠読めない ${String(unreadable)}` : ''}`
            : tab.id === 'managers' && counts !== null && counts.runningManagers > 0
              ? ` ${String(counts.runningManagers)}`
              : '';
        return (
          <Text
            key={tab.id}
            {...(tab.id === active ? { inverse: true, bold: true } : { dimColor: true })}
            {...(unreadable > 0 ? { color: theme.warn } : {})}
          >
            {`[${tab.key} ${tab.label}${badge}]`}
            {tab.id === active ? '' : ' '}
          </Text>
        );
      })}
    </Text>
  </Box>
);

export const Footer: FC<{ hint: string }> = ({ hint }) => (
  <Box flexShrink={0}>
    <Text wrap="truncate-end" dimColor>
      {hint}
    </Text>
  </Box>
);

// 0 件でも「会話はまだありません」と言わない: 窓が先頭に届いていないと判定できないため
export function conversationPickerNotes(
  count: number,
  scanned: number,
  reachedStart: boolean,
  hiddenByLimit: number,
  hasMore = false,
): string[] {
  const notes: string[] = [];
  if (hasMore) return notes;
  if (!reachedStart) {
    notes.push(
      `人間との往復を ${String(scanned)} 件遡ったが、先頭には届いていない。これより古い会話が残っているかもしれない`,
    );
  }
  if (hiddenByLimit > 0) {
    notes.push(
      `…ほか ${String(hiddenByLimit)} 件は省略（この窓に ${String(count + hiddenByLimit)} 件あり、新しい順に ${String(count)} 件だけ出した）`,
    );
  }
  return notes;
}

export const ConversationPicker: FC<{
  status: 'loading' | 'ready';
  items: readonly ConversationSummary[];
  scanned: number;
  reachedStart: boolean;
  hiddenByLimit: number;
  nextCursor?: string | undefined;
  moreLoading?: boolean;
  moreError?: string | null;
  selected: number;
  height: number;
  now: number;
}> = ({
  status,
  items,
  scanned,
  reachedStart,
  hiddenByLimit,
  nextCursor,
  moreLoading = false,
  moreError = null,
  selected,
  height,
  now,
}) => {
  const hasMore = status === 'ready' && nextCursor !== undefined;
  const notes =
    status === 'ready'
      ? conversationPickerNotes(items.length, scanned, reachedStart, hiddenByLimit, hasMore)
      : [];
  const errorLine =
    hasMore && moreError !== null
      ? oneLine(
          sanitizeForTerminal(`続きを読めなかった: ${moreError}（もう一度 Enter で取り直す）`),
          120,
        )
      : null;
  const rowCount = items.length + (hasMore ? 1 : 0);
  const cap = Math.max(1, height - 1 - notes.length - (errorLine === null ? 0 : 1));
  const start = Math.min(Math.max(0, selected - cap + 1), Math.max(0, rowCount - cap));
  const shown = items.slice(start, Math.min(items.length, start + cap));
  const showMore = hasMore && start + cap >= rowCount;
  return (
    <Box flexDirection="column" height={height} overflow="hidden" flexShrink={0}>
      <Text bold wrap="truncate-end">
        {status === 'loading'
          ? '会話の履歴を読んでいる…'
          : `会話の履歴（${String(items.length)} 件）`}
      </Text>
      {status === 'ready' && items.length === 0 ? (
        <Text dimColor wrap="truncate-end">
          {reachedStart
            ? '会話はまだありません'
            : '会話があるかどうか判定できない（窓の外にあるかもしれない）'}
        </Text>
      ) : null}
      {notes.map((note) => (
        <Text key={note} dimColor wrap="truncate-end">
          {note}
        </Text>
      ))}
      {shown.map((item, i) => {
        const index = start + i;
        const preview = oneLine(sanitizeForTerminal(item.preview), 120);
        return (
          <Box key={item.conversationId} flexShrink={0}>
            <Text wrap="truncate-end" {...(index === selected ? { inverse: true } : {})}>
              {sanitizeForTerminal(
                `${index === selected ? glyph.caret : ' '} ${formatElapsedAgo(item.updatedAt, now)} (${String(item.messages)}件) ${preview}`,
              )}
            </Text>
          </Box>
        );
      })}
      {showMore ? (
        <Box flexShrink={0}>
          <Text wrap="truncate-end" {...(selected === items.length ? { inverse: true } : {})}>
            {`${selected === items.length ? glyph.caret : ' '} ${
              moreLoading ? 'もっと見る（読み込み中…）' : 'もっと見る（Enter で次の頁を読む）'
            }`}
          </Text>
        </Box>
      ) : null}
      {errorLine === null ? null : (
        <Text dimColor wrap="truncate-end">
          {errorLine}
        </Text>
      )}
    </Box>
  );
};
