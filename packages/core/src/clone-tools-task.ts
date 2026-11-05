// task と進捗・外部観測・inbox の掃除（task_* / progress_read / github_observation_record / inbox_remove_many）の道具。
// `tools.ts` から呼ぶ（`createCloneTools` が並びのまま連結する）。このファイルから `tools.ts` を import しない（一方向）。

import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  describeOffsetRequiredTimeBoundary,
  isOffsetQualifiedTimeBoundary,
} from './journal-time.js';
import { journalEntryShape, noteDroppedRecord } from './dropped-record.js';
import { collapseErrorCause } from './error-cause.js';
import { describePage, excerptLine, page, renderListing, renderListingEntry } from './excerpt.js';
import {
  DEFAULT_PROGRESS_WINDOW_HOURS,
  InvalidProgressWindowError,
  readProgress,
} from './progress-read.js';
import { removeInboxChunkJournalFirst } from './removal-journal-first.js';
import { describeProgress } from './progress-describe.js';
import { stripNul } from './nul-guard.js';
import {
  taskOriginSchema,
  githubObservationInputSchema,
  taskStatusSchema,
  type TaskStatus,
  type Task,
  type TaskOrigin,
  type JournalEntryInput,
} from './schema.js';
import {
  TASK_BODY_LIMIT,
  TASK_LIST_BUDGET,
  TASK_PAGE,
  TASK_PLACEMENT_TARGETS,
  TASK_TITLE_MAX,
  UNREADABLE_TASK_IDS_SHOWN,
  describeTaskClosedRecord,
  describeTaskPlacement,
  encodeTaskCursor,
  resolveTaskCursor,
  resolveTaskPlacement,
  taskKeepChangeEntry,
  taskStatusChangeEntry,
  taskStatusLine,
} from './task-tools.js';
import {
  UnreadableTaskError,
  describeUnreadableInboxEvents,
  type JournalStore,
  type TaskStore,
} from './store.js';
import {
  CLONE_REMOVABLE_INBOX_EVENT_TYPES,
  inboxRemoveManyTypesSchema,
  matchesInboxRemoveManyFilter,
  type InboxRemoveManyFilter,
} from './inbox-backlog.js';
import { chunkIdsByChars } from './chunk-ids.js';
import {
  CLOSE_MANY_IDS_SHOWN,
  CLOSE_MANY_JOURNAL_ID_CHARS,
  CLOSE_MANY_LIMIT_MAX,
  CLOSE_MANY_SOURCES_SHOWN,
  closeManyInChunks,
  describeCloseManyFilter,
  TASK_STATUS_MANY_TARGETS,
  describeTaskStatusManyViolation,
  selectTaskStatusManyTargets,
  taskStatusManyStore,
} from './task-set-status-many.js';
import {
  describeArrayLengthViolation,
  describeBlankViolation,
  describeIntRangeViolation,
  describeStringArrayElementLengthViolation,
  describeStringLengthViolation,
  formatArrayLengthJa,
  formatIntRangeJa,
  formatStringLengthJa,
} from './tool-arg-checks.js';
import { REMOVE_MANY_LIMIT_DEFAULT, REMOVE_MANY_LIMIT_MAX } from './remove-many-limit.js';
import {
  appendJournalOrDrop,
  tool,
  text,
  appendJournalOrThrow,
  JournalNotRecordedError,
} from './clone-tools-common.js';
import type { ToolContext, CloneToolsShared } from './clone-tools-context.js';

// モデルの引数からは受けない: 名乗りを引数に任せると「誰の観測か」が申告の申告になるため
export const GITHUB_OBSERVATION_CLONE_OBSERVER = 'clone';

export const REMOVE_MANY_JOURNAL_ID_CHARS = 3_600;

const REMOVE_MANY_IDS_SHOWN = 20;

const TASK_ORIGIN_LABEL: Record<TaskOrigin, string> = {
  human: '人間の依頼',
  manager: 'マネージャーの報告',
  external: '外部イベント',
  self: '自分で気づいた宿題',
};

function taskOriginBadge(entry: { origin: TaskOrigin; source?: string }): string {
  const label = TASK_ORIGIN_LABEL[entry.origin];
  return entry.source === undefined ? `[${label}]` : `[${label} / ${entry.source}]`;
}

// `.min(1)` を入力スキーマ側に置かない: SDK の `tool()` がハンドラより前に検証するため、件数の検査はハンドラの先頭の `safeParse` へ渡す
const inboxRemoveManyTypesToolInputSchema = z.array(z.enum(CLONE_REMOVABLE_INBOX_EVENT_TYPES));

class CloseManyStoppedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CloseManyStoppedError';
  }
}

// 「完了した」と言わない: 塊の途中で止まった回に `act-completed` の定型（「完了した・やり直さないこと」）を返すと、残りの塊を閉じないまま終わったと読まれるため
// 前の塊の id は先頭の1塊ぶん（日誌と同じ文字数の予算）だけ出す: 全件を並べると件数で応答が溢れる。この塊の id は日誌に無く書き直す材料がここにしか無いので、省略しない
function formatCloseManyStoppedMessage(args: {
  failed: { chunk: { number: number; total: number }; closed: readonly string[] };
  journaledIds: readonly string[];
  entry: JournalEntryInput;
  cause: unknown;
  /** ここまでに処理した件数（この塊までの塊の id の合計）。競合で閉じられなかった分を数える母数で、まだ処理していない塊は含めない */
  processedCount: number;
  /** 1回の上限に収まらず対象にしなかった件数と、その上限 */
  restCount: number;
  limit: number;
}): string {
  const { failed, journaledIds, entry, cause, processedCount, restCount, limit } = args;
  const shape = journalEntryShape(entry);
  const reason = collapseErrorCause(cause);
  const shownPrior = chunkIdsByChars(journaledIds, CLOSE_MANY_JOURNAL_ID_CHARS)[0] ?? [];
  const hiddenPrior = journaledIds.length - shownPrior.length;
  const remainingChunks = failed.chunk.total - failed.chunk.number;
  const closedTotal = journaledIds.length + failed.closed.length;
  // 最後の塊では全件を処理し終えている: 「閉じていない」と言うと、同じ絞り込みで呼び直されて上限の外の行や間に届いた行まで閉じるため
  const lastChunk = remainingChunks === 0;
  // 競合の数は処理した塊だけで数える: 対象の総数との差にすると、まだ処理していない塊の分まで競合に混ざる
  const raced = processedCount - closedTotal;
  return [
    lastChunk
      ? '⚠⚠ 全件を閉じ終えた・最後の塊の日誌が未記録・閉じ直し禁止'
      : '⚠⚠ 一括は途中で止まった・この塊の日誌が未記録・残りの塊は閉じていない',
    lastChunk
      ? `task_set_status_many は対象の全件を処理し終えた（閉じた task を戻すには task_set_status で1件ずつ queued にする）。` +
        `最後の ${failed.chunk.number}/${failed.chunk.total} 塊目の日誌を書けなかった。`
      : `task_set_status_many は途中で止まった（全件は閉じていない。「完了した」ではない）。` +
        `${failed.chunk.number}/${failed.chunk.total} 塊目まで閉じたところで、この塊の日誌を書けなかった。`,
    `ここまでに閉じた id は ${closedTotal} 件` +
      `（前の塊の ${journaledIds.length} 件は日誌に記録済み、この塊の ${failed.closed.length} 件は未記録）。`,
    ...(raced > 0
      ? [
          `⚠ ここまでに処理した ${processedCount} 件のうち ${raced} 件は閉じられなかった（この呼びの最中に他の経路が先に閉じた）。`,
        ]
      : []),
    `この塊の閉じた id（日誌に無い）: ${failed.closed.join(' ')}`,
    ...(journaledIds.length === 0
      ? []
      : [
          `前の塊の閉じた id（先頭 ${shownPrior.length} 件）: ${shownPrior.join(' ')}${
            hiddenPrior > 0 ? ` …ほか ${hiddenPrior} 件は省略（日誌に残してある）` : ''
          }`,
        ]),
    lastChunk
      ? '残りの塊は無い。この呼びの対象は閉じ終えているので、やり直さないこと（呼び直すと、この呼びの対象の外にあった行や間に届いた行まで閉じかねない）。'
      : `残りの ${remainingChunks} 塊は閉じていない。同じ絞り込みでもう一度呼べば続きを閉じられる（閉じた行は未了から外れているので、閉じ直しにはならない）。`,
    ...(restCount === 0
      ? []
      : [
          `1回の上限（${limit} 件）に収まらず対象にしなかった ${restCount} 件は、そもそもこの呼びでは閉じていない` +
            (lastChunk ? '（journal_write で記録を書き直した後に、別の呼びで閉じること）。' : '。'),
        ]),
    `記録できなかったエントリ: ${shape}`,
    `理由: ${reason}`,
    'journal_write で、この塊の閉じた id を記録に書き直すこと。閉じ直さないこと。',
  ].join('\n');
}

// 閉じる側（task の書き込み）が投げた回: 日誌が落ちた回（`formatCloseManyStoppedMessage`）と違い、この塊の日誌は書いていない。ここまでに閉じた分は前の塊で、日誌に記録済み
// task は1件ずつ書くので、失敗した塊は途中まで閉じていることがありうる（その分は日誌に無い）: 「閉じていない」と言い切らず、task_list で確かめさせる
function formatCloseManyCloseFailedMessage(args: {
  failedChunk: { number: number; total: number };
  journaledIds: readonly string[];
  cause: unknown;
  /** この塊より前に処理した件数（競合で閉じられなかった分を数える母数。この塊と、まだ処理していない塊は含めない） */
  processedCount: number;
  restCount: number;
  limit: number;
}): string {
  const { failedChunk, journaledIds, cause, processedCount, restCount, limit } = args;
  const reason = collapseErrorCause(cause);
  const shownPrior = chunkIdsByChars(journaledIds, CLOSE_MANY_JOURNAL_ID_CHARS)[0] ?? [];
  const hiddenPrior = journaledIds.length - shownPrior.length;
  const unclosedChunks = failedChunk.total - failedChunk.number + 1;
  const raced = processedCount - journaledIds.length;
  return [
    '⚠⚠ 一括は途中で止まった・この塊の task の書き込みが失敗した・この塊以降は閉じ切っていない',
    `task_set_status_many は途中で止まった（全件は閉じていない。「完了した」ではない）。` +
      `${failedChunk.number}/${failedChunk.total} 塊目の task の書き込みが失敗した（この塊は途中まで閉じている可能性があり、その分の日誌は無い）。`,
    journaledIds.length === 0
      ? 'ここまでに閉じた id は 0 件（1 塊目で失敗したので、1件も閉じていない）。'
      : `ここまでに閉じた id は ${journaledIds.length} 件（前の塊の分。日誌に記録済み）。`,
    ...(raced > 0
      ? [
          `⚠ ここまでに処理した ${processedCount} 件のうち ${raced} 件は閉じられなかった（この呼びの最中に他の経路が先に閉じた）。`,
        ]
      : []),
    ...(journaledIds.length === 0
      ? []
      : [
          `前の塊の閉じた id（先頭 ${shownPrior.length} 件）: ${shownPrior.join(' ')}${
            hiddenPrior > 0 ? ` …ほか ${hiddenPrior} 件は省略（日誌に残してある）` : ''
          }`,
        ]),
    `この塊以降の ${unclosedChunks} 塊は閉じ切っていない。同じ絞り込みでもう一度呼べば続きを閉じられる（閉じた task は開いている一覧から外れているので、閉じ直しにはならない）。` +
      '失敗した塊の中身は task_list で確かめること。',
    ...(restCount === 0
      ? []
      : [
          `1回の上限（${limit} 件）に収まらず対象にしなかった ${restCount} 件は、そもそもこの呼びでは閉じていない。`,
        ]),
    `理由: ${reason}`,
    '閉じた id の日誌は書き込み済みなので、journal_write で書き直す必要は無い。',
  ].join('\n');
}

