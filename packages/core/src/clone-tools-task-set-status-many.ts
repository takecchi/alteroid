// `task_set_status_many` の道具（開いている task を絞り込んでまとめて done / cancelled にする）と、その応答・日誌・途中停止の補助。
// `clone-tools-task.ts` の `taskTools` が並びのまま連結する。このファイルから `clone-tools-task.ts` を import しない（一方向）。

import { z } from 'zod';
import { journalEntryShape } from './dropped-record.js';
import { collapseErrorCause } from './error-cause.js';
import { stripNulWellFormed } from './nul-guard.js';
import { taskOriginSchema, type Task, type TaskOrigin, type JournalEntryInput } from './schema.js';
import type { JournalStore, Stores, TaskStore } from './store.js';
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
import { formatArrayLengthJa, formatIntRangeJa, formatStringLengthJa } from './tool-arg-checks.js';
import { tool, text, appendJournalOrThrow, JournalNotRecordedError } from './clone-tools-common.js';

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
  // 全件が競合したときは「0 件を done にした」と空の「変えた id」で終えず、閉じられなかったと言う（`renderInboxRemoveManyDone` と同じ。競合の注意を本体にする）
  if (closedIds.length === 0 && targetCount > 0) {
    return [
      `**1 件も閉じられなかった**（理由: ${reason}）。`,
      funnel,
      `絞り込み: ${filterText}`,
      ...renderCloseManyRacedNote(targetCount, targetCount),
      ...args.restNote,
      ...args.unreadableNote,
    ].join('\n');
  }
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

export function taskSetStatusManyTool(stores: Stores) {
  return tool(
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
    async ({ origin, source, q, until, status, reason: rawReason, dryRun, limit }) => {
      // 検証は `task-set-status-many.ts` の `describeTaskStatusManyViolation`
      const input = { origin, source, q, until, status, reason: rawReason, dryRun, limit };
      const violation = describeTaskStatusManyViolation(input);
      if (violation !== null) return text(violation);
      // task の閉じた理由（ストアが NUL を落とす）・日誌・出力で同じ文字列にするため、検証のあとで先に落とす。前後の空白は task_set_status と同じく trim しない
      const reason = stripNulWellFormed(rawReason);

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
  );
}
