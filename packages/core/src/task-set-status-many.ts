import {
  CLOSE_MANY_LIMIT_DEFAULT,
  describeCloseManyViolation,
  type CloseManyFilterInput,
  type CloseManyStore,
} from './task-close-many.js';
import type { Task, TaskClosedBy } from './schema.js';
import type { TaskStore } from './store.js';
import { UnreadableTaskError } from './store.js';

// 道具 `task_set_status_many`（クローン）の検証・絞り込み・Task ストアへの当て方。
// 検証は `describeCloseManyViolation`（`task-close-many.ts`）に任せる。
// 日誌は塊ごとに書く（塊の割り方は `closeManyInChunks`）。Task の一括の口は TaskStore に足さない: 1件ずつの `setStatus` が遷移の規則と排他を持っており、
// 一括用の別経路を3実装に足すと、遷移の規則が2か所に割れるため。Task は数千件溜める前提ではないので、1件ずつの書き直しの重さは許す

/** まとめて移せる先。閉じる状態だけ（開き直し・開いている状態どうしの移動は1件ずつの `task_set_status`）。 */
export const TASK_STATUS_MANY_TARGETS = ['done', 'cancelled'] as const;
export type TaskStatusManyTarget = (typeof TASK_STATUS_MANY_TARGETS)[number];

export interface TaskStatusManyInput extends CloseManyFilterInput {
  status: TaskStatusManyTarget;
  reason: string;
  dryRun?: boolean | undefined;
  limit?: number | undefined;
}

/** 断るなら人間（と AI）が読む断り文を返し、通すなら `null`。 */
export function describeTaskStatusManyViolation(input: TaskStatusManyInput): string | null {
  if (!(TASK_STATUS_MANY_TARGETS as readonly string[]).includes(input.status)) {
    return (
      `status=${String(input.status)} はまとめて移せない（${TASK_STATUS_MANY_TARGETS.join(' / ')} だけ）。` +
      '開き直しや開いている状態どうしの移動は、1件ずつ task_set_status で行う。**1件も閉じていない。**'
    );
  }
  return describeCloseManyViolation(input, 'task の待ち行列');
}

export interface TaskStatusManySelection {
  /** 開いている全 Task（読めた分）。0件の理由を段で言うために段ごとの行を持つ */
  openEntries: readonly Task[];
  afterOrigin: readonly Task[];
  afterSource: readonly Task[];
  afterQ: readonly Task[];
  matched: readonly Task[];
  /** この呼びで変える Task（`matched` の古い側から `limit` 件） */
  targets: readonly Task[];
  rest: number;
  effectiveLimit: number;
  unreadableCount: number;
}

/**
 * 開いている Task を絞り込んで、変える対象を決める（変えない）。古い側（`createdAt`）から `limit` 件。
 * 入力は `describeTaskStatusManyViolation` を通った後のものを渡すこと。
 */
export async function selectTaskStatusManyTargets(
  tasks: Pick<TaskStore, 'list'>,
  input: CloseManyFilterInput & { limit?: number | undefined },
): Promise<TaskStatusManySelection> {
  const { origin, source, q, until, limit } = input;
  const { entries, unreadable } = await tasks.list();
  const openEntries = [...entries].sort(
    (a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt),
  );
  const afterOrigin = openEntries.filter((task) => origin.includes(task.origin));
  const afterSource =
    source === undefined
      ? afterOrigin
      : afterOrigin.filter((task) => task.source !== undefined && source.includes(task.source));
  const needle = q?.toLowerCase();
  const afterQ =
    needle === undefined
      ? afterSource
      : afterSource.filter(
          (task) =>
            task.title.toLowerCase().includes(needle) ||
            task.body.toLowerCase().includes(needle) ||
            (task.source !== undefined && task.source.toLowerCase().includes(needle)),
        );
  const untilMs = until === undefined ? undefined : Date.parse(until);
  const matched =
    untilMs === undefined ? afterQ : afterQ.filter((task) => Date.parse(task.createdAt) <= untilMs);
  const effectiveLimit = limit ?? CLOSE_MANY_LIMIT_DEFAULT;
  const targets = matched.slice(0, effectiveLimit);
  return {
    openEntries,
    afterOrigin,
    afterSource,
    afterQ,
    matched,
    targets,
    rest: matched.length - targets.length,
    effectiveLimit,
    unreadableCount: unreadable.length,
  };
}

/**
 * `closeManyInChunks`（塊ごとに「閉じる → 日誌」を回す）へ渡す、Task の `setStatus` を1件ずつ回す口。
 * 変わった id だけを返す: 他の経路が先に閉じていた・消えていた・読めない形だった Task は含めない（応答が「閉じた」と言い張らないため）。
 */
export function taskStatusManyStore(
  tasks: Pick<TaskStore, 'setStatus'>,
  status: TaskStatusManyTarget,
): CloseManyStore {
  return {
    async closeMany(
      ids: readonly string[],
      at: string,
      reason: string,
      by: TaskClosedBy,
    ): Promise<string[]> {
      const changed: string[] = [];
      for (const id of ids) {
        try {
          const result = await tasks.setStatus(id, status, { reason, by, at });
          if (result.kind === 'changed') changed.push(id);
        } catch (error) {
          if (!(error instanceof UnreadableTaskError)) throw error;
        }
      }
      return changed;
    },
  };
}
