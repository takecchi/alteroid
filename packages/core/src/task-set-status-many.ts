import { chunkIdsByChars } from './chunk-ids.js';
import {
  describeOffsetRequiredTimeBoundary,
  isOffsetQualifiedTimeBoundary,
} from './journal-time.js';
import { taskOriginSchema } from './schema.js';
import type { Task, TaskClosedBy, TaskOrigin } from './schema.js';
import type { TaskStore } from './store.js';
import { UnreadableTaskError } from './store.js';
import {
  describeArrayLengthViolation,
  describeBlankViolation,
  describeIntRangeViolation,
  describeStringArrayElementLengthViolation,
  describeStringLengthViolation,
} from './tool-arg-checks.js';

// 道具 `task_set_status_many`（クローン）の検証・絞り込み・Task ストアへの当て方・塊ごとの閉じ方（`closeManyInChunks`）。
// 日誌は塊ごとに書く。日誌を書く順序は共有しない: 呼び手の流儀に合わせて差し込み口（`CloseManyChunkHooks`）で渡す。
// Task の一括の口は TaskStore に足さない: 1件ずつの `setStatus` が遷移の規則と排他を持っており、
// 一括用の別経路を3実装に足すと、遷移の規則が2か所に割れるため。Task は数千件溜める前提ではないので、1件ずつの書き直しの重さは許す

export const CLOSE_MANY_LIMIT_DEFAULT = 500;
// store 側に同じ上限を置いて二重にしない: どちらが効いたのか呼び出し側から読めなくなるため
export const CLOSE_MANY_LIMIT_MAX = 2_000;
// id 列は件数ではなく文字数の予算で塊に割り、塊ごとに1件の日誌を書く: 全件を1行へ詰めると予算が文字数という面の規約に反するため
export const CLOSE_MANY_JOURNAL_ID_CHARS = 3_600;
export const CLOSE_MANY_IDS_SHOWN = 20;
export const CLOSE_MANY_SOURCES_SHOWN = 8;

/** まとめて移せる先。閉じる状態だけ（開き直し・開いている状態どうしの移動は1件ずつの `task_set_status`）。 */
export const TASK_STATUS_MANY_TARGETS = ['done', 'cancelled'] as const;
type TaskStatusManyTarget = (typeof TASK_STATUS_MANY_TARGETS)[number];

interface CloseManyFilterInput {
  origin: readonly TaskOrigin[];
  source?: readonly string[] | undefined;
  q?: string | undefined;
  until?: string | undefined;
}

interface TaskStatusManyInput extends CloseManyFilterInput {
  status: TaskStatusManyTarget;
  reason: string;
  dryRun?: boolean | undefined;
  limit?: number | undefined;
}

/**
 * 入力の検証。断るなら人間（と AI）が読む断り文を返し、通すなら `null`。
 * 検査の順序と文言は道具が持っていたものそのまま: 先に当たった違反だけを返す。
 */
