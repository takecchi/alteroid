import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  ScheduleConflictError,
  UnreadableScheduleError,
  assertNoNul,
  stripNul,
  schedulePhaseSchema,
  scheduledRequestSchema,
  scheduleVersionMatches,
  compareCodeUnits,
} from '@alteroid/core';
import type {
  SchedulePhase,
  ScheduleList,
  ScheduleSpec,
  ScheduleStore,
  ScheduledRequest,
  UnreadableSchedule,
  WriteScheduleOptions,
} from '@alteroid/core';
import { z } from 'zod';

import { writeFileAtomic } from './atomic.js';
import { withPathLock } from './file-lock.js';

/**
 * 各要素をここで `z.array(scheduledRequestSchema)` 等で検査しない: 1行の不正が配列全体
 * （位相側の壊れた1行なら `list()` まで）を道連れにする。行ごとの検査は `#read()` が行う。
 */
const fileSchema = z.object({
  schedules: z.array(z.unknown()).default([]),
  // 位相を別ファイルにしない: `#update` の排他区間が2本になり、片方だけ直列化される。
  phases: z.array(z.unknown()).default([]),
});

/**
 * `invalid*Raw` を消さずに持ち回る: 書き込みは全体をシリアライズし直すので、ここへ入れなかった
 * 行は次の書き込みで消え、手編集でできた不正な行が黙って失われる。
 */
interface ScheduleFile {
  schedules: ScheduledRequest[];
  invalidSchedulesRaw: unknown[];
  phases: SchedulePhase[];
  invalidPhasesRaw: unknown[];
}

const EMPTY: ScheduleFile = {
  schedules: [],
  invalidSchedulesRaw: [],
  phases: [],
  invalidPhasesRaw: [],
};

/** `issue.message` は使わない: zod の既定メッセージが `received`（実際の値）を含む形に変わっても値が漏れないように、欄名だけを出す。 */
function summarizeInvalidFields(issues: readonly { path: readonly PropertyKey[] }[]): string {
  const fields = [
    ...new Set(issues.map((issue) => (issue.path.length > 0 ? String(issue.path[0]) : '(root)'))),
  ];
  return fields.length > 0 ? `不正な欄: ${fields.join(',')}` : '不正な行';
}

function extractKind(raw: unknown): string | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const kind = (raw as Record<string, unknown>).kind;
  return typeof kind === 'string' ? kind : undefined;
}

function unreadableError(kind: string, reason: string): UnreadableScheduleError {
  return new UnreadableScheduleError(
    `継続中の依頼 ${kind} が読めない形で入っている（消されたのではない）: ${reason}`,
    { kind },
  );
}

function throwIfUnreadable(file: ScheduleFile, kind: string): void {
  const invalidRaw = file.invalidSchedulesRaw.find((raw) => extractKind(raw) === kind);
  if (invalidRaw === undefined) return;
  const result = scheduledRequestSchema.safeParse(invalidRaw);
  throw unreadableError(kind, result.success ? '不正な行' : result.error.message);
}

/** kind 以外の値は載せない: `request` には人間の依頼文がそのまま入りうる。 */
function describeSkippedScheduleRow(params: {
  index: number;
  reason: string;
  kind?: string;
}): string {
  const kindNote = params.kind === undefined ? '' : ` kind=${JSON.stringify(params.kind)}`;
  return (
    `alteroid: schedules の不正な行を読み飛ばしました` +
    `（${params.index + 1} 行目、${params.reason}）${kindNote}`
  );
}

function describeSkippedPhaseRow(params: { index: number; reason: string; kind?: string }): string {
  const kindNote = params.kind === undefined ? '' : ` kind=${JSON.stringify(params.kind)}`;
  return (
    `alteroid: phases の不正な行を読み飛ばしました` +
    `（${params.index + 1} 行目、${params.reason}）${kindNote}`
  );
}

