// task と進捗・外部観測（task_* / progress_read / github_observation_record）の道具。
// `tools.ts` から呼ぶ（`createCloneTools` が並びのまま連結する）。このファイルから `tools.ts` を import しない（一方向）。
// `task_set_status_many` は `clone-tools-task-set-status-many.ts`、`inbox_remove_many` は `clone-tools-inbox-remove-many.ts` に在る（`taskTools` が並びの同じ位置へ差し込む）。

import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { collapseErrorCause } from './error-cause.js';
import { describePage, excerptLine, page, renderListing, renderListingEntry } from './excerpt.js';
import {
  DEFAULT_PROGRESS_WINDOW_HOURS,
  InvalidProgressWindowError,
  readProgress,
} from './progress-read.js';
import { describeProgress } from './progress-describe.js';
import { stripNul } from './nul-guard.js';
import {
  githubObservationInputSchema,
  taskStatusSchema,
  type TaskStatus,
  type Task,
  type TaskOrigin,
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
import { UnreadableTaskError, type JournalStore, type TaskStore } from './store.js';
import {
  describeBlankViolation,
  describeIntRangeViolation,
  describeStringLengthViolation,
  formatIntRangeJa,
  formatStringLengthJa,
} from './tool-arg-checks.js';
import { appendJournalOrDrop, tool, text, appendJournalOrThrow } from './clone-tools-common.js';
import { taskSetStatusManyTool } from './clone-tools-task-set-status-many.js';
import { inboxRemoveManyTool } from './clone-tools-inbox-remove-many.js';
import type { ToolContext, CloneToolsShared } from './clone-tools-context.js';

// モデルの引数からは受けない: 名乗りを引数に任せると「誰の観測か」が申告の申告になるため
export const GITHUB_OBSERVATION_CLONE_OBSERVER = 'clone';

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

type TaskAddStores = CloneToolsShared['stores'];
type TaskAddPlacement = Parameters<typeof describeTaskPlacement>[0];
type TaskAddOutcome =
  | { kind: 'anchor-not-found' }
  // 同じ id の行が既に在り、何も書かなかった（id がぶつかった）
  | { kind: 'existed' }
  // 器は書いたと返したが、読み直しで確かめられなかった。missing（読み直しが null）/ unreadable（読み直しが読めない形）
  | { kind: 'unconfirmed'; reason: 'missing' | 'unreadable' }
  | { kind: 'added' };

// 題・本文・出所の検査。断る文を返す（通れば null）。順: 題の長さと空白 → 題の改行 → 本文 → 出所
function describeTaskAddViolation(
  title: string,
  body: string,
  source: string | undefined,
): string | null {
  const titleError =
    describeStringLengthViolation('title', title, { min: 1, max: TASK_TITLE_MAX }) ??
    describeBlankViolation('title', title);
  if (titleError !== null) return titleError;
  if (/[\r\n]/.test(title)) return 'title は使えない（改行を含まない一行のみ）。';
  const bodyError =
    describeStringLengthViolation('body', body, { min: 1 }) ?? describeBlankViolation('body', body);
  if (bodyError !== null) return bodyError;
  for (const [field, value] of [['source', source]] as const) {
    if (value !== undefined && stripNul(value).trim().length === 0) {
      return `${field} が空です。分かるときだけ実のある文字列で渡し、無いなら省略してください。`;
    }
  }
  return null;
}

// 新しい task の行。新しい task は必ず起点の会話 id を持つ（task_say の宛先）。機構が決める: いまのターンの会話か、報告を読んでいる委譲の起点。どちらも無いときだけ新しい id
// 呼びの順: new Date() → getWorkConversationId() →（無いときだけ randomUUID()）→ task の id の randomUUID()
function buildTaskAddEntry(
  getWorkConversationId: CloneToolsShared['getWorkConversationId'],
  title: string,
  body: string,
  source: string | undefined,
): Task {
  const now = new Date().toISOString();
  const originId = getWorkConversationId() ?? randomUUID();
  return {
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
}

// 「足した」と名乗る前に読み直して確かめる: 書き込みが静かに失敗しても呼び出し側からは例外が見えないため。
// `tasks.get` だけを包み、`UnreadableTaskError` は null（読めない）にして、ほかは投げ直す
async function readBackAddedTask(
  stores: TaskAddStores,
  taskId: string,
): Promise<{ task: Task | null; unreadable: boolean }> {
  try {
    return { task: await stores.tasks.get(taskId), unreadable: false };
  } catch (error) {
    if (!(error instanceof UnreadableTaskError)) throw error;
    return { task: null, unreadable: true };
  }
}

function renderTaskAddAnchorMissing(anchorId: string | undefined): string {
  return `anchorId ${anchorId} は開いている task に無い（閉じた件・無い id は基準にできない）。何も足していない。task_list で確かめること。`;
}

// 同じ id の行が既に在った回の断り。何も書いていない（#6471）
function renderTaskAddExisted(taskId: string): string {
  return (
    `task の id ${taskId} が既に在ったので、何も書かなかった（新しく採番した id がぶつかった）。**何も足していない。** ` +
    'もう一度 task_add を呼べば、新しい id で足せる。'
  );
}

// 器は書いたと返したが、読み直しで確かめられなかった回（読み直しが null / 読めない）の断り
function renderTaskAddUnconfirmed(taskId: string): string {
  return (
    `task を書き込んだが、直後に読み直しても ${taskId} を確認できなかった。**「足した」とは言えない。** ` +
    `task_list id=${taskId} で確かめ、無ければ同じ内容でもう一度 task_add を試すこと。`
  );
}

function buildTaskAddJournalEntry(entry: Task, placement: TaskAddPlacement) {
  return {
    type: 'decision' as const,
    target: { kind: 'task' as const, id: entry.id },
    decision: `task を足した（${entry.id}）: ${entry.title}`,
    grounds: `自分で task_add した。置き場所: ${describeTaskPlacement(placement)}。起点の会話: ${entry.originConversationId}。本文: ${entry.body}`,
  };
}

// 器は書いたと返したが読み直しで確かめられなかった回の日誌。行は在るかもしれないので、日誌が無いまま残さない（#6471）
function buildTaskAddUnconfirmedJournalEntry(
  entry: Task,
  placement: TaskAddPlacement,
  why: string,
) {
  const base = buildTaskAddJournalEntry(entry, placement);
  return {
    ...base,
    decision: `task を足した（${entry.id}）が、直後の読み直しで確かめられなかった: ${entry.title}`,
    grounds: `${base.grounds}。読み直し: ${why}`,
  };
}

function renderTaskAddDone(entry: Task): string {
  return `task を足した（${entry.id}）。起点の会話は ${entry.originConversationId}（task_say taskId=${entry.id} でここへ書ける）。位置は task_list で確かめられる。`;
}

// 足す → 読み直して確かめる → 日誌、の段
// 器が書いたと返したのに確かめられなかった回も、日誌に1行残す: 行は在るかもしれず、日誌が無いと足したことが辿れないため（#6471）。
// 行の実在は分からないので「完了済み・やり直し禁止」の例外にはせず、書けなくても断りの文を返す（appendJournalOrDrop）
async function addTaskVerifyingJournaling(
  stores: TaskAddStores,
  entry: Task,
  placement: TaskAddPlacement,
): Promise<TaskAddOutcome> {
  const added = await stores.tasks.add(entry, placement);
  if (added.kind === 'anchor-not-found') return { kind: 'anchor-not-found' };
  // 同じ id が既に在れば器は何も書いていないので、読み直さずに断る
  if (added.kind === 'existed') return { kind: 'existed' };
  let back: { task: Task | null; unreadable: boolean };
  try {
    back = await readBackAddedTask(stores, entry.id);
  } catch (error) {
    await appendJournalOrDrop(
      'task_add',
      stores.journal,
      buildTaskAddUnconfirmedJournalEntry(
        entry,
        placement,
        `例外で終わった（${collapseErrorCause(error)}）`,
      ),
    );
    throw error;
  }
  if (back.task === null) {
    await appendJournalOrDrop(
      'task_add',
      stores.journal,
      buildTaskAddUnconfirmedJournalEntry(
        entry,
        placement,
        back.unreadable ? '読めない形で入っていた' : '見つからなかった',
      ),
    );
    return { kind: 'unconfirmed', reason: back.unreadable ? 'unreadable' : 'missing' };
  }
  await appendJournalOrThrow(
    'task_add',
    stores.journal,
    buildTaskAddJournalEntry(entry, placement),
    'act-completed',
  );
  return { kind: 'added' };
}

type TaskMovePlacement = NonNullable<Parameters<typeof describeTaskPlacement>[0]>;
type TaskMoveOutcome = Awaited<ReturnType<TaskStore['move']>>;

function renderTaskMoveUnreadable(taskId: string): string {
  return `task ${taskId} は読めない形で入っている。読めない形のまま書き直さないので、動かしていない。`;
}

// move の結果が断りなら、その文を返す（動かせたなら null）
function describeTaskMoveRefusal(args: {
  moved: TaskMoveOutcome;
  taskId: string;
  anchorId: string | undefined;
}): string | null {
  const { moved, taskId, anchorId } = args;
  if (moved.kind === 'not-found') {
    return `task ${taskId} は無い（task_list で実在する id を確かめること）。何もしていない。`;
  }
  if (moved.kind === 'closed') {
    return `task ${taskId} は閉じている（並びに載っていない）ので動かせない。戻すなら task_set_status で queued にする。`;
  }
  if (moved.kind === 'anchor-is-self') {
    return 'anchorId に動かす task 自身は指せない。何もしていない。';
  }
  if (moved.kind === 'anchor-not-found') {
    return `anchorId ${anchorId} は開いている task に無い（閉じた件・無い id は基準にできない）。何も動かしていない。`;
  }
  return null;
}

function buildTaskMoveJournalEntry(args: { taskId: string; placement: TaskMovePlacement }) {
  const { taskId, placement } = args;
  return {
    type: 'decision' as const,
    target: { kind: 'task' as const, id: taskId },
    decision: `task の並びを変えた（${taskId}）: ${describeTaskPlacement(placement)}へ`,
    grounds: '自分で task_move した',
  };
}

function renderTaskMoveDone(taskId: string, placement: TaskMovePlacement): string {
  return `task ${taskId} を${describeTaskPlacement(placement)}へ動かした。`;
}

type TaskKeepOutcome = Awaited<ReturnType<TaskStore['setKeep']>>;

function renderTaskKeepUnreadable(taskId: string): string {
  return `task ${taskId} は読めない形で入っている。読めない形のまま書き直さないので、印を変えていない。`;
}

// setKeep の結果が断り（印を変えなかった: changed 以外）のとき、その文を返す。
// 呼び側が `result.kind !== 'changed'` で絞ってから呼ぶ: null を返す形にすると、呼び側で `result.task` の型が絞れないため
function describeTaskKeepRefusal(args: {
  result: Exclude<TaskKeepOutcome, { kind: 'changed' }>;
  taskId: string;
  keep: boolean;
}): string {
  const { result, taskId, keep } = args;
  if (result.kind === 'not-found') {
    return `task ${taskId} は無い（task_list で実在する id を確かめること）。何もしていない。`;
  }
  return `task ${taskId} は既に${keep ? '「続く」の印つき' : '印なし'}。何もしていない。`;
}

function renderTaskKeepDone(taskId: string, keep: boolean): string {
  return `task ${taskId} の「続く」の印を${keep ? '立てた。返答しても器は自動では done にしない' : '外した'}。`;
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
        const violation = describeTaskAddViolation(title, body, source);
        if (violation !== null) return text(violation);
        const resolved = resolveTaskPlacement(to, anchorId);
        if (resolved.kind === 'invalid') return text(resolved.message);
        const entry = buildTaskAddEntry(getWorkConversationId, title, body, source);
        const outcome = await addTaskVerifyingJournaling(stores, entry, resolved.placement);
        if (outcome.kind === 'anchor-not-found') return text(renderTaskAddAnchorMissing(anchorId));
        if (outcome.kind === 'existed') return text(renderTaskAddExisted(entry.id));
        if (outcome.kind === 'unconfirmed') return text(renderTaskAddUnconfirmed(entry.id));
        return text(renderTaskAddDone(entry));
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
            return text(renderTaskMoveUnreadable(taskId));
          }
          throw error;
        }
        const refusal = describeTaskMoveRefusal({ moved, taskId, anchorId });
        if (refusal !== null) return text(refusal);
        await appendJournalOrThrow(
          'task_move',
          stores.journal,
          buildTaskMoveJournalEntry({ taskId, placement }),
          'act-completed',
        );
        return text(renderTaskMoveDone(taskId, placement));
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
        '自動 done が閉じない場合はほかにもある: waiting / needs_decision（待ち・判断待ち）、その会話に答えの無い問い（ask_human・request_permission。前のターンのものを含む。不要になった問いは approval_withdraw で取り下げると対象に戻る）が残っているとき、その task に結び付いた委譲（manager_start の taskId。Job.taskId）が走っている（running / waiting_human。前のターンで起こしたものを含む）か、このターンで manager_send で頼んだとき（task に結び付かない委譲は数えない）、まだ読んでいない発言の task、起点の会話が無い task。',
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
          if (error instanceof UnreadableTaskError) return text(renderTaskKeepUnreadable(taskId));
          throw error;
        }
        if (result.kind !== 'changed') {
          return text(describeTaskKeepRefusal({ result, taskId, keep }));
        }
        await appendJournalOrThrow(
          'task_keep',
          stores.journal,
          taskKeepChangeEntry(taskId, result.task, keep),
          'act-completed',
        );
        return text(renderTaskKeepDone(taskId, keep));
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

    taskSetStatusManyTool(stores),

    inboxRemoveManyTool(context, stores),
  ];
}
