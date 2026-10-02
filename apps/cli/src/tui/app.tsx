/**
 * TUI の root。1 画面に `useInput` は 1 つだけ（ここ）で、フォーカスは「ゾーン」で分ける:
 * 入力欄（`input`）と、その外（`nav`）。Esc は開いた順に閉じる（履歴の選択 → 入力欄）。
 *
 * 出所: takecchi/codiva（MIT）`src/app.tsx` / `.claude/rules/ink-components.md` の作法
 * （単一の useInput・ゾーン・Esc で戻る・ref で逐次適用）。
 */
import { Box, useApp, useInput, useWindowSize } from 'ink';
import { useMemo, useRef, useState, type FC } from 'react';

import type { ConversationSummary, TuiApi } from './api.js';
import type { ChatController } from './chat-controller.js';
import { resolveCommand, helpLines, type CommandAction } from './commands.js';
import {
  ConversationPicker,
  Footer,
  Header,
  LogView,
  Placeholder,
  PromptInput,
  StatusRow,
  Tabs,
} from './components.js';
import type { HeaderFeed } from './header-feed.js';
import { HINT_INPUT, HINT_NAV, HINT_PICKER, HINT_QUITTING } from './hints.js';
import { useCoalescedStore, useSyncedState } from './hooks.js';
import { editText, normalizeChord, resolveEnter } from './input.js';
import { chatLayout, TABS, type TabId } from './layout.js';
import {
  logLines,
  logWindow,
  pageStep,
  scrollDown,
  scrollUp,
  streamLines,
  type ScrollAnchor,
} from './log.js';
import {
  COMPOSER_PREFIX_CELLS,
  composerLayout,
  emptyBuffer,
  isEmptyBuffer,
  visibleLineRange,
  type TextBuffer,
} from './text-buffer.js';

type Zone = 'input' | 'nav';

interface PickerState {
  status: 'loading' | 'ready';
  items: readonly ConversationSummary[];
  selected: number;
  /** 一覧を読んだ時刻（「何分前」の基準。描画のたびに時刻を読まない）。 */
  loadedAt: number;
}

export interface AppProps {
  api: TuiApi;
  controller: ChatController;
  feed: HeaderFeed;
  /** 全画面レイアウト（root の高さを端末の行数に固定）を使うか。小さい端末ではインライン。 */
  fullscreen: boolean;
}