type TaskStatusManySelection = Awaited<ReturnType<typeof selectTaskStatusManyTargets>>;
type TaskStatusManyTargetStatus = (typeof TASK_STATUS_MANY_TARGETS)[number];

interface TaskStatusManyFilterArgs {
  origin: readonly TaskOrigin[];
  source: readonly string[] | undefined;
  q: string | undefined;
  until: string | undefined;
}

// 漏斗（段ごとの残数）を必ず出す: 「0件だった」と「絞り込みが間違っていた」はどの段で0になったかでしか区別できないため
function renderCloseManyFunnel(
  filter: TaskStatusManyFilterArgs,
  selection: TaskStatusManySelection,
): string {
  const { origin, source, q, until } = filter;
  const { openEntries, afterOrigin, afterSource, afterQ, matched } = selection;
  return [
    `開いている task ${openEntries.length} 件`,
    `origin=[${origin.join(', ')}] で ${afterOrigin.length} 件`,
    ...(source === undefined ? [] : [`source（完全一致）で ${afterSource.length} 件`]),
    ...(q === undefined ? [] : [`q で ${afterQ.length} 件`]),
    ...(until === undefined ? [] : [`until で ${matched.length} 件`]),
  ].join(' → ');
}

// 読めない行は件数を黙って落とさない: 「これで全部だ」と読まれるため
function renderCloseManyUnreadableNote(unreadableCount: number): string[] {
  return unreadableCount === 0
    ? []
    : [
        `⚠ 読めない task の行が ${unreadableCount} 件ある。` +
          'この道具は絞り込みを当てられないので対象に含めていない（task_list で確かめること）。',
      ];
}

function renderCloseManyRestNote(remainingCount: number, effectiveLimit: number): string[] {
  return remainingCount === 0
    ? []
    : [
        `1回の上限（${effectiveLimit} 件）に当たったので、残り ${remainingCount} 件は対象にしていない。` +
          '**同じ絞り込みでもう一度呼べば続きを閉じられる。**',
      ];
}

function describeCloseManyOriginMiss(
  origin: readonly TaskOrigin[],
  openEntries: readonly Task[],
): string {
  const breakdown = taskOriginSchema.options
    .map((known) => `${known} ${openEntries.filter((task) => task.origin === known).length}`)
    .join(' / ');
  return (
    `開いている ${openEntries.length} 件のうち origin=[${origin.join(', ')}] に当たる task が0件——` +
    `**絞り込みが外れている。** いま開いている task の起点の内訳: ${breakdown}`
  );
}

function describeCloseManySourceMiss(
  source: readonly string[],
  afterOrigin: readonly Task[],
): string {
  const counts = new Map<string, number>();
  for (const task of afterOrigin) {
    if (task.source === undefined) continue;
    counts.set(task.source, (counts.get(task.source) ?? 0) + 1);
  }
  const top = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, CLOSE_MANY_SOURCES_SHOWN)
    .map(([name, count]) => `${name} ${count}`)
    .join(' / ');
  const rest = counts.size - Math.min(counts.size, CLOSE_MANY_SOURCES_SHOWN);
  return (
    `origin では ${afterOrigin.length} 件当たったが source=[${source.join(', ')}] の完全一致で0件——` +
    `**この source は開いている task に無い。** 当たった task に実在する source（多い順）: ` +
    `${top === '' ? '（source を持つ task が無い）' : top}` +
    `${rest > 0 ? ` …ほか ${rest} 種は省略` : ''}`
  );
}

function describeCloseManyQMiss(q: string, afterSourceCount: number): string {
  return (
    `source までで ${afterSourceCount} 件当たったが q="${q}" に当たる task が0件` +
    '（タイトル・本文・出所を見て当たらなかった）。'
  );
}

function describeCloseManyUntilMiss(until: string | undefined, afterQ: readonly Task[]): string {
  const oldest = afterQ.reduce(
    (acc, task) => (acc === undefined || task.createdAt < acc ? task.createdAt : acc),
    undefined as string | undefined,
  );
  return (
    `q までで ${afterQ.length} 件当たったが until=${until} より前の task が0件` +
    `（当たった task のうち最も古いのは ${oldest ?? '不明'}）。`
  );
}

// 0件の理由を段で名指しする: 1つの文言で済ませると「当たるものが無かった」と「絞り込みを間違えた」が同じ顔になるため
function describeCloseManyZeroReason(
  filter: TaskStatusManyFilterArgs,
  selection: TaskStatusManySelection,
): string {
  const { origin, source, q, until } = filter;
  const { openEntries, afterOrigin, afterSource, afterQ } = selection;
  if (openEntries.length === 0) {
    return '開いている task が1件も無い。**絞り込みの問題ではない**（変えるべきものがそもそも無い）。';
  }
  if (afterOrigin.length === 0) return describeCloseManyOriginMiss(origin, openEntries);
  if (source !== undefined && afterSource.length === 0) {
    return describeCloseManySourceMiss(source, afterOrigin);
  }
  if (q !== undefined && afterQ.length === 0) return describeCloseManyQMiss(q, afterSource.length);
  return describeCloseManyUntilMiss(until, afterQ);
}

function renderCloseManyZeroResult(args: {
  funnel: string;
  why: string;
  unreadableNote: readonly string[];
}): string {
  return [
    '絞り込みに当たる開いている task は0件だった。**1件も閉じていない。**',
    args.funnel,
    args.why,
    ...args.unreadableNote,
  ].join('\n');
}

function renderCloseManyDryRunSummary(
  status: TaskStatusManyTargetStatus,
  targets: readonly Task[],
  matchedCount: number,
): string {
  return (
    `この呼びで ${status} にするのは ${targets.length} 件（当たったのは ${matchedCount} 件）。` +
    `いちばん古いのは ${targets[0]?.createdAt ?? '不明'}、いちばん新しいのは ${
      targets[targets.length - 1]?.createdAt ?? '不明'
    }。`
  );
}

function renderCloseManyDryRunIds(targets: readonly Task[]): string {
  const shown = targets.slice(0, CLOSE_MANY_IDS_SHOWN).map((task) => task.id);
  const hidden = targets.length - shown.length;
  return `対象の id（先頭 ${shown.length} 件）: ${shown.join(', ')}${
    hidden > 0 ? ` …ほか ${hidden} 件は省略` : ''
  }`;
}

function renderCloseManyDryRun(args: {
  status: TaskStatusManyTargetStatus;
  funnel: string;
  filterText: string;
  selection: TaskStatusManySelection;
  restNote: readonly string[];
  unreadableNote: readonly string[];
}): string {
  const { status, funnel, filterText, selection, restNote, unreadableNote } = args;
  const { targets, matched } = selection;
  return [
    `**試算（dryRun）。1件も閉じていない。** 実際に ${status} にするには dryRun: false を渡すこと。`,
    funnel,
    `絞り込み: ${filterText}`,
    renderCloseManyDryRunSummary(status, targets, matched.length),
    renderCloseManyDryRunIds(targets),
    ...restNote,
    ...unreadableNote,
  ].join('\n');
}

interface CloseManyRunState {
  /** 「日誌に N 件」は実際に書いた件数で数える: 塊の数で言うと、塊が丸ごと競合になった回に無い日誌の行を名乗るため */
  journaledChunks: number;
  /** 日誌が塊の途中で落ちたとき、変えた id を応答へ出すために持つ（`closeManyInChunks` は例外で抜けると id を返さない） */
  journaledIds: string[];
  unjournaled: { chunk: { number: number; total: number }; closed: readonly string[] } | undefined;
  /** 処理し終えた塊の id の合計: 競合で変えられなかった件数は、まだ処理していない塊を混ぜずに数えるため */
  processedCount: number;
  closeFailure: { chunk: { number: number; total: number }; error: unknown } | undefined;
}

function buildCloseManyJournalEntry(args: {
  status: TaskStatusManyTargetStatus;
  reason: string;
  filterText: string;
  chunk: { number: number; total: number };
  closed: readonly string[];
}): JournalEntryInput {
  const { status, reason, filterText, chunk, closed } = args;
  return {
    type: 'decision',
    // 1件を指せない一括の行: id を省き、task の一覧だけを取り直させる
    target: { kind: 'task' },
    decision:
      `task を絞り込みでまとめて ${status} にした` +
      `（${chunk.number}/${chunk.total} 塊目、この塊は ${closed.length} 件）: ${reason}\n` +
      `絞り込み: ${filterText}\n` +
      `変えた id: ${closed.join(' ')}`,
    // `grounds` には id を置かない: この欄は操作の由来を名乗る文で、控えを置く場所ではないため
    grounds: '自分で task_set_status_many して絞り込みで閉じた（人間はこれを読んで後から否定する）',
  };
}

// 塊ごとに「変える → その塊の id を日誌へ書く」の、日誌の側（`closeManyInChunks` の after）
async function journalCloseManyChunk(args: {
  journal: JournalStore;
  state: CloseManyRunState;
  chunk: { number: number; total: number; ids: readonly string[] };
  closed: readonly string[];
  status: TaskStatusManyTargetStatus;
  reason: string;
  filterText: string;
}): Promise<void> {
  const { journal, state, chunk, closed, status, reason, filterText } = args;
  state.processedCount += chunk.ids.length;
  // 1件も変えられなかった塊では日誌へ書かない: 抜けている塊番号そのものが「その塊は1件も変えなかった」を意味するため
  if (closed.length === 0) return;
  state.journaledChunks += 1;
  state.unjournaled = { chunk, closed };
  await appendJournalOrThrow(
    'task_set_status_many',
    journal,
    buildCloseManyJournalEntry({ status, reason, filterText, chunk, closed }),
    'act-completed',
  );
  state.journaledIds.push(...closed);
  state.unjournaled = undefined;
}

