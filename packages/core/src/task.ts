import { assertNoNul, stripNulWellFormed as cleanText } from './nul-guard.js';
import { taskSchema } from './schema.js';
import type { CommitmentOrigin, JobStatus, Task, TaskClosedBy, TaskStatus } from './schema.js';
import { compareIsoInstant } from './iso-instant.js';

// Task の状態遷移と並びの規則。純関数だけを置き、メモリ・fs・pg の3実装が同じものを呼ぶ。
// 3実装が規則をそれぞれ持つと必ずずれる（`findOpenManagerDuplicate` と同じ理由）。pg も「全行を読む → ここの関数で次の行を作る → 変わった行だけ書く」の形で、規則を SQL に書き直さない。

export function isTaskClosed(status: TaskStatus): boolean {
  return status === 'done' || status === 'cancelled';
}

/**
 * 結び付いた委譲の状態に対応する task の状態（#5469 P3）。
 * 動いている間と、人間の返事待ち（`waiting_human`）は `waiting`。終わった委譲（done / failed / lost / stopped）は `needs_decision`:
 * 結果をどうするか（次の委譲・人間への報告・閉じる）はクローンが決める。`done` でも task は閉じない。
 */
export function taskStatusForJob(status: JobStatus): TaskStatus {
  return status === 'running' || status === 'waiting_human' ? 'waiting' : 'needs_decision';
}

export type TaskTransition =
  /** 状態が変わる。 */
  | { readonly kind: 'allowed' }
  /** 同じ状態への遷移。何も書かない（失敗にもしない: 二重に届いた指示を冪等にするため）。 */
  | { readonly kind: 'noop' }
  /** 許されない遷移。例外にせず結果で返す（呼び出し側が理由を人間・クローンに返す）。 */
  | { readonly kind: 'rejected' };

/**
 * 遷移の規則。
 * - queued / waiting / needs_decision は相互に行き来できる（委譲の返事待ち・クローンの判断待ちは、仕事の途中で何度でも入れ替わる）。
 * - どれからも done / cancelled へ行ける。
 * - done / cancelled からは queued へだけ戻せる（reopen）。waiting / needs_decision へ直接戻すと、閉じた記録を外した行が「何を待っているのか」を持たない。
 *   done と cancelled の相互の付け替えも拒む: 閉じた理由を黙って書き換えると、何が起きたかを後から追えなくなるため。
 */
export function planTaskTransition(from: TaskStatus, to: TaskStatus): TaskTransition {
  if (from === to) return { kind: 'noop' };
  if (!isTaskClosed(from)) return { kind: 'allowed' };
  return to === 'queued' ? { kind: 'allowed' } : { kind: 'rejected' };
}

// ---- 並び ----

export type TaskPlacement =
  | { readonly kind: 'front' }
  | { readonly kind: 'back' }
  | { readonly kind: 'before'; readonly anchorId: string }
  | { readonly kind: 'after'; readonly anchorId: string };

/** 並びの計算に要る最小の形。`rank` は昇順が先頭。 */
export interface TaskRankRow {
  readonly id: string;
  readonly rank: number;
  readonly origin: CommitmentOrigin;
}

export type TaskPlacementResult =
  | {
      readonly kind: 'placed';
      readonly rank: number;
      /** 隙間が尽きたときだけ付く、既存の行の振り直し（挿入した行は含まない）。 */
      readonly renumber: readonly { readonly id: string; readonly rank: number }[];
    }
  | { readonly kind: 'anchor-not-found' };

// 位置は fractional rank（double）で持つ。隣との中点を取るので、行を1つ動かしても他の行を書き直さない（fs の全体書き直し・pg の更新行数を増やさない）。
// 整数の連番にしない: 先頭への割り込みのたびに全行の振り直しになる。
export const TASK_RANK_STEP = 1024;