export function describeTaskStatusManyViolation(input: TaskStatusManyInput): string | null {
  if (!(TASK_STATUS_MANY_TARGETS as readonly string[]).includes(input.status)) {
    return (
      `status=${String(input.status)} はまとめて移せない（${TASK_STATUS_MANY_TARGETS.join(' / ')} だけ）。` +
      '開き直しや開いている状態どうしの移動は、1件ずつ task_set_status で行う。**1件も閉じていない。**'
    );
  }
  const { origin, source, q, until, reason, limit } = input;
  const limitError = describeIntRangeViolation('limit', limit, {
    min: 1,
    max: CLOSE_MANY_LIMIT_MAX,
  });
  if (limitError !== null) return limitError;
  const originError = describeArrayLengthViolation('origin', origin, { min: 1 });
  if (originError !== null) return originError;
  const sourceLengthError = describeArrayLengthViolation('source', source, { min: 1 });
  if (sourceLengthError !== null) return sourceLengthError;
  const sourceElementError = describeStringArrayElementLengthViolation('source', source);
  if (sourceElementError !== null) return sourceElementError;
  const qError = describeStringLengthViolation('q', q, { min: 1 });
  if (qError !== null) return qError;
  const untilLengthError = describeStringLengthViolation('until', until, { min: 1 });
  if (untilLengthError !== null) return untilLengthError;
  const reasonError =
    describeStringLengthViolation('reason', reason, { min: 1 }) ??
    describeBlankViolation('reason', reason);
  if (reasonError !== null) return reasonError;
  // 絞り込みの無い呼びを断る: 「全部閉じる」が事故で撃てる形を作らないため。確認用の追加の引数は作らない: `dryRun` の既定と2重に問うことになり、どちらが効いたのか読めなくなるため
  if (taskOriginSchema.options.every((known) => origin.includes(known))) {
    return (
      'origin に在る起点を全部（human / manager / external / self）並べた呼びは断る——' +
      'それは絞り込みが無いのと同じで、1回でtask の待ち行列を空にできてしまう。' +
      '閉じたい起点だけを名指しすること（例 origin: ["external"]）。**1件も閉じていない。**'
    );
  }
  // 読めない `until` を「絞り込みが当たらなかった」に混ぜない: 打ち間違いが「0件だった」に化けて静かに通るため
  // 時差（`Z` / `±hh:mm`）を必須にする: 元に戻せない一括操作で、時差の無い形は `Date.parse` が地方時刻として読み境界が黙ってずれるため
  if (until !== undefined && !isOffsetQualifiedTimeBoundary(until)) {
    return (
      describeOffsetRequiredTimeBoundary('until', until, '2026-09-11T19:00:00.000Z') +
      '**1件も閉じていない。**'
    );
  }
  return null;
}

export function describeCloseManyFilter(filter: CloseManyFilterInput): string {
  const { origin, source, q, until } = filter;
  return [
    `origin=[${origin.join(', ')}]`,
    ...(source === undefined ? [] : [`source=[${source.join(', ')}]（完全一致）`]),
    ...(q === undefined ? [] : [`q="${q}"`]),
    ...(until === undefined ? [] : [`until=${until}`]),
  ].join(' / ');
}

interface TaskStatusManySelection {
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
) {
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

interface CloseManyChunk {
  /** 1 起点 */
  number: number;
  total: number;
  ids: readonly string[];
}

interface CloseManyChunkHooks {
  /** 塊を閉じる前。投げれば、その塊を閉じずに全体を止める（投げた例外はそのまま呼び手へ出る） */
  before?: (chunk: CloseManyChunk) => Promise<void>;
  /** `closeMany` が投げたとき。ここで打ち消しなどを書いてよい。例外はそのまま呼び手へ出る */
  closeFailed?: (chunk: CloseManyChunk, error: unknown) => Promise<void>;
  /** 塊を閉じた後。`closed` はこの呼びが実際に閉じた id（他経路が先に閉じていた分は含まない。0件のこともある） */
  after: (chunk: CloseManyChunk, closed: readonly string[]) => Promise<void>;
}

/**
 * 対象の id を文字数の予算で塊に割り、塊ごとに「前 → 閉じる → 後」を交互に回す: まとめて閉じてから日誌を書くと、器が落ちたとき閉じたのに記録が無い行が最大 `CLOSE_MANY_LIMIT_MAX` 件できるため。
 * 閉じた id を全部返す。
 */
export async function closeManyInChunks(
  store: ReturnType<typeof taskStatusManyStore>,
  ids: readonly string[],
  options: { reason: string; by: TaskClosedBy; at: string },
  hooks: CloseManyChunkHooks,
): Promise<string[]> {
  const chunks = chunkIdsByChars(ids, CLOSE_MANY_JOURNAL_ID_CHARS);
  const closedIds: string[] = [];
  for (const [index, chunkIds] of chunks.entries()) {
    const chunk: CloseManyChunk = { number: index + 1, total: chunks.length, ids: chunkIds };
    await hooks.before?.(chunk);
    let closed: string[];
    try {
      closed = await store.closeMany(chunkIds, options.at, options.reason, options.by);
    } catch (error) {
      await hooks.closeFailed?.(chunk, error);
      throw error;
    }
    closedIds.push(...closed);
    await hooks.after(chunk, closed);
  }
  return closedIds;
}
