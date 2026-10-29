import { createHash } from 'node:crypto';

import { lookupConversation } from './conversation-lookup.js';
import { compareIsoInstant } from './iso-instant.js';
import type { Commitment, CommitmentOrigin, Task } from './schema.js';
import type { CommitmentStore, JobStore, JournalStore, TaskStore } from './store.js';

// 台帳（Commitment）→ Task の移行（#5469 P7）。純関数の計画（`planCommitmentMigration`）と、それを実行する `migrateCommitmentsToTasks`。
// 起動時にも道具にも繋がない: 呼ぶのは HTTP（`GET /tasks/migration-plan`・`POST /tasks/migrate`）と CLI（`alteroid tasks migrate`）だけ。
// 実行（P7b）は dry-run が返した計画の指紋を必須で受け取り、実行時に組み直した計画の指紋と違えば何も書かずに断る。

export type CommitmentMigrationStores = {
  readonly commitments: CommitmentStore;
  readonly tasks: TaskStore;
  readonly journal: JournalStore;
  /** 台帳の `source` が承認の id のとき、承認の会話 id を引くため（`getApproval` だけ使う）。 */
  readonly jobs: Pick<JobStore, 'getApproval'>;
};

/** 移す Task の起点の会話を、台帳の `source` から引いた結果。 */
export interface OriginConversationResolution {
  readonly conversationId: string;
  /** `conversation`: `source` が実在する会話 id。`approval`: `source` が承認の id で、その承認の会話 id。 */
  readonly via: 'conversation' | 'approval';
}

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
  /** `task` の行だけ。引けなかった行は無い（付けずに移す）。 */
  readonly originConversation?: OriginConversationResolution;
}

export interface CommitmentMigrationOriginConversationCounts {
  /** `source` が実在する会話 id だった。 */
  fromConversation: number;
  /** `source` が承認の id で、承認の会話 id を引けた。 */
  fromApproval: number;
  /** どちらとも引けなかった（起点の会話を付けずに移す）。 */
  unresolved: number;
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
  /** Task を新しく作る行（`toTask`）の、起点の会話の引き方の内訳。3つの合計が `toTask`。 */
  originConversation: CommitmentMigrationOriginConversationCounts;
  /** Task を新しく作る行（`toTask`）の最古/最新の `at`。無ければ `null`。 */
  oldestAt: string | null;
  newestAt: string | null;
}

export interface CommitmentMigrationPlan {
  /** at の古い順（同じ at は id）。この順で Task を add すると、P2 の既定の置き場所で古い順に並ぶ。 */
  readonly rows: readonly CommitmentMigrationPlanRow[];
  readonly summary: CommitmentMigrationSummary;
  /** 計画の指紋（{@link commitmentMigrationFingerprint}）。 */
  readonly fingerprint: string;
}

/**
 * 計画の指紋。dry-run で見た計画と、実行時に組み直した計画が同じかを判るための値。
 * 閉じた行（`skip-closed`）は書き込みの対象でないので入れない（閉じた行が増えても指紋は変わらない）。
 * それ以外の行は、行の id・動作・起点・時刻と、移す Task に付ける起点の会話（会話 id と引き方）を入れる:
 * 動作や宛先が見たものと違う計画を、同じ指紋で実行しないため。本文は入れない（台帳の本文は書き換わらず、id で一意に決まる）。
 * 行は計画の並び（at、同じ at は id）のままで、並びも指紋に入る。
 */
export function commitmentMigrationFingerprint(
  rows: readonly CommitmentMigrationPlanRow[],
): string {
  const lines = rows
    .filter((row) => row.action !== 'skip-closed')
    .map(({ action, commitment, originConversation }) =>
      JSON.stringify([
        action,
        commitment.id,
        commitment.origin,
        commitment.at,
        originConversation?.via ?? null,
        originConversation?.conversationId ?? null,
      ]),
    );
  return createHash('sha256').update(lines.join('\n'), 'utf8').digest('hex');
}

const ORIGINS: readonly CommitmentOrigin[] = ['human', 'manager', 'external', 'self'];

