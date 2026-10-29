import { compareIsoInstant } from './iso-instant.js';
import type { Commitment, CommitmentOrigin, Task } from './schema.js';
import type { CommitmentStore, JournalStore, TaskStore } from './store.js';

// 台帳（Commitment）→ Task の移行（#5469 P7a）。純関数の計画（`planCommitmentMigration`）と、それを実行する `migrateCommitmentsToTasks`。
// 起動時にも道具にも繋がない: 実行の口は P7 本体が配線する。いまは dryRun の読み口（`GET /tasks/migration-plan`・`alteroid tasks migrate --dry-run`）だけが呼ぶ。

export type CommitmentMigrationStores = {
  readonly commitments: CommitmentStore;
  readonly tasks: TaskStore;
  readonly journal: JournalStore;
};

export type CommitmentMigrationAction =
  /** 開いている human 起点の行。Task を作って台帳を閉じる。 */
  | 'task'
  /** Task が既に在る（途中で落ちた再実行の復旧）。Task は作らず台帳を閉じるだけ。 */
  | 'close-only'
  /** human 以外の開いている行。Task にせず台帳を閉じる（日誌へ本文を残す）。 */
  | 'retire'
  /** 閉じた行。移さず台帳に残す（件数だけ数える）。 */
  | 'skip-closed';

export interface CommitmentMigrationPlanRow {
  readonly action: CommitmentMigrationAction;
  readonly commitment: Commitment;
}

export interface CommitmentMigrationOriginCounts {
  toTask: number;
  closeOnly: number;
  retire: number;
  skipClosed: number;
}

export interface CommitmentMigrationSummary {
  total: number;
  /** Task を新しく作る件数。 */
  toTask: number;
  /** Task が既に在り、台帳を閉じるだけの件数。 */
  closeOnly: number;
  /** human 以外の開いている行を畳む件数。 */
  retire: number;
  /** 閉じていて移さない件数。 */
  skipClosed: number;
  byOrigin: Record<CommitmentOrigin, CommitmentMigrationOriginCounts>;
  /** Task を新しく作る行（`toTask`）の最古/最新の `at`。無ければ `null`。 */
  oldestAt: string | null;
  newestAt: string | null;
}

export interface CommitmentMigrationPlan {
  /** at の古い順（同じ at は id）。この順で Task を add すると、P2 の既定の置き場所で古い順に並ぶ。 */
  readonly rows: readonly CommitmentMigrationPlanRow[];
  readonly summary: CommitmentMigrationSummary;
}

const ORIGINS: readonly CommitmentOrigin[] = ['human', 'manager', 'external', 'self'];