// 途中で落ちたとき、投げ直すもの: 閉じる側の失敗・日誌の失敗は文を持つ `CloseManyStoppedError` にし、それ以外は元の例外のまま
function toCloseManyStopError(args: {
  error: unknown;
  state: CloseManyRunState;
  restCount: number;
  limit: number;
}): unknown {
  const { error, state, restCount, limit } = args;
  const { closeFailure, unjournaled, journaledIds, processedCount } = state;
  // 閉じる側の失敗（`setStatus` の例外）: この塊は閉じ切っていない。前の塊の分は日誌に記録済み
  if (closeFailure !== undefined) {
    return new CloseManyStoppedError(
      formatCloseManyCloseFailedMessage({
        failedChunk: closeFailure.chunk,
        journaledIds,
        cause: closeFailure.error,
        processedCount,
        restCount,
        limit,
      }),
    );
  }
  if (error instanceof JournalNotRecordedError && unjournaled !== undefined) {
    return new CloseManyStoppedError(
      formatCloseManyStoppedMessage({
        failed: unjournaled,
        journaledIds,
        entry: error.entry,
        cause: error.journalCause,
        processedCount,
        restCount,
        limit,
      }),
    );
  }
  return error;
}

// 塊ごとに「変える → その塊の id を日誌へ書く」を交互に回す: まとめて変えてから日誌を書くと、器が落ちたとき閉じたのに記録が無い task が最大 `CLOSE_MANY_LIMIT_DEFAULT` 件できるため
async function closeManyTargetsJournaling(args: {
  tasks: Pick<TaskStore, 'setStatus'>;
  journal: JournalStore;
  selection: TaskStatusManySelection;
  status: TaskStatusManyTargetStatus;
  reason: string;
  filterText: string;
}): Promise<{ closedIds: string[]; journaledChunks: number }> {
  const { tasks, journal, selection, status, reason, filterText } = args;
  const { targets, rest: remainingCount, effectiveLimit } = selection;
  const state: CloseManyRunState = {
    journaledChunks: 0,
    journaledIds: [],
    unjournaled: undefined,
    processedCount: 0,
    closeFailure: undefined,
  };
  let closedIds: string[];
  try {
    closedIds = await closeManyInChunks(
      taskStatusManyStore(tasks, status),
      targets.map((task) => task.id),
      { reason, by: 'clone', at: new Date().toISOString() },
      {
        closeFailed: async (chunk, error) => {
          state.closeFailure = { chunk, error };
        },
        after: async (chunk, closed) => {
          await journalCloseManyChunk({
            journal,
            state,
            chunk,
            closed,
            status,
            reason,
            filterText,
          });
        },
      },
    );
  } catch (error) {
    throw toCloseManyStopError({ error, state, restCount: remainingCount, limit: effectiveLimit });
  }
  return { closedIds, journaledChunks: state.journaledChunks };
}

function renderCloseManyClosedIds(closedIds: readonly string[], journaledChunks: number): string {
  const shownClosed = closedIds.slice(0, CLOSE_MANY_IDS_SHOWN);
  const hiddenClosed = closedIds.length - shownClosed.length;
  return `変えた id（先頭 ${shownClosed.length} 件）: ${shownClosed.join(', ')}${
    hiddenClosed > 0
      ? ` …ほか ${hiddenClosed} 件は省略（**全 id は日誌に ${journaledChunks} 件に分けて残してある**）`
      : ''
  }`;
}

// 当たったのに変えられなかった分を黙らせない: 「全部閉じた」と読まれると次の呼びの判断が狂うため
function renderCloseManyRacedNote(targetCount: number, raced: number): string[] {
  return raced === 0
    ? []
    : [
        `⚠ 対象 ${targetCount} 件のうち ${raced} 件は変えられなかった` +
          '（この呼びの最中に他の経路が先に閉じた・消えた・読めない形だった）。',
      ];
}

function renderCloseManyDone(args: {
  status: TaskStatusManyTargetStatus;
  reason: string;
  funnel: string;
  filterText: string;
  targetCount: number;
  closedIds: readonly string[];
  journaledChunks: number;
  restNote: readonly string[];
  unreadableNote: readonly string[];
}): string {
  const { status, reason, funnel, filterText, targetCount, closedIds, journaledChunks } = args;
  return [
    `**${closedIds.length} 件を ${status} にした**（理由: ${reason}）。`,
    funnel,
    `絞り込み: ${filterText}`,
    renderCloseManyClosedIds(closedIds, journaledChunks),
    ...renderCloseManyRacedNote(targetCount, targetCount - closedIds.length),
    ...args.restNote,
    ...args.unreadableNote,
  ].join('\n');
}

// 先に書いた開き直しの行を打ち消す。書けなければ跡（noteDroppedRecord）だけ残す: ここへ来る時点で task は変わっていない
async function retractTaskReopenEntry(
  journal: JournalStore,
  taskId: string,
  why: string,
): Promise<void> {
  await appendJournalOrDrop('task_set_status', journal, {
    type: 'decision',
    target: { kind: 'task', id: taskId },
    decision: `直前の task の開き直しの行は効いていない（開き直していない）。理由: ${why}`,
    grounds: `${taskId} の開き直し。日誌を先に書いたが、開き直しが実行されなかったため打ち消す`,
  });
}

type InboxRemoveManyStores = CloneToolsShared['stores'];
type InboxPendingRow = Awaited<
  ReturnType<InboxRemoveManyStores['inbox']['peekPending']>
>['entries'][number];
type InboxDeliveryStop = NonNullable<ToolContext['dropQueuedInboxEvents']>;

interface InboxRemoveManyInput {
  types: InboxRemoveManyFilter['types'];
  sources: string[] | undefined;
  before: string | undefined;
  reason: string;
  limit: number | undefined;
}

// 引数の検査。断る文を返す（通れば null）。順序は元のまま
function describeInboxRemoveManyViolation(input: InboxRemoveManyInput): string | null {
  const { types, sources, before, reason, limit } = input;
  const limitError = describeIntRangeViolation('limit', limit, {
    min: 1,
    max: REMOVE_MANY_LIMIT_MAX,
  });
  if (limitError !== null) return limitError;
  if (!inboxRemoveManyTypesSchema.safeParse(types).success) {
    return `types は使えない（${formatArrayLengthJa({ min: 1 })}）。`;
  }
  const sourcesLengthError = describeArrayLengthViolation('sources', sources, { min: 1 });
  if (sourcesLengthError !== null) return sourcesLengthError;
  const sourcesElementError = describeStringArrayElementLengthViolation('sources', sources);
  if (sourcesElementError !== null) return sourcesElementError;
  const beforeLengthError = describeStringLengthViolation('before', before, { min: 1 });
  if (beforeLengthError !== null) return beforeLengthError;
  const reasonError =
    describeStringLengthViolation('reason', reason, { min: 1 }) ??
    describeBlankViolation('reason', reason);
  if (reasonError !== null) return reasonError;
  // 絞り込みの無い呼びを断る: 「全部」は選べる5種類を指し、その2種は zod の enum が型で塞いでいるため実行時に弾くのは5種類を全部選んだ場合だけ
  if (CLONE_REMOVABLE_INBOX_EVENT_TYPES.every((known) => types.includes(known))) {
    return (
      `types に選べる5種類（${CLONE_REMOVABLE_INBOX_EVENT_TYPES.join(', ')}）を全部並べた` +
      '呼びは断る——それは絞り込みが無いのと同じで、1回で（人間起点を除く）受信箱を' +
      '空にできてしまう。消したい種類だけを名指しすること（例 types: ["manager_message"]）。' +
      '**1件も消していない。**'
    );
  }
  // 読めない `before` を「絞り込みが当たらなかった」に混ぜない・時差を必須にする: `until` と同じ理由
  if (before !== undefined && !isOffsetQualifiedTimeBoundary(before)) {
    return (
      describeOffsetRequiredTimeBoundary('before', before, '2026-09-15T00:00:00.000Z') +
      '**1件も消していない。**'
    );
  }
  return null;
}

// 受信箱の一覧を読んで絞り込む（`peekPending` は1回だけ）
async function selectInboxRemoveManyTargets(
  inbox: InboxRemoveManyStores['inbox'],
  filter: InboxRemoveManyFilter,
): Promise<{
  allPending: readonly InboxPendingRow[];
  matched: readonly InboxPendingRow[];
  // 読めない行は絞り込みの材料が取れず対象にできないので、「未読が1件も無い」とは言わない: 消していないだけで受信箱に在るため
  unreadableNote: string | null;
}> {
  const peek = await inbox.peekPending();
  const allPending = peek.entries;
  const unreadableNote = describeUnreadableInboxEvents(peek.unreadable);
  const matched = allPending.filter((row) => matchesInboxRemoveManyFilter(row, filter));
  return { allPending, matched, unreadableNote };
}

function describeInboxRemoveManyFilterText(filter: InboxRemoveManyFilter): string {
  const { types, sources, before } = filter;
  return [
    `types=[${types.join(', ')}]`,
    ...(sources === undefined ? [] : [`sources=[${sources.join(', ')}]（完全一致）`]),
    ...(before === undefined ? [] : [`before=${before}`]),
  ].join(' / ');
}

function renderInboxRemoveManyFunnel(allPendingCount: number, matchedCount: number): string {
  return `未読 ${allPendingCount} 件 → 絞り込みで ${matchedCount} 件`;
}

function describeInboxRemoveManyZeroReason(
  allPending: readonly InboxPendingRow[],
  unreadableNote: string | null,
): string {
  if (allPending.length === 0 && unreadableNote !== null) {
    return `読めた未読が1件も無い。ただし ${unreadableNote}この道具では選べず、1件も消していない。`;
  }
  if (allPending.length === 0) {
    return '受信箱に未読が1件も無い。**絞り込みの問題ではない**（消すべきものがそもそも無い）。';
  }
  const breakdown = CLONE_REMOVABLE_INBOX_EVENT_TYPES.map(
    (known) => `${known} ${allPending.filter((row) => row.event.type === known).length}`,
  ).join(' / ');
  const humanCount = allPending.filter(
    (row) => row.event.type === 'human_message' || row.event.type === 'human_answer',
  ).length;
  return (
    `未読 ${allPending.length} 件のうち絞り込みに当たる行が0件——**絞り込みが外れている。**` +
    ` いま未読に在る種類の内訳（選べる5種類のみ）: ${breakdown}` +
    `${humanCount > 0 ? `（このほか人間起点の行が ${humanCount} 件あるが、この道具では選べない）` : ''}`
  );
}

