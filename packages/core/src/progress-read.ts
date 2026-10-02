/**
 * 作業の進捗を読む（Issue #2241 の 3）——集計の入力の組み立てを1か所にしたもの。
 *
 * **`GET /progress`（daemon）・`GET /commitments`（daemon）・クローンの道具
 * `progress_read` が同じ組み立てを使う。** 台帳の行に足す `respondedAt` /
 * `activeManagerIds` の意味や、台帳・委譲の読み方が口ごとにずれると、口によって
 * 数が食い違う（一覧の「返答済み」と集計の `byState.responded` など）。
 *
 * daemon の `app.ts` にあった `buildCommitmentDerivations` と `GET /progress` の
 * 組み立てを、出力を1文字も変えずにここへ移した。
 */
import { readConversationWindow } from './conversation.js';
import { commitmentActiveDelegationIds, commitmentRespondedAt } from './schema.js';
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
 * `GET /commitments` が「進行中（委譲あり）」の導出と一緒に言う、読めない委譲の行（issue #2359）。
 *
 * `activeManagerIds` は `listJobs()` から組むので、読めない委譲に紐づく台帳の行は「委譲なし」に
 * 見える。**その委譲がどの台帳の行に紐づくかは、行が壊れているので言えない**ため、ここは
 * 行へ紐づけず、読めない行（id と不正な欄名だけ）をそのまま返す。
 *
 * 導出の対象になりうる行が1件も無ければ読まない（`buildCommitmentDerivations` と同じ条件。
 * どの行にも「委譲なし」と言っていないので、断る相手が居ない）。
 */
export async function readUnreadableJobsForCommitments(
  stores: Stores,
  entries: readonly Commitment[],
): Promise<UnreadableJob[]> {
  if (!hasDelegationDerivableEntry(entries)) return [];
  return stores.jobs.listUnreadableJobs();
}

/**
 * 台帳の行に足す2つの導出値の材料——会話 id ごとの返答時刻と、会話 id ごとの走行中の委譲。
 *
 * **一致しうる行（`origin` が `human` で `source` を持つ）が1件も無ければ、日誌も
 * job 一覧も読まない**（どの行でも `undefined` にしかならない）。`readJobs` は
 * 呼び手が既に job 一覧を読んでいるときに、二重に読まないための差し込み口。
 */
export async function buildCommitmentDerivations(
  stores: Stores,
  entries: readonly Commitment[],
  readJobs: () => Promise<readonly Job[]> = () => stores.jobs.listJobs(),
) {
  const repliesByConversation = new Map<string, string[]>();
  const activeManagersByConversation = new Map<
    string,
    { managerId: string; createdAt: string }[]
  >();
  if (!hasDelegationDerivableEntry(entries)) {
    return { repliesByConversation, activeManagersByConversation };
  }

  // **窓の組み立ては `readConversationWindow` を通す。**
  // `types: ['exchange'], with: ['human']` を手組みし直すと、issue #418 の症状
  // （`with` の絞りを1か所直し忘れる余地）を再び作る——
  // `scripts/conversation-window-single-source.test.ts` がこれを歯として測っている。
  // ここは「会話を1本表示する窓」ではなく「返答済みを判定するための全履歴」が要るので、
  // `scan` に事実上の無制限（`Number.MAX_SAFE_INTEGER`。`packages/storage-pg/src/
  // journal.ts` が `limit` 省略時に使うのと同じ値）を渡す。
  const humanExchanges = await readConversationWindow(stores.journal, {
    scan: Number.MAX_SAFE_INTEGER,
  });
  for (const exchange of humanExchanges) {
    if (exchange.type !== 'exchange') continue;
    if (exchange.role !== 'outbound' || exchange.conversationId === undefined) continue;
    const existing = repliesByConversation.get(exchange.conversationId);
    if (existing) {
      existing.push(exchange.at);
    } else {
      repliesByConversation.set(exchange.conversationId, [exchange.at]);
    }
  }
  // `commitmentRespondedAt` の契約は「昇順」——ここで1回だけ並べる。
  for (const list of repliesByConversation.values()) list.sort();

  // **`stores.jobs.listJobs()` を直接読む。** `clone.managers.list()`
  // （`ManagerSummary`）は `conversationId` を持たない。台帳（`Job`）は
  // 「デーモンが観測できたこと」の正本。
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

/** `GET /progress` の応答と、道具 `progress_read` が文にする入力。 */
export type ProgressView = ProgressSummary & {
  observedAt: string;
  /** 観測の記録を返すだけ（デーモンは GitHub を見に行かない）。`progress-github.ts`。 */
  github: ProgressGithub;
};

export interface ReadProgressOptions {
  now: Date;
  /** 省略時は `DEFAULT_PROGRESS_WINDOW_HOURS`。有限の正数でなければ `InvalidProgressWindowError`。 */
  windowHours?: number;
}

/**
 * 台帳と委譲を読み、進捗を数え直す。**読むだけで書かない。**
 *
 * 台帳は `list({ includeClosed: true })` の各行に `respondedAt` / `activeManagerIds` を
 * 足したもの、委譲は `stores.jobs.listJobs()`。`unreadable` / `trimmedClosed` はストアが
 * 返したまま渡す（取れない行を 0 に丸めない）。読めない委譲の行の数は
 * `stores.jobs.listUnreadableJobs()` から取り、`backlog.completeness.unreadableJobs` に載せる。
 */
export async function readProgress(
  stores: Stores,
  { now, windowHours = DEFAULT_PROGRESS_WINDOW_HOURS }: ReadProgressOptions,
): Promise<ProgressView> {
  if (!Number.isFinite(windowHours) || windowHours <= 0) throw new InvalidProgressWindowError();
  const commitments = await stores.commitments.list({ includeClosed: true });
  // job 一覧は summarizeProgress にも要るので1回だけ読み、導出の材料にも使い回す。
  const jobs = await stores.jobs.listJobs();
  // 読めない委譲の行は `listJobs()` に載らない。数を別に取り、`completeness` で言う（issue #2345）。
  const unreadableJobs = (await stores.jobs.listUnreadableJobs()).length;
  const { repliesByConversation, activeManagersByConversation } = await buildCommitmentDerivations(
    stores,
    commitments.entries,
    async () => jobs,
  );
  let summary: ProgressSummary;
  try {
    summary = summarizeProgress({
      commitments: {
        ...commitments,
        entries: commitments.entries.map((entry) => ({
          ...entry,
          respondedAt: commitmentRespondedAt(entry, repliesByConversation),
          activeManagerIds: commitmentActiveDelegationIds(entry, activeManagersByConversation),
        })),
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
 * 日誌の `github_observation` を新しい順に `GITHUB_OBSERVATION_SCAN_LIMIT + 1` 件まで読む（#2603）。
 * 「先が在る」かは読めた行の数が上限に届いたかでは決められない——pg の `list()` は SQL の `LIMIT` の
 * 後で読めない行を捨てるので、500 件を要求しても 499 件で返りうる。`scanJournalPages` は短いページを
 * 終端とみなさず、要求した件数に届くか空ページが返るまで読み継ぐ。
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
