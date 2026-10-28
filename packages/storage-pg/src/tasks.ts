import {
  addTaskRow,
  hasNul,
  listTaskRows,
  moveTaskRow,
  prepareTask,
  setTaskRowStatus,
  taskSchema,
  UnreadableTaskError,
  unreadableTaskSchema,
} from '@alteroid/core';
import type {
  SetTaskStatusOptions,
  Task,
  TaskAddResult,
  TaskList,
  TaskMoveResult,
  TaskPlacement,
  TaskRow,
  TaskSetStatusResult,
  TaskStatus,
  TaskStore,
  UnreadableTask,
} from '@alteroid/core';
import { eq, sql } from 'drizzle-orm';

import type { Db } from './db.js';
import { stripNulls } from './db.js';
import { tasks } from './schema.js';

// 全操作を1本の advisory lock で直列化する: 並びは行どうしの関係（隣の rank）で決まるので、行ロックでは足りない。
// 別々のデーモンが同じ表を触っても、2つの `add` が同じ隙間へ同じ rank を割り当てたり、振り直しが互いを踏んだりしない。
// 規模が小さい表（開いている task は人間が把握できる数）なので、表全体を直列化しても詰まらない。
const TASK_LOCK_NAMESPACE = 'alteroid.tasks';

interface RawRow {
  id: string;
  rank: number;
  task: unknown;
}

// `id` / `createdAt` 以外を覗かない（`FsTaskStore` と同じ理由）
function stringFieldOf(value: unknown, key: 'id' | 'createdAt'): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === 'string' ? field : undefined;
}

interface Loaded {
  rows: TaskRow[];
  unreadable: (UnreadableTask & { id: string })[];
}

// 1行が読めなくても投げない: 一覧が丸ごと落ちるため
function split(raw: readonly RawRow[]): Loaded {
  const rows: TaskRow[] = [];
  const unreadable: Loaded['unreadable'] = [];
  for (const row of raw) {
    const parsed = taskSchema.safeParse(row.task);
    if (parsed.success) {
      rows.push({ rank: row.rank, task: parsed.data });
      continue;
    }
    const createdAt = stringFieldOf(row.task, 'createdAt');
    unreadable.push({
      id: row.id,
      createdAt:
        createdAt !== undefined && unreadableTaskSchema.shape.createdAt.safeParse(createdAt).success
          ? createdAt
          : undefined,
      reason: parsed.error.message,
    });
  }
  return { rows, unreadable };
}

function unreadableError(id: string, reason: string): UnreadableTaskError {
  return new UnreadableTaskError(`task ${id} が読めない形で入っている: ${reason}`);
}

/**
 * 規則は core の `task.ts` に1本だけあり、ここは「全行を読む → core の関数で次の行を作る → 参照が変わった行だけ書く」を
 * advisory lock の中で行う。並びの規則を SQL に書き直さない（3実装が同じ観測結果になることを `task-store-contract.ts` が測る）。
 */
export class PgTaskStore implements TaskStore {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  async list(options?: { includeClosed?: boolean }): Promise<TaskList> {
    const loaded = await this.#load(this.#db);
    return {
      entries: listTaskRows(loaded.rows, options?.includeClosed === true),
      unreadable: loaded.unreadable,
    };
  }

  async get(id: string): Promise<Task | null> {
    if (hasNul(id)) return null;
    const rows = await this.#db
      .select({ id: tasks.id, rank: tasks.rank, task: tasks.task })
      .from(tasks)
      .where(eq(tasks.id, id))
      .limit(1);
    const row = rows[0];
    if (row === undefined) return null;
    const loaded = split([row]);
    const found = loaded.rows[0];
    if (found !== undefined) return found.task;
    throw unreadableError(id, loaded.unreadable[0]?.reason ?? '');
  }

  async add(entry: Task, placement?: TaskPlacement): Promise<TaskAddResult> {
    const prepared = prepareTask(entry);
    return this.#mutate((loaded) => {
      // 読めない行の id も「在った」とする（fs と同じ）
      if (loaded.unreadable.some((row) => row.id === prepared.id)) {
        return { rows: loaded.rows, result: { kind: 'existed' } };
      }
      return addTaskRow(loaded.rows, prepared, placement);
    });
  }

  async move(id: string, placement: TaskPlacement): Promise<TaskMoveResult> {
    if (hasNul(id)) return { kind: 'not-found' };
    return this.#mutate((loaded) => {
      this.#throwIfUnreadable(loaded, id);
      return moveTaskRow(loaded.rows, id, placement);
    });
  }

  async setStatus(
    id: string,
    status: TaskStatus,
    options: SetTaskStatusOptions,
  ): Promise<TaskSetStatusResult> {
    if (hasNul(id)) return { kind: 'not-found' };
    return this.#mutate((loaded) => {
      this.#throwIfUnreadable(loaded, id);
      return setTaskRowStatus(loaded.rows, id, status, options);
    });
  }

  async clear(): Promise<number> {
    const removed = await this.#db.delete(tasks).returning({ id: tasks.id });
    return removed.length;
  }

  #throwIfUnreadable(loaded: Loaded, id: string): void {
    const broken = loaded.unreadable.find((row) => row.id === id);
    if (broken !== undefined) throw unreadableError(id, broken.reason);
  }

  async #load(reader: Pick<Db, 'select'>): Promise<Loaded> {
    return split(
      await reader.select({ id: tasks.id, rank: tasks.rank, task: tasks.task }).from(tasks),
    );
  }

  async #mutate<T>(run: (loaded: Loaded) => { rows: TaskRow[]; result: T }): Promise<T> {
    return this.#db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${TASK_LOCK_NAMESPACE}), hashtext('rows'))`,
      );
      const loaded = await this.#load(tx);
      const { rows, result } = run(loaded);
      const before = new Map(loaded.rows.map((row) => [row.task.id, row]));
      // core の関数は変えていない行を同じ参照で返す。参照が違う行（新規・rank が動いた・状態が変わった）だけ書く
      for (const row of rows) {
        if (before.get(row.task.id) === row) continue;
        const value = stripNulls(row.task);
        await tx
          .insert(tasks)
          .values({ id: row.task.id, rank: row.rank, task: value })
          .onConflictDoUpdate({ target: tasks.id, set: { rank: row.rank, task: value } });
      }
      return result;
    });
  }
}