function renderInboxRemoveManyZeroResult(funnel: string, why: string): string {
  return ['絞り込みに当たる未読は0件だった。**1件も消していない。**', funnel, why].join('\n');
}

function renderInboxRemoveManyRestNote(rest: number, effectiveLimit: number): string[] {
  return rest === 0
    ? []
    : [
        `1回の上限（${effectiveLimit} 件）に当たったので、残り ${rest} 件は対象にしていない。` +
          '**同じ絞り込みでもう一度呼べば続きを消せる。**',
      ];
}

function renderInboxRemoveManyDryRunIds(targets: readonly InboxPendingRow[]): string {
  const shown = targets.slice(0, REMOVE_MANY_IDS_SHOWN).map((row) => row.event.id);
  const hidden = targets.length - shown.length;
  return `対象の id（先頭 ${shown.length} 件）: ${shown.join(', ')}${
    hidden > 0 ? ` …ほか ${hidden} 件は省略` : ''
  }`;
}

function renderInboxRemoveManyDryRun(args: {
  funnel: string;
  filterText: string;
  targets: readonly InboxPendingRow[];
  matchedCount: number;
  restNote: readonly string[];
}): string {
  const { funnel, filterText, targets, matchedCount } = args;
  return [
    `**試算（dryRun）。1件も消していない。** 実際に消すには dryRun: false を渡すこと。`,
    funnel,
    `絞り込み: ${filterText}`,
    `この呼びで消すのは ${targets.length} 件（当たったのは ${matchedCount} 件）。` +
      `いちばん古いのは ${targets[0]?.at ?? '不明'}、いちばん新しいのは ${
        targets[targets.length - 1]?.at ?? '不明'
      }。`,
    renderInboxRemoveManyDryRunIds(targets),
    ...args.restNote,
  ].join('\n');
}

function renderInboxRemoveManyNoDeliveryRefusal(): string {
  return [
    '**1件も消していない。** 配達の待ち行列から落とす口が渡されていないので、' +
      'この道具は消し込みを拒んだ。',
    '消しても、既にクローンのメモリ上の待ち行列へ載った合図は配られ続ける' +
      '。「消した」と名乗って配達が続く状態を作らないために、' +
      'ここで止めている。',
    '⚠️ これは配線の不備である（本番の `ToolContext` は2箇所とも' +
      '`dropQueuedInboxEvents` を渡している）。人間へ上げること。',
  ].join('\n');
}

// 塊ごとの先の日誌の行
function buildInboxRemoveManyJournalEntry(args: {
  index: number;
  chunkCount: number;
  chunk: readonly string[];
  reason: string;
  filterText: string;
}): JournalEntryInput {
  const { index, chunkCount, chunk, reason, filterText } = args;
  return {
    type: 'decision',
    decision:
      `受信箱の未読を絞り込みで一括して畳む（消す）` +
      `（${index + 1}/${chunkCount} 塊目、この塊は ${chunk.length} 件）: ${reason}\n` +
      `絞り込み: ${filterText}\n` +
      `消す id: ${chunk.join(' ')}`,
    grounds:
      'クローン自身が inbox_remove_many で絞り込んで消す（人間はこれを読んで後から否定する）',
  };
}

function describeInboxRemoveManyStopped(args: {
  index: number;
  chunkCount: number;
  chunkSize: number;
  error: unknown;
}): string {
  const { index, chunkCount, chunkSize, error } = args;
  return (
    `⚠⚠ ${index + 1}/${chunkCount} 塊目の先の日誌が書けなかったので、この塊（${chunkSize} 件）と` +
    `それ以降は消さずに止めた（${collapseErrorCause(error)}）。` +
    `止める前の ${index} 塊は消えていて日誌にも残っている。残りは同じ絞り込みでもう一度呼べば続きから消せる。`
  );
}

// 「日誌に N 件」は実際に書いた件数で数える: 先の行が書けて止めた回に、書いていない行を名乗らないため
interface InboxRemoveManyRunState {
  removedIds: string[];
  droppedFromDelivery: number;
  raced: number;
  journaledChunks: number;
  stoppedNote: string | undefined;
}

// 塊ごとに「その塊の id を日誌へ書く → 消す」を交互に回す（`removeInboxChunkJournalFirst`）: 消すと配達も止まって戻らないので、消してから書くと日誌が落ちた回に何を畳んだかが残らないため
// `stores.inbox.removeMany` を直に呼ばない: 器から消すのと配達を止めるのを1つの呼びで行う関数を通す（helper の中）
async function removeInboxTargetsJournaling(args: {
  stores: InboxRemoveManyStores;
  stopDelivery: InboxDeliveryStop;
  targets: readonly InboxPendingRow[];
  reason: string;
  filterText: string;
}): Promise<InboxRemoveManyRunState> {
  const { stores, stopDelivery, targets, reason, filterText } = args;
  const chunks = chunkIdsByChars(
    targets.map((row) => row.event.id),
    REMOVE_MANY_JOURNAL_ID_CHARS,
  );
  const state: InboxRemoveManyRunState = {
    removedIds: [],
    droppedFromDelivery: 0,
    raced: 0,
    journaledChunks: 0,
    stoppedNote: undefined,
  };
  for (const [index, chunk] of chunks.entries()) {
    const outcome = await removeInboxChunkJournalFirst(
      stores,
      { dropQueuedInboxEvents: stopDelivery },
      chunk,
      () =>
        buildInboxRemoveManyJournalEntry({
          index,
          chunkCount: chunks.length,
          chunk,
          reason,
          filterText,
        }),
    );
    if (outcome.kind === 'journal-failed') {
      // 先の行が書けなかった塊は消していない。1つも消していなければ行為は起きていない（`act-not-performed`）。
      noteDroppedRecord('日誌', journalEntryShape(outcome.entry), outcome.error);
      if (state.journaledChunks === 0) {
        throw new JournalNotRecordedError(
          'inbox_remove_many',
          outcome.entry,
          'act-not-performed',
          outcome.error,
        );
      }
      // 前の塊は消えていて日誌にも在るので投げず、どこまで消したかを返す（投げると「やり直してよい」が前の塊について嘘になる）
      state.stoppedNote = describeInboxRemoveManyStopped({
        index,
        chunkCount: chunks.length,
        chunkSize: chunk.length,
        error: outcome.error,
      });
      break;
    }
    state.journaledChunks += 1;
    state.droppedFromDelivery += outcome.droppedFromDelivery;
    state.removedIds.push(...outcome.removedIds);
    state.raced += outcome.racedIds.length;
  }
  return state;
}

function renderInboxRemoveManyRemovedIds(
  removedIds: readonly string[],
  journaledChunks: number,
): string {
  const shownRemoved = removedIds.slice(0, REMOVE_MANY_IDS_SHOWN);
  const hiddenRemoved = removedIds.length - shownRemoved.length;
  return `消した id（先頭 ${shownRemoved.length} 件）: ${shownRemoved.join(', ')}${
    hiddenRemoved > 0
      ? ` …ほか ${hiddenRemoved} 件は省略（**全 id は日誌に ${journaledChunks} 件に分けて残してある**）`
      : ''
  }`;
}

// 配達の側にも届いたことを名乗る: 消えた件数だけを出すと器の行しか消さずに「消した」と名乗る形に戻るため
function renderInboxRemoveManyDeliveryNote(droppedFromDelivery: number): string {
  return (
    `配達の待ち行列からも外したのは ${droppedFromDelivery} 件` +
    `（残りは器に在っただけで、まだ配達待ちには載っていなかった分である。` +
    `**既に取り出して処理中のものは取り消せない。**）`
  );
}

function renderInboxRemoveManyRacedNote(targetCount: number, raced: number): string[] {
  return raced === 0
    ? []
    : [
        `⚠ 対象 ${targetCount} 件のうち ${raced} 件は消せなかった` +
          '（この呼びの最中に他の経路が先に消した）。',
      ];
}

function renderInboxRemoveManyDone(args: {
  reason: string;
  funnel: string;
  filterText: string;
  targetCount: number;
  state: InboxRemoveManyRunState;
  restNote: readonly string[];
}): string {
  const { reason, funnel, filterText, targetCount, state } = args;
  return [
    ...(state.stoppedNote === undefined ? [] : [state.stoppedNote]),
    `**${state.removedIds.length} 件を畳んだ（消した）**（理由: ${reason}）。`,
    funnel,
    `絞り込み: ${filterText}`,
    renderInboxRemoveManyRemovedIds(state.removedIds, state.journaledChunks),
    renderInboxRemoveManyDeliveryNote(state.droppedFromDelivery),
    ...renderInboxRemoveManyRacedNote(targetCount, state.raced),
    ...args.restNote,
  ].join('\n');
}

type TaskCursorOutcome = ReturnType<typeof resolveTaskCursor>;
type TaskCursorRefusal = Exclude<TaskCursorOutcome, { kind: 'ok' }>;
type TaskListStores = CloneToolsShared['stores'];
type TaskListUnreadable = Awaited<ReturnType<TaskListStores['tasks']['list']>>['unreadable'];
type TaskReadOutcome = { kind: 'unreadable' } | { kind: 'missing' } | { kind: 'found'; task: Task };

// 引数の検査。断る文を返す（通れば null）
function describeTaskListViolation(offset: number): string | null {
  return describeIntRangeViolation('offset', offset, { min: 0 });
}

// task を1件読み、見つかった / 無い / 読めないの3通りにする（task_list の全文読みと task_set_status の開き直しで使う）。
// `UnreadableTaskError` だけを3値目として返す: 器の障害まで飲み込むと「壊れている」に化けて見えなくなるため
async function readTaskLookup(
  tasks: TaskListStores['tasks'],
  id: string,
): Promise<TaskReadOutcome> {
  let task: Task | null;
  try {
    task = await tasks.get(id);
  } catch (error) {
    if (error instanceof UnreadableTaskError) return { kind: 'unreadable' };
    throw error;
  }
  if (task === null) return { kind: 'missing' };
  return { kind: 'found', task };
}

function renderTaskListUnreadableOne(id: string): string {
  return `task ${id} は読めない形で入っている（無いのとは違う）。本文はここでは取れない。`;
}

function renderTaskListMissing(id: string): string {
  return `task ${id} は無い（task_list で実在する id を確かめること）。`;
}

function renderTaskFullHead(id: string, task: Task): string {
  return [
    `${id} ${task.title}`,
    `${taskOriginBadge({ origin: task.origin, source: task.source })}`,
    `作成: ${task.createdAt} / 更新: ${task.updatedAt}`,
    taskStatusLine(task),
    ...(task.originConversationId === undefined
      ? []
      : [`起点の会話: ${task.originConversationId}`]),
  ].join('\n');
}