/**
 * 新しい（または動かす）行の rank を決める。`open` は **開いている行だけ**・rank の昇順で、置く行自身を含まない。
 * closed の行を並びの計算から外す: 閉じた行は list の既定で出ず、アンカーにも「最後の human の直後」の判定にもならないため。
 *
 * `placement` を省くと既定の挿入: origin が human なら「開いている human 起点の最後の直後」（無ければ先頭）、それ以外は末尾。
 * 既定は人間起点が先、残りは届いた順（#5469 方針案1）。
 */
export function placeTask(
  open: readonly TaskRankRow[],
  placement: TaskPlacement | undefined,
  origin: CommitmentOrigin,
): TaskPlacementResult {
  const index = insertionIndex(open, placement ?? defaultPlacement(open, origin));
  if (index === undefined) return { kind: 'anchor-not-found' };

  const prev = index > 0 ? open[index - 1]?.rank : undefined;
  const next = index < open.length ? open[index]?.rank : undefined;
  if (prev === undefined && next === undefined) {
    return { kind: 'placed', rank: TASK_RANK_STEP, renumber: [] };
  }
  if (prev === undefined && next !== undefined) {
    return { kind: 'placed', rank: next - TASK_RANK_STEP, renumber: [] };
  }
  if (next === undefined && prev !== undefined) {
    return { kind: 'placed', rank: prev + TASK_RANK_STEP, renumber: [] };
  }
  if (prev !== undefined && next !== undefined) {
    const middle = prev + (next - prev) / 2;
    // 中点が隣のどちらかに潰れたら隙間が尽きている。double の精度で挿入を拒まず、全行を振り直す
    if (middle > prev && middle < next) return { kind: 'placed', rank: middle, renumber: [] };
  }
  const order = [...open.slice(0, index), undefined, ...open.slice(index)];
  const renumber: { id: string; rank: number }[] = [];
  let rank = TASK_RANK_STEP;
  let placedRank = TASK_RANK_STEP;
  for (const row of order) {
    if (row === undefined) placedRank = rank;
    else renumber.push({ id: row.id, rank });
    rank += TASK_RANK_STEP;
  }
  return { kind: 'placed', rank: placedRank, renumber };
}

function defaultPlacement(open: readonly TaskRankRow[], origin: CommitmentOrigin): TaskPlacement {
  if (origin !== 'human') return { kind: 'back' };
  const lastHuman = open.findLast((row) => row.origin === 'human');
  return lastHuman === undefined ? { kind: 'front' } : { kind: 'after', anchorId: lastHuman.id };
}

function insertionIndex(
  open: readonly TaskRankRow[],
  placement: TaskPlacement,
): number | undefined {
  if (placement.kind === 'front') return 0;
  if (placement.kind === 'back') return open.length;
  const anchor = open.findIndex((row) => row.id === placement.anchorId);
  if (anchor < 0) return undefined;
  return placement.kind === 'before' ? anchor : anchor + 1;
}

// ---- 行の集合に対する操作（メモリ・fs・pg が共有する） ----
// 変えていない行は同じ参照のまま返す: pg が「参照が違う行だけ書く」ために使う。

export interface TaskRow {
  readonly rank: number;
  readonly task: Task;
}

function openRankRows(rows: readonly TaskRow[], exceptId?: string): TaskRankRow[] {
  return rows
    .filter((row) => !isTaskClosed(row.task.status) && row.task.id !== exceptId)
    .map((row) => ({ id: row.task.id, rank: row.rank, origin: row.task.origin }))
    .sort((a, b) => a.rank - b.rank);
}

function withRanks(
  rows: readonly TaskRow[],
  renumber: readonly { id: string; rank: number }[],
): TaskRow[] {
  if (renumber.length === 0) return [...rows];
  const byId = new Map(renumber.map((item) => [item.id, item.rank]));
  return rows.map((row) => {
    const rank = byId.get(row.task.id);
    return rank === undefined || rank === row.rank ? row : { rank, task: row.task };
  });
}

