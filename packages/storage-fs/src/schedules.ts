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
 * トップレベルの形だけを見る。**`schedules` / `phases` のどちらも、各要素は
 * ここでは検査しない**（issue #1944。`FsJobStore` の `fileSchema` が #1868 /
 * #1928 でそろえた形と同じ）——`z.array(scheduledRequestSchema)` /
 * `z.array(schedulePhaseSchema)` にすると、1行の不正が配列全体を道連れに
 * する。行ごとの検査は `#read()` がそれぞれ `scheduledRequestSchema.safeParse` /
 * `schedulePhaseSchema.safeParse` で1行ずつ行う。
 *
 * **`schedules` と `phases` を同時に壊さないためにも要る。** 1枚の JSON に
 * 両方が入っているので、片方だけを丸ごと検査する形のままだと、位相
 * （`phases`）側の壊れた1行が `list()`（依頼の一覧）まで道連れにする——
 * `#read()` が両方を同時に返す1つの関数だからである。
 */
const fileSchema = z.object({
  schedules: z.array(z.unknown()).default([]),
  /**
   * 既定の仕込み（日報・発意 tick）の位相。**依頼ではない**ので `list()` には出ない。
   *
   * 同じファイルに置いてあるのは、`#update` の排他区間を1本に保つためである
   * （別ファイルにすると鎖が2本になり、片方だけ直列化されている状態が生まれる）。
   * 既定 `[]` なので、この列が無い古いファイルもそのまま読める。
   */
  phases: z.array(z.unknown()).default([]),
});

/**
 * `schedules.json` の中身。**検査を通った `schedules` / `phases` と、それぞれ
 * 形が不正で読めなかった `invalidSchedulesRaw` / `invalidPhasesRaw`（生の要素。
 * パース前のまま）を分けて持つ**（issue #1944。`FsJobStore` の `JobFile` と同じ形）。
 *
 * `invalid*Raw` を消さずに持ち回るのが、この直しの核心である。`put` /
 * `putPhase` / `clear` はいずれも最終的にこれを丸ごとシリアライズし直す
 * （`serialize`）ので、ここへ入れなかった行は次の書き込みで消える——検査を
 * 通った行だけを書けば、版ずれ・手編集でできた不正な行が黙って消えることになる。
 */
interface ScheduleFile {
  schedules: ScheduledRequest[];
  /** 依頼の行の形が不正で読めなかった、生の要素（パース前のまま）。issue #1944。 */
  invalidSchedulesRaw: unknown[];
  phases: SchedulePhase[];
  /** 位相の行の形が不正で読めなかった、生の要素（パース前のまま）。issue #1944。 */
  invalidPhasesRaw: unknown[];
}

const EMPTY: ScheduleFile = {
  schedules: [],
  invalidSchedulesRaw: [],
  phases: [],
  invalidPhasesRaw: [],
};

/**
 * 不正な行を要約する。**`issue.message` は使わない**——zod の既定メッセージが
 * 将来 `received`（実際の値）を含む形に変わっても、ここを通す限り値は漏れない。
 * 出すのは「どの欄が」だけである（`FsJobStore.summarizeInvalidFields` と同じ
 * 理由・同じ形。パッケージ内で閉じた共通化に留め、ファイルを跨いだ共通化は
 * していない——#1928 / #1951 と同じ判断）。
 */
function summarizeInvalidFields(issues: readonly { path: readonly PropertyKey[] }[]): string {
  const fields = [
    ...new Set(issues.map((issue) => (issue.path.length > 0 ? String(issue.path[0]) : '(root)'))),
  ];
  return fields.length > 0 ? `不正な欄: ${fields.join(',')}` : '不正な行';
}

/**
 * 生の要素から、値を出さずに `kind` だけを安全に取り出す（取れなければ
 * `undefined`）。**`schedules` / `phases` どちらの行にも使う共通の関数**
 * （issue #1944。`FsJobStore.extractRowId` と同じ形——鍵の名前だけが `id` では
 * なく `kind` である）。
 */