// 閉じた理由を本文より先に置く: 本文が長いと2ページ目へ落ちるため
function renderTaskFullBody(task: Task): string {
  return [
    ...(task.closedAt === undefined ? [] : [`閉じた理由: ${describeTaskClosedRecord(task)}`]),
    `本文（全文）: ${task.body}`,
  ].join('\n\n');
}

function renderTaskFullTail(task: Task, part: ReturnType<typeof page>): string {
  return part.more
    ? `\n\n…（ここで切れている。続きは task_list id=${task.id} offset=${part.to}）`
    : '';
}

function renderTaskFull(id: string, task: Task, offset: number): string {
  const head = renderTaskFullHead(id, task);
  const body = renderTaskFullBody(task);
  const part = page(body, offset, TASK_PAGE);
  const tail = renderTaskFullTail(task, part);
  return `${head}（${describePage(part)}）\n\n${part.body}${tail}`;
}

function renderTaskListEmpty(): string {
  return '（task は無い）';
}

function renderTaskListCursorRefusal(
  outcome: TaskCursorRefusal,
  cursor: string | undefined,
): string {
  if (outcome.kind === 'malformed') {
    return (
      'cursor が壊れている（この道具が返したものではないか、書き換えられている）。' +
      '一覧を先頭から読み直すには cursor を付けずに task_list を呼ぶこと。'
    );
  }
  if (outcome.kind === 'includeClosed-mismatch') {
    return (
      `cursor は includeClosed=${outcome.cursorIncludeClosed} の一覧から出た続きの位置。` +
      `task_list includeClosed=${outcome.cursorIncludeClosed} cursor=${cursor} のように揃えて呼び直すか、` +
      'cursor を付けずに先頭から呼び直すこと。'
    );
  }
  return (
    'cursor が指していた task は、いまの一覧に居ない（閉じた・消えた）。続きの位置が決められないので、' +
    '黙って別の続きにはしない。cursor を付けずに task_list を先頭から呼び直すこと。'
  );
}

function renderTaskListItems(view: readonly Task[], firstPosition: number): string[] {
  return view.map((task, index) =>
    renderListingEntry({
      id: task.id,
      title: task.title,
      summary: excerptLine(task.body, TASK_BODY_LIMIT),
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      extra: [
        `  ${firstPosition + index + 1}番目 / ${taskStatusLine(task)}`,
        ...(task.originConversationId === undefined
          ? []
          : [`  起点の会話: ${task.originConversationId}`]),
      ],
    }),
  );
}

// 母数は cursor を当てる前の全件: 頁が進んでも動かさないため
function renderTaskListOmitted(args: {
  rest: number;
  shown: number;
  view: readonly Task[];
  total: number;
  firstPosition: number;
  includeClosed: boolean;
}): string {
  const { rest, shown, view, total, firstPosition, includeClosed } = args;
  const lastShown = view[shown - 1];
  const nextCursor = encodeTaskCursor({ id: lastShown!.id, includeClosed });
  return (
    `…ほか ${rest} 件は省略（task は ${total} 件あり、並びの ${firstPosition + 1} 番目から ${shown} 件だけ出した。` +
    `省いたのは、これより後ろの件である。続きは task_list cursor=${nextCursor} で取れる。` +
    `includeClosed=${includeClosed} のまま呼ぶこと）。`
  );
}

function renderTaskListBody(args: {
  entriesCount: number;
  view: readonly Task[];
  items: readonly string[];
  firstPosition: number;
  includeClosed: boolean;
}): string[] {
  const { entriesCount, view, items, firstPosition, includeClosed } = args;
  if (entriesCount === 0) return ['（読める task は無い）'];
  if (view.length === 0) return ['（cursor より後ろの task は無い。これが最後の頁）'];
  return [
    includeClosed
      ? '（上から並び順。開いている件の後ろに、閉じた件が新しい順で続く）'
      : '（以下はすべて開いている件。上が先）',
    renderListing(items, {
      budget: TASK_LIST_BUDGET,
      omitted: ({ rest, shown }) =>
        renderTaskListOmitted({
          rest,
          shown,
          view,
          total: entriesCount,
          firstPosition,
          includeClosed,
        }),
    }),
    `（本文は${TASK_BODY_LIMIT}字の抜粋。1件の全文は task_list id=<id> で取れる）`,
  ];
}

function renderTaskListUnreadableNote(unreadable: TaskListUnreadable): string {
  const idsAll = unreadable
    .map((entry) => entry.id)
    .filter((value): value is string => value !== undefined);
  const ids = idsAll.slice(0, UNREADABLE_TASK_IDS_SHOWN);
  const idsRest = idsAll.length - ids.length;
  return `**読めない行が ${unreadable.length} 件ある${
    ids.length > 0
      ? `（id: ${ids.join(', ')}${idsRest > 0 ? ` …ほか ${idsRest} 件は省略` : ''}）`
      : ''
  }。終わったのではない。**`;
}

type TaskSetStatusStores = CloneToolsShared['stores'];
type TaskSetStatusResult = Awaited<ReturnType<TaskSetStatusStores['tasks']['setStatus']>>;
type TaskSetStatusOutcome =
  | { kind: 'unreadable' }
  | { kind: 'moved'; result: TaskSetStatusResult; journaledFirst: Task | undefined };

// 引数の検査。断る文を返す（通れば null）
function describeTaskSetStatusViolation(
  status: TaskStatus,
  reason: string | undefined,
): string | null {
  const closing = status === 'done' || status === 'cancelled';
  if (closing && reason === undefined) {
    return `status=${status} には reason が要る（何をもって終わりとしたか、なぜ取りやめたか）。`;
  }
  return (
    describeStringLengthViolation('reason', reason, { min: 1 }) ??
    describeBlankViolation('reason', reason)
  );
}

function renderTaskSetStatusUnreadable(taskId: string): string {
  return `task ${taskId} は読めない形で入っている。読めない形のまま書き直さないので、状態を変えていない。`;
}

function renderTaskSetStatusMissing(taskId: string): string {
  return `task ${taskId} は無い（task_list で実在する id を確かめること）。何もしていない。`;
}

function renderTaskSetStatusUnchanged(taskId: string, status: TaskStatus): string {
  return `task ${taskId} は既に ${status}。何もしていない。`;
}

function renderTaskSetStatusRejected(from: TaskStatus, to: TaskStatus): string {
  return `${from} から ${to} へは移せない（閉じた件から戻せるのは queued だけ）。何もしていない。`;
}

function renderTaskSetStatusMoved(
  taskId: string,
  before: Task,
  status: TaskStatus,
  reopened: boolean,
): string {
  return `task ${taskId} を ${before.status} から ${status} へ移した${
    reopened ? '（閉じた記録は日誌に残してある）' : ''
  }。`;
}

// 開き直し（閉じた件を queued へ）は閉じた記録を行から外すので、日誌を先に書いて、書けてから外す（#5176）:
// 外した後に日誌が落ちると、閉じた時刻・主体・理由が行にも日誌にも残らない
async function journalReopenFirst(
  stores: TaskSetStatusStores,
  taskId: string,
  read: Task | null,
  status: TaskStatus,
  reason: string | undefined,
): Promise<Task | undefined> {
  if (read === null || read.closedAt === undefined) return undefined;
  await appendJournalOrThrow(
    'task_set_status',
    stores.journal,
    taskStatusChangeEntry(taskId, read, status, reason),
    'act-not-performed',
  );
  return read;
}

// `setStatus` だけを包む。先に開き直しの行を書いた回は、どんな例外でも打ち消してから返す / 投げ直す（#6424）。
// `UnreadableTaskError` は null（読めない）にし、ほかは投げ直す
async function runTaskSetStatus(
  stores: TaskSetStatusStores,
  taskId: string,
  status: TaskStatus,
  reason: string | undefined,
  journaledFirst: Task | undefined,
): Promise<TaskSetStatusResult | null> {
  let result;
  try {
    result = await stores.tasks.setStatus(taskId, status, {
      ...(reason === undefined ? {} : { reason }),
      by: 'clone',
      at: new Date().toISOString(),
    });
  } catch (error) {
    const unreadable = error instanceof UnreadableTaskError;
    // 読めない以外の例外でも打ち消す: 投げ直すだけだと、行は閉じたままなのに「開き直した」の日誌だけが残るため
    if (journaledFirst !== undefined) {
      await retractTaskReopenEntry(
        stores.journal,
        taskId,
        unreadable
          ? '開き直す直前に行が読めない形になった'
          : `開き直す途中で行の書き換えが例外で終わった（${collapseErrorCause(error)}）`,
      );
    }
    if (unreadable) return null;
    throw error;
  }
  return result;
}

// 先に書いた開き直しの行の後始末: 変わらなかったなら打ち消し、閉じ直されていたなら注を残す。
// 別の手が先に開き直していた（この呼びは閉じた記録を外していない）なら打ち消して 'retracted' を返す
async function settleReopenJournal(
  stores: TaskSetStatusStores,
  taskId: string,
  journaledFirst: Task,
  result: TaskSetStatusResult,
): Promise<'kept' | 'retracted'> {
  if (result.kind !== 'changed') {
    // 先に書いた行を打ち消す: 日誌に「開き直した」だけが残ると事実と食い違う
    await retractTaskReopenEntry(
      stores.journal,
      taskId,
      result.kind === 'not-found'
        ? '開き直す直前に task が消えていた'
        : '開き直す直前に別の手で状態が変わっていた',
    );
    return 'retracted';
  }
  if (result.before.closedAt === undefined) {
    // 別の手が先に開き直して動かしていた: この呼びが移したのは開いている状態どうしで、閉じた記録は外していない（#6424）
    await retractTaskReopenEntry(
      stores.journal,
      taskId,
      `開き直す直前に別の手が先に開き直していた（この呼びは ${result.before.status} から移しただけで、閉じた記録は外していない）`,
    );
    return 'retracted';
  }
  // 時刻だけで比べない: 別の手が同じ時刻に別の主体・理由で閉じ直すと、実際に外した記録が日誌に残らないため（#6424）
  if (describeTaskClosedRecord(result.before) !== describeTaskClosedRecord(journaledFirst)) {
    // 行から実際に外れた記録が日誌に無い状態を作らない
    await appendJournalOrDrop('task_set_status', stores.journal, {
      type: 'decision',
      target: { kind: 'task', id: taskId },
      decision: `開き直し（${taskId}）の間に閉じ直されていた。実際に行から外した記録: ${describeTaskClosedRecord(result.before)}`,
      grounds: `先の行の記録: ${describeTaskClosedRecord(journaledFirst)}`,
    });
  }
  return 'kept';
}

