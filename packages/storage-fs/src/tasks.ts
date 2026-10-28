import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

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
import { z } from 'zod';

import { writeFileAtomic } from './atomic.js';
import { withPathLock } from './file-lock.js';

const rawFileSchema = z.object({
  tasks: z.array(z.object({ rank: z.unknown(), task: z.unknown() })).default([]),
});

// 生の値を保持する: 書き戻しのたびに、読めなかった行が気づかれないままディスクから永久に消えるため（`FsCommitmentStore` と同じ）
interface UnreadableRow {
  readonly rank: unknown;
  readonly value: unknown;
  readonly id?: string;
  readonly createdAt?: string;
  readonly reason: string;
}

interface TaskFile {
  readonly rows: TaskRow[];
  readonly unreadable: UnreadableRow[];
}

// `id` / `createdAt` 以外を覗かない: 抽出を広げて `body` まで拾うと「本文を載せない」制約が抽出のほうから破れる
function stringFieldOf(value: unknown, key: 'id' | 'createdAt'): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === 'string' ? field : undefined;
}

function splitRows(raw: { rank: unknown; task: unknown }[]): TaskFile {
  const rows: TaskRow[] = [];
  const unreadable: UnreadableRow[] = [];
  for (const { rank, task } of raw) {
    const parsed = taskSchema.safeParse(task);
    if (parsed.success && typeof rank === 'number' && Number.isFinite(rank)) {
      rows.push({ rank, task: parsed.data });
      continue;
    }
    const createdAtCandidate = stringFieldOf(task, 'createdAt');
    unreadable.push({
      rank,
      value: task,
      id: stringFieldOf(task, 'id'),
      createdAt:
        createdAtCandidate !== undefined &&
        unreadableTaskSchema.shape.createdAt.safeParse(createdAtCandidate).success
          ? createdAtCandidate
          : undefined,
      reason: parsed.success ? `rank が数でない: ${String(rank)}` : parsed.error.message,
    });
  }
  return { rows, unreadable };
}

function toPublicUnreadable(row: UnreadableRow): UnreadableTask {
  return { id: row.id, createdAt: row.createdAt, reason: row.reason };
}

function unreadableError(id: string, reason: string): UnreadableTaskError {
  return new UnreadableTaskError(`task ${id} が読めない形で入っている: ${reason}`);
}

/**
 * ファイル1枚（`tasks.json`）に全行を持つ。規則は core の `task.ts` に1本だけあり、ここは読み書きと排他だけ（メモリ・pg と共有）。
 * 閉じた行を刈らない: `CommitmentStore` の `CLOSED_HISTORY_LIMIT` のような物理削除は、task の閉じた記録（done / cancelled の理由）を失うので持たない。
 * 毎回全体を書き直す費用は、閉じた行が積もる P7 までに保持方針と合わせて決める（今は task を作る口が `task_add` だけで量が小さい）。
 */
export class FsTaskStore implements TaskStore {
  readonly #dir: string;
  readonly #path: string;

  constructor(dir: string) {
    this.#dir = dir;
    this.#path = join(dir, 'tasks.json');
  }

  async list(options?: { includeClosed?: boolean }): Promise<TaskList> {
    const file = await this.#read();
    return {
      entries: listTaskRows(file.rows, options?.includeClosed === true),
      unreadable: file.unreadable.map(toPublicUnreadable),
    };
  }

  async get(id: string): Promise<Task | null> {
    if (hasNul(id)) return null;
    const file = await this.#read();
    const found = file.rows.find((row) => row.task.id === id);
    if (found !== undefined) return found.task;
    const broken = file.unreadable.find((row) => row.id === id);
    if (broken !== undefined) throw unreadableError(id, broken.reason);
    return null;
  }

  async add(entry: Task, placement?: TaskPlacement): Promise<TaskAddResult> {
    const prepared = prepareTask(entry);
    return this.#update((file) => {
      // 読めない行の id も「在った」とする: 同じ id が2行（壊れた生の値＋新しい行）並ぶとどちらが本物か決まらない
      if (file.unreadable.some((row) => row.id === prepared.id)) {
        return { next: file, result: { kind: 'existed' } };
      }
      const { rows, result } = addTaskRow(file.rows, prepared, placement);
      return { next: { rows, unreadable: file.unreadable }, result };
    });
  }

  async move(id: string, placement: TaskPlacement): Promise<TaskMoveResult> {
    if (hasNul(id)) return { kind: 'not-found' };
    return this.#update((file) => {
      this.#throwIfUnreadable(file, id);
      const { rows, result } = moveTaskRow(file.rows, id, placement);
      return { next: { rows, unreadable: file.unreadable }, result };
    });
  }

  async setStatus(
    id: string,
    status: TaskStatus,
    options: SetTaskStatusOptions,
  ): Promise<TaskSetStatusResult> {
    if (hasNul(id)) return { kind: 'not-found' };
    return this.#update((file) => {
      this.#throwIfUnreadable(file, id);
      const { rows, result } = setTaskRowStatus(file.rows, id, status, options);
      return { next: { rows, unreadable: file.unreadable }, result };
    });
  }

  async clear(): Promise<number> {
    return this.#update((file) => ({
      next: { rows: [], unreadable: [] },
      result: file.rows.length + file.unreadable.length,
    }));
  }

  // 読めない行は書き直さない（本文が読める形へ戻る保証が無い）。`get` と同じく投げる
  #throwIfUnreadable(file: TaskFile, id: string): void {
    const broken = file.unreadable.find((row) => row.id === id);
    if (broken !== undefined) throw unreadableError(id, broken.reason);
  }

  async #read(): Promise<TaskFile> {
    try {
      const raw = await readFile(this.#path, 'utf8');
      return splitRows(rawFileSchema.parse(JSON.parse(raw)).tasks);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { rows: [], unreadable: [] };
      throw error;
    }
  }

  async #update<T>(mutate: (file: TaskFile) => { next: TaskFile; result: T }): Promise<T> {
    return withPathLock(this.#path, async () => {
      const { next, result } = mutate(await this.#read());
      await mkdir(this.#dir, { recursive: true });
      // 読めない行の生の値も必ず書き戻す（上の `UnreadableRow` の理由）
      const tasks = [
        ...next.rows.map((row) => ({ rank: row.rank, task: row.task })),
        ...next.unreadable.map((row) => ({ rank: row.rank, task: row.value })),
      ];
      await writeFileAtomic(this.#path, `${JSON.stringify({ tasks }, null, 2)}\n`);
      return result;
    });
  }
}