export const App: FC<AppProps> = ({ api, controller, feed, fullscreen }) => {
  const { exit } = useApp();
  const { columns, rows } = useWindowSize();
  const chat = useCoalescedStore(controller.store);
  const header = useCoalescedStore(feed.store);

  const [tab, setTab, tabRef] = useSyncedState<TabId>('chat');
  const [zone, setZone, zoneRef] = useSyncedState<Zone>('input');
  const [buffer, setBuffer, bufferRef] = useSyncedState<TextBuffer>(emptyBuffer());
  const [anchor, setAnchor, anchorRef] = useSyncedState<ScrollAnchor>('bottom');
  const [picker, setPicker, pickerRef] = useSyncedState<PickerState | null>(null);
  const [quitting, setQuitting] = useState(false);

  const wrapWidth = Math.max(1, columns - COMPOSER_PREFIX_CELLS);
  const composer = composerLayout(buffer, wrapWidth);
  const layout = chatLayout({ rows, composerRows: composer.rows.length, fullscreen });
  const composerWindow = visibleLineRange(
    composer.rows.length,
    composer.caret.row,
    layout.composerShown,
  );

  const logRows = useMemo(() => logLines(chat.entries, columns), [chat.entries, columns]);
  const streamRows = streamLines(chat.streaming, columns, layout.logHeight);
  const win = logWindow([...logRows, ...streamRows], layout.logHeight, anchor);

  /** スクロールの総行数。ハンドラの中で最新の状態から数える（ログの展開はキャッシュされる）。 */
  const totalRows = (): number => {
    const s = controller.store.getSnapshot();
    return (
      logLines(s.entries, columns).length +
      streamLines(s.streaming, columns, layout.logHeight).length
    );
  };

  const quittingRef = useRef(false);
  const quit = (): void => {
    if (quittingRef.current) return;
    quittingRef.current = true;
    setQuitting(true);
    void (async () => {
      await controller.shutdown();
      feed.stop();
      exit();
    })();
  };

  const openPicker = (): void => {
    setPicker({ status: 'loading', items: [], selected: 0, loadedAt: 0 });
    controller.listConversations().then(
      ({ items, at }) =>
        setPicker((p) => (p === null ? p : { status: 'ready', items, selected: 0, loadedAt: at })),
      (error: unknown) => {
        setPicker(null);
        controller.addError(error instanceof Error ? error.message : String(error));
      },
    );
  };

  const goTab = (next: TabId): void => {
    setTab(next);
    setZone(next === 'chat' ? 'input' : 'nav');
    setPicker(null);
  };

  const runCommand = (action: CommandAction): void => {
    switch (action) {
      case 'help':
        controller.addSystem(helpLines().join('\n'));
        break;
      case 'exit':
        quit();
        break;
      case 'chat':
      case 'approvals':
      case 'managers':
      case 'journal':
      case 'memory':
        goTab(action);
        break;
      case 'conversations':
        openPicker();
        break;
      case 'new':
        controller.newConversation();
        setAnchor('bottom');
        break;
      case 'end':
        void controller.endConversation();
        break;
      case 'interrupt':
        void controller.interrupt();
        break;
    }
  };

  const submit = (text: string): void => {
    setBuffer(emptyBuffer());
    if (text.length === 0) return;
    const resolved = resolveCommand(text);
    if (resolved.kind === 'command') return runCommand(resolved.spec.action);
    if (resolved.kind === 'unknown') {
      controller.addSystem(
        `不明なコマンド: /${resolved.name}（/help で一覧。/ で始まる文をそのまま送るなら // で始める）`,
      );
      return;
    }
    setAnchor('bottom');
    void controller.send(resolved.text);
  };

  useInput((rawInput, rawKey) => {
    const { input, key } = normalizeChord(rawInput, rawKey);

    if (key.ctrl && input === 'c') {
      void controller.interrupt();
      return;
    }
    if (key.ctrl && input === 'd') {
      // 入力欄が空のときだけ（書きかけを誤って捨てない）。入力欄の外・他の画面では常に終了。
      if (
        tabRef.current !== 'chat' ||
        zoneRef.current !== 'input' ||
        isEmptyBuffer(bufferRef.current)
      ) {
        quit();
      }
      return;
    }

    const p = pickerRef.current;
    if (p !== null) {
      if (key.escape) setPicker(null);
      else if (key.upArrow) setPicker({ ...p, selected: Math.max(0, p.selected - 1) });
      else if (key.downArrow) {
        setPicker({ ...p, selected: Math.min(Math.max(0, p.items.length - 1), p.selected + 1) });
      } else if (key.return) {
        const item = p.items[p.selected];
        if (item !== undefined) {
          setPicker(null);
          void controller.openConversation(item.conversationId).then((ok) => {
            if (ok) setAnchor('bottom');
          });
        }
      }
      return;
    }

    // スクロール（会話の画面ならどのゾーンでも）。
    if (tabRef.current === 'chat') {
      const step = pageStep(layout.logHeight);
      if (key.pageUp)
        return setAnchor(scrollUp(anchorRef.current, totalRows(), layout.logHeight, step));
      if (key.pageDown)
        return setAnchor(scrollDown(anchorRef.current, totalRows(), layout.logHeight, step));
    }

    if (tabRef.current === 'chat' && zoneRef.current === 'input') {
      if (key.escape || key.tab) return setZone('nav');
      if (key.return) {
        const action = resolveEnter(bufferRef.current, key);
        if (action.kind === 'newline') setBuffer(action.buffer);
        else submit(action.text);
        return;
      }
      const edited = editText(bufferRef.current, input, key, { wrapWidth });
      if (edited.changed) setBuffer(edited.buffer);
      return;
    }

    // 入力欄の外（nav）。
    if (input === '/') {
      goTab('chat');
      setBuffer({ value: '/', cursor: 1 });
      return;
    }
    const digit = TABS.find((t) => t.key === input);
    if (digit !== undefined) return goTab(digit.id);
    if (tabRef.current === 'chat') {
      if (key.tab || key.return || input === 'i') return setZone('input');
      if (key.upArrow)
        return setAnchor(scrollUp(anchorRef.current, totalRows(), layout.logHeight, 1));
      if (key.downArrow)
        return setAnchor(scrollDown(anchorRef.current, totalRows(), layout.logHeight, 1));
    }
  });

  // 入力欄の上端の画面上の行: ヘッダ + タブ + ログ + 状態行 + 上の罫線。
  const cursorTop = 2 + layout.logHeight + 1 + 1;
  const hint = quitting
    ? HINT_QUITTING
    : picker !== null
      ? HINT_PICKER
      : tab === 'chat' && zone === 'input'
        ? HINT_INPUT
        : HINT_NAV;

  return (
    <Box
      flexDirection="column"
      width={columns}
      {...(fullscreen ? { height: rows, overflow: 'hidden' as const } : {})}
    >
      <Header baseUrl={api.baseUrl} state={header} />
      <Tabs active={tab} counts={header.counts} />
      {tab !== 'chat' ? (
        <Placeholder tab={tab} height={layout.bodyHeight} />
      ) : picker !== null ? (
        <ConversationPicker
          status={picker.status}
          items={picker.items}
          selected={picker.selected}
          height={layout.bodyHeight}
          now={picker.loadedAt}
        />
      ) : (
        <>
          <LogView lines={win.entries} height={layout.logHeight} />
          <StatusRow hiddenBelow={win.hiddenBelow} transient={chat.transient} />
          <PromptInput
            rows={composer.rows.slice(composerWindow.start, composerWindow.end)}
            window={{ start: 0, end: composerWindow.end - composerWindow.start }}
            caret={{ row: composer.caret.row - composerWindow.start, col: composer.caret.col }}
            focused={zone === 'input'}
            placeholder={
              chat.busy ? '応答中… 続けて送ると追送になる' : 'メッセージ（/help でコマンド）'
            }
            cursorTop={cursorTop}
          />
        </>
      )}
      <Footer hint={hint} />
    </Box>
  );
};