function compareId(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * 計画を立てる純関数。何も読まず・書かない。
 * `existingTaskIds` は **読めない Task の行の id も含める**（`TaskStore.add` が「読めない行も在るものとして」existed を返すのと揃える）。
 * 二重に移さない根拠は台帳を閉じたことだけに頼らず、Task の id（= 元の commitment の id）で判る。
 * `originConversations` は行の id → 起点の会話（`resolveOriginConversations` の結果）。`task` の行で無ければ「引けなかった」として数える。
 */
export function planCommitmentMigration(
  commitments: readonly Commitment[],
  existingTaskIds: ReadonlySet<string>,
  originConversations: ReadonlyMap<string, OriginConversationResolution> = new Map(),
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
    originConversation: { fromConversation: 0, fromApproval: 0, unresolved: 0 },
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
      const originConversation = originConversations.get(commitment.id);
      if (originConversation === undefined) summary.originConversation.unresolved += 1;
      else if (originConversation.via === 'conversation') {
        summary.originConversation.fromConversation += 1;
      } else summary.originConversation.fromApproval += 1;
      return { action, commitment, ...(originConversation ? { originConversation } : {}) };
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
  return { rows, summary, fingerprint: commitmentMigrationFingerprint(rows) };
}

/** 起点の会話を引く読みが失敗した。誤った宛先を付けた Task を作らないため、計画を立てずに止める（何も書いていない）。 */
export class OriginConversationLookupError extends Error {
  constructor(
    readonly commitmentId: string,
    cause: unknown,
  ) {
    super(
      `台帳の行 ${commitmentId} の起点の会話を引く読みが失敗したので、計画を立てなかった（何も書いていない）。`,
      { cause },
    );
    this.name = 'OriginConversationLookupError';
  }
}

/** 実行時に組み直した計画の指紋が、渡された指紋と違う。何も書いていない。 */
export class MigrationPlanChangedError extends Error {
  constructor(
    readonly expected: string,
    readonly actual: string,
  ) {
    super(
      '計画が dry-run のときから変わっている（台帳か task か会話が動いた）ので、何も書かずに断った。dry-run をやり直して、新しい指紋で実行すること。',
    );
    this.name = 'MigrationPlanChangedError';
  }
}

/**
 * `task` になる行ごとに、起点の会話を `source` から引く。
 * - `source` が承認の id なら、その承認の会話 id（承認は鍵で引くので安い。会話 id の確かめも通す）。
 * - そうでなければ、`source` が実在する会話 id か（日誌の人間との往復に在るか）。
 * - どちらとも引けなければ載せない（呼び手が「引けなかった」として数える）。
 * 読みが投げたら `OriginConversationLookupError`。読めない承認の行も同じ扱い（会話 id が判らないまま別の宛先を付けないため）。
 */
async function resolveOriginConversations(
  stores: CommitmentMigrationStores,
  commitments: readonly Commitment[],
): Promise<Map<string, OriginConversationResolution>> {
  const result = new Map<string, OriginConversationResolution>();
  const bySource = new Map<string, OriginConversationResolution | null>();
  for (const commitment of commitments) {
    const source = commitment.source;
    if (source === undefined || source === '') continue;
    try {
      let resolved = bySource.get(source);
      if (resolved === undefined) {
        resolved = await resolveSource(stores, source);
        bySource.set(source, resolved);
      }
      if (resolved !== null) result.set(commitment.id, resolved);
    } catch (error) {
      throw new OriginConversationLookupError(commitment.id, error);
    }
  }
  return result;
}

async function resolveSource(
  stores: CommitmentMigrationStores,
  source: string,
): Promise<OriginConversationResolution | null> {
  const approval = await stores.jobs.getApproval(source);
  if (approval !== null) {
    const conversationId = approval.conversationId;
    if (conversationId === undefined || conversationId === '') return null;
    return (await lookupConversation(stores.journal, conversationId)).found
      ? { conversationId, via: 'approval' }
      : null;
  }
  return (await lookupConversation(stores.journal, source)).found
    ? { conversationId: source, via: 'conversation' }
    : null;
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
export function taskFromCommitment(
  commitment: Commitment,
  now: string,
  originConversationId?: string,
): Task {
  return {
    id: commitment.id,
    createdAt: commitment.at,
    updatedAt: now,
    status: 'queued',
    origin: 'human',
    ...(commitment.source === undefined ? {} : { source: commitment.source }),
    ...(originConversationId === undefined ? {} : { originConversationId }),
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
  /** `task` の行で、起点の会話を引けたときだけ。引けなかった行は欄が無い。 */
  originConversation?: OriginConversationResolution;
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
  /** 上の件数の行の id（人間が結果を台帳・task と突き合わせるため。本文は無い）。 */
  ids: { migrated: string[]; closeOnly: string[]; retired: string[]; alreadyClosed: string[] };
  /** Task を実際に作った行（`migrated` のうち台帳を閉じる前に落ちた行も含む）の、起点の会話の引き方の内訳。 */
  originConversation: {
    fromConversation: number;
    fromApproval: number;
    /** 起点の会話を引けず、付けずに作った Task の id。 */
    unresolvedIds: string[];
  };
  failed: CommitmentMigrationFailure[];
}

export interface CommitmentMigrationReport {
  dryRun: boolean;
  /** 計画の指紋。dry-run の結果から取り、実行へそのまま渡す。 */
  fingerprint: string;
  summary: CommitmentMigrationSummary;
  items: CommitmentMigrationPlanItem[];
  /** 読めない台帳の行。触らない。id（無ければ欠落）だけを出し、本文・理由は出さない。 */
  unreadableCommitments: { id?: string }[];
  /** 読めない Task の行の件数（台帳の id と無関係なものも含む）。 */
  unreadableTasks: number;
  /** 開いている human 行の id と同じ id で在る、読めない Task の行。existed と同じ扱いで台帳を閉じるだけにした。 */
  unreadableTaskCollisions: string[];
  /** 移す行（`task`）のうち、起点の会話を引けなかった行の id。付けずに移す。 */
  unresolvedOriginIds: string[];
  /** dryRun では無い。 */
  execution?: CommitmentMigrationExecution;
}

export type MigrateCommitmentsOptions = {
  /** Task の `updatedAt` と台帳を閉じる時刻（ISO8601）。 */
  readonly now: string;
} & (
  | { readonly dryRun: true }
  | {
      readonly dryRun: false;
      /** dry-run が返した指紋。実行時に組み直した計画の指紋と違えば `MigrationPlanChangedError` で、何も書かない。 */
      readonly expectedFingerprint: string;
    }
);

/**
 * 台帳 → Task の移行。1行ごとに (1) Task を add（human のみ）→ (2) 日誌（decision）→ (3) 台帳を close。
 * - 日誌が書けなければ閉じない（開き直しと同じ「日誌が先」の線）。
 * - 途中で落ちても再実行で続きから進む: Task は id が元の id なので existed になり、台帳を閉じるだけが続く。
 *   このとき (2) の日誌は2回書かれうる（Task を書いた後・日誌の前後で落ちた行）。日誌は追記専用で「何が起きたかの記録」なので、欠けるより重複するほうを選ぶ。
 * - 1行の失敗（例外）は `failed` に数えて次の行へ進む。全体を例外で止めない。
 * - dryRun は読むだけで、何も書かない。
 * - 実行は `expectedFingerprint`（dry-run の指紋）を必須で受け取り、組み直した計画の指紋と違えば何も書かずに `MigrationPlanChangedError`。
 * - 起点の会話を引く読みが失敗したら（dry-run も実行も）、その行だけ付けずに移すのではなく `OriginConversationLookupError` で全体を止める。
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
  // 起点の会話を引くのは `task` になる行だけ（動作は起点の会話に依らないので、先に動作だけ決めてから引く）
  const toTask = planCommitmentMigration(entries, existingTaskIds).rows.flatMap((row) =>
    row.action === 'task' ? [row.commitment] : [],
  );
  const originConversations = await resolveOriginConversations(stores, toTask);
  const plan = planCommitmentMigration(entries, existingTaskIds, originConversations);
  if (!options.dryRun && options.expectedFingerprint !== plan.fingerprint) {
    throw new MigrationPlanChangedError(options.expectedFingerprint, plan.fingerprint);
  }

  const unreadableTaskSet = new Set(unreadableTaskIds);
  const report: CommitmentMigrationReport = {
    dryRun: options.dryRun,
    fingerprint: plan.fingerprint,
    summary: plan.summary,
    items: plan.rows.map(({ action, commitment, originConversation }) => ({
      id: commitment.id,
      action,
      origin: commitment.origin,
      at: commitment.at,
      ...(action === 'task' ? { title: migrationTaskTitle(commitment.body) } : {}),
      ...(originConversation === undefined ? {} : { originConversation }),
    })),
    unresolvedOriginIds: plan.rows.flatMap(({ action, commitment, originConversation }) =>
      action === 'task' && originConversation === undefined ? [commitment.id] : [],
    ),
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
    ids: { migrated: [], closeOnly: [], retired: [], alreadyClosed: [] },
    originConversation: { fromConversation: 0, fromApproval: 0, unresolvedIds: [] },
    failed: [],
  };
  for (const { action, commitment, originConversation } of plan.rows) {
    if (action === 'skip-closed') continue;
    let step: CommitmentMigrationFailure['step'] = 'task';
    try {
      let effective = action;
      if (action === 'task') {
        const added = await stores.tasks.add(
          taskFromCommitment(commitment, options.now, originConversation?.conversationId),
        );
        if (added.kind === 'existed') {
          effective = 'close-only';
        } else if (added.kind !== 'added') {
          // 既定の置き方はアンカーを使わないので来ない。来たら黙って閉じず失敗として数える
          throw new Error('Task を置けなかった');
        } else if (originConversation === undefined) {
          execution.originConversation.unresolvedIds.push(commitment.id);
        } else if (originConversation.via === 'conversation') {
          execution.originConversation.fromConversation += 1;
        } else execution.originConversation.fromApproval += 1;
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
      if (!closed) {
        execution.alreadyClosed += 1;
        execution.ids.alreadyClosed.push(commitment.id);
      } else if (effective === 'task') {
        execution.migrated += 1;
        execution.ids.migrated.push(commitment.id);
      } else if (effective === 'close-only') {
        execution.closeOnly += 1;
        execution.ids.closeOnly.push(commitment.id);
      } else {
        execution.retired += 1;
        execution.ids.retired.push(commitment.id);
      }
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