function compareId(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * 計画を立てる純関数。何も読まず・書かない。
 * `existingTaskIds` は **読めない Task の行の id も含める**（`TaskStore.add` が「読めない行も在るものとして」existed を返すのと揃える）。
 * 二重に移さない根拠は台帳を閉じたことだけに頼らず、Task の id（= 元の commitment の id）で判る。
 */
export function planCommitmentMigration(
  commitments: readonly Commitment[],
  existingTaskIds: ReadonlySet<string>,
): CommitmentMigrationPlan {
  const sorted = [...commitments].sort(
    (a, b) => compareIsoInstant(a.at, b.at) || compareId(a.id, b.id),
  );
  const byOrigin = Object.fromEntries(
    ORIGINS.map((origin) => [origin, { toTask: 0, closeOnly: 0, retire: 0, skipClosed: 0 }]),
  ) as Record<CommitmentOrigin, CommitmentMigrationOriginCounts>;
  const summary: CommitmentMigrationSummary = {
    total: sorted.length,
    toTask: 0,
    closeOnly: 0,
    retire: 0,
    skipClosed: 0,
    byOrigin,
    oldestAt: null,
    newestAt: null,
  };
  const rows = sorted.map((commitment): CommitmentMigrationPlanRow => {
    const action = actionFor(commitment, existingTaskIds);
    const counts = byOrigin[commitment.origin];
    if (action === 'task') {
      summary.toTask += 1;
      counts.toTask += 1;
      summary.oldestAt ??= commitment.at;
      summary.newestAt = commitment.at;
    } else if (action === 'close-only') {
      summary.closeOnly += 1;
      counts.closeOnly += 1;
    } else if (action === 'retire') {
      summary.retire += 1;
      counts.retire += 1;
    } else {
      summary.skipClosed += 1;
      counts.skipClosed += 1;
    }
    return { action, commitment };
  });
  return { rows, summary };
}

function actionFor(
  commitment: Commitment,
  existingTaskIds: ReadonlySet<string>,
): CommitmentMigrationAction {
  if (commitment.closedAt !== undefined) return 'skip-closed';
  if (commitment.origin !== 'human') return 'retire';
  return existingTaskIds.has(commitment.id) ? 'close-only' : 'task';
}

const TITLE_MAX = 60;
const EMPTY_TITLE = '（本文なし）';

/** 本文の先頭の空でない行を、`…` を含めて60字までに切る。全文は body に残るので、ここは一覧用の短い一行。 */
export function migrationTaskTitle(body: string): string {
  const first = body
    .split('\n')
    .find((line) => line.trim().length > 0)
    ?.trim();
  if (first === undefined) return EMPTY_TITLE;
  const chars = [...first];
  return chars.length <= TITLE_MAX ? first : `${chars.slice(0, TITLE_MAX - 1).join('')}…`;
}

/** 台帳の行から作る Task。id を元の id にする（schema.ts に元 id の欄を足さずに、Task 側の id で二重の移行を判るようにするため）。 */
export function taskFromCommitment(commitment: Commitment, now: string): Task {
  return {
    id: commitment.id,
    createdAt: commitment.at,
    updatedAt: now,
    status: 'queued',
    origin: 'human',
    ...(commitment.source === undefined ? {} : { source: commitment.source }),
    title: migrationTaskTitle(commitment.body),
    body: commitment.body,
  };
}

export interface CommitmentMigrationPlanItem {
  id: string;
  action: CommitmentMigrationAction;
  origin: CommitmentOrigin;
  at: string;
  /** `task` の行だけ。本文は載せない（一覧にタイトルと要旨だけを出す。全文は台帳に在る）。 */
  title?: string;
}

export interface CommitmentMigrationFailure {
  id: string;
  step: 'task' | 'journal' | 'close';
  /** 例外の型名だけ。メッセージには本文が混ざりうるので載せない。 */
  error: string;
}

export interface CommitmentMigrationExecution {
  /** Task を作り、台帳を閉じるところまで終えた行。 */
  migrated: number;
  /** Task が既に在り、台帳だけを閉じた行（途中で落ちた再実行の復旧・`add` が existed を返した行）。 */
  closeOnly: number;
  /** human 以外を畳んだ行。 */
  retired: number;
  /** 閉じようとしたら既に閉じていた行（別の書き手が先に閉じた）。 */
  alreadyClosed: number;
  failed: CommitmentMigrationFailure[];
}

export interface CommitmentMigrationReport {
  dryRun: boolean;
  summary: CommitmentMigrationSummary;
  items: CommitmentMigrationPlanItem[];
  /** 読めない台帳の行。触らない。id（無ければ欠落）だけを出し、本文・理由は出さない。 */
  unreadableCommitments: { id?: string }[];
  /** 読めない Task の行の件数（台帳の id と無関係なものも含む）。 */
  unreadableTasks: number;
  /** 開いている human 行の id と同じ id で在る、読めない Task の行。existed と同じ扱いで台帳を閉じるだけにした。 */
  unreadableTaskCollisions: string[];
  /** dryRun では無い。 */
  execution?: CommitmentMigrationExecution;
}

export interface MigrateCommitmentsOptions {
  readonly dryRun: boolean;
  /** Task の `updatedAt` と台帳を閉じる時刻（ISO8601）。 */
  readonly now: string;
}

/**
 * 台帳 → Task の移行。1行ごとに (1) Task を add（human のみ）→ (2) 日誌（decision）→ (3) 台帳を close。
 * - 日誌が書けなければ閉じない（開き直しと同じ「日誌が先」の線）。
 * - 途中で落ちても再実行で続きから進む: Task は id が元の id なので existed になり、台帳を閉じるだけが続く。
 *   このとき (2) の日誌は2回書かれうる（Task を書いた後・日誌の前後で落ちた行）。日誌は追記専用で「何が起きたかの記録」なので、欠けるより重複するほうを選ぶ。
 * - 1行の失敗（例外）は `failed` に数えて次の行へ進む。全体を例外で止めない。
 * - dryRun は読むだけで、何も書かない。
 */
export async function migrateCommitmentsToTasks(
  stores: CommitmentMigrationStores,
  options: MigrateCommitmentsOptions,
): Promise<CommitmentMigrationReport> {
  const { entries, unreadable } = await stores.commitments.list({ includeClosed: true });
  const taskList = await stores.tasks.list({ includeClosed: true });
  const unreadableTaskIds = taskList.unreadable.flatMap((row) =>
    row.id === undefined ? [] : [row.id],
  );
  const existingTaskIds = new Set([
    ...taskList.entries.map((task) => task.id),
    ...unreadableTaskIds,
  ]);
  const plan = planCommitmentMigration(entries, existingTaskIds);

  const unreadableTaskSet = new Set(unreadableTaskIds);
  const report: CommitmentMigrationReport = {
    dryRun: options.dryRun,
    summary: plan.summary,
    items: plan.rows.map(({ action, commitment }) => ({
      id: commitment.id,
      action,
      origin: commitment.origin,
      at: commitment.at,
      ...(action === 'task' ? { title: migrationTaskTitle(commitment.body) } : {}),
    })),
    unreadableCommitments: unreadable.map((row) => (row.id === undefined ? {} : { id: row.id })),
    unreadableTasks: taskList.unreadable.length,
    unreadableTaskCollisions: plan.rows.flatMap(({ action, commitment }) =>
      action === 'close-only' && unreadableTaskSet.has(commitment.id) ? [commitment.id] : [],
    ),
  };
  if (options.dryRun) return report;

  const execution: CommitmentMigrationExecution = {
    migrated: 0,
    closeOnly: 0,
    retired: 0,
    alreadyClosed: 0,
    failed: [],
  };
  for (const { action, commitment } of plan.rows) {
    if (action === 'skip-closed') continue;
    let step: CommitmentMigrationFailure['step'] = 'task';
    try {
      let effective = action;
      if (action === 'task') {
        const added = await stores.tasks.add(taskFromCommitment(commitment, options.now));
        if (added.kind === 'existed') {
          effective = 'close-only';
        } else if (added.kind !== 'added') {
          // 既定の置き方はアンカーを使わないので来ない。来たら黙って閉じず失敗として数える
          throw new Error('Task を置けなかった');
        }
      }
      step = 'journal';
      await stores.journal.append({
        type: 'decision',
        decision: describeDecision(effective, commitment),
        grounds: '#5469 P7 の台帳→Task の移行。本文は台帳の行を閉じる前に、ここへ逐語で残した。',
      });
      step = 'close';
      const closed = await stores.commitments.close(
        commitment.id,
        options.now,
        closeReason(effective, commitment),
        'daemon',
      );
      if (!closed) execution.alreadyClosed += 1;
      else if (effective === 'task') execution.migrated += 1;
      else if (effective === 'close-only') execution.closeOnly += 1;
      else execution.retired += 1;
    } catch (error) {
      execution.failed.push({
        id: commitment.id,
        step,
        error: error instanceof Error ? error.name : 'unknown',
      });
    }
  }
  return { ...report, execution };
}

function describeDecision(action: CommitmentMigrationAction, commitment: Commitment): string {
  const head = `台帳の行 ${commitment.id}（origin: ${commitment.origin}、${commitment.at}${
    commitment.source === undefined ? '' : `、source: ${commitment.source}`
  }）`;
  if (action === 'retire') {
    return `${head}を、移行で畳んだ（Task にせず台帳を閉じた）。本文:\n${commitment.body}`;
  }
  const suffix =
    action === 'close-only'
      ? 'Task（同じ id）は既に在るので、台帳の行を閉じた。'
      : `Task（同じ id: ${commitment.id}）へ移し、台帳の行を閉じた。`;
  return `${head}を ${suffix}本文:\n${commitment.body}`;
}

function closeReason(action: CommitmentMigrationAction, commitment: Commitment): string {
  if (action === 'retire') return `移行で畳んだ（#5469 P7）。元の origin: ${commitment.origin}`;
  return `Task ${commitment.id} へ移した（#5469 P7）`;
}
