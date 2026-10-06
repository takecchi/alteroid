/**
 * 画面の部品（見た目だけ。キー操作は `app.tsx` の 1 つの `useInput` が持つ）。
 *
 * Ink の地雷への対処（出所: takecchi/codiva（MIT）の `codiva/.claude/rules/ink-components.md` と
 * `codiva/docs/TECH_NOTES.md`。どちらも codiva の repo のファイルで、この repo には無い）:
 * - 空の `<Text>` は高さ 0。空行は半角スペース 1 つにして必ず 1 行ぶん確保する。
 * - Yoga は溢れた子を縮める。行の入れ物に `flexShrink={0}` を付け、窓の行数は可視高さ以下にする。
 * - 1 行に `<Text>` を 2 つ並べない（Box の row に置かない）。1 行は 1 つの `<Text>` の中に入れ子で組む。
 * - 一覧のセルは `wrap="truncate-end"`。
 * - 長い文字列を毎フレーム渡さない（Ink の測定キャッシュは上限なしで伸びる）。ログは可視窓の
 *   物理行だけを、各行 1 本の短い文字列として渡す。
 */
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

/** 1 物理行。装飾付き（Markdown 由来）なら span ごとに色・太さを当てる。 */
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

/** ログ直下の 1 行（常に 1 行 — 出入りするとログ全体が 1 行跳ねる）。 */
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

/**
 * 入力欄。上下に罫線を引き、行は折り返し済み（`composerLayout`）。実際の端末のカーソルを
 * キャレットの位置へ置く: IME の未確定文字列（変換中のプレビュー）は端末がカーソル位置に
 * 描くので、隠したままだと日本語が打てなくなる。位置はレイアウトが固定なので計算で出す
 * （`cursorTop` = 先頭の表示行の画面上の y）。出所: takecchi/codiva（MIT）`ui/prompt-input.tsx`。
 */
export const PromptInput: FC<{
  rows: readonly ComposerRow[];
  /** 描く表示行の範囲 `[start, end)`。 */
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

/** キャレット位置を反転で描く（1 コードポイント単位で読む — サロゲートを割らない）。 */
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

/**
 * 履歴の一覧の断り書き（文言は `conversations.ts` の `renderConversationsList` に揃える）。
 * 窓が先頭に届いていないとき、0 件でも「会話はまだありません」とは言えない（判定できない）。
 */
export function conversationPickerNotes(
  count: number,
  scanned: number,
  reachedStart: boolean,
  hiddenByLimit: number,
): string[] {
  const notes: string[] = [];
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

/** 会話の履歴の選択。窓は選択行が見える範囲だけを描く。 */
export const ConversationPicker: FC<{
  status: 'loading' | 'ready';
  items: readonly ConversationSummary[];
  scanned: number;
  reachedStart: boolean;
  hiddenByLimit: number;
  selected: number;
  height: number;
  now: number;
}> = ({ status, items, scanned, reachedStart, hiddenByLimit, selected, height, now }) => {
  const notes =
    status === 'ready'
      ? conversationPickerNotes(items.length, scanned, reachedStart, hiddenByLimit)
      : [];
  const cap = Math.max(1, height - 1 - notes.length);
  const start = Math.min(Math.max(0, selected - cap + 1), Math.max(0, items.length - cap));
  const shown = items.slice(start, start + cap);
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
    </Box>
  );
};
