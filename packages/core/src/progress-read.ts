import { readConversationWindow } from './conversation.js';
import { taskIsResponseJudgeable, taskRespondedAt } from './schema.js';
import type { Commitment, Job, JournalEntry, UnreadableJob } from './schema.js';
import { summarizeProgress } from './progress.js';
import type { ProgressSummary } from './progress.js';
import { scanJournalPages } from './journal-scan.js';
import { GITHUB_OBSERVATION_SCAN_LIMIT, summarizeGithubObservations } from './progress-github.js';
import type { ProgressGithub } from './progress-github.js';
import type { Stores } from './store.js';

/** 窓の既定（時間）。`summarizeProgress` は既定を持たないので、口はここを共有する。 */
export const DEFAULT_PROGRESS_WINDOW_HOURS = 168;

/** `windowHours` が不正なときの文言。送られてきた値は混ぜない。 */
export const PROGRESS_WINDOW_HOURS_INVALID_MESSAGE = 'windowHours は有限の正数（時間）で指定する';

/** `windowHours` の不正。ストアの `RangeError` と取り違えないよう専用の型にする。 */
export class InvalidProgressWindowError extends RangeError {
  constructor() {
    super(PROGRESS_WINDOW_HOURS_INVALID_MESSAGE);
    this.name = 'InvalidProgressWindowError';
  }
}

/** `activeManagerIds` の導出の対象になりうる行（`origin` が `human` で `source` を持つ）か。 */
function hasDelegationDerivableEntry(entries: readonly Commitment[]): boolean {
  return entries.some((entry) => entry.origin === 'human' && entry.source !== undefined);
}

/**
 * 読めない委譲がどの台帳の行に紐づくかは、行が壊れているので言えない。行へ紐づけず、
 * 読めない行（id と不正な欄名だけ）をそのまま返す。
 */
export async function readUnreadableJobsForCommitments(
  stores: Stores,
  entries: readonly Commitment[],
): Promise<UnreadableJob[]> {
  if (!hasDelegationDerivableEntry(entries)) return [];
  return stores.jobs.listUnreadableJobs();
}

/**
 * 台帳の一覧（`GET /commitments`）の導出。進捗（`GET /progress`・`progress_read`）は台帳でなく task から数える（`readProgress`）ので使わない。
 * 返答の引き方（`readRepliesByConversation`）だけは進捗と共有する。
 * `readJobs` は、呼び手が既に job 一覧を読んでいるときに二重に読まないための差し込み口。
 */
export async function buildCommitmentDerivations(
  stores: Stores,
  entries: readonly Commitment[],
  readJobs: () => Promise<readonly Job[]> = () => stores.jobs.listJobs(),
) {
  const activeManagersByConversation = new Map<
    string,
    { managerId: string; createdAt: string }[]
  >();
  if (!hasDelegationDerivableEntry(entries)) {
    return { repliesByConversation: new Map<string, string[]>(), activeManagersByConversation };
  }

  const repliesByConversation = await readRepliesByConversation(stores);

  // `clone.managers.list()`（`ManagerSummary`）は `conversationId` を持たないので使わない。
  for (const job of await readJobs()) {
    if (job.conversationId === undefined) continue;
    if (job.status !== 'running' && job.status !== 'waiting_human') continue;
    const existing = activeManagersByConversation.get(job.conversationId);
    const entry = { managerId: job.id, createdAt: job.createdAt };
    if (existing) {
      existing.push(entry);
    } else {
      activeManagersByConversation.set(job.conversationId, [entry]);
    }
  }
  return { repliesByConversation, activeManagersByConversation };
}

/**
 * 会話 id ごとの、人間への返答の時刻（昇順）。台帳の行と task のどちらの「返事したか」も、これを引く（作法を1本にする）。
 */
export async function readRepliesByConversation(stores: Stores): Promise<Map<string, string[]>> {
  const repliesByConversation = new Map<string, string[]>();
  for (const reply of await readHumanReplies(stores)) {
    const existing = repliesByConversation.get(reply.conversationId);
    if (existing) {
      existing.push(reply.at);
    } else {
      repliesByConversation.set(reply.conversationId, [reply.at]);
    }
  }
  for (const list of repliesByConversation.values()) list.sort();
  return repliesByConversation;
}