function extractKind(raw: unknown): string | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const kind = (raw as Record<string, unknown>).kind;
  return typeof kind === 'string' ? kind : undefined;
}

/**
 * issue #2177。文言は `UnreadableScheduleError` を足す前と1文字も変えていない（pg の
 * `parsePlan` と同じ）——`instanceof` で見分けられるようにするだけである。
 */
function unreadableError(kind: string, reason: string): UnreadableScheduleError {
  return new UnreadableScheduleError(
    `継続中の依頼 ${kind} が読めない形で入っている（消されたのではない）: ${reason}`,
    { kind },
  );
}

/**
 * 読めない行が kind で見つかれば `UnreadableScheduleError` を投げる（Issue #3859）。
 * 読めた行が無いときにだけ呼ぶこと（`get()` と同じく、読めた行が先）。
 */
function throwIfUnreadable(file: ScheduleFile, kind: string): void {
  const invalidRaw = file.invalidSchedulesRaw.find((raw) => extractKind(raw) === kind);
  if (invalidRaw === undefined) return;
  const result = scheduledRequestSchema.safeParse(invalidRaw);
  throw unreadableError(kind, result.success ? '不正な行' : result.error.message);
}

/**
 * 飛ばした依頼の行を stderr へ1行で要約する。**kind 以外の値は絶対に載せない**
 * ——`request` には人間の依頼文がそのまま入りうる（`FsJobStore.describeSkippedJobRow`
 * と同じ理由。issue #1944）。
 */
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

/** 飛ばした位相の行を stderr へ1行で要約する（`describeSkippedScheduleRow` と対）。 */
function describeSkippedPhaseRow(params: { index: number; reason: string; kind?: string }): string {
  const kindNote = params.kind === undefined ? '' : ` kind=${JSON.stringify(params.kind)}`;
  return (
    `alteroid: phases の不正な行を読み飛ばしました` +
    `（${params.index + 1} 行目、${params.reason}）${kindNote}`
  );
}

/**
 * `ScheduleFile` をディスク上の形へ直す。**検査を通った `schedules` /
 * `phases` と、それぞれの `invalidSchedulesRaw` / `invalidPhasesRaw` を1本の
 * 配列へ合流させる**——分けたまま書くと、次の `#read()` が `fileSchema`
 * （トップレベルの形しか見ない）を通すときに未知のキー（`invalidSchedulesRaw` /
 * `invalidPhasesRaw`）として黙って捨てられ、壊れた行を持ち回る意味が消える。
 */
function serialize(file: ScheduleFile): { schedules: unknown[]; phases: unknown[] } {
  return {
    schedules: [...file.schedules, ...file.invalidSchedulesRaw],
    phases: [...file.phases, ...file.invalidPhasesRaw],
  };
}

/**
 * 継続中の依頼 = 1枚の JSON。
 *
 * ジョブ台帳と同じディレクトリに置く。**人間が開いて読めること**を保つ形にしておく
 * （自分が出した「これからずっと」の依頼が見えないのは可観測性の穴になる）。
 */
export class FsScheduleStore implements ScheduleStore {
  readonly #dir: string;
  readonly #path: string;

  constructor(dir: string) {
    this.#dir = dir;
    this.#path = join(dir, 'schedules.json');
  }

  /**
   * `entries` は kind の昇順。**不正な行は `entries` に入れず、`unreadable` に別欄で
   * 返す**（issue #2343。以前は黙って飛ばしていたため、上の層が「依頼は無い」と
   * 言い切れた。`listApprovals` の #2298 と同じ形）——飛ばした行は `#read()` が
   * stderr へ跡を残し、`invalidSchedulesRaw` として書き戻しでも生かしたまま
   * 持ち回る（消さない）。`unreadable` は kind（取れれば）と不正な欄名だけを持ち、
   * 本文は載せない。
   */
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