/** `invalid*Raw` は1本の配列へ合流させる: 分けたまま書くと、次の `#read()` が未知のキーとして黙って捨てる。 */
function serialize(file: ScheduleFile): { schedules: unknown[]; phases: unknown[] } {
  return {
    schedules: [...file.schedules, ...file.invalidSchedulesRaw],
    phases: [...file.phases, ...file.invalidPhasesRaw],
  };
}

export class FsScheduleStore implements ScheduleStore {
  readonly #dir: string;
  readonly #path: string;

  constructor(dir: string) {
    this.#dir = dir;
    this.#path = join(dir, 'schedules.json');
  }

  /** 不正な行は `entries` に入れず `unreadable` に別欄で返す: 黙って飛ばすと上の層が「依頼は無い」と言い切れてしまう。`unreadable` は kind と不正な欄名だけを持ち、本文は載せない。 */
  async list(): Promise<ScheduleList> {
    const { schedules, invalidSchedulesRaw } = await this.#read();
    return {
      entries: [...schedules].sort((a, b) => compareCodeUnits(a.kind, b.kind)),
      unreadable: invalidSchedulesRaw.map((raw): UnreadableSchedule => {
        const kind = extractKind(raw);
        const result = scheduledRequestSchema.safeParse(raw);
        const reason = result.success ? '不正な行' : summarizeInvalidFields(result.error.issues);
        return kind === undefined ? { reason } : { kind, reason };
      }),
    };
  }

  /** 読めない行は `null` にせず投げる: 区別できないと `clone.ts` が発火した依頼を「人間が手で仕込んだ kind」と誤解し、本文なしの曖昧なターンを走らせる。 */
  async get(kind: string): Promise<ScheduledRequest | null> {
    const file = await this.#read();
    const found = file.schedules.find((entry) => entry.kind === kind);
    if (found !== undefined) return found;
    const invalidRaw = file.invalidSchedulesRaw.find((raw) => extractKind(raw) === kind);
    if (invalidRaw === undefined) return null;
    const result = scheduledRequestSchema.safeParse(invalidRaw);
    // `invalidSchedulesRaw` に入っている時点で失敗するはずだが、型の上では保証できないので、成功していたらその値を返す。
    if (result.success) return result.data;
    throw unreadableError(kind, result.error.message);
  }