// 開き直しの先の日誌 → setStatus → 打ち消し / 注、の流れ
async function moveTaskStatus(
  stores: TaskSetStatusStores,
  taskId: string,
  status: TaskStatus,
  reason: string | undefined,
): Promise<TaskSetStatusOutcome> {
  let journaledFirst: Task | undefined;
  if (status === 'queued') {
    const read = await readTaskLookup(stores.tasks, taskId);
    if (read.kind === 'unreadable') return { kind: 'unreadable' };
    journaledFirst = await journalReopenFirst(
      stores,
      taskId,
      read.kind === 'found' ? read.task : null,
      status,
      reason,
    );
  }
  const result = await runTaskSetStatus(stores, taskId, status, reason, journaledFirst);
  if (result === null) return { kind: 'unreadable' };
  if (journaledFirst !== undefined) {
    const settled = await settleReopenJournal(stores, taskId, journaledFirst, result);
    // 打ち消した回は「開き直しの行を先に書いた」ことにしない: 移せていれば、ふつうの移動の行を書くため
    if (settled === 'retracted') journaledFirst = undefined;
  }
  return { kind: 'moved', result, journaledFirst };
}

// 開き直しの行は先に書いてある。ここで書くのはそれ以外（閉じる・開いている状態どうし）だけ
async function journalPlainStatusChange(
  stores: TaskSetStatusStores,
  taskId: string,
  before: Task,
  status: TaskStatus,
  reason: string | undefined,
  journaledFirst: Task | undefined,
): Promise<void> {
  if (journaledFirst !== undefined) return;
  await appendJournalOrThrow(
    'task_set_status',
    stores.journal,
    taskStatusChangeEntry(taskId, before, status, reason),
    'act-completed',
  );
}