  /**
   * **`list()` とは違い、読めない行は投げる**（issue #1944 の方針。pg 実装
   * `PgScheduleStore.get` の doc と同じ理由）。「消された」（`null`）と
   * 「読めない」（throw）を区別できないと、`clone.ts` は発火した依頼を
   * 「人間が手で仕込んだ kind を起こした」と誤解し、本文なしの曖昧なターンを
   * 走らせる。
   */
  async get(kind: string): Promise<ScheduledRequest | null> {
    const file = await this.#read();
    const found = file.schedules.find((entry) => entry.kind === kind);
    if (found !== undefined) return found;
    const invalidRaw = file.invalidSchedulesRaw.find((raw) => extractKind(raw) === kind);
    if (invalidRaw === undefined) return null;
    const result = scheduledRequestSchema.safeParse(invalidRaw);
    // `invalidSchedulesRaw` に入っている時点で必ず失敗するはずだが、型の上では
    // `result.success` を保証できないので、成功していたら（起こり得ない）
    // その値を返す——念のための保険であって、通常はここへ来ない。
    if (result.success) return result.data;
    throw unreadableError(kind, result.error.message);
  }

  async put(entry: ScheduledRequest, options?: WriteScheduleOptions): Promise<void> {
    // **`...file` を落とさないこと。** 同じファイルに位相も入っているので、
    // 書き換える列だけを差し替える（`{ schedules: ... }` だけを返すと位相が消える）。
    await this.#update((file) => {
      // 前提の版（Issue #3821）。`#update`（`withPathLock` の内側）で書く直前に比べる。
      // 読めない形の行は「無い」側に数えず、`UnreadableScheduleError`（Issue #3859。
      // `editRequest` と同じ）。省略（無条件の上書き）は壊れた行を置き換える。
      if (options?.ifMatch !== undefined) {
        const current = file.schedules.find((existing) => existing.kind === entry.kind);
        if (current === undefined) throwIfUnreadable(file, entry.kind);
        if (!scheduleVersionMatches(current ?? null, options.ifMatch)) {
          throw new ScheduleConflictError(entry.kind, current ?? null);
        }
      }
      const schedules = [
        ...file.schedules.filter((existing) => existing.kind !== entry.kind),
        // kind の NUL は入口のスキーマが弾く。本文は落として残す（issue #3011）。
        scheduledRequestSchema.parse({ ...entry, request: stripNul(entry.request) }),
      ];
      // **書き込む kind と一致する壊れた行は置き換える**（`FsJobStore.putJob`
      // と同じフォローアップ。issue #1944）。直したはずの kind の壊れた行が
      // `invalidSchedulesRaw` として残り続けると、ファイルに同じ kind が2行
      // 並び、以後 `list()` のたびに直したはずの跡が出続ける——「直した」
      // という呼び出し側の意図に対する驚きになる。
      const invalidSchedulesRaw = file.invalidSchedulesRaw.filter(
        (raw) => extractKind(raw) !== entry.kind,
      );
      return { next: { ...file, schedules, invalidSchedulesRaw }, result: undefined };
    });
  }

  /**
   * **不正な行も kind 指定で消せる**（issue #1944）。`get(kind)` が読めない行を
   * 投げたままにする一方で、`remove()` まで `schedules`（検査を通った行）
   * だけを見ると、壊れた kind は「投げるので消せない」まま永久に残ってしまう。
   * `invalidSchedulesRaw` も一緒に filter する。
   *
   * **人間が復旧するための口は `removeIfPresent()` が持つ**（issue #1982）。
   * `DELETE /schedule/:kind` / `schedule_remove` はこちらではなく
   * `removeIfPresent()` を呼ぶ——先に `get(kind)` を挟むと、壊れた行では
   * `remove()` まで届く前に例外が上がってしまうため（`removeIfPresent`
   * の doc）。
   */
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

  /**
   * `remove()` と同じ排他区間で、消す前にどんな状態で在ったかを返す
   * （`ScheduleStore.removeIfPresent` の doc。issue #1982）。**`get()` を
   * 先に呼ばない**——読み（在ったかどうか・読めたかどうかの判定）と書き
   * （消す）を1回の `#update` に閉じることで、`get` が読めない行で投げる
   * 契約とぶつからずに「読めない行も外せる」を実現する。
   */
  async removeIfPresent(kind: string): Promise<ScheduledRequest | 'unreadable' | null> {
    // **`T` を明示する。** 3つの `return` が `result` にそれぞれ違う型
    // （`ScheduledRequest` / `null` / リテラル `'unreadable'`）を持つと、
    // `#update<T>` への推論だけでは `'unreadable'` が `string` へ広がって
    // 型が合わなくなる（推論の間はこの引数へ逆方向の文脈型が付かないため）。
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
   * `request` / `spec` だけを差し替える（Issue #1654。`ScheduleStore.editRequest`
   * の doc）。**現在値を読むのも書くのも同じ `#update` の排他区間の中**——
   * `pendingRun` / `lastRunAt` / `lastScheduledRunAt` / `createdAt` は、呼び出し側
   * が読んだかもしれない古い値ではなく、ここで読み直した現在値をそのまま引き継ぐ。
   *
   * **壊れた行は `UnreadableScheduleError`**（Issue #3859。`get(kind)` と同じ線で、
   * pg と同じ）。「無い」（`null`）に落とすと、呼び出し側が続けて `put()` で壊れた行を
   * 黙って置き換える。直すには `remove` / `removeIfPresent` で外してから作り直す。
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
      // 前提の版（Issue #3821）。同じ排他区間の中で比べるので、照合と書き込みの間に割り込めない。
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

  /**
   * 既定の仕込みの位相を読む。無ければ null。**壊れた行は投げる**
   * （`get()` と同じ理由——`PgScheduleStore.getPhase` の doc・issue #1944）。
   */
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
      // 書き込む kind と一致する壊れた行は置き換える（`put()` と同じフォローアップ）。
      const invalidPhasesRaw = file.invalidPhasesRaw.filter(
        (raw) => extractKind(raw) !== phase.kind,
      );
      return { next: { ...file, phases, invalidPhasesRaw }, result: undefined };
    });
  }

  /**
   * 発火の確定。**読みと記録を同じ排他区間で行う**（隙間に remove / put を挟ませない）。
   *
   * **`updatedAt` は動かさない** — あれは「依頼が最後に書き換えられた時刻」であり、
   * 発火で上書きすると人間が「この依頼いつ直したか」を追えなくなる。同時に、これが
   * 版の識別子でもある（動かすと版の比較そのものが壊れる）。
   *
   * **壊れた行は `UnreadableScheduleError`**（Issue #3859。`editRequest` と同じ。版が
   * 何であれ投げる）。`null` は「消された・書き換わった」だけの意味に保つ。
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
      // 消された・書き換わった。**古い本文で動かさないために null を返す。**
      if (found === undefined || found.updatedAt !== expectedUpdatedAt) {
        return { next: file, result: null };
      }
      return {
        next: {
          ...file,
          schedules: file.schedules.map((entry) =>
            entry.kind === kind
              ? // 引き受けた印と観測用の時刻だけ。定期の基準は `completeRun` で進める
                { ...entry, lastRunAt: at, pendingRun: { at, cause } }
              : entry,
          ),
        },
        // 返すのは更新前の姿（呼び出し側は「前回いつ動いたか」と、前の発火が
        // 終わっていたかを材料に要る）
        result: found,
      };
    });
  }

  async completeRun(kind: string, at: string, cause: 'schedule' | 'manual'): Promise<void> {
    await this.#update((file) => ({
      next: {
        ...file,
        schedules: file.schedules.map((entry) => {
          // 別の発火の印が付いているなら触らない（後から来た発火のものを消さない）
          if (entry.kind !== kind || entry.pendingRun?.at !== at) return entry;
          const rest = { ...entry };
          delete rest.pendingRun;
          // 手で起こした1回では定期の予定をずらさない
          return cause === 'schedule' ? { ...rest, lastScheduledRunAt: at } : rest;
        }),
      },
      result: undefined,
    }));
  }

  /**
   * 継続中の依頼と既定の仕込みの位相を両方消す（`ScheduleStore.clear` の doc）。
   *
   * **壊れた行（`invalidSchedulesRaw` / `invalidPhasesRaw`）も一緒に消す**
   * （`FsJobStore.clear` が #1868 でそろえた形と同じ理由。issue #1944）。
   * `clear()` はワークスペースのリセット専用の全消去操作で、pg 実装は表の行を
   * `DELETE` で全部消す（`PgScheduleStore.clear` の doc）——行の中身が
   * 壊れているかどうかは関係なく消える。fs だけが壊れた行を生かして残すと、
   * 同じ `clear()` の意味が実装ごとに変わってしまう。
   *
   * **返す件数も、消した壊れた行を数える**（`FsJobStore.clear` の #1892 の形と
   * 同じ）。pg 実装は `DELETE … RETURNING` の行数をそのまま返すので、壊れた
   * 行も件数に入る。
   */
  async clear(): Promise<{ schedules: number; phases: number }> {
    return this.#update((file) => ({
      next: { schedules: [], invalidSchedulesRaw: [], phases: [], invalidPhasesRaw: [] },
      result: {
        schedules: file.schedules.length + file.invalidSchedulesRaw.length,
        phases: file.phases.length + file.invalidPhasesRaw.length,
      },
    }));
  }

  /**
   * `schedules.json` を読む。**`schedules` と `phases` の両方を、行ごとに
   * 検査して不正な1行だけを飛ばす**（issue #1944。以前は `fileSchema.parse`
   * でそれぞれの配列全体を1回に検査していたため、1行でも不正だと `list()` が
   * 丸ごと例外を投げ、正しい行も読めなくなっていた——pg 実装
   * （`PgScheduleStore.list`）も同じ穴を持っていたので、同じ issue で直した）。
   *
   * **飛ばすのは行の形が不正なとき（enum に無い値・欄が欠けている・型が
   * 違う、など）だけである。** ファイルそのものが JSON として読めない・
   * トップレベルの形が違う（`schedules` / `phases` が配列でない等）ときは、
   * いまの振る舞い（例外）のままにしてある——それは1行の問題ではないため。
   *
   * 飛ばした行は stderr へ1行の跡を残し（`describeSkippedScheduleRow` /
   * `describeSkippedPhaseRow`。**値は request 等の本文を含めず、kind だけ**）、
   * `invalidSchedulesRaw` / `invalidPhasesRaw` として生の形のまま保持する——
   * `put` / `putPhase` / `clear` がこれを書き戻すことで、版ずれ・手編集で
   * できた不正な行を黙って消さない。**`get` / `getPhase` はこれを見て、
   * 読めない行を id 指定で引かれたら投げる**（`list()` とは別の契約）。
   */
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

  /**
   * read-modify-write を直列化する（issue #1113 / #1050 — `withPathLock` で
   * プロセス内・プロセス間の両方を排他する。advisory の強さは `file-lock.ts`
   * の doc を見よ）。
   *
   * `mutate` は書き込む内容と、呼び出し側へ返す値の両方を決める。**読んだ結果に
   * 基づいて書くかどうかを決める操作**（`claimRun`）を、この区間の外へ出さないこと。
   */
  async #update<T>(mutate: (file: ScheduleFile) => { next: ScheduleFile; result: T }): Promise<T> {
    return withPathLock(this.#path, async () => {
      const { next, result } = mutate(await this.#read());
      await mkdir(this.#dir, { recursive: true });
      await writeFileAtomic(this.#path, `${JSON.stringify(serialize(next), null, 2)}\n`);
      return result;
    });
  }
}
