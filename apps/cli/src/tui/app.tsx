/**
 * TUI の root。1 画面に `useInput` は 1 つだけ（ここ）で、フォーカスは「ゾーン」で分ける:
 * 入力欄（`input`）と、その外（`nav`）。Esc は開いた順に閉じる（履歴の選択 → 入力欄）。
 *
 * 出所: takecchi/codiva（MIT）`src/app.tsx` / `.claude/rules/ink-components.md` の作法
 * （単一の useInput・ゾーン・Esc で戻る・ref で逐次適用）。
 */
import { JOURNAL_MAX_LIMIT, JOURNAL_TYPES } from '@alteroid/logic';
import { Box, useApp, useInput, useWindowSize } from 'ink';
import { useMemo, useRef, useState, type FC } from 'react';

import { redactedErrorMessage } from '../redact.js';
import { parseJournalSearchTokens } from '../chat.js';
import type { ConversationSummary, TuiApi } from './api.js';
import type { ChatController } from './chat-controller.js';
import type { ApprovalsController } from './approvals-controller.js';
import {
  AnsweredDatesList,
  AnsweredDayList,
  ApprovalList,
  approvalDocument,
  approvalStatusText,
  composerPlaceholder,
} from './approvals-view.js';
import { resolveCommand, helpLines, type CommandAction } from './commands.js';
import {
  ConversationPicker,
  Footer,
  Header,
  LogView,
  PromptInput,
  StatusRow,
  Tabs,
} from './components.js';
import type { HeaderFeed } from './header-feed.js';
import {
  HINT_AP_CONFIRM,
  approvalDetailHint,
  HINT_AP_FORM,
  HINT_AP_INPUT,
  HINT_AP_DATES,
  HINT_AP_DAY,
  HINT_AP_LIST,
  HINT_INPUT,
  HINT_JOURNAL_DETAIL,
  HINT_JOURNAL_FILTER,
  HINT_JOURNAL_LIST,
  HINT_MEM_DETAIL,
  HINT_MEM_LIST,
  HINT_MGR_CONFIRM,
  HINT_MGR_DETAIL,
  HINT_MGR_INPUT,
  HINT_MGR_LIST,
  HINT_NAV,
  HINT_PICKER,
  HINT_QUITTING,
} from './hints.js';
import { useCoalescedStore, useSyncedState } from './hooks.js';
import { editText, isSpaceKey, normalizeChord, resolveEnter } from './input.js';
import type { JournalController } from './journal-controller.js';
import type { JournalType } from './journal-format.js';
import {
  JOURNAL_DETAIL_HEAD_ROWS,
  JournalDetailHead,
  JournalDetailStatus,
  JournalFilter,
  JournalList,
  journalDetailLines,
} from './journal-view.js';
import { chatLayout, TABS, type TabId } from './layout.js';
import type { MemoryController } from './memory-controller.js';
import {
  MEMORY_DETAIL_HEAD_ROWS,
  MemoryDetailHead,
  MemoryList,
  memoryDetailStatus,
} from './memory-view.js';
import type { ManagersController } from './managers-controller.js';
import {
  DETAIL_HEAD_ROWS,
  DetailStatusRow,
  ManagerDetailHead,
  ManagerList,
  detailStatusText,
} from './managers-view.js';
import {
  type DisplayLine,
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
  bufferOf,
  composerLayout,
  emptyBuffer,
  isEmptyBuffer,
  visibleLineRange,
  type TextBuffer,
} from './text-buffer.js';

type Zone = 'input' | 'nav';

/** 本文が `height` 行に足りないとき、下を空行で埋める。 */
function padRows(rows: DisplayLine[], height: number): DisplayLine[] {
  if (rows.length >= height) return rows;
  const pad: DisplayLine[] = [];
  for (let i = rows.length; i < height; i += 1) {
    pad.push({ key: `pad${String(i)}`, kind: 'assistant', text: ' ' });
  }
  return [...rows, ...pad];
}

interface PickerState {
  status: 'loading' | 'ready';
  items: readonly ConversationSummary[];
  /** 窓の見え方（読み終えるまでは「届いた」「省略なし」の既定）。 */
  scanned: number;
  reachedStart: boolean;
  hiddenByLimit: number;
  selected: number;
  /** 一覧を読んだ時刻（「何分前」の基準。描画のたびに時刻を読まない）。 */
  loadedAt: number;
}

export interface AppProps {
  api: TuiApi;
  controller: ChatController;
  feed: HeaderFeed;
  /** 「承認待ち」タブ（一覧・詳細・答える）の状態と操作。 */
  approvals: ApprovalsController;
  /** 「委譲」タブ（一覧・詳細）の状態と操作。 */
  managers: ManagersController;
  /** 「日誌」タブ（一覧・種別の絞り込み・全文）の状態と操作。 */
  journal: JournalController;
  /** 「記憶」タブ（一覧・詳細。読むだけ）の状態と操作。 */
  memory: MemoryController;
  /** 全画面レイアウト（root の高さを端末の行数に固定）を使うか。小さい端末ではインライン。 */
  fullscreen: boolean;
}

