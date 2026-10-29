import { excerptLine } from './excerpt.js';
import { isTaskClosed } from './task.js';
import type { TaskPlacement } from './task.js';
import type { JournalEntryInput, Task, TaskStatus } from './schema.js';
import type { TaskList } from './store.js';

// task_* 道具の入力の解釈と表示だけを置く（登録と日誌は tools.ts）。規則（遷移・並び）は task.ts が1本だけ持つ。

export const TASK_TITLE_MAX = 200;
export const TASK_BODY_LIMIT = 240;
export const TASK_LIST_BUDGET = 8_000;
export const TASK_PAGE = 8_000;
export const UNREADABLE_TASK_IDS_SHOWN = 20;

export const TASK_PLACEMENT_TARGETS = ['front', 'back', 'before', 'after'] as const;
export type TaskPlacementTarget = (typeof TASK_PLACEMENT_TARGETS)[number];

export const TASK_STATUS_LABEL: Record<TaskStatus, string> = {
  queued: '待ち行列',
  waiting: '待ち（外の返事・時間待ち）',
  needs_decision: '決めてほしい',
  done: '終わった',
  cancelled: '取りやめた',
};

/** `to` と `anchorId` を `TaskPlacement` に直す。食い違いは文言で返す（例外にしない）。 */
export function resolveTaskPlacement(
  to: TaskPlacementTarget | undefined,
  anchorId: string | undefined,
): { kind: 'ok'; placement: TaskPlacement | undefined } | { kind: 'invalid'; message: string } {
  if (to === undefined) {
    if (anchorId !== undefined) {
      return {
        kind: 'invalid',
        message: 'anchorId だけでは置き場所が決まらない。to に before か after を渡すこと。',
      };
    }
    return { kind: 'ok', placement: undefined };
  }
  if (to === 'before' || to === 'after') {
    if (anchorId === undefined || anchorId.length === 0) {
      return {
        kind: 'invalid',
        message: `to=${to} には anchorId（基準にする task の id）が要る。`,
      };
    }
    return { kind: 'ok', placement: { kind: to, anchorId } };
  }
  if (anchorId !== undefined) {
    return {
      kind: 'invalid',
      message: `to=${to} に anchorId は付けられない（before / after のときだけ使う）。`,
    };
  }
  return { kind: 'ok', placement: { kind: to } };
}

export function describeTaskPlacement(placement: TaskPlacement | undefined): string {
  if (placement === undefined) return '既定の位置';
  if (placement.kind === 'front') return '先頭';
  if (placement.kind === 'back') return '末尾';
  return `${placement.anchorId} の${placement.kind === 'before' ? '直前' : '直後'}`;
}

export function taskStatusLine(task: Pick<Task, 'status' | 'closedAt' | 'keep'>): string {
  const label = TASK_STATUS_LABEL[task.status];
  const state =
    task.closedAt === undefined
      ? `状態: ${task.status}（${label}）`
      : `状態: ${task.status}（${label}）/ ${task.closedAt} に閉じた`;
  return task.keep === true ? `${state} / 続く（返答しても自動で閉じない）` : state;
}

/** 「続く」の印を変えた日誌の行。 */
export function taskKeepChangeEntry(taskId: string, task: Task, keep: boolean): JournalEntryInput {
  return {
    type: 'decision',
    decision: `task の「続く」の印を${keep ? '立てた' : '外した'}（${taskId}: ${task.title}）`,
    grounds: keep
      ? '自分で task_keep した。起点の会話へ返答しても、この task は器が自動では done にしない（閉じるのは task_set_status）'
      : '自分で task_keep した。印を外したので、queued のままなら、その発言を読んで起点の会話へ返答したターンの終わりに、器が自動で done にしうる（後から来た別の発言への turn_reply では閉じない。印を外した後の task_say と、回答のターンの返答では、受信箱に残っていない限り閉じうる。終えるときは task_set_status で done にしてもよい）',
  };
}

/** 発意 tick の入力に載せる待ち行列の先頭の件数（初期値。多すぎる・少なすぎるは運用で見て変える）。 */
export const TASK_QUEUE_HEAD_LIMIT = 3;

const TASK_QUEUE_HEAD_TITLE_LIMIT = 120;
const OPEN_TASK_STATUSES = ['queued', 'waiting', 'needs_decision'] as const;

/** 待ち行列の件数の1行（開いている件の合計と状態別の内訳）。閉じた件は数えない。 */
export function describeTaskQueueCount(list: Pick<TaskList, 'entries'>): string {
  const open = list.entries.filter((task) => !isTaskClosed(task.status));
  const breakdown = OPEN_TASK_STATUSES.map(
    (status) => `${status} ${open.filter((task) => task.status === status).length}`,
  ).join(' / ');
  return `待ち行列: 開いている ${open.length} 件（${breakdown}）`;
}