/** 開いている行を rank の昇順（同じ rank は作成の古い順 → id）、続けて閉じた行を閉じた新しい順。`includeClosed` を省くと開いている行だけ。 */
export function listTaskRows(rows: readonly TaskRow[], includeClosed: boolean): Task[] {
  const open = rows
    .filter((row) => !isTaskClosed(row.task.status))
    .sort(
      (a, b) =>
        a.rank - b.rank ||
        compareIsoInstant(a.task.createdAt, b.task.createdAt) ||
        compareText(a.task.id, b.task.id),
    )
    .map((row) => row.task);
  if (!includeClosed) return open;
  const closed = rows
    .filter((row) => isTaskClosed(row.task.status))
    .map((row) => row.task)
    .sort(
      (a, b) =>
        compareIsoInstant(b.closedAt ?? b.updatedAt, a.closedAt ?? a.updatedAt) ||
        compareText(a.id, b.id),
    );
  return [...open, ...closed];
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * 書き込む前の整え。id の NUL は断り（行を指す鍵なので）、本文系の NUL は落として残す（`CommitmentStore.open` と同じ作法）。
 * `taskSchema` を通すので、型を外れた値は例外になる。
 */
export function prepareTask(entry: Task): Task {
  assertNoNul('task.id', entry.id);
  return taskSchema.parse({
    ...entry,
    // NUL に加えて孤立サロゲートも直す: pg の `stripNulls` が jsonb へ入れる前に必ず直すので、揃えないと器によって読み戻した本文が違う
    title: cleanText(entry.title),
    body: cleanText(entry.body),
    ...(entry.source === undefined ? {} : { source: cleanText(entry.source) }),
    ...(entry.originConversationId === undefined
      ? {}
      : { originConversationId: cleanText(entry.originConversationId) }),
    ...(entry.closedReason === undefined ? {} : { closedReason: cleanText(entry.closedReason) }),
  });
}

export type TaskAddResult =
  /** 同じ id が既に在った（読めない行を含む）。何も書いていない。 */
  { readonly kind: 'existed' } | { readonly kind: 'added' } | { readonly kind: 'anchor-not-found' };

export function addTaskRow(
  rows: readonly TaskRow[],
  entry: Task,
  placement: TaskPlacement | undefined,
): { rows: TaskRow[]; result: TaskAddResult } {
  if (rows.some((row) => row.task.id === entry.id)) {
    return { rows: [...rows], result: { kind: 'existed' } };
  }
  const placed = placeTask(openRankRows(rows), placement, entry.origin);
  if (placed.kind === 'anchor-not-found') {
    return { rows: [...rows], result: { kind: 'anchor-not-found' } };
  }
  return {
    rows: [...withRanks(rows, placed.renumber), { rank: placed.rank, task: entry }],
    result: { kind: 'added' },
  };
}

export type TaskMoveResult =
  | { readonly kind: 'moved' }
  | { readonly kind: 'not-found' }
  /** 閉じた行は動かさない（並びの計算から外れているため）。 */
  | { readonly kind: 'closed' }
  | { readonly kind: 'anchor-not-found' }
  | { readonly kind: 'anchor-is-self' };

export function moveTaskRow(
  rows: readonly TaskRow[],
  id: string,
  placement: TaskPlacement,
): { rows: TaskRow[]; result: TaskMoveResult } {
  const unchanged = (result: TaskMoveResult) => ({ rows: [...rows], result });
  const target = rows.find((row) => row.task.id === id);
  if (target === undefined) return unchanged({ kind: 'not-found' });
  if (isTaskClosed(target.task.status)) return unchanged({ kind: 'closed' });
  if ((placement.kind === 'before' || placement.kind === 'after') && placement.anchorId === id) {
    return unchanged({ kind: 'anchor-is-self' });
  }
  const placed = placeTask(openRankRows(rows, id), placement, target.task.origin);
  if (placed.kind === 'anchor-not-found') return unchanged({ kind: 'anchor-not-found' });
  const renumbered = withRanks(rows, placed.renumber);
  return {
    rows: renumbered.map((row) =>
      row.task.id === id ? { rank: placed.rank, task: row.task } : row,
    ),
    result: { kind: 'moved' },
  };
}

export type TaskSetKeepResult =
  | { readonly kind: 'changed'; readonly task: Task }
  /** 既にその印の状態だった。何も書かない。 */
  | { readonly kind: 'unchanged'; readonly task: Task }
  | { readonly kind: 'not-found' };

/**
 * 「続く」の印（`keep`）を立てる／外す。状態・並び・`updatedAt` は動かさない（`updatedAt` は状態と閉じた記録の更新の時刻）。
 * 閉じた件にも立てられる（開き直したときに効く）。外すときは欄ごと消す（`keep: false` は持たない。型が `true` だけのため）。
 */
export function setTaskRowKeep(
  rows: readonly TaskRow[],
  id: string,
  keep: boolean,
): { rows: TaskRow[]; result: TaskSetKeepResult } {
  const target = rows.find((row) => row.task.id === id);
  if (target === undefined) return { rows: [...rows], result: { kind: 'not-found' } };
  if ((target.task.keep === true) === keep) {
    return { rows: [...rows], result: { kind: 'unchanged', task: target.task } };
  }
  const next: Task = { ...target.task };
  if (keep) next.keep = true;
  else delete next.keep;
  return {
    rows: rows.map((row) => (row === target ? { rank: row.rank, task: next } : row)),
    result: { kind: 'changed', task: next },
  };
}

export interface SetTaskStatusOptions {
  /** 閉じる理由。done / cancelled のときだけ行に残す。 */
  readonly reason?: string;
  readonly by: TaskClosedBy;
  readonly at: string;
}

export type TaskSetStatusResult =
  /** `before` は書き換える前の行。閉じた記録を外す reopen では、日誌へ逐語で残す材料がここにしか無い。 */
  | { readonly kind: 'changed'; readonly before: Task; readonly task: Task }
  | { readonly kind: 'unchanged'; readonly task: Task }
  | { readonly kind: 'rejected'; readonly from: TaskStatus; readonly to: TaskStatus }
  | { readonly kind: 'not-found' };

export function setTaskRowStatus(
  rows: readonly TaskRow[],
  id: string,
  status: TaskStatus,
  options: SetTaskStatusOptions,
): { rows: TaskRow[]; result: TaskSetStatusResult } {
  const target = rows.find((row) => row.task.id === id);
  if (target === undefined) return { rows: [...rows], result: { kind: 'not-found' } };
  const before = target.task;
  const transition = planTaskTransition(before.status, status);
  if (transition.kind === 'noop') {
    return { rows: [...rows], result: { kind: 'unchanged', task: before } };
  }
  if (transition.kind === 'rejected') {
    return {
      rows: [...rows],
      result: { kind: 'rejected', from: before.status, to: status },
    };
  }

  if (isTaskClosed(status)) {
    const closed: Task = {
      ...before,
      status,
      updatedAt: options.at,
      closedAt: options.at,
      closedBy: options.by,
      ...(options.reason === undefined ? {} : { closedReason: cleanText(options.reason) }),
    };
    return {
      rows: rows.map((row) => (row === target ? { rank: row.rank, task: closed } : row)),
      result: { kind: 'changed', before, task: closed },
    };
  }

  const next: Task = { ...before, status, updatedAt: options.at };
  delete next.closedAt;
  delete next.closedReason;
  delete next.closedBy;
  if (!isTaskClosed(before.status)) {
    return {
      rows: rows.map((row) => (row === target ? { rank: row.rank, task: next } : row)),
      result: { kind: 'changed', before, task: next },
    };
  }
  // reopen: 閉じていたあいだ並びの外に居たので、新しく届いた行と同じ既定の規則で置き直す（古い rank は他の行と無関係になっている）
  const placed = placeTask(openRankRows(rows, id), undefined, before.origin);
  if (placed.kind === 'anchor-not-found') {
    // 既定の置き方はアンカーを使わないので来ない。来たら黙って壊さず投げる
    throw new Error('Task の reopen の既定の置き方がアンカーを探した');
  }
  return {
    rows: withRanks(rows, placed.renumber).map((row) =>
      row.task.id === id ? { rank: placed.rank, task: next } : row,
    ),
    result: { kind: 'changed', before, task: next },
  };
}