export const App: FC<AppProps> = ({
  api,
  controller,
  feed,
  approvals,
  managers,
  journal,
  memory,
  fullscreen,
}) => {
  const { exit } = useApp();
  const { columns, rows } = useWindowSize();
  const chat = useCoalescedStore(controller.store);
  const header = useCoalescedStore(feed.store);
  const ap = useCoalescedStore(approvals.store);
  const mgr = useCoalescedStore(managers.store);
  const jr = useCoalescedStore(journal.store);
  const mem = useCoalescedStore(memory.store);

  const [tab, setTab, tabRef] = useSyncedState<TabId>('chat');
  const [zone, setZone, zoneRef] = useSyncedState<Zone>('input');
  const [buffer, setBuffer, bufferRef] = useSyncedState<TextBuffer>(emptyBuffer());
  const [anchor, setAnchor, anchorRef] = useSyncedState<ScrollAnchor>('bottom');
  /** 委譲の詳細の入力欄（会話の下書きとは別に持つ）と、生ログのスクロール位置。 */
  const [mgrBuffer, setMgrBuffer, mgrBufferRef] = useSyncedState<TextBuffer>(emptyBuffer());
  const [mgrAnchor, setMgrAnchor, mgrAnchorRef] = useSyncedState<ScrollAnchor>('bottom');
  /** 承認待ちの詳細の入力欄（「その他」・補足・自由文の回答。会話の下書きとは別に持つ）と、本文のスクロール位置。 */
  const [apBuffer, setApBuffer, apBufferRef] = useSyncedState<TextBuffer>(emptyBuffer());
  const [apAnchor, setApAnchor, apAnchorRef] = useSyncedState<ScrollAnchor>('bottom');
  /** 日誌の全文・記憶の本文のスクロール位置。 */
  const [jAnchor, setJAnchor, jAnchorRef] = useSyncedState<ScrollAnchor>('bottom');
  const [memAnchor, setMemAnchor, memAnchorRef] = useSyncedState<ScrollAnchor>('bottom');
  const [picker, setPicker, pickerRef] = useSyncedState<PickerState | null>(null);
  const [quitting, setQuitting] = useState(false);
  /** 最下行に、キーヒントの代わりに出す通知（次のキーで消える）。会話のログが見えない画面で結果を言う（#3489・#3490）。 */
  const [footNote, setFootNote] = useState<string | null>(null);

  const wrapWidth = Math.max(1, columns - COMPOSER_PREFIX_CELLS);
  const inMgrDetail = tab === 'managers' && mgr.view === 'detail' && mgr.detail !== null;
  const inApDetail = tab === 'approvals' && ap.view === 'detail' && ap.detail !== null;
  const composer = composerLayout(
    inMgrDetail ? mgrBuffer : inApDetail ? apBuffer : buffer,
    wrapWidth,
  );
  const layout = chatLayout({ rows, composerRows: composer.rows.length, fullscreen });
  const composerWindow = visibleLineRange(
    composer.rows.length,
    composer.caret.row,
    layout.composerShown,
  );

  /** 委譲の詳細: 頭の行のぶん、生ログの窓を縮める。 */
  const mgrLogHeight = Math.max(1, layout.logHeight - DETAIL_HEAD_ROWS);
  const mgrRows = useMemo(
    () => logLines(mgr.detail?.transcript ?? [], columns),
    [mgr.detail?.transcript, columns],
  );
  const mgrWin = logWindow(mgrRows, mgrLogHeight, mgrAnchor);

  /**
   * 承認待ちの詳細: 本文を折り返した物理行を、読む画面では上から読み進め、答えるフォームでは
   * カーソル行が窓の中ほどに来るように置く。本文が窓より短いときは下を空行で埋める
   * （ログビューは下寄せなので、埋めないと短い本文が画面の底に寄る）。
   */
  const apLogHeight = layout.logHeight;
  const apDoc = useMemo(
    () =>
      ap.detail === null ? { rows: [], focusRow: null } : approvalDocument(ap.detail, columns),
    [ap.detail, columns],
  );
  const apRows = useMemo(() => padRows(apDoc.rows, apLogHeight), [apDoc.rows, apLogHeight]);
  const apWin = logWindow(
    apRows,
    apLogHeight,
    ap.detail?.mode === 'form' && apDoc.focusRow !== null
      ? apDoc.focusRow - (apLogHeight >> 1) + apLogHeight
      : apAnchor,
  );

  /** 日誌の全文: 頭 3 行と最下行 1 行のぶん、窓を縮める。 */
  const jLogHeight = Math.max(1, layout.bodyHeight - JOURNAL_DETAIL_HEAD_ROWS - 1);
  const jRows = useMemo(
    () => (jr.detail === null ? [] : journalDetailLines(jr.detail, columns)),
    [jr.detail, columns],
  );
  const jWin = logWindow(jRows, jLogHeight, jAnchor);
  /** 記憶の本文（Markdown）。 */
  const memLogHeight = Math.max(1, layout.bodyHeight - MEMORY_DETAIL_HEAD_ROWS - 1);
  const memRows = useMemo(
    () => logLines(mem.detail?.body ?? [], columns),
    [mem.detail?.body, columns],
  );
  const memWin = logWindow(memRows, memLogHeight, memAnchor);

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
  /** 委譲の詳細で、書きかけを捨てて戻る 2 度目の Esc を待っている（#3367）。 */
  const mgrDiscardArmedRef = useRef(false);
  /** 書きかけが在るまま、2 度目の Ctrl+D（捨てて終了）を待っている（#3490）。 */
  const quitArmedRef = useRef(false);
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
    setPicker({
      status: 'loading',
      items: [],
      scanned: 0,
      reachedStart: true,
      hiddenByLimit: 0,
      selected: 0,
      loadedAt: 0,
    });
    controller.listConversations().then(
      ({ items, at, scanned, reachedStart, hiddenByLimit }) =>
        setPicker((p) =>
          p === null
            ? p
            : {
                status: 'ready',
                items,
                scanned,
                reachedStart,
                hiddenByLimit,
                selected: 0,
                loadedAt: at,
              },
        ),
      (error: unknown) => {
        setPicker(null);
        controller.addError(redactedErrorMessage(error));
      },
    );
  };

  /** 承認待ちの詳細を id から開く（会話の `ask_human` の案内・`/approvals <id>`）。 */
  const openApproval = (id: string): void => {
    setTab('approvals');
    setZone('nav');
    setPicker(null);
    setApAnchor(apLogHeight);
    setApBuffer(emptyBuffer());
    void approvals.open(id);
  };

  const goTab = (next: TabId): void => {
    setTab(next);
    if (next === 'approvals') {
      approvals.enter();
      setApAnchor(apLogHeight);
    }
    if (next === 'managers') managers.enter();
    if (next === 'journal') journal.enter();
    if (next === 'memory') memory.enter();
    setZone(next === 'chat' ? 'input' : 'nav');
    setPicker(null);
  };

  /**
   * `/journal [件数] [type=<種別,…>] [q=<語>]`。CLI `/journal` と同じ `parseJournalSearchTokens` で解く
   * （知らない種別は問い合わせる前に断る）。引数が無ければ今の絞りのまま画面へ移るだけ。
   */
  const applyJournalArgs = (args: string): void => {
    const tokens = args.split(/\s+/).filter((t) => t.length > 0);
    if (tokens.length === 0) return;
    const parsed = parseJournalSearchTokens(tokens);
    if (!parsed.ok) {
      journal.note(parsed.message);
      return;
    }
    let pageSize: number | undefined;
    if (parsed.limit !== undefined) {
      const n = Number(parsed.limit);
      if (!Number.isInteger(n) || n < 1 || n > JOURNAL_MAX_LIMIT) {
        journal.note(`件数は 1〜${String(JOURNAL_MAX_LIMIT)} の整数で指定する（${parsed.limit}）`);
        return;
      }
      pageSize = n;
    }
    const types = (parsed.type ?? '')
      .split(',')
      .filter((t): t is JournalType => (JOURNAL_TYPES as readonly string[]).includes(t));
    setJAnchor('bottom');
    journal.setFilter(types, parsed.q ?? '', pageSize);
  };

  const runCommand = (action: CommandAction, args = ''): void => {
    // 会話の側へ効く（または会話のログへ書く）コマンドは、結果が見えるよう会話へ移ってから実行する。
    if (
      tabRef.current !== 'chat' &&
      (action === 'help' ||
        action === 'conversations' ||
        action === 'resume' ||
        action === 'new' ||
        action === 'end' ||
        action === 'interrupt' ||
        action === 'attach' ||
        action === 'attachments' ||
        action === 'detach')
    ) {
      goTab('chat');
    }
    switch (action) {
      case 'help':
        controller.addSystem(helpLines().join('\n'));
        break;
      case 'exit':
        quit();
        break;
      case 'journal':
        // 絞りを先に決める（画面を開く読み込みと二重にならないように）。
        applyJournalArgs(args);
        goTab(action);
        break;
      case 'approvals': {
        const id = args.split(/\s+/)[0] ?? '';
        if (id.length > 0) openApproval(id);
        else goTab(action);
        break;
      }
      case 'chat':
      case 'managers':
      case 'memory':
        goTab(action);
        break;
      case 'conversations':
        openPicker();
        break;
      case 'resume': {
        const id = args.split(/\s+/)[0] ?? '';
        void controller.resumeConversation(id.length > 0 ? id : undefined).then((ok) => {
          if (ok) setAnchor('bottom');
        });
        break;
      }
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
      case 'attach':
        void controller.attach(args);
        break;
      case 'attachments':
        controller.listAttachments();
        break;
      case 'detach':
        controller.detach(args);
        break;
    }
  };

  const submit = (text: string): void => {
    const resolved = resolveCommand(text);
    // 未知のコマンドとして断るときは、書いた文を消さない（`/var/log/…` で始まる普通の文を打ち直させない。#3406）。
    if (resolved.kind !== 'unknown') setBuffer(emptyBuffer());
    if (text.length === 0 && !controller.hasAttachments()) return;
    if (resolved.kind === 'command') return runCommand(resolved.spec.action, resolved.args);
    if (resolved.kind === 'unknown') {
      controller.addSystem(
        `不明なコマンド: /${resolved.name}（/help で一覧。/ で始まる文をそのまま送るなら // で始める）`,
      );
      return;
    }
    setAnchor('bottom');
    // 前の送信を引けなくて送らなかったときは、打った文を入力欄へ戻す（打ち直しを求めない。#3304）。
    void controller.send(resolved.text).then((sent) => {
      if (!sent && isEmptyBuffer(bufferRef.current)) setBuffer(bufferOf(text));
    });
  };

  /** 委譲の詳細の入力欄の Enter。スラッシュコマンドは解決し、それ以外は追加指示として送る。 */
  const submitManager = (text: string): void => {
    const resolved = resolveCommand(text);
    // 未知のコマンドとして断るときは、書いた文を消さない（会話の `submit` と同じ。#3406・#3486）。
    if (resolved.kind !== 'unknown') setMgrBuffer(emptyBuffer());
    if (text.length === 0) return;
    if (resolved.kind === 'command') return runCommand(resolved.spec.action, resolved.args);
    if (resolved.kind === 'unknown') {
      managers.setNotice(
        `不明なコマンド: /${resolved.name}（/help で一覧。/ で始まる文をそのまま送るなら // で始める）`,
      );
      return;
    }
    setMgrAnchor('bottom');
    // 送れなかった（失敗・送信中）ときは、打った文を入力欄へ戻す（#3367。会話の #3304 と同じ形）。
    void managers.sendMessage(resolved.text).then((sent) => {
      if (!sent && isEmptyBuffer(mgrBufferRef.current)) setMgrBuffer(bufferOf(text));
    });
  };

  /** 生ログの総行数（ハンドラの中で最新の状態から数える）。 */
  const mgrTotalRows = (): number =>
    logLines(managers.store.getSnapshot().detail?.transcript ?? [], columns).length;

  /**
   * 委譲タブの nav ゾーンのキー。消費したら true。数字・`/` は呼び出し側の共通処理へ落とす。
   * 一覧: ↑↓ 選択 / Enter 詳細 / f 絞り / m 古い側 / r 更新。
   * 詳細: Esc 一覧へ / i・Tab・Enter 指示 / s 停止（y で確定）/ ↑↓ PgUp PgDn 生ログ / r 更新。
   */
  const handleManagersNav = (
    input: string,
    key: Parameters<Parameters<typeof useInput>[0]>[1],
  ): boolean => {
    const state = managers.store.getSnapshot();
    if (state.view === 'list') {
      if (key.upArrow) managers.moveSelection(-1);
      else if (key.downArrow) managers.moveSelection(1);
      else if (key.pageUp) managers.moveSelection(-pageStep(layout.bodyHeight));
      else if (key.pageDown) managers.moveSelection(pageStep(layout.bodyHeight));
      else if (key.return) {
        setMgrAnchor('bottom');
        managers.openSelected();
      } else if (input === 'f') managers.cycleFilter();
      else if (input === 'm') void managers.loadOlder();
      else if (input === 'r') void managers.loadList();
      else return false;
      return true;
    }
    const detail = state.detail;
    if (detail === null) return false;
    if (!key.escape) mgrDiscardArmedRef.current = false;
    if (detail.confirmStop) {
      // 確認中は全部のキーをここで受ける。y だけが確定。
      if (input === 'y') void managers.confirmStop();
      else managers.cancelStop();
      return true;
    }
    const step = pageStep(mgrLogHeight);
    if (key.escape) {
      // 書きかけは黙って捨てない。1 度目の Esc は残して言い、もう一度押したら捨てて戻る（#3367）。
      if (!isEmptyBuffer(mgrBufferRef.current) && !mgrDiscardArmedRef.current) {
        mgrDiscardArmedRef.current = true;
        managers.setNotice(
          '書きかけの追加指示が残っている。もう一度 Esc で捨てて一覧へ戻る（i で続きを書く）',
        );
        return true;
      }
      mgrDiscardArmedRef.current = false;
      setMgrAnchor('bottom');
      setMgrBuffer(emptyBuffer());
      managers.back();
    } else if (key.pageUp) {
      setMgrAnchor(scrollUp(mgrAnchorRef.current, mgrTotalRows(), mgrLogHeight, step));
    } else if (key.pageDown) {
      setMgrAnchor(scrollDown(mgrAnchorRef.current, mgrTotalRows(), mgrLogHeight, step));
    } else if (key.upArrow) {
      setMgrAnchor(scrollUp(mgrAnchorRef.current, mgrTotalRows(), mgrLogHeight, 1));
    } else if (key.downArrow) {
      setMgrAnchor(scrollDown(mgrAnchorRef.current, mgrTotalRows(), mgrLogHeight, 1));
    } else if (key.tab || key.return || input === 'i') {
      setZone('input');
    } else if (input === 's') managers.askStop();
    else if (input === 'r') void managers.refreshDetail();
    else return false;
    return true;
  };

  /** 承認待ちの本文の総行数（ハンドラの中で最新の状態から数える）。 */
  const apTotalRows = (): number => {
    const detail = approvals.store.getSnapshot().detail;
    return detail === null
      ? 0
      : padRows(approvalDocument(detail, columns).rows, apLogHeight).length;
  };

  /** 入力欄へ、カーソルの指す文字欄（その他・補足・自由文の回答）の中身を読み込んで書き始める。 */
  const startApprovalEdit = (): void => {
    setApBuffer(bufferOf(approvals.fieldText()));
    setZone('input');
  };

  /**
   * 承認待ちタブの nav ゾーンのキー。消費したら true。数字・`/` は呼び出し側の共通処理へ落とす。
   * 一覧: ↑↓ 選択 / Enter 詳細 / d 回答済み（決着した日 → その日の件 → 詳細）/ r 更新。
   * 詳細（読む）: Esc 一覧へ / a・i・Enter・Tab 答える / ↑↓ PgUp PgDn / r 更新。
   * 詳細（答える）: ↑↓ 移動 / Space・Enter 選ぶ（文字欄では書く）/ s 確認へ / Esc 読む画面へ。
   * 確認: y だけが送る。それ以外は全部、フォームへ戻る。
   */
  const handleApprovalsNav = (
    input: string,
    key: Parameters<Parameters<typeof useInput>[0]>[1],
  ): boolean => {
    const state = approvals.store.getSnapshot();
    // 回答済み（決着した日 → その日の件 → 既存の詳細。#3340）。
    if (state.view === 'dates') {
      if (key.upArrow) approvals.moveDatesSelection(-1);
      else if (key.downArrow) approvals.moveDatesSelection(1);
      else if (key.pageUp) approvals.moveDatesSelection(-pageStep(layout.bodyHeight));
      else if (key.pageDown) approvals.moveDatesSelection(pageStep(layout.bodyHeight));
      else if (key.return) approvals.openDay();
      else if (key.escape || input === 'd') approvals.leaveDates();
      else if (input === 'm') void approvals.loadMoreDates();
      else if (input === 'r') void approvals.loadDates();
      else return false;
      return true;
    }
    if (state.view === 'day') {
      if (key.upArrow) approvals.moveDaySelection(-1);
      else if (key.downArrow) approvals.moveDaySelection(1);
      else if (key.pageUp) approvals.moveDaySelection(-pageStep(layout.bodyHeight));
      else if (key.pageDown) approvals.moveDaySelection(pageStep(layout.bodyHeight));
      else if (key.return) {
        setApAnchor(apLogHeight);
        setApBuffer(emptyBuffer());
        approvals.openDayItem();
      } else if (key.escape) approvals.leaveDay();
      else if (input === 'r') void approvals.loadDay();
      else return false;
      return true;
    }
    if (state.view === 'list') {
      if (key.upArrow) approvals.moveSelection(-1);
      else if (key.downArrow) approvals.moveSelection(1);
      else if (key.pageUp) approvals.moveSelection(-pageStep(layout.bodyHeight));
      else if (key.pageDown) approvals.moveSelection(pageStep(layout.bodyHeight));
      else if (key.return) {
        setApAnchor(apLogHeight);
        setApBuffer(emptyBuffer());
        approvals.openSelected();
      } else if (input === 'd') approvals.openDates();
      else if (input === 'r') void approvals.reload();
      else return false;
      return true;
    }
    const detail = state.detail;
    if (detail === null) return false;
    if (detail.mode === 'confirm') {
      if (input === 'y') {
        void approvals.confirmSend().then((sent) => {
          if (!sent) return;
          setApBuffer(emptyBuffer());
          setApAnchor(apLogHeight);
        });
      } else approvals.cancelConfirm();
      return true;
    }
    if (detail.mode === 'form') {
      if (key.escape) {
        setApAnchor(apLogHeight);
        approvals.leaveForm();
      } else if (key.upArrow) approvals.moveCursor(-1);
      else if (key.downArrow) approvals.moveCursor(1);
      else if (key.pageUp) approvals.moveCursor(-pageStep(apLogHeight));
      else if (key.pageDown) approvals.moveCursor(pageStep(apLogHeight));
      else if (isSpaceKey(input) || key.return) {
        if (approvals.activate() === 'edit') startApprovalEdit();
      } else if (input === 's') approvals.askConfirm();
      else if (input === 'r') void approvals.reload();
      else return false;
      return true;
    }
    const step = pageStep(apLogHeight);
    if (key.escape) {
      setApAnchor(apLogHeight);
      setApBuffer(emptyBuffer());
      approvals.back();
    } else if (key.pageUp) {
      setApAnchor(scrollUp(apAnchorRef.current, apTotalRows(), apLogHeight, step));
    } else if (key.pageDown) {
      setApAnchor(scrollDown(apAnchorRef.current, apTotalRows(), apLogHeight, step));
    } else if (key.upArrow) {
      setApAnchor(scrollUp(apAnchorRef.current, apTotalRows(), apLogHeight, 1));
    } else if (key.downArrow) {
      setApAnchor(scrollDown(apAnchorRef.current, apTotalRows(), apLogHeight, 1));
    } else if (input === 'a' || input === 'i' || key.return || key.tab) {
      if (approvals.startAnswer() === 'edit') startApprovalEdit();
    } else if (input === 'r') void approvals.reload();
    else return false;
    return true;
  };

  /** 日誌の全文の総行数（ハンドラの中で最新の状態から数える）。 */
  const jTotalRows = (): number => {
    const detail = journal.store.getSnapshot().detail;
    return detail === null ? 0 : journalDetailLines(detail, columns).length;
  };
  const memTotalRows = (): number =>
    logLines(memory.store.getSnapshot().detail?.body ?? [], columns).length;

  /**
   * 日誌タブの nav ゾーンのキー。消費したら true。
   * 一覧: ↑↓ PgUp/PgDn 選択（最新に居る間は末尾に追従）/ Enter 全文 / f 種別 / n 最新へ / m 古い側 / r 更新。
   * 種別の選択: ↑↓ Space Enter c Esc。全文: Esc 一覧へ / ↑↓ PgUp PgDn。
   */
  const handleJournalNav = (
    input: string,
    key: Parameters<Parameters<typeof useInput>[0]>[1],
  ): boolean => {
    const state = journal.store.getSnapshot();
    if (state.view === 'filter') {
      if (key.escape) journal.cancelFilter();
      else if (key.upArrow) journal.moveFilterCursor(-1);
      else if (key.downArrow) journal.moveFilterCursor(1);
      else if (isSpaceKey(input)) journal.toggleFilterDraft();
      else if (key.return) {
        setJAnchor('bottom');
        journal.applyFilter();
      } else if (input === 'c') journal.clearFilterDraft();
      else return false;
      return true;
    }
    if (state.view === 'detail') {
      const step = pageStep(jLogHeight);
      if (key.escape) {
        setJAnchor('bottom');
        journal.back();
      } else if (key.pageUp)
        setJAnchor(scrollUp(jAnchorRef.current, jTotalRows(), jLogHeight, step));
      else if (key.pageDown)
        setJAnchor(scrollDown(jAnchorRef.current, jTotalRows(), jLogHeight, step));
      else if (key.upArrow) setJAnchor(scrollUp(jAnchorRef.current, jTotalRows(), jLogHeight, 1));
      else if (key.downArrow)
        setJAnchor(scrollDown(jAnchorRef.current, jTotalRows(), jLogHeight, 1));
      else return false;
      return true;
    }
    const page = pageStep(layout.bodyHeight);
    if (key.upArrow) journal.moveSelection(1);
    else if (key.downArrow) journal.moveSelection(-1);
    else if (key.pageUp) journal.moveSelection(page);
    else if (key.pageDown) journal.moveSelection(-page);
    else if (key.return) {
      // 全文は頭から読む（末尾追従のログとは逆に、窓を先頭の 1 画面に置く）。
      setJAnchor(jLogHeight);
      journal.openDetail();
    } else if (input === 'f') journal.openFilter();
    else if (input === 'n') journal.jumpNewest();
    else if (input === 'm') void journal.loadOlder();
    else if (input === 'r') void journal.load();
    else return false;
    return true;
  };

  /** 記憶タブの nav ゾーンのキー。一覧: ↑↓ 選択 / Enter 開く / r 更新。詳細: Esc 一覧へ / ↑↓ PgUp PgDn。 */
  const handleMemoryNav = (
    input: string,
    key: Parameters<Parameters<typeof useInput>[0]>[1],
  ): boolean => {
    const state = memory.store.getSnapshot();
    if (state.view === 'detail') {
      const step = pageStep(memLogHeight);
      if (key.escape) {
        setMemAnchor('bottom');
        memory.back();
      } else if (key.pageUp)
        setMemAnchor(scrollUp(memAnchorRef.current, memTotalRows(), memLogHeight, step));
      else if (key.pageDown)
        setMemAnchor(scrollDown(memAnchorRef.current, memTotalRows(), memLogHeight, step));
      else if (key.upArrow)
        setMemAnchor(scrollUp(memAnchorRef.current, memTotalRows(), memLogHeight, 1));
      else if (key.downArrow)
        setMemAnchor(scrollDown(memAnchorRef.current, memTotalRows(), memLogHeight, 1));
      else if (input === 'r') void memory.refreshDetail();
      else return false;
      return true;
    }
    const page = Math.max(1, pageStep(layout.bodyHeight) >> 1);
    if (key.upArrow) memory.moveSelection(-1);
    else if (key.downArrow) memory.moveSelection(1);
    else if (key.pageUp) memory.moveSelection(-page);
    else if (key.pageDown) memory.moveSelection(page);
    else if (key.return) {
      setMemAnchor(memLogHeight);
      memory.openSelected();
    } else if (input === 'r') void memory.loadList();
    else return false;
    return true;
  };

  useInput((rawInput, rawKey) => {
    const { input, key } = normalizeChord(rawInput, rawKey);

    // 通知は次のキーで消す。Ctrl+D の 2 度目の待ちも、Ctrl+D 以外のキーで解く。
    setFootNote(null);
    if (!(key.ctrl && input === 'd')) quitArmedRef.current = false;

    if (key.ctrl && input === 'c') {
      const where = tabRef.current;
      void controller.interrupt().then((result) => {
        // 会話のログが見えない画面では、結果（失敗も）を最下行にも出す（#3489）。
        if (where !== 'chat') setFootNote(result.ok ? result.text : `✗ ${result.text}`);
      });
      return;
    }
    if (key.ctrl && input === 'd') {
      // 書きかけ（会話・委譲・承認待ちの入力欄）が在れば、1 度目は言うだけで、2 度目で終了する。
      // どの画面・どのゾーンでも同じ（委譲の Esc 二度押しと揃える。#3490）。
      const hasDraft =
        !isEmptyBuffer(bufferRef.current) ||
        !isEmptyBuffer(mgrBufferRef.current) ||
        (tabRef.current === 'approvals' &&
          zoneRef.current === 'input' &&
          !isEmptyBuffer(apBufferRef.current));
      if (hasDraft && !quitArmedRef.current) {
        quitArmedRef.current = true;
        setFootNote('書きかけが残っている。もう一度 ^D で捨てて終了する');
        return;
      }
      quit();
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

    // 委譲の詳細の入力欄（追加指示）。Esc は入力欄 → 一覧の順に閉じる。
    if (tabRef.current === 'managers' && zoneRef.current === 'input') {
      if (key.escape || key.tab) return setZone('nav');
      if (key.pageUp)
        return setMgrAnchor(
          scrollUp(mgrAnchorRef.current, mgrTotalRows(), mgrLogHeight, pageStep(mgrLogHeight)),
        );
      if (key.pageDown)
        return setMgrAnchor(
          scrollDown(mgrAnchorRef.current, mgrTotalRows(), mgrLogHeight, pageStep(mgrLogHeight)),
        );
      if (key.return) {
        const action = resolveEnter(mgrBufferRef.current, key);
        if (action.kind === 'newline') setMgrBuffer(action.buffer);
        else submitManager(action.text);
        return;
      }
      const edited = editText(mgrBufferRef.current, input, key, { wrapWidth });
      if (edited.changed) setMgrBuffer(edited.buffer);
      return;
    }

    // 承認待ちの詳細の入力欄（「その他」・補足・自由文の回答）。Esc は、書いた文を欄へ置いて抜ける。
    // 設問の無い承認待ちの Enter は、書いた自由文を回答として確認へ進む。
    if (tabRef.current === 'approvals' && zoneRef.current === 'input') {
      if (key.escape || key.tab) {
        approvals.setFieldText(apBufferRef.current.value);
        return setZone('nav');
      }
      if (key.return) {
        const action = resolveEnter(apBufferRef.current, key);
        if (action.kind === 'newline') setApBuffer(action.buffer);
        else {
          approvals.submitField(action.text);
          setZone('nav');
        }
        return;
      }
      const edited = editText(apBufferRef.current, input, key, { wrapWidth });
      if (edited.changed) setApBuffer(edited.buffer);
      return;
    }

    // 入力欄の外（nav）。
    if (tabRef.current === 'approvals' && handleApprovalsNav(input, key)) return;
    if (tabRef.current === 'managers' && handleManagersNav(input, key)) return;
    if (tabRef.current === 'journal' && handleJournalNav(input, key)) return;
    if (tabRef.current === 'memory' && handleMemoryNav(input, key)) return;
    if (input === '/') {
      // 会話の書きかけは「/」で置き換えて消さない。空のときだけ「/」から書き始める（#3488）。
      goTab('chat');
      if (isEmptyBuffer(bufferRef.current)) setBuffer({ value: '/', cursor: 1 });
      return;
    }
    const digit = TABS.find((t) => t.key === input);
    if (digit !== undefined) return goTab(digit.id);
    if (tabRef.current === 'chat') {
      // 会話で `ask_human` が来ていれば、その承認待ちの詳細へ飛ぶ。
      const asked = controller.store.getSnapshot().pendingAsk;
      if (input === 'a' && asked !== null) return openApproval(asked);
      if (key.tab || key.return || input === 'i') return setZone('input');
      if (key.upArrow)
        return setAnchor(scrollUp(anchorRef.current, totalRows(), layout.logHeight, 1));
      if (key.downArrow)
        return setAnchor(scrollDown(anchorRef.current, totalRows(), layout.logHeight, 1));
    }
  });

  // 入力欄の上端の画面上の行: ヘッダ + タブ + ログ + 状態行 + 上の罫線。
  const cursorTop = inMgrDetail
    ? 2 + DETAIL_HEAD_ROWS + mgrLogHeight + 1 + 1
    : 2 + layout.logHeight + 1 + 1;
  const baseHint = quitting
    ? HINT_QUITTING
    : picker !== null
      ? HINT_PICKER
      : tab === 'approvals'
        ? ap.view === 'list'
          ? HINT_AP_LIST
          : ap.view === 'dates'
            ? HINT_AP_DATES
            : ap.view === 'day'
              ? HINT_AP_DAY
              : ap.detail?.mode === 'confirm'
                ? HINT_AP_CONFIRM
                : zone === 'input'
                  ? HINT_AP_INPUT
                  : ap.detail?.mode === 'form'
                    ? HINT_AP_FORM
                    : approvalDetailHint(ap.detailFrom)
        : tab === 'journal'
          ? jr.view === 'filter'
            ? HINT_JOURNAL_FILTER
            : jr.view === 'detail'
              ? HINT_JOURNAL_DETAIL
              : HINT_JOURNAL_LIST
          : tab === 'memory'
            ? mem.view === 'detail'
              ? HINT_MEM_DETAIL
              : HINT_MEM_LIST
            : tab === 'managers'
              ? mgr.view === 'list'
                ? HINT_MGR_LIST
                : mgr.detail?.confirmStop === true
                  ? HINT_MGR_CONFIRM
                  : zone === 'input'
                    ? HINT_MGR_INPUT
                    : HINT_MGR_DETAIL
              : tab === 'chat' && zone === 'input'
                ? HINT_INPUT
                : HINT_NAV;

  const hint = quitting ? baseHint : (footNote ?? baseHint);

  return (
    <Box
      flexDirection="column"
      width={columns}
      {...(fullscreen ? { height: rows, overflow: 'hidden' as const } : {})}
    >
      <Header baseUrl={api.baseUrl} state={header} />
      <Tabs active={tab} counts={header.counts} />
      {tab === 'approvals' ? (
        ap.view === 'detail' && ap.detail !== null ? (
          <>
            <LogView lines={apWin.entries} height={apLogHeight} />
            <DetailStatusRow {...approvalStatusText(ap.detail, apWin.hiddenBelow)} />
            <PromptInput
              rows={composer.rows.slice(composerWindow.start, composerWindow.end)}
              window={{ start: 0, end: composerWindow.end - composerWindow.start }}
              caret={{ row: composer.caret.row - composerWindow.start, col: composer.caret.col }}
              focused={zone === 'input'}
              placeholder={composerPlaceholder(ap.detail)}
              cursorTop={cursorTop}
            />
          </>
        ) : ap.view === 'dates' ? (
          <AnsweredDatesList dates={ap.dates} height={layout.bodyHeight} />
        ) : ap.view === 'day' ? (
          <AnsweredDayList day={ap.day} height={layout.bodyHeight} />
        ) : (
          <ApprovalList list={ap.list} height={layout.bodyHeight} />
        )
      ) : tab === 'managers' ? (
        mgr.view === 'detail' && mgr.detail !== null ? (
          <>
            <ManagerDetailHead detail={mgr.detail} />
            <LogView lines={mgrWin.entries} height={mgrLogHeight} />
            <DetailStatusRow {...detailStatusText(mgr.detail, mgrWin.hiddenBelow)} />
            <PromptInput
              rows={composer.rows.slice(composerWindow.start, composerWindow.end)}
              window={{ start: 0, end: composerWindow.end - composerWindow.start }}
              caret={{ row: composer.caret.row - composerWindow.start, col: composer.caret.col }}
              focused={zone === 'input'}
              placeholder={mgr.detail.busy ? '送信中…' : '追加指示（i で書く · /help でコマンド）'}
              cursorTop={cursorTop}
            />
          </>
        ) : (
          <ManagerList list={mgr.list} height={layout.bodyHeight} />
        )
      ) : tab === 'journal' ? (
        jr.view === 'detail' && jr.detail !== null ? (
          <>
            <JournalDetailHead entry={jr.detail} now={jr.loadedAt} />
            <LogView lines={jWin.entries} height={jLogHeight} />
            <JournalDetailStatus hiddenBelow={jWin.hiddenBelow} />
          </>
        ) : jr.view === 'filter' ? (
          <JournalFilter state={jr} height={layout.bodyHeight} />
        ) : (
          <JournalList state={jr} height={layout.bodyHeight} live={header.live} />
        )
      ) : tab === 'memory' ? (
        mem.view === 'detail' && mem.detail !== null ? (
          <>
            <MemoryDetailHead detail={mem.detail} />
            <LogView lines={memWin.entries} height={memLogHeight} />
            <DetailStatusRow {...memoryDetailStatus(mem.detail, memWin.hiddenBelow)} />
          </>
        ) : (
          <MemoryList state={mem} height={layout.bodyHeight} />
        )
      ) : picker !== null ? (
        <ConversationPicker
          status={picker.status}
          items={picker.items}
          scanned={picker.scanned}
          reachedStart={picker.reachedStart}
          hiddenByLimit={picker.hiddenByLimit}
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