/**
 * 発意 tick の入力の「待ち行列の先頭」の行。件数の1行・読めない行の断り・先頭 `limit` 件・1行の案内。
 * 並びは `list.entries` のまま（器は並べ直さない。先頭が先にやるもの）。読めない行は 0 に丸めず件数で断る（終わったのではない）。
 * 開いている件が無ければ件数の行（と読めない行の断り）だけで、案内は出さない。
 */
export function describeTaskQueueHead(list: TaskList, options: { limit: number }): string[] {
  const open = list.entries.filter((task) => !isTaskClosed(task.status));
  const lines = [`- ${describeTaskQueueCount(list)}`];
  if (list.unreadable.length > 0) {
    lines.push(
      `- 読めない task の行が ${list.unreadable.length} 件ある（上の件数には入っていない。終わったのではない）`,
    );
  }
  if (open.length === 0) return lines;
  const shown = open.slice(0, options.limit);
  for (const task of shown) {
    lines.push(
      `- ${task.id}（${taskStatusLine(task)} / origin: ${task.origin}）${excerptLine(task.title, TASK_QUEUE_HEAD_TITLE_LIMIT)}`,
    );
  }
  // 先頭が waiting だけで埋まると、動ける task が見えなくなる（waiting にしても rank は動かない）。最初の queued / needs_decision を1件添える
  const movable = (task: Task): boolean =>
    task.status === 'queued' || task.status === 'needs_decision';
  let extra: Task | undefined;
  if (!shown.some(movable)) {
    extra = open.slice(shown.length).find(movable);
    if (extra) {
      lines.push(
        `- 先頭から離れている（先頭は待ちばかり）: ${extra.id}（${taskStatusLine(extra)} / origin: ${extra.origin}）${excerptLine(extra.title, TASK_QUEUE_HEAD_TITLE_LIMIT)}`,
      );
    }
  }
  const rest = open.length - shown.length - (extra ? 1 : 0);
  if (rest > 0) {
    lines.push(`- …ほか ${rest} 件（task_list で全部見える）`);
  }
  lines.push(
    '（先頭が先にやるもの。並べ替えは task_move、取りやめ・完了は task_set_status、全部は task_list）',
  );
  return lines;
}

// task の並びは行の欄ではなくストアが持つ位置（rank）で、rank は読む側に出ない。続きの錨は「最後に出した件の id」にする:
// 並べ替えで錨の位置が動いても錨の直後から続き、錨が一覧から外れたら黙って別の続きにせず明示のエラーにする
export interface TaskCursor {
  id: string;
  includeClosed: boolean;
}

export function encodeTaskCursor(cursor: TaskCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function decodeTaskCursor(raw: string): TaskCursor | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (typeof parsed !== 'object' || parsed === null) return null;
    const { id, includeClosed } = parsed as Record<string, unknown>;
    if (typeof id !== 'string' || id.length === 0 || typeof includeClosed !== 'boolean')
      return null;
    return { id, includeClosed };
  } catch {
    return null;
  }
}

export type TaskCursorOutcome =
  | { kind: 'ok'; view: Task[] }
  | { kind: 'malformed' }
  | { kind: 'includeClosed-mismatch'; cursorIncludeClosed: boolean }
  | { kind: 'anchor-gone' };

export function resolveTaskCursor(
  entries: readonly Task[],
  includeClosed: boolean,
  cursorRaw: string | undefined,
): TaskCursorOutcome {
  if (cursorRaw === undefined) return { kind: 'ok', view: [...entries] };
  const decoded = decodeTaskCursor(cursorRaw);
  if (decoded === null) return { kind: 'malformed' };
  if (decoded.includeClosed !== includeClosed) {
    return { kind: 'includeClosed-mismatch', cursorIncludeClosed: decoded.includeClosed };
  }
  const index = entries.findIndex((entry) => entry.id === decoded.id);
  if (index < 0) return { kind: 'anchor-gone' };
  return { kind: 'ok', view: entries.slice(index + 1) };
}

/** 状態変更の日誌の行。閉じた行を戻すときは、行から外れる閉じた記録を逐語で含める（外れた後は日誌にしか残らない）。 */
export function taskStatusChangeEntry(
  taskId: string,
  before: Task,
  status: TaskStatus,
  reason: string | undefined,
): JournalEntryInput {
  return {
    type: 'decision',
    decision: `task の状態を変えた（${taskId}）: ${before.status} → ${status}${
      reason === undefined ? '' : `（${reason}）`
    }`,
    grounds:
      before.closedAt !== undefined
        ? `自分で task_set_status した。開き直す前の記録: ${describeTaskClosedRecord(before)}`
        : '自分で task_set_status した',
  };
}

export function describeTaskClosedRecord(task: Task): string {
  if (task.closedAt === undefined) return '（閉じた記録なし）';
  return `閉じた時刻=${task.closedAt} / 閉じた主体=${task.closedBy ?? '（記録なし）'} / 理由=${task.closedReason ?? '（理由の記録なし）'}`;
}