  async put(entry: ScheduledRequest, options?: WriteScheduleOptions): Promise<void> {
    // `...file` を落とさない: 同じファイルに位相も入っているので、`{ schedules }` だけを返すと位相が消える。
    await this.#update((file) => {
      // `ifMatch` 省略（無条件の上書き）は壊れた行を置き換える: 直す口を塞がないため。
      if (options?.ifMatch !== undefined) {
        const current = file.schedules.find((existing) => existing.kind === entry.kind);
        if (current === undefined) throwIfUnreadable(file, entry.kind);
        if (!scheduleVersionMatches(current ?? null, options.ifMatch)) {
          throw new ScheduleConflictError(entry.kind, current ?? null);
        }
      }
      const schedules = [
        ...file.schedules.filter((existing) => existing.kind !== entry.kind),
        scheduledRequestSchema.parse({ ...entry, request: stripNul(entry.request) }),
      ];
      // 同じ kind の壊れた行は置き換える: 残すと同じ kind が2行並び、直したはずの跡が `list()` のたびに出続ける。
      const invalidSchedulesRaw = file.invalidSchedulesRaw.filter(
        (raw) => extractKind(raw) !== entry.kind,
      );
      return { next: { ...file, schedules, invalidSchedulesRaw }, result: undefined };
    });
  }

  /** `invalidSchedulesRaw` も filter する: 検査を通った行だけを見ると、壊れた kind は `get` が投げるので消せないまま残る。 */
  async remove(kind: string): Promise<void> {
    await this.#update((file) => ({
      next: {
        ...file,
        schedules: file.schedules.filter((existing) => existing.kind !== kind),
        invalidSchedulesRaw: file.invalidSchedulesRaw.filter((raw) => extractKind(raw) !== kind),
      },
      result: undefined,
    }));
  }

  /** `get()` を先に呼ばない: 読めない行では `remove()` まで届く前に例外が上がる。読みと書きを1回の `#update` に閉じる。 */
  async removeIfPresent(kind: string): Promise<ScheduledRequest | 'unreadable' | null> {
    // `T` を明示する: 推論だけだと `'unreadable'` が `string` へ広がって型が合わなくなる。
    return this.#update<ScheduledRequest | 'unreadable' | null>((file) => {
      const found = file.schedules.find((entry) => entry.kind === kind);
      if (found !== undefined) {
        return {
          next: {
            ...file,
            schedules: file.schedules.filter((entry) => entry.kind !== kind),
            invalidSchedulesRaw: file.invalidSchedulesRaw.filter(
              (raw) => extractKind(raw) !== kind,
            ),
          },
          result: found,
        };
      }
      const invalidRaw = file.invalidSchedulesRaw.find((raw) => extractKind(raw) === kind);
      if (invalidRaw === undefined) return { next: file, result: null };
      return {
        next: {
          ...file,
          invalidSchedulesRaw: file.invalidSchedulesRaw.filter((raw) => extractKind(raw) !== kind),
        },
        result: 'unreadable',
      };
    });
  }

  /**
   * 現在値の読みと書きを同じ排他区間に置く: `pendingRun` / `lastRunAt` 等は呼び出し側の古い値ではなく読み直した値を引き継ぐ。
   * 壊れた行を `null` に落とさない: 呼び出し側が続けて `put()` で黙って置き換える。
   */
  async editRequest(
    kind: string,
    changes: { readonly request: string; readonly spec: ScheduleSpec },
    updatedAt: string,
    options?: WriteScheduleOptions,
  ): Promise<ScheduledRequest | null> {
    return this.#update((file) => {
      const found = file.schedules.find((entry) => entry.kind === kind);
      if (found === undefined) throwIfUnreadable(file, kind);
      if (!scheduleVersionMatches(found ?? null, options?.ifMatch)) {
        throw new ScheduleConflictError(kind, found ?? null);
      }
      if (found === undefined) return { next: file, result: null };
      const next = scheduledRequestSchema.parse({
        ...found,
        request: stripNul(changes.request),
        spec: changes.spec,
        updatedAt,
      });
      return {
        next: {
          ...file,
          schedules: file.schedules.map((entry) => (entry.kind === kind ? next : entry)),
        },
        result: next,
      };
    });
  }

  /** 壊れた行は投げる: `get()` と同じ理由。 */
  async getPhase(kind: string): Promise<SchedulePhase | null> {
    const file = await this.#read();
    const found = file.phases.find((phase) => phase.kind === kind);
    if (found !== undefined) return found;
    const invalidRaw = file.invalidPhasesRaw.find((raw) => extractKind(raw) === kind);
    if (invalidRaw === undefined) return null;
    const result = schedulePhaseSchema.safeParse(invalidRaw);
    if (result.success) return result.data;
    throw new Error(
      `定期ジョブ ${kind} の位相が読めない形で入っている（まだ動いていないのではない）: ${result.error.message}`,
    );
  }

  async putPhase(phase: SchedulePhase): Promise<void> {
    assertNoNul('schedulePhase.kind', phase.kind);
    await this.#update((file) => {
      const phases = [
        ...file.phases.filter((existing) => existing.kind !== phase.kind),
        schedulePhaseSchema.parse(phase),
      ];
      const invalidPhasesRaw = file.invalidPhasesRaw.filter(
        (raw) => extractKind(raw) !== phase.kind,
      );
      return { next: { ...file, phases, invalidPhasesRaw }, result: undefined };
    });
  }

  /**
   * `updatedAt` は動かさない: 「依頼が最後に書き換えられた時刻」であり、版の識別子でもある（動かすと版の比較が壊れる）。
   * 壊れた行は `null` にしない: `null` は「消された・書き換わった」だけの意味に保つ。
   */
  async claimRun(
    kind: string,
    expectedUpdatedAt: string,
    at: string,
    cause: 'schedule' | 'manual',
  ): Promise<ScheduledRequest | null> {
    return this.#update((file) => {
      const found = file.schedules.find((entry) => entry.kind === kind);
      if (found === undefined) throwIfUnreadable(file, kind);
      // 古い本文で動かさないために null を返す。
      if (found === undefined || found.updatedAt !== expectedUpdatedAt) {
        return { next: file, result: null };
      }
      return {
        next: {
          ...file,
          schedules: file.schedules.map((entry) =>
            entry.kind === kind
              ? // 定期の基準は `completeRun` で進める
                { ...entry, lastRunAt: at, pendingRun: { at, cause } }
              : entry,
          ),
        },
        result: found,
      };
    });
  }

  async completeRun(kind: string, at: string, cause: 'schedule' | 'manual'): Promise<void> {
    await this.#update((file) => ({
      next: {
        ...file,
        schedules: file.schedules.map((entry) => {
          // 別の発火の印が付いているなら触らない: 後から来た発火のものを消さない。
          if (entry.kind !== kind || entry.pendingRun?.at !== at) return entry;
          const rest = { ...entry };
          delete rest.pendingRun;
          return cause === 'schedule' ? { ...rest, lastScheduledRunAt: at } : rest;
        }),
      },
      result: undefined,
    }));
  }

  /** 壊れた行も消し、件数にも数える: pg 実装は `DELETE … RETURNING` で全行を消すので、fs だけ生かすと `clear()` の意味が実装ごとに変わる。 */
  async clear(): Promise<{ schedules: number; phases: number }> {
    return this.#update((file) => ({
      next: { schedules: [], invalidSchedulesRaw: [], phases: [], invalidPhasesRaw: [] },
      result: {
        schedules: file.schedules.length + file.invalidSchedulesRaw.length,
        phases: file.phases.length + file.invalidPhasesRaw.length,
      },
    }));
  }

  /** 飛ばすのは行の形が不正なときだけ: ファイルが JSON として読めない・トップレベルの形が違うのは1行の問題ではないので例外のままにする。 */
  async #read(): Promise<ScheduleFile> {
    try {
      const raw = await readFile(this.#path, 'utf8');
      const top = fileSchema.parse(JSON.parse(raw));
      const schedules: ScheduledRequest[] = [];
      const invalidSchedulesRaw: unknown[] = [];
      top.schedules.forEach((rawEntry, index) => {
        const result = scheduledRequestSchema.safeParse(rawEntry);
        if (result.success) {
          schedules.push(result.data);
          return;
        }
        invalidSchedulesRaw.push(rawEntry);
        process.stderr.write(
          `${describeSkippedScheduleRow({
            index,
            reason: summarizeInvalidFields(result.error.issues),
            kind: extractKind(rawEntry),
          })}\n`,
        );
      });
      const phases: SchedulePhase[] = [];
      const invalidPhasesRaw: unknown[] = [];
      top.phases.forEach((rawPhase, index) => {
        const result = schedulePhaseSchema.safeParse(rawPhase);
        if (result.success) {
          phases.push(result.data);
          return;
        }
        invalidPhasesRaw.push(rawPhase);
        process.stderr.write(
          `${describeSkippedPhaseRow({
            index,
            reason: summarizeInvalidFields(result.error.issues),
            kind: extractKind(rawPhase),
          })}\n`,
        );
      });
      return { schedules, invalidSchedulesRaw, phases, invalidPhasesRaw };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return EMPTY;
      throw error;
    }
  }

  /** 読んだ結果に基づいて書くかを決める操作（`claimRun`）を、この排他区間の外へ出さない。 */
  async #update<T>(mutate: (file: ScheduleFile) => { next: ScheduleFile; result: T }): Promise<T> {
    return withPathLock(this.#path, async () => {
      const { next, result } = mutate(await this.#read());
      await mkdir(this.#dir, { recursive: true });
      await writeFileAtomic(this.#path, `${JSON.stringify(serialize(next), null, 2)}\n`);
      return result;
    });
  }
}