export function taskTools(context: ToolContext, shared: CloneToolsShared) {
  const { stores, getWorkConversationId } = shared;
  return [
    // 引き受けた仕事の器はここだけ: 順序と状態を持つ
    tool(
      'task_list',
      [
        'task（順序と状態を持つ待ち行列）の一覧。**先頭が先にやるもの**で、並びは器が持つ（数値の優先度・締切は無い）。',
        '各件はタイトルと本文の抜粋だけを出す。1件の全文（本文と、閉じたなら理由）が要るなら id を渡す。閉じた件も id で読める。',
        '既定は開いている件（queued / waiting / needs_decision）だけ。includeClosed で閉じた件（done / cancelled）を後ろに足す。',
        '引き受けた仕事の器はこれだけ。人間の発言は、届いた時点で自動的に載る（queued）。人間の承認への回答・マネージャーの報告・外部イベントは自動では載らない。自分で引き受けるもの・手を付けない気づき・未了の問いは task_add で足す。',
        '人間の発言の task は、その発言を読んで返答したターンの終わりに、queued であれば器が自動で done にする（閉じたものは includeClosed で読み返せる。止めるなら task_keep）。ただし、答えの無い問い（ask_human・request_permission。前のターンのものを含む）が残っている会話の task（不要になった問いは approval_withdraw で取り下げると対象に戻る）、結び付いた委譲（manager_start の taskId）が走っている（running / waiting_human）task は閉じない。',
        '一覧が予算で切れたら、断り書きが次に打つ cursor を案内する。それを cursor へ渡すと続きから読める。',
      ].join(' '),
      {
        id: z
          .string()
          .optional()
          .describe(
            'この1件を全文で読む（一覧に出ている id）。閉じた件も読める。他の条件は無視される',
          ),
        offset: z
          .number()
          .optional()
          .describe(
            `id で全文を読むとき、何文字目から読むか（文字数。${formatIntRangeJa({ min: 0 })}）`,
          ),
        includeClosed: z
          .boolean()
          .optional()
          .describe('閉じた件（done / cancelled）も後ろに足す（既定は開いている件だけ）'),
        cursor: z
          .string()
          .optional()
          .describe(
            '一覧モードの続きを読む位置。前回の応答の断り書きに出た cursor をそのまま渡す（自分で組み立てない）。includeClosed は揃えること',
          ),
      },
      async ({ id, offset = 0, includeClosed, cursor }) => {
        const offsetError = describeTaskListViolation(offset);
        if (offsetError !== null) return text(offsetError);
        if (id !== undefined) {
          const read = await readTaskLookup(stores.tasks, id);
          if (read.kind === 'unreadable') return text(renderTaskListUnreadableOne(id));
          if (read.kind === 'missing') return text(renderTaskListMissing(id));
          return text(renderTaskFull(id, read.task, offset));
        }

        const { entries, unreadable } = await stores.tasks.list(
          includeClosed === true ? { includeClosed: true } : undefined,
        );
        if (entries.length === 0 && unreadable.length === 0) {
          return text(renderTaskListEmpty());
        }
        const cursorOutcome = resolveTaskCursor(entries, includeClosed === true, cursor);
        if (cursorOutcome.kind !== 'ok') {
          return text(renderTaskListCursorRefusal(cursorOutcome, cursor));
        }
        const view = cursorOutcome.view;
        const firstPosition = entries.length - view.length;
        const items = renderTaskListItems(view, firstPosition);
        const lines = renderTaskListBody({
          entriesCount: entries.length,
          view,
          items,
          firstPosition,
          includeClosed: includeClosed === true,
        });
        if (unreadable.length > 0) lines.push(renderTaskListUnreadableNote(unreadable));
        return text(lines.join('\n'));
      },
    ),

    tool(
      'task_add',
      [
        '順序と状態を持つ task を1件足す。起点は自分（self）として載る。',
        '起点の会話は、いまのターンの会話か、報告を読んでいる委譲の起点に自動で結ばれる。どちらも無ければ新しい会話ができる（task_say の宛先になる）。',
        '知らせるためだけに足した task は、書いたら done にして閉じる。続ける仕事の task は、その会話への返答で器が自動で done にしないよう、task_keep で「続く」の印を付ける。',
        '置き場所を省くと既定の位置に入る（自分で足した件は末尾）。to で先頭・末尾・特定の task の前後を指せる。',
        '手を付けない気づき・人間へ出したまま答えを得ていない問い（問いの全文と選択肢を逐語で）もここへ足す。',
      ].join(' '),
      {
        title: z
          .string()
          .describe(
            `一行のタイトル（${formatStringLengthJa({ min: 1, max: TASK_TITLE_MAX })}。改行は使えない）。一覧にはこれと本文の抜粋だけが出る`,
          ),
        body: z
          .string()
          .describe(
            `何をするか。後日のあなたが読んでそのまま動ける粒度で、要約せず逐語で書く（${formatStringLengthJa({ min: 1 })}）`,
          ),
        to: z
          .enum(TASK_PLACEMENT_TARGETS)
          .optional()
          .describe(
            '置き場所（front=先頭 / back=末尾 / before・after=anchorId の直前・直後）。省くと既定の位置',
          ),
        anchorId: z
          .string()
          .optional()
          .describe('to が before / after のときの基準の task の id（開いている件だけ指せる）'),
        source: z
          .string()
          .optional()
          .describe('関係する相手や出所（マネージャー id など。分かるときだけ）'),
      },
      async ({ title, body, to, anchorId, source }) => {
        const titleError =
          describeStringLengthViolation('title', title, { min: 1, max: TASK_TITLE_MAX }) ??
          describeBlankViolation('title', title);
        if (titleError !== null) return text(titleError);
        if (/[\r\n]/.test(title)) return text('title は使えない（改行を含まない一行のみ）。');
        const bodyError =
          describeStringLengthViolation('body', body, { min: 1 }) ??
          describeBlankViolation('body', body);
        if (bodyError !== null) return text(bodyError);
        for (const [field, value] of [['source', source]] as const) {
          if (value !== undefined && stripNul(value).trim().length === 0) {
            return text(
              `${field} が空です。分かるときだけ実のある文字列で渡し、無いなら省略してください。`,
            );
          }
        }
        const resolved = resolveTaskPlacement(to, anchorId);
        if (resolved.kind === 'invalid') return text(resolved.message);
        const now = new Date().toISOString();
        // 新しい task は必ず起点の会話 id を持つ（task_say の宛先）。機構が決める: いまのターンの会話か、報告を読んでいる委譲の起点。どちらも無いときだけ新しい id
        const originId = getWorkConversationId() ?? randomUUID();
        const entry: Task = {
          id: randomUUID(),
          createdAt: now,
          updatedAt: now,
          status: 'queued',
          origin: 'self',
          ...(source === undefined ? {} : { source }),
          originConversationId: originId,
          title,
          body,
        };
        const added = await stores.tasks.add(entry, resolved.placement);
        if (added.kind === 'anchor-not-found') {
          return text(
            `anchorId ${anchorId} は開いている task に無い（閉じた件・無い id は基準にできない）。何も足していない。task_list で確かめること。`,
          );
        }
        // 「足した」と名乗る前に読み直して確かめる: 書き込みが静かに失敗しても呼び出し側からは例外が見えないため
        let confirmed: Task | null;
        try {
          confirmed = await stores.tasks.get(entry.id);
        } catch (error) {
          if (!(error instanceof UnreadableTaskError)) throw error;
          confirmed = null;
        }
        if (added.kind === 'existed' || confirmed === null) {
          return text(
            `task を書き込んだが、直後に読み直しても ${entry.id} を確認できなかった。**「足した」とは言えない。** ` +
              `task_list id=${entry.id} で確かめ、無ければ同じ内容でもう一度 task_add を試すこと。`,
          );
        }
        await appendJournalOrThrow(
          'task_add',
          stores.journal,
          {
            type: 'decision',
            target: { kind: 'task', id: entry.id },
            decision: `task を足した（${entry.id}）: ${title}`,
            grounds: `自分で task_add した。置き場所: ${describeTaskPlacement(resolved.placement)}。起点の会話: ${originId}。本文: ${body}`,
          },
          'act-completed',
        );
        return text(
          `task を足した（${entry.id}）。起点の会話は ${originId}（task_say taskId=${entry.id} でここへ書ける）。位置は task_list で確かめられる。`,
        );
      },
    ),

    tool(
      'task_move',
      [
        '開いている task の並びを変える。先頭が先にやるもの。',
        'to=front（先頭）/ back（末尾）/ before・after（anchorId の直前・直後）。',
        '閉じた件は動かせない（並びから外れている）。開き直したいなら task_set_status で queued にする。',
      ].join(' '),
      {
        taskId: z.string().describe('task_list に出ている、開いている件の id'),
        to: z.enum(TASK_PLACEMENT_TARGETS).describe('置き場所'),
        anchorId: z
          .string()
          .optional()
          .describe(
            'to が before / after のときの基準の task の id（開いている件だけ。自分自身は不可）',
          ),
      },
      async ({ taskId, to, anchorId }) => {
        const resolved = resolveTaskPlacement(to, anchorId);
        if (resolved.kind === 'invalid') return text(resolved.message);
        const placement = resolved.placement!;
        let moved;
        try {
          moved = await stores.tasks.move(taskId, placement);
        } catch (error) {
          if (error instanceof UnreadableTaskError) {
            return text(
              `task ${taskId} は読めない形で入っている。読めない形のまま書き直さないので、動かしていない。`,
            );
          }
          throw error;
        }
        if (moved.kind === 'not-found') {
          return text(
            `task ${taskId} は無い（task_list で実在する id を確かめること）。何もしていない。`,
          );
        }
        if (moved.kind === 'closed') {
          return text(
            `task ${taskId} は閉じている（並びに載っていない）ので動かせない。戻すなら task_set_status で queued にする。`,
          );
        }
        if (moved.kind === 'anchor-is-self') {
          return text('anchorId に動かす task 自身は指せない。何もしていない。');
        }
        if (moved.kind === 'anchor-not-found') {
          return text(
            `anchorId ${anchorId} は開いている task に無い（閉じた件・無い id は基準にできない）。何も動かしていない。`,
          );
        }
        await appendJournalOrThrow(
          'task_move',
          stores.journal,
          {
            type: 'decision',
            target: { kind: 'task', id: taskId },
            decision: `task の並びを変えた（${taskId}）: ${describeTaskPlacement(placement)}へ`,
            grounds: '自分で task_move した',
          },
          'act-completed',
        );
        return text(`task ${taskId} を${describeTaskPlacement(placement)}へ動かした。`);
      },
    ),

    tool(
      'task_set_status',
      [
        'task の状態を変える。queued / waiting / needs_decision（開いている3つ）は互いに行き来できる。',
        '開いている件からは done / cancelled（閉じる）へ行ける（閉じた件どうし、done と cancelled の間は移せない）。**閉じるときは reason が要る**（何をもって終わりとしたか、なぜ取りやめたか。人間が読んで後から否定する）。',
        '閉じた件から戻せるのは queued だけ（開き直し。閉じた記録は行から外れ、日誌へ逐語で残る）。同じ状態への変更は何もしない。',
      ].join(' '),
      {
        taskId: z
          .string()
          .describe('task_list に出ている id（開き直すなら includeClosed で出る閉じた件）'),
        status: z.enum(taskStatusSchema.options).describe('移す先の状態'),
        reason: z
          .string()
          .optional()
          .describe(
            `理由（${formatStringLengthJa({ min: 1 })}）。done / cancelled では必須、開き直し（閉じた件を queued にする）でも日誌に残すので付ける`,
          ),
      },
      async ({ taskId, status, reason }) => {
        const violation = describeTaskSetStatusViolation(status, reason);
        if (violation !== null) return text(violation);
        const moved = await moveTaskStatus(stores, taskId, status, reason);
        if (moved.kind === 'unreadable') return text(renderTaskSetStatusUnreadable(taskId));
        const { result, journaledFirst } = moved;
        if (result.kind === 'not-found') return text(renderTaskSetStatusMissing(taskId));
        if (result.kind === 'unchanged') return text(renderTaskSetStatusUnchanged(taskId, status));
        if (result.kind === 'rejected')
          return text(renderTaskSetStatusRejected(result.from, result.to));
        const reopened = result.before.closedAt !== undefined;
        await journalPlainStatusChange(
          stores,
          taskId,
          result.before,
          status,
          reason,
          journaledFirst,
        );
        return text(renderTaskSetStatusMoved(taskId, result.before, status, reopened));
      },
    ),

    tool(
      'task_keep',
      [
        'task に「続く」の印を立てる（keep=true）／外す（keep=false）。',
        '人間の発言の task は、その発言を読んで返答したターンの終わりに、queued であれば器が自動で done にする（理由と閉じた主体 daemon が残り、日誌にも書かれる）。',
        '返答したあとも続ける仕事（返答は途中経過で、まだ終わっていない）は、返答する前にこの印を立てておくと、自動では閉じない。',
        '印は状態・並びを動かさない。印を立てた task を終えるときは task_set_status で done にすること。',
        '自動 done が閉じない場合はほかにもある: waiting / needs_decision（待ち・判断待ち）、その会話に答えの無い問い（ask_human・request_permission。前のターンのものを含む。不要になった問いは approval_withdraw で取り下げると対象に戻る）が残っているとき、その task に結び付いた委譲（manager_start の taskId。Job.taskId）が走っている（running / waiting_human。前のターンで起こしたものを含む）か、このターンで manager_send で頼んだとき（委譲を起こすときは taskId を渡すこと。渡さない委譲は task に結び付かず、この判定に数えられない）、まだ読んでいない発言の task、起点の会話が無い task。',
      ].join(' '),
      {
        taskId: z
          .string()
          .describe('task_list に出ている id（閉じた件にも立てられる。開き直したときに効く）'),
        keep: z.boolean().describe('true で立てる、false で外す'),
      },
      async ({ taskId, keep }) => {
        let result;
        try {
          result = await stores.tasks.setKeep(taskId, keep);
        } catch (error) {
          if (error instanceof UnreadableTaskError) {
            return text(
              `task ${taskId} は読めない形で入っている。読めない形のまま書き直さないので、印を変えていない。`,
            );
          }
          throw error;
        }
        if (result.kind === 'not-found') {
          return text(
            `task ${taskId} は無い（task_list で実在する id を確かめること）。何もしていない。`,
          );
        }
        if (result.kind === 'unchanged') {
          return text(
            `task ${taskId} は既に${keep ? '「続く」の印つき' : '印なし'}。何もしていない。`,
          );
        }
        await appendJournalOrThrow(
          'task_keep',
          stores.journal,
          taskKeepChangeEntry(taskId, result.task, keep),
          'act-completed',
        );
        return text(
          `task ${taskId} の「続く」の印を${keep ? '立てた。返答しても器は自動では done にしない' : '外した'}。`,
        );
      },
    ),

    tool(
      'progress_read',
      [
        '作業の進捗を、task（待ち行列の行）と委譲の行から数え直して読む。',
        '積み上がり（未了の task の件数・起点別・齢）・実施中（委譲）・窓の中の消化・見込みを返す。',
        '**率（%）は出さない**（task に総量が無く、分母が定まらない）。取れないものは 0 にせず、状態か理由で言う。',
        '**GitHub（Issue / PR / CI）は観測していない**——出力にある「観測していない」は 0 件という意味ではない。',
        '観測した側が数を記録していれば（`github_observation_record`）、その数が出る。',
        '観測時刻を出力に含む。人間が `alteroid progress` や GET /progress で見るものと同じ数・同じ文である。',
      ].join(' '),
      {
        windowHours: z
          .number()
          .optional()
          .describe(
            `速度と見込みを数える窓の長さ（時間。有限の正数。省略時は ${String(DEFAULT_PROGRESS_WINDOW_HOURS)}）`,
          ),
      },
      async ({ windowHours }) => {
        try {
          const view = await readProgress(stores, { now: new Date(), windowHours });
          return text(describeProgress(view));
        } catch (error) {
          if (error instanceof InvalidProgressWindowError) {
            throw new Error(error.message, { cause: error });
          }
          throw error;
        }
      },
    ),

    // 日誌が全行為なので、書けなければ失敗を返す: 書けたふりをしないため
    tool(
      'github_observation_record',
      [
        '自分（または委譲先）が GitHub を見て数えた open Issue / open PR の件数を、日誌へ記録する。',
        '`progress_read` / `GET /progress` の「GitHub」欄はこの記録を返す（デーモンは GitHub を見に行かない。値は観測した側の申告）。',
        '**取れなかった回は数を作らない。** `result: { status: "failed", reason }` で、取れなかったことと理由を記録する（0 件と書かない）。',
        '`query` には**母集合を切った引数を含める**（例: `gh issue list --state open --limit 200`）。`limit` を付けたなら `limit` にも同じ値を入れ、',
        '件数が `limit` に達したときは `truncated: true`（数は下限）にする。',
        '**CI の数え方**: ok のとき、open PR の CI を見たなら `result.ci: { pulls, success, failure, pending, checks }` を付ける（`pulls` は CI を見た PR の数。1つの PR は success / failure / pending のどれか1つに数え、チェックが1件も無い PR はどれにも数えない。3つの和は `pulls` 以下）。',
        '**何を数えたかを `checks` に書く**（例「必須チェックだけ」・check の名前の列挙。500字まで）。`query` が母集合の切り方を持つのと同じで、これが無いと数は読めない。打ち切ったら `ci.truncated: true`。',
        '**CI を取れなかったら `ci` を置かず `result.ciUnavailable` に理由を書く**（`ci` と同時には置けない。0 を書かない）。CI を見ていないなら両方とも省く（読み手には「観測していない」と出る）。',
        '観測者はあなた（clone）として器が記録する（引数では指定できない）。いつ観測するかはここでは決まらない。',
      ].join(' '),
      {
        repo: githubObservationInputSchema.shape.repo.describe('観測した repo（`owner/name`）'),
        query: githubObservationInputSchema.shape.query.describe(
          '何をどう数えたか（母集合を切る引数を含めたコマンド・条件）',
        ),
        limit:
          githubObservationInputSchema.shape.limit.describe('母集合を切った件数の上限（あれば）'),
        result: githubObservationInputSchema.shape.result.describe(
          '観測の結果。ok のときだけ件数（openIssues / openPulls / truncated と、任意で ci または ciUnavailable）、取れなかったときは failed と reason（数は持たない）',
        ),
      },
      async (args) => {
        const parsed = githubObservationInputSchema.omit({ observedBy: true }).safeParse(args);
        if (!parsed.success) {
          // 送られた値は混ぜない（where だけ）。
          const where = parsed.error.issues.map((issue) => issue.path.join('.')).join(', ');
          return text(
            `github 観測の形が不正のため記録していない${where === '' ? '' : `: ${where}`}。`,
          );
        }
        const entry = await appendJournalOrThrow(
          'github_observation_record',
          stores.journal,
          {
            type: 'github_observation',
            ...parsed.data,
            observedBy: GITHUB_OBSERVATION_CLONE_OBSERVER,
          },
          'act-not-performed',
        );
        return text(
          `GitHub の観測を記録した（${entry.id}。${parsed.data.repo}。観測者 ${GITHUB_OBSERVATION_CLONE_OBSERVER}）。` +
            (parsed.data.result.status === 'failed'
              ? '取れなかった回として記録した（数は無い）。'
              : ''),
        );
      },
    ),

    tool(
      'task_set_status_many',
      [
        '開いている task（queued / waiting / needs_decision）を、**絞り込みを渡してまとめて done / cancelled にする**。',
        '1件ずつの `task_set_status` では手に負えない数の task が溜まったときの口である。',
        '**既定は試算で、1件も変えない。** 実際に変えるには `dryRun: false` を明示すること —— ',
        '閉じた task は `task_set_status` で queued へ1件ずつ開き直せるが、まとめて開き直す口は無いので、撃ち間違えは実質戻せない。',
        '**`origin` は必須で、在る起点（human / manager / external / self）を全部並べた呼びは断る**' +
          '（「全部閉じる」を1回で撃てる形は作らない）。',
        '**変えた id は全部日誌に残る。** 閉じる理由（reason）は task の行にも残り、人間はこれを読んで後から否定する。',
      ].join(''),
      {
        origin: z
          .array(z.enum(taskOriginSchema.options))
          .describe(
            `例 {"origin":["self"]}。配列で渡し、値は引用符で囲む。` +
              `対象の起点（必須。${formatArrayLengthJa({ min: 1 })}）。在る起点を全部（human / manager / external / self）並べると断られる。`,
          ),
        source: z
          .array(z.string())
          .optional()
          .describe(
            `例 {"source":["mgr-1"]}。配列で渡し、値は引用符で囲む。` +
              `出所の**完全一致**（配列は${formatArrayLengthJa({ min: 1 })}、各要素は${formatStringLengthJa({ min: 1 })}）。q の部分一致とは別物`,
          ),
        q: z
          .string()
          .optional()
          .describe(
            `タイトル・本文・出所への部分一致（大文字小文字を区別しない。${formatStringLengthJa({ min: 1 })}）`,
          ),
        until: z
          .string()
          .optional()
          .describe(
            `この時刻までに積んだ（createdAt）task だけを対象にする（ISO8601。${formatStringLengthJa({ min: 1 })}。その瞬間ちょうどの task は含む）。` +
              '元に戻せない操作なので時差が必須（Z か +09:00。例 2026-09-11T19:00:00Z。時差の無い形は断る）。' +
              '変えている最中に積まれた新しい task を巻き込まないために使う',
          ),
        status: z
          .enum(TASK_STATUS_MANY_TARGETS)
          .describe('移す先の状態（done=終わった / cancelled=取りやめた。閉じる状態だけ）'),
        reason: z
          .string()
          .describe(
            `何をもってこの絞り込みに当たる task を閉じてよいとするか（${formatStringLengthJa({ min: 1 })}）。人間はこれを読んで後から否定する`,
          ),
        dryRun: z
          .boolean()
          .optional()
          .describe(
            '省略すると true（何件当たるかを数えるだけで1件も変えない）。実際に変えるときだけ false を明示する',
          ),
        limit: z
          .number()
          .optional()
          .describe(
            `1回の呼びで変える上限（${formatIntRangeJa({ min: 1, max: CLOSE_MANY_LIMIT_MAX })}。省略すると 500）。**古い側から**変える。` +
              '残りは同じ絞り込みでもう一度呼べば続けられる',
          ),
      },
      async ({ origin, source, q, until, status, reason, dryRun, limit }) => {
        // 検証は `task-set-status-many.ts` の `describeTaskStatusManyViolation`
        const input = { origin, source, q, until, status, reason, dryRun, limit };
        const violation = describeTaskStatusManyViolation(input);
        if (violation !== null) return text(violation);

        const selection = await selectTaskStatusManyTargets(stores.tasks, input);

        const filter = { origin, source, q, until };
        const filterText = describeCloseManyFilter(input);
        const funnel = renderCloseManyFunnel(filter, selection);
        const unreadableNote = renderCloseManyUnreadableNote(selection.unreadableCount);

        if (selection.matched.length === 0) {
          const why = describeCloseManyZeroReason(filter, selection);
          return text(renderCloseManyZeroResult({ funnel, why, unreadableNote }));
        }

        const restNote = renderCloseManyRestNote(selection.rest, selection.effectiveLimit);

        // 省略された `dryRun` は試算にする: 開き直す口は1件ずつで、まとめて開き直す口が無く、撃ち間違えた一括の変更は実質戻せないため
        if (dryRun !== false) {
          return text(
            renderCloseManyDryRun({
              status,
              funnel,
              filterText,
              selection,
              restNote,
              unreadableNote,
            }),
          );
        }

        const { closedIds, journaledChunks } = await closeManyTargetsJournaling({
          tasks: stores.tasks,
          journal: stores.journal,
          selection,
          status,
          reason,
          filterText,
        });
        return text(
          renderCloseManyDone({
            status,
            reason,
            funnel,
            filterText,
            targetCount: selection.targets.length,
            closedIds,
            journaledChunks,
            restNote,
            unreadableNote,
          }),
        );
      },
    ),

    // 人間起点の合図（`human_message` / `human_answer`）を選べない形にする: クローンは自分の側の都合で溜まった合図だけを畳める
    // 絞り込みの判定をストアへ複製しない: SQL 側へ同じ判定を書くと「一覧に見えている件数」と「実際に消える件数」が別の実装を持つことになるため

    tool(
      'inbox_remove_many',
      [
        '受信箱（`InboxStore`）の未読を、**絞り込みを渡してまとめて畳む（消す）**。',
        '1件ずつ消す道具（内部の `remove()`）はこの器から呼べない——同じ失敗の写しが',
        '数千件積もると、1ターン1件のペースでの排出それ自体が文脈窓を食い潰す。',
        '**既定は試算（dryRun）で、1件も消さない。** 実際に消すには `dryRun: false` を明示すること——',
        '消した合図を戻す道具はこの器に無いので、撃ち間違えは道具では戻せない。',
        `**\`types\` は必須で、選べる5種類（${CLONE_REMOVABLE_INBOX_EVENT_TYPES.join(' / ')}）を` +
          '全部並べた呼びは断る**' +
          '（「全部消す」を1回で撃てる形は作らない——それは `POST /reset` の役目である）。',
        '**人間起点の合図（`human_message` / `human_answer`）はそもそも選べない。**' +
          'あなたは自分の側の都合で溜まった合図だけを畳める——人間から届いた合図を' +
          '自分の判断で畳む口は、この道具には無い（オーナー判断）。',
        '**行は消える。** `task_set_status_many` の「閉じる（closedAt を付けるだけで行は残る）」とは違い、',
        '受信箱は「まだ処理し終えていない」という事実だけを持つ器で、片付いた後の記録を残す場所ではない',
        '（`InboxStore` の doc）。**消した id は全部日誌に残る。**',
      ].join(''),
      {
        types: inboxRemoveManyTypesToolInputSchema.describe(
          `例 {"types":["manager_message"]}。配列で渡し、値は引用符で囲む。` +
            `消す対象の種類（必須。${formatArrayLengthJa({ min: 1 })}）。選べる5種類 ` +
            `(${CLONE_REMOVABLE_INBOX_EVENT_TYPES.join(' / ')}) を全部並べると断られる。` +
            '人間起点の human_message / human_answer はここに無い——選べない' +
            '（自分の受信箱から人間の発言・回答を自分の判断で畳むことはできない）。' +
            '例: 委譲先の429の写しを畳むなら manager_message だけを狙う',
        ),
        sources: z
          .array(z.string())
          .optional()
          .describe(
            `例 {"sources":["external:token-pool"]}。配列で渡し、値は引用符で囲む。` +
              `送信元の**完全一致**（配列は${formatArrayLengthJa({ min: 1 })}、各要素は${formatStringLengthJa({ min: 1 })}）。\`manager_list\` の内訳（送信元）に出る表記` +
              '（例 "external:token-pool" / "manager:mgr-xxx"）をそのまま渡す。' +
              '送信元を言えない種類（distill / timer / self_initiative）の行は、' +
              'これを渡すと必ず対象から外れる',
          ),
        before: z
          .string()
          .optional()
          .describe(
            `この時刻**以前**（ISO8601、その瞬間ちょうども含む。${formatStringLengthJa({ min: 1 })}）に積まれた行だけを対象にする。` +
              '元に戻せない操作なので時差が必須（Z か +09:00。例 2026-09-15T00:00:00Z。時差の無い形は断る）。' +
              '消している最中に届いた新しい行を巻き込まないために使う',
          ),
        reason: z
          .string()
          .describe(
            `何をもってこの絞り込みに当たる行を畳んでよいとしたか（${formatStringLengthJa({ min: 1 })}）。人間はこれを読んで後から否定する`,
          ),
        dryRun: z
          .boolean()
          .optional()
          .describe(
            '省略すると true（何件当たるかを数えるだけで1件も消さない）。実際に消すときだけ false を明示する',
          ),
        limit: z
          .number()
          .optional()
          .describe(
            `1回の呼びで消す上限（${formatIntRangeJa({ min: 1, max: REMOVE_MANY_LIMIT_MAX })}。省略すると 500）。**古い側から**消す。` +
              '残りは同じ絞り込みでもう一度呼べば続けられる',
          ),
      },
      async ({ types, sources, before, reason, dryRun, limit }) => {
        const violation = describeInboxRemoveManyViolation({
          types,
          sources,
          before,
          reason,
          limit,
        });
        if (violation !== null) return text(violation);

        const filter: InboxRemoveManyFilter = {
          types,
          ...(sources === undefined ? {} : { sources }),
          ...(before === undefined ? {} : { before }),
        };
        const { allPending, matched, unreadableNote } = await selectInboxRemoveManyTargets(
          stores.inbox,
          filter,
        );

        const filterText = describeInboxRemoveManyFilterText(filter);
        const funnel = renderInboxRemoveManyFunnel(allPending.length, matched.length);

        if (matched.length === 0) {
          const why = describeInboxRemoveManyZeroReason(allPending, unreadableNote);
          return text(renderInboxRemoveManyZeroResult(funnel, why));
        }

        const effectiveLimit = limit ?? REMOVE_MANY_LIMIT_DEFAULT;
        const targets = matched.slice(0, effectiveLimit);
        const restNote = renderInboxRemoveManyRestNote(
          matched.length - targets.length,
          effectiveLimit,
        );

        // 省略された `dryRun` は試算にする: 消した合図を戻す道具が無いため
        if (dryRun !== false) {
          return text(
            renderInboxRemoveManyDryRun({
              funnel,
              filterText,
              targets,
              matchedCount: matched.length,
              restNote,
            }),
          );
        }

        // 配達を止める口が無ければ1件も消さない: 行を消した状態で配達だけが続くほうが、1件も消さないより悪い（掃除できたと誤解するのにターンは起き続ける）ため
        const stopDelivery = context.dropQueuedInboxEvents;
        if (stopDelivery === undefined) return text(renderInboxRemoveManyNoDeliveryRefusal());

        const state = await removeInboxTargetsJournaling({
          stores,
          stopDelivery,
          targets,
          reason,
          filterText,
        });
        return text(
          renderInboxRemoveManyDone({
            reason,
            funnel,
            filterText,
            targetCount: targets.length,
            state,
            restNote,
          }),
        );
      },
    ),
  ];
}
