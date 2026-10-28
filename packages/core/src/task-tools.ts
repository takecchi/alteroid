import type { TaskPlacement } from './task.js';
import type { Task, TaskStatus } from './schema.js';

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

export function taskStatusLine(task: Pick<Task, 'status' | 'closedAt'>): string {
  const label = TASK_STATUS_LABEL[task.status];
  return task.closedAt === undefined
    ? `状態: ${task.status}（${label}）`
    : `状態: ${task.status}（${label}）/ ${task.closedAt} に閉じた`;
}

export function describeTaskClosedRecord(task: Task): string {
  if (task.closedAt === undefined) return '（閉じた記録なし）';
  return `閉じた時刻=${task.closedAt} / 閉じた主体=${task.closedBy ?? '（記録なし）'} / 理由=${task.closedReason ?? '（理由の記録なし）'}`;
}