/**
 * 人間への返答の会話 id と時刻。器が口（`humanReplies`）を持てば、本文を読まずにそこから引く（#5089: pg で全履歴の往復を本文ごと読むのが
 * `/progress`・`/commitments` の時間の多くを占めていた）。持たなければ人間との往復を全部読んで作る。
 */
async function readHumanReplies(stores: Stores): Promise<{ conversationId: string; at: string }[]> {
  if (stores.journal.humanReplies !== undefined) return stores.journal.humanReplies();
  // `types` / `with` を手組みし直さない: `with` の絞りを直し忘れる余地が戻る
  // （`scripts/conversation-window-single-source.test.ts`）。返答済みの判定は全履歴が要るので `scan` は事実上無制限。
  const humanExchanges = await readConversationWindow(stores.journal, {
    scan: Number.MAX_SAFE_INTEGER,
  });
  const replies: { conversationId: string; at: string }[] = [];
  for (const exchange of humanExchanges) {
    if (exchange.type !== 'exchange') continue;
    if (exchange.role !== 'outbound' || exchange.conversationId === undefined) continue;
    replies.push({ conversationId: exchange.conversationId, at: exchange.at });
  }
  return replies;
}

/** `GET /progress` の応答と、道具 `progress_read` が文にする入力。 */
export type ProgressView = ProgressSummary & {
  observedAt: string;
  github: ProgressGithub;
};

export interface ReadProgressOptions {
  now: Date;
  /** 省略時は `DEFAULT_PROGRESS_WINDOW_HOURS`。有限の正数でなければ `InvalidProgressWindowError`。 */
  windowHours?: number;
}

export async function readProgress(
  stores: Stores,
  { now, windowHours = DEFAULT_PROGRESS_WINDOW_HOURS }: ReadProgressOptions,
): Promise<ProgressView> {
  if (!Number.isFinite(windowHours) || windowHours <= 0) throw new InvalidProgressWindowError();
  const tasks = await stores.tasks.list({ includeClosed: true });
  const jobs = await stores.jobs.listJobs();
  const unreadableJobs = (await stores.jobs.listUnreadableJobs()).length;
  // 「返答済み」を数えるのは未了の task だけ（`summarizeProgress` は閉じた task の `respondedAt` を読まない）。
  // 閉じた task まで導出して写すと、閉じた task が積もるほど毎回無駄になる（#5089）。
  // 返答の一覧は、返事を結べる未了の human の task が1件でもあるときだけ読む
  const openEntries = tasks.entries.filter((entry) => entry.closedAt === undefined);
  const repliesByConversation = openEntries.some((entry) => taskIsResponseJudgeable(entry))
    ? await readRepliesByConversation(stores)
    : new Map<string, string[]>();
  let summary: ProgressSummary;
  try {
    summary = summarizeProgress({
      tasks: {
        ...tasks,
        entries: tasks.entries.map((entry) =>
          entry.closedAt !== undefined
            ? entry
            : { ...entry, respondedAt: taskRespondedAt(entry, repliesByConversation) },
        ),
      },
      jobs,
      unreadableJobs,
      now,
      windowHours,
    });
  } catch (error) {
    if (error instanceof RangeError) throw new InvalidProgressWindowError();
    throw error;
  }
  return {
    observedAt: now.toISOString(),
    ...summary,
    github: summarizeGithubObservations(await readGithubObservations(stores)),
  };
}

/**
 * 短いページを終端とみなさない: pg の `list()` は SQL の `LIMIT` の後で読めない行を捨てるので、
 * 要求した件数に届くか空ページが返るまで読み継ぐ。
 */
async function readGithubObservations(stores: Stores): Promise<JournalEntry[]> {
  const want = GITHUB_OBSERVATION_SCAN_LIMIT + 1;
  const found: JournalEntry[] = [];
  await scanJournalPages(
    stores.journal,
    { types: ['github_observation'] },
    (page) => {
      found.push(...page);
    },
    { pageSize: want, maxScanned: want },
  );
  return found;
}
