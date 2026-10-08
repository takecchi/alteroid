import { excerptLine } from './excerpt.js';
import { compareIsoInstant } from './iso-instant.js';
import { scanJournalPages } from './journal-scan.js';
// 型だけを取る: `manager.ts` との間に実行時の循環を作らないため
import type { ManagerAwaitingBackground, SessionMissingKind } from './manager.js';
import { describeScheduleSpec } from './schedule.js';
import type { Job, JobStatus, JournalEntry, PendingApproval } from './schema.js';
import {
  UnreadableApprovalError,
  describeUnreadableApprovals,
  describeUnreadableJobs,
  describeUnreadableSchedules,
} from './store.js';
import type { Stores } from './store.js';
import {
  describeUnmeteredUsage,
  describeUnreadableUsageRows,
  formatUsd,
  isCloneActor,
  summarizeUsage,
  usageDate,
} from './usage.js';

export interface DigestWindow {
  since: Date;
  // 省略時だけ 1ms 足す: たったいま書かれた記録が落ちないようにするため
  until?: Date;
}

export const MAX_ITEMS = 15;

// `MAX_ITEMS` を保持の上限にしない: `omitted()` へ渡す「実際に保持できた件数」との差を確かめる余地が無くなるため
export const DIGEST_RETAIN_LIMIT = 200;

// 走査そのものにも上限を置く: ページを読み継ぐだけでは、247万行の窓で約5,000回のクエリが走るため
// 普通の日（1万〜3万行）に当たらない桁にする: 毎日鳴る断り書きは意味を失うため
export const DIGEST_JOURNAL_SCAN_LIMIT = 100_000;

// source 別カウンタのキー数に上限を置く: source は呼び出し元が名乗る任意の文字列で、無制限だと Map が育つため
// 上限を超えた分は `overflowCount` で数え続ける: 黙って捨てないため
export const DIGEST_SOURCE_TALLY_LIMIT = 32;

export type ManagerLiveness = ReadonlyMap<string, boolean>;

// `ManagerLiveness` と別の Map にする: 1つに畳むと、片方だけ取れた回と何も取れなかった回が同じ「載っていない」になるため
export type ManagerAwaitingBackgroundMap = ReadonlyMap<string, ManagerAwaitingBackground>;

// `live` の `undefined` を `true` に倒さない: 省略した側が黙って「繋がっている」と名乗るため（否定でも肯定でもない `/セッション不明` を既定にする）
// 経過時間を作らず `since`（時刻）を渡す: 呼ぶ時刻ごとに違う文字列を返す純関数でなくなるため
export function describeManagerState(
  status: JobStatus,
  live: boolean | undefined,
  awaitingBackground?: { tasks: number; since?: string },
): string {
  const base = describeLiveState(status, live);
  // 背景タスクの内訳（`breakdown`）は載せない: 件数に比例して伸び、溜まっているときほど一覧が重くなるため
  if (awaitingBackground === undefined) return base;
  const sinceSuffix =
    awaitingBackground.since === undefined ? '' : `（${awaitingBackground.since} から）`;
  return `${base}/背景処理待ち×${awaitingBackground.tasks}${sinceSuffix}`;
}

function describeLiveState(status: JobStatus, live: boolean | undefined): string {
  if (live === true) return status;
  if (live === false) return `${status}/セッション切断`;
  return `${status}/セッション不明`;
}

// `describeManagerFailure` をそのまま呼ばない: 200文字超の定型文で、15本並べると節が膨らみ後続の節が tail-cut で押し出されるため
// `code` / `via` を `brief()` で縛る: SDK の値で長さの上限が無く、worst case が際限なく伸びるため
function describeLastFailureLine(failure: Job['lastFailure']): string {
  if (failure === undefined) return '';
  return (
    `\n  ⚠ 直近のターンは失敗で終わっている: ${brief(failure.code, 60)}` +
    `（via: ${brief(failure.via, 60)}, ${failure.at}）。` +
    '全文と次の一手は `manager_list` / `manager_report` で見る。'
  );
}

// `undefined` は空文字にする（「不明」と書かない）: 実際には2つしかない区別が3つに見えるため
export function describeSessionMissingKind(kind: SessionMissingKind | undefined): string {
  if (kind === 'resume-failed') return 'resume でも入り直せなかった。';
  if (kind === 'unlisted') return '名簿に載っていなかった。resume はまだ試していない。';
  return '';
}

// `lost` をここへ足さない（`isManagerAwaitingJudgement` を使う）: 日報は第1キーで sort して `MAX_ITEMS` で slice するので、枠を食って最近終わった委譲が押し出されるため
export function isManagerInFlight(status: JobStatus): boolean {
  return status === 'running' || status === 'waiting_human';
}

// `status === 'lost'` と直に書かず名前を付ける: 使う面が2つあり、書き下ろすと `lost` だけを見ている意味論の置き場が消えるため
export function isManagerAwaitingJudgement(status: JobStatus): boolean {
  return status === 'lost';
}

// `isManagerAwaitingJudgement` を書き換えてこれにしない: `failed` を混ぜると `manager_list` の群1（`lost`）の境界が動くため
export function isManagerOutcomeUnobserved(status: JobStatus): boolean {
  return status === 'lost' || status === 'failed';
}

export type UnobservedReportState = 'none' | 'failure-wrapped' | 'delivered';

export type JudgementRank = 0 | 1 | 2;

// 新しい値（`3`）を与えない: 群2の中に「`failed` 全部 → `done`/`stopped` 全部」という4つ目の群を黙って作るため
export const JUDGEMENT_RANK_NOT_APPLICABLE = 2 satisfies JudgementRank;

export interface UnobservedOutcomeInput {
  status: JobStatus;
  lastReport?: string;
  lastFailure?: Job['lastFailure'];
}

export interface UnobservedOutcome {
  reportState: UnobservedReportState;
  rank: JudgementRank;
}

// 順位を PR の有無で付けない: 依頼の種類によって系統的に間違える（調査だけを頼んだ委譲は PR が無くても価値が高い）ため
export function classifyUnobservedOutcome(
  manager: UnobservedOutcomeInput,
): UnobservedOutcome | null {
  if (!isManagerOutcomeUnobserved(manager.status)) return null;
  const reportState: UnobservedReportState =
    manager.lastReport === undefined
      ? 'none'
      : manager.lastFailure === undefined
        ? 'delivered'
        : 'failure-wrapped';
  const rank: JudgementRank =
    reportState === 'none' ? 0 : reportState === 'failure-wrapped' ? 1 : 2;
  return { reportState, rank };
}

function describeReportState(state: UnobservedReportState): string {
  switch (state) {
    case 'none':
      return (
        '⚠ 終端までに本文が1文字も届いていない。' +
        'この委譲が何をしたかは、この一覧からは1文字も読めない' +
        '（台帳の報告欄は一度でも届けば残る欄なので、「まだ読んでいない」ではなく「届いていない」である）。'
      );
    case 'failure-wrapped':
      return (
        '⚠ 届いている本文は runner が包んだエラー文であって報告ではない（Issue #714）。' +
        '中身を完遂の報告として読まないこと。'
      );
    case 'delivered':
      return (
        '⚠ 本文は届いているが、完遂した報告とは限らない。' +
        '終端の直前に「喋っただけの本文」がそのまま報告として出る経路が runner に在り、' +
        '台帳からはこの2つを区別できない。'
      );
  }
}

// 対象外では `null` を返す: 一覧は文字数の予算に張り付いていて、行を1本増やすと出る件数が減るため
export function describeUnobservedOutcome(manager: UnobservedOutcomeInput): string | null {
  const outcome = classifyUnobservedOutcome(manager);
  if (outcome === null) return null;
  return describeReportState(outcome.reportState);
}

interface EscalationGroup {
  approvalId: string;
  question: string;
  managerId: string | undefined;
  // 呼び出し側が `at` で明示的に並べ直す: `journal.list()` の降順の契約への暗黙の依存をこのファイルの外へ置かないため
  at: string;
  // いちばん新しい `at` の行を採る: 古い行が新しい行を上書きして answer が後退するのを防ぐため
  answeredInWindow: { answer: string; at: string } | undefined;
  withdrawnInWindow: { reason: string; at: string } | undefined;
}

function groupEscalations(
  entries: readonly Extract<JournalEntry, { type: 'escalation' }>[],
): EscalationGroup[] {
  const byId = new Map<string, EscalationGroup>();
  for (const entry of entries) {
    const existing = byId.get(entry.approvalId);
    let answeredInWindow = existing?.answeredInWindow;
    if (
      entry.answer !== undefined &&
      (answeredInWindow === undefined || compareIsoInstant(entry.at, answeredInWindow.at) > 0)
    ) {
      answeredInWindow = { answer: entry.answer, at: entry.at };
    }
    let withdrawnInWindow = existing?.withdrawnInWindow;
    if (
      entry.withdrawnAt !== undefined &&
      (withdrawnInWindow === undefined || compareIsoInstant(entry.at, withdrawnInWindow.at) > 0)
    ) {
      withdrawnInWindow = { reason: entry.withdrawnReason ?? '', at: entry.at };
    }
    byId.set(entry.approvalId, {
      approvalId: entry.approvalId,
      question: existing?.question ?? entry.question,
      managerId: existing?.managerId ?? entry.managerId,
      at:
        existing === undefined || compareIsoInstant(entry.at, existing.at) > 0
          ? entry.at
          : existing.at,
      answeredInWindow,
      withdrawnInWindow,
    });
  }
  return [...byId.values()];
}

// `managerId` の有無で id 空間を区別する: 取り違えると、読み手が別の id 空間へ同じ意味で問い合わせて空振りするため
function escalationIdLabel(group: EscalationGroup): string {
  if (group.managerId !== undefined) {
    return `requestId: ${group.approvalId}（マネージャー ${group.managerId} 発。承認待ちキューの id ではない）`;
  }
  return `id: ${group.approvalId}`;
}

// 日誌の行だけでは決めない: 窓の外で回答された場合と本当に未回答の場合を日誌だけでは区別できず、権威ある出所は承認待ちキューのため
// キューを引くのは表示する分（`MAX_ITEMS` 件まで）に絞る: キューは単調に増え、全件を毎回引くと digest 1回のコストが増えるため
// キューにも `managerId` も無い状態をどちらかへ倒さない: 判定できないという3つ目の状態として出す
async function describeEscalationState(
  stores: Stores,
  group: EscalationGroup,
  pendingById: ReadonlyMap<string, PendingApproval>,
): Promise<string> {
  if (group.answeredInWindow !== undefined) {
    return `回答: ${brief(group.answeredInWindow.answer, 80)}`;
  }
  // 取り下げを `pendingById.has` より先に確かめる: 催促する相手がいないため
  if (group.withdrawnInWindow !== undefined) {
    return `取り下げ: ${brief(group.withdrawnInWindow.reason, 80)}`;
  }
  if (pendingById.has(group.approvalId)) {
    return '未回答（承認待ちキューに在る。下の「人間の回答待ち」に同じ id で出ている）';
  }
  let approval: PendingApproval | null;
  try {
    approval = await stores.jobs.getApproval(group.approvalId);
  } catch (error) {
    // 一覧全体を落とさない: この1件だけ「在るが読めない」と出す
    if (!(error instanceof UnreadableApprovalError)) throw error;
    return '承認待ちキューに行は在るが読めない形で入っている（壊れた行。消されたのではない。回答済みかどうかも判定できない）';
  }
  if (approval !== null) {
    // 取り下げを先に見る: `withdrawnAt` の行は `answer` を持たないので、後回しにすると破損の分岐に誤って落ちるため
    if (approval.withdrawnAt !== undefined) {
      return (
        `この期間の日誌には取り下げ前の行しか無いが、承認待ちキューでは既に取り下げ済み` +
        `（この期間の外で取り下げられた）: ${brief(approval.withdrawnReason ?? '（理由の記録なし）', 80)}`
      );
    }
    const answerText =
      approval.answer === undefined
        ? '（回答の本文が無い記録——answeredAt はあるが answer が欠けている。台帳の破損の可能性がある）'
        : brief(approval.answer, 80);
    return (
      `この期間の日誌には未回答の行しか無いが、承認待ちキューでは既に回答済み` +
      `（この期間の外で回答された）: ${answerText}`
    );
  }
  if (group.managerId !== undefined) {
    return `未回答（マネージャー ${group.managerId} 発の確認。承認待ちキューには載らない設計——欠落ではない）`;
  }
  return '判定できない（承認待ちキューに見つからず、マネージャー発でもない）';
}

// `total` ではなく実際に出した件数（`shown`）から引く: 切る件数が定数から離れた日に、出した数と合図の数が食い違っても読んだ側から気づけないため
function omitted(total: number, shown: number, where: string): string[] {
  if (total <= shown) return [];
  return [`- …ほか ${total - shown} 件（${where}）`];
}

// `since` だけでなく `until` まで書く: `journal_read` も新しい順に返し、手前の最新分が `limit` を食い尽くして狙った時刻に届かないため
function journalWhere(type: JournalEntry['type']): string {
  return (
    `新しい側だけ出している。続きは \`journal_read\` に types=["${type}"] と until を渡して掘る` +
    '（あちらも予算で打ち切り、残りの件数が本文に出る）'
  );
}

function createSourceTally(maxKeys: number) {
  const counts = new Map<string, number>();
  let overflowCount = 0;
  return {
    push(source: string): void {
      const current = counts.get(source);
      if (current !== undefined) {
        counts.set(source, current + 1);
        return;
      }
      if (counts.size >= maxKeys) {
        overflowCount += 1;
        return;
      }
      counts.set(source, 1);
    },
    // 同数は source 名の昇順: `Map` の反復順は挿入順に依存し、出力の並びが実行のたびに変わるため
    get rows(): { source: string; count: number }[] {
      return Array.from(counts, ([source, count]) => ({ source, count })).sort((a, b) => {
        if (a.count !== b.count) return b.count - a.count;
        return a.source < b.source ? -1 : a.source > b.source ? 1 : 0;
      });
    },
    get overflowCount(): number {
      return overflowCount;
    },
  };
}

interface ExternalSourceBreakdown {
  source: string;
  distinctSummaries: number;
  topSummaryCount: number;
}

// `summary` を正規化して寄せない: 揺れを吸収する判定を足すほど、「何をもって同じ本文としたか」が曖昧になるため
function summarizeExternalSources(
  externals: readonly Extract<JournalEntry, { type: 'external_event' }>[],
): ExternalSourceBreakdown[] {
  const summariesBySource = new Map<string, string[]>();
  for (const entry of externals) {
    const list = summariesBySource.get(entry.source);
    if (list === undefined) summariesBySource.set(entry.source, [entry.summary]);
    else list.push(entry.summary);
  }

  const rows: ExternalSourceBreakdown[] = [];
  for (const [source, summaries] of summariesBySource) {
    const countBySummary = new Map<string, number>();
    for (const summary of summaries) {
      countBySummary.set(summary, (countBySummary.get(summary) ?? 0) + 1);
    }
    rows.push({
      source,
      distinctSummaries: countBySummary.size,
      topSummaryCount: Math.max(...countBySummary.values()),
    });
  }

  rows.sort((a, b) => {
    if (a.topSummaryCount !== b.topSummaryCount) return b.topSummaryCount - a.topSummaryCount;
    return a.source < b.source ? -1 : a.source > b.source ? 1 : 0;
  });
  return rows;
}

// 4軸ともここを通す: 値が増えた日に、ここだけ書き忘れないため
// 省いた件数は `MAX_ITEMS` ではなく実際に出した件数から引く: 定数から離れた日に、出した数と合図の数が食い違っても読んだ側から気づけないため
function usageOmitted(total: number, shown: number, axis: string, unit: string): string {
  if (total <= shown) return '';
  return (
    `…ほか ${total - shown} ${unit}` +
    // `axis` だけ渡す: 省略すれば `usage_read` は先頭から出るため
    `（\`usage_read\` に axis="${axis}" を渡すと続きから辿れる）`
  );
}

// 件数を保持配列の `.length` から取らない: 保持の上限に当たった日だけ件数が静かに減るため
function createRetainBucket<T>(retainLimit: number) {
  const retained: T[] = [];
  let count = 0;
  return {
    push(entry: T): void {
      count += 1;
      if (retained.length < retainLimit) retained.push(entry);
    },
    get count(): number {
      return count;
    },
    get retained(): readonly T[] {
      return retained;
    },
  };
}

// 件数の値を焼き込まず定数名で指す: AGENTS.md「数を生成物へ焼き込まない」に従うため
const JOURNAL_SCAN_TRUNCATED_NOTICE =
  '⚠ この期間の日誌が多く、走査を `DIGEST_JOURNAL_SCAN_LIMIT` 件で打ち切った。' +
  'これより下の件数・一覧は、日誌の新しい側から読んだ範囲のものである' +
  '（実際はもっと多い可能性がある）。新しい側から読んでいるので、新しいものは' +
  '1件も落ちていない——足りないとすれば古い側である。';

const ESCALATION_RETAIN_CAPPED_NOTICE =
  '（⚠ 束ねた元の行を全部は読んでいない。保持の上限に当たったので、この件数は少なく出ている可能性がある）';

// `liveness` を必須にしない: 省略時は全件 `/セッション不明` になり、黙って「繋がっている」と名乗らないため
// `awaitingBackground` を必須にしない: 省略時は何も書き足さず、取れていないことを「手が空いている」と偽らないため
export async function buildActivityDigest(
  stores: Stores,
  window: DigestWindow,
  liveness?: ManagerLiveness,
  awaitingBackground?: ManagerAwaitingBackgroundMap,
): Promise<string> {
  const until = window.until ?? new Date(Date.now() + 1);
  const sinceIso = window.since.toISOString();
  const untilIso = until.toISOString();

  const jobs = await stores.jobs.listJobs();
  // 読めない委譲の行（`listJobs()` が飛ばしたもの）を消さない
  const unreadableJobs = await stores.jobs.listUnreadableJobs();
  const unreadableJobNote = describeUnreadableJobs(unreadableJobs);
  // `pendingOnly` を外さない: 承認待ちキューの行を消す口が無く、全件を毎回引くと digest 1回のコストが単調に増えるため
  const approvalList = await stores.jobs.listApprovals({ pendingOnly: true });
  const pending = approvalList.entries;
  const unreadableApprovalNote = describeUnreadableApprovals(approvalList.unreadable);
  const pendingById = new Map(pending.map((approval) => [approval.id, approval] as const));
  const standingList = await stores.schedules.list();
  const standing = standingList.entries;
  const unreadableStandingNote = describeUnreadableSchedules(standingList.unreadable);
  // 継続中の依頼・未了を期間で切らない: 切ると、2日前に頼まれてまだ手を付けていない仕事だけが静かに落ちるため
  const commitmentList = await stores.commitments.list();
  const commitments = commitmentList.entries;
  const unreadableCommitments = commitmentList.unreadable;
  const trimmedClosedCount = commitmentList.trimmedClosed;
  const settled = (await stores.commitments.list({ includeClosed: true })).entries.filter(
    (entry) =>
      entry.closedAt !== undefined &&
      compareIsoInstant(entry.closedAt, window.since.toISOString()) >= 0 &&
      compareIsoInstant(entry.closedAt, until.toISOString()) < 0,
  );

  // 境界を JS 側で切り直す: `JournalQuery.until` は含む側で `DigestWindow.until` は含まない。クエリ側を外すと OOM に戻り、JS 側を外すと境界のミリ秒が1件ずれるため
  const withinWindow = (entry: JournalEntry): boolean => compareIsoInstant(entry.at, untilIso) < 0;

  // `exchange` は別の走査にする: `JournalQuery.with` は `exchange` にしか効かない契約で、他の種別と1本に混ぜると契約に無い動きになるため
  let humanTurnsCount = 0;
  const exchangeScan = await scanJournalPages(
    stores.journal,
    { types: ['exchange'], with: ['human'], since: sinceIso, until: untilIso, order: 'desc' },
    (page) => {
      for (const entry of page) {
        if (entry.type !== 'exchange' || !withinWindow(entry)) continue;
        if (entry.role === 'inbound') humanTurnsCount += 1;
      }
    },
    { maxScanned: DIGEST_JOURNAL_SCAN_LIMIT },
  );

  const decisionBucket =
    createRetainBucket<Extract<JournalEntry, { type: 'decision' }>>(DIGEST_RETAIN_LIMIT);
  const escalationBucket =
    createRetainBucket<Extract<JournalEntry, { type: 'escalation' }>>(DIGEST_RETAIN_LIMIT);
  const memoryUpdateBucket =
    createRetainBucket<Extract<JournalEntry, { type: 'memory_update' }>>(DIGEST_RETAIN_LIMIT);
  const externalBucket =
    createRetainBucket<Extract<JournalEntry, { type: 'external_event' }>>(DIGEST_RETAIN_LIMIT);
  const externalSourceTally = createSourceTally(DIGEST_SOURCE_TALLY_LIMIT);
  // ツール実行を層（`actor`）で分ける: 1つの数にまとめると、委譲した量として読める数がクローン自身の手の量で膨らみ、委譲の判断が狂うため
  let cloneToolUsesCount = 0;
  let delegatedToolUsesCount = 0;

  const activityScan = await scanJournalPages(
    stores.journal,
    {
      types: ['decision', 'escalation', 'memory_update', 'external_event', 'tool_use'],
      since: sinceIso,
      until: untilIso,
      order: 'desc',
    },
    (page) => {
      for (const entry of page) {
        if (!withinWindow(entry)) continue;
        switch (entry.type) {
          case 'decision':
            decisionBucket.push(entry);
            break;
          case 'escalation':
            escalationBucket.push(entry);
            break;
          case 'memory_update':
            memoryUpdateBucket.push(entry);
            break;
          case 'external_event':
            externalBucket.push(entry);
            // `retained` の上限の外で数える: 内側で数えると `DIGEST_RETAIN_LIMIT` を超えた日に保持した行だけを数える形に戻るため
            externalSourceTally.push(entry.source);
            break;
          case 'tool_use':
            if (isCloneActor(entry.actor)) cloneToolUsesCount += 1;
            else delegatedToolUsesCount += 1;
            break;
        }
      }
    },
    { maxScanned: DIGEST_JOURNAL_SCAN_LIMIT },
  );

  const journalScanTruncated = exchangeScan.truncated || activityScan.truncated;

  const decisions = decisionBucket.retained;
  const decisionsCount = decisionBucket.count;
  // `approvalId` で束ねる: 日誌は追記専用で、同じ問いが「未回答」と「回答あり」の両方として並ぶため
  const escalationGroups = groupEscalations(escalationBucket.retained).sort((a, b) =>
    b.at.localeCompare(a.at),
  );
  const escalationRetainCapped = escalationBucket.count > escalationBucket.retained.length;
  const memoryUpdates = memoryUpdateBucket.retained;
  const memoryUpdatesCount = memoryUpdateBucket.count;
  const externals = externalBucket.retained;
  const externalsCount = externalBucket.count;

  // `isManagerInFlight` を書き下ろさない: `manager_list` と同じ分け方を使うため
  const inFlight = isManagerInFlight;
  // 並べ直す: 材料の順序は器ごとに違い、並べ直さないと期間の外から拾った走行中・返事待ちが古い `done` に押し出されて消えうるため
  const managers = jobs
    .filter((job) => job.updatedAt >= window.since.toISOString() || inFlight(job.status))
    .sort((a, b) => {
      if (inFlight(a.status) !== inFlight(b.status)) return inFlight(a.status) ? -1 : 1;
      return b.updatedAt.localeCompare(a.updatedAt);
    });

  // 束ねた問いの数を出す（日誌の行数ではない）: 1問に「聞いた」「答えた」の2行が付くことがあり、二重に数えるため
  const escalationCountLine =
    `- エスカレーション: ${escalationGroups.length} 件` +
    (escalationRetainCapped ? ESCALATION_RETAIN_CAPPED_NOTICE : '');

  const sections: string[] = [
    `期間: ${window.since.toISOString()} 〜 ${until.toISOString()}`,
    ...(journalScanTruncated ? [JOURNAL_SCAN_TRUNCATED_NOTICE] : []),
    '',
    `- 人間からの発言: ${humanTurnsCount} 件`,
    `- マネージャーへの委譲（この期間に動いたもの）: ${managers.length} 本`,
    ...(unreadableJobs.length === 0
      ? []
      : [`- 読めない委譲（壊れた行。上の本数には入っていない）: ${unreadableJobs.length} 件`]),
    `- 自分で決めたこと（日誌の decision）: ${decisionsCount} 件`,
    escalationCountLine,
    `- 記憶の更新: ${memoryUpdatesCount} 件`,
    // `externals.length` ではなく `externalsCount` を出す: 上限に当たっている回に、この行が黙って少なく出るため
    `- 外部イベント（日誌 external_event の行数）: ${externalsCount} 件`,
    `- マネージャー・作業者のツール実行: ${delegatedToolUsesCount} 件`,
    `- あなた自身が手を動かした回数（委譲せずに使った道具）: ${cloneToolUsesCount} 件`,
    `- いま人間の回答を待っているもの: ${pending.length} 件`,
    // 0件のときは行を作らない: 0 の行は「読めない行は無い」と読めてしまうため
    ...(approvalList.unreadable.length === 0
      ? []
      : [
          `- 読めない承認待ち（壊れた行。上の件数には入っていない）: ${approvalList.unreadable.length} 件`,
        ]),
    `- 継続中の依頼（定期の仕込み）: ${standing.length} 件`,
    ...(standingList.unreadable.length === 0
      ? []
      : [
          `- 読めない継続中の依頼（壊れた行。上の件数には入っていない）: ${standingList.unreadable.length} 件`,
        ]),
    `- 引き受けたまま終わっていない仕事: ${commitments.length} 件`,
    // 0件でも出す: 実際に取れている軸なので0を隠さない
    `- 読めない行（台帳が壊れている。片付いたのではない）: ${unreadableCommitments.length} 件`,
    `- この期間に片付けた仕事: ${settled.length} 件`,
    `- 保持上限を超えて物理削除された片付き行（累計。この記憶ストアが最初から数えている分）: ${trimmedClosedCount} 件`,
  ];

  // `commitments.length` だけを出し分けの条件にしない: 0件でも読めない行だけは在りうるため
  if (commitments.length > 0 || unreadableCommitments.length > 0) {
    sections.push(
      '',
      '## 引き受けたまま終わっていない仕事' +
        '（古い側と新しい側の両端。入り切らない分は真ん中を省く。' +
        '片付いたら `commitment_close` で閉じる）',
      '**順序はここには無い。** どれを先にやるかは記憶にある目的と価値観に照らして決めること。',
    );
    if (unreadableCommitments.length > 0) {
      // 「片付いたのではない」を落とさない: 落とすと、読めない行が静かに未了から消えたのと区別が付かなくなるため
      const idsAll = unreadableCommitments
        .map((entry) => entry.id)
        .filter((id): id is string => id !== undefined);
      // id の列にも上限を付ける: 台帳が壊れるほど digest が伸びるため
      const ids = idsAll.slice(0, MAX_ITEMS);
      const idsExtra =
        idsAll.length > ids.length
          ? `（…ほか ${idsAll.length - ids.length} 件。id は commitment_list（id を指定しない一覧モード）を呼べば読めない行の id が全部出る）`
          : '';
      sections.push(
        `**読めない行が ${unreadableCommitments.length} 件ある（片付いたのではない）。**` +
          (ids.length === 0 ? '' : ` id: ${ids.join(', ')}${idsExtra}。`) +
          // 「全文が見られる」と書かない: `commitment_list id=<id>` は読めない行で本文を返さないため
          '`commitment_list id=<id>` で状態は確かめられる（本文はここでは取れない）。',
      );
    }
    // 両端を出す（合計は `MAX_ITEMS` のまま）: 古い未了を押し出すと放置されているものが見えず、新しい側が1件も見えないのも困るため
    const oldestCount = Math.min(commitments.length, Math.ceil(MAX_ITEMS / 2));
    const newestCount = Math.min(commitments.length - oldestCount, MAX_ITEMS - oldestCount);
    const shownOldest = commitments.slice(0, oldestCount);
    const shownNewest =
      newestCount === 0 ? [] : commitments.slice(commitments.length - newestCount);
    const shownTotal = shownOldest.length + shownNewest.length;
    const renderCommitment = (entry: (typeof commitments)[number]) =>
      `- ${entry.id}（${entry.at} / ${entry.origin}${entry.source === undefined ? '' : ` / ${entry.source}`}）` +
      `\n  ${brief(entry.body)}`;
    for (const entry of shownOldest) {
      sections.push(renderCommitment(entry));
    }
    // 省略の断り書きは古い側と新しい側の列の間に置く: 末尾に置くと「新しい側の続きを省いた」に見えるため
    sections.push(
      ...omitted(
        commitments.length,
        shownTotal,
        '真ん中を省いている。`commitment_list`（古い順で辿れる）でその区間も見られる。' +
          'あちらも入る分までで、残りの件数が本文に出る',
      ),
    );
    for (const entry of shownNewest) {
      sections.push(renderCommitment(entry));
    }
  }

  if (standing.length > 0 || unreadableStandingNote !== null) {
    sections.push('', '## 継続中の依頼（時刻が来れば届く。前回からの続きがあるか見ること）');
    const shownStanding = standing.slice(0, MAX_ITEMS);
    for (const plan of shownStanding) {
      sections.push(
        `- ${plan.kind}（${describeScheduleSpec(plan.spec)}）${brief(plan.request)}` +
          `\n  前回動いた時刻: ${plan.lastRunAt ?? '（まだ一度も動いていない）'}`,
      );
    }
    if (standing.length > 0) {
      sections.push(
        ...omitted(standing.length, shownStanding.length, '`schedule_list` で全部見える'),
      );
    }
    if (unreadableStandingNote !== null) sections.push(`- ${unreadableStandingNote}`);
  }

  if (settled.length > 0) {
    sections.push('', '## この期間に片付けた仕事');
    const shownSettled = settled.slice(0, MAX_ITEMS);
    for (const entry of shownSettled) {
      sections.push(
        `- ${brief(entry.body, 120)}\n  片付いたとした理由: ${brief(entry.closedReason ?? '', 120)}`,
      );
    }
    sections.push(
      ...omitted(
        settled.length,
        shownSettled.length,
        '`commitment_list` に includeClosed=true を渡すと辿れる',
      ),
    );
  }

  if (managers.length > 0 || unreadableJobNote !== null) {
    sections.push('', '## マネージャー（走行中・返事待ちから先に出す）');
    const shownManagers = managers.slice(0, MAX_ITEMS);
    for (const job of shownManagers) {
      sections.push(
        `- ${job.id} [${describeManagerState(job.status, liveness?.get(job.id), awaitingBackground?.get(job.id))}] ${brief(job.request ?? job.summary)}` +
          (job.lastReport === undefined ? '' : `\n  直近の報告: ${brief(job.lastReport)}`) +
          describeLastFailureLine(job.lastFailure),
      );
    }
    if (managers.length > 0) {
      sections.push(
        ...omitted(
          managers.length,
          shownManagers.length,
          '`manager_list` で状態を見る。あちらも入る分までで、残りの件数が本文に出る',
        ),
      );
    }
    if (unreadableJobNote !== null) sections.push(`- ${unreadableJobNote}`);
  }

  if (decisionsCount > 0) {
    sections.push('', '## 聞かずに決めたこと');
    const shownDecisions = decisions.slice(0, MAX_ITEMS);
    for (const entry of shownDecisions) {
      sections.push(`- ${entry.at} ${brief(entry.decision)}（根拠: ${brief(entry.grounds, 80)}）`);
    }
    sections.push(...omitted(decisionsCount, shownDecisions.length, journalWhere('decision')));
  }

  if (escalationGroups.length > 0) {
    sections.push('', '## エスカレーション');
    // 切った後の分だけ `getApproval` を引く: 切る前の全件に行うと、呼び出し回数が問いの総数に比例するため
    const shownEscalations = escalationGroups.slice(0, MAX_ITEMS);
    for (const group of shownEscalations) {
      const state = await describeEscalationState(stores, group, pendingById);
      // 行そのものに id を出す: 状態の文言が「同じ id で出ている」と言うので、突き合わせる id を読み手が質問文から探すことになるため
      sections.push(`- ${brief(group.question)} → ${state}（${escalationIdLabel(group)}）`);
    }
    sections.push(
      ...omitted(escalationGroups.length, shownEscalations.length, journalWhere('escalation')),
    );
  }

  if (pending.length > 0 || unreadableApprovalNote !== null) {
    sections.push('', '## 人間の回答待ち（保留中。他の仕事は進めてよい）');
    const shownPending = pending.slice(0, MAX_ITEMS);
    for (const approval of shownPending) {
      sections.push(
        `- ${approval.id}（${approval.createdAt}）${brief(approval.question)}` +
          (approval.jobId === undefined ? '' : ` [マネージャー ${approval.jobId}]`),
      );
    }
    // 「全部見える」と書く: `approvals_list` は打ち切らないため
    if (pending.length > 0) {
      sections.push(
        ...omitted(pending.length, shownPending.length, '`approvals_list` で全部見える'),
      );
    }
    if (unreadableApprovalNote !== null) sections.push(`- ${unreadableApprovalNote}`);
  }

  if (memoryUpdatesCount > 0) {
    sections.push('', '## 記憶の更新');
    const shownMemoryUpdates = memoryUpdates.slice(0, MAX_ITEMS);
    for (const entry of shownMemoryUpdates) {
      // 無いバイト数を `0` として出さない: 「変化が無かった」と読めてしまうため
      const action = entry.action === undefined ? '' : `/${entry.action}`;
      const bytes =
        entry.bytesBefore === undefined || entry.bytesAfter === undefined
          ? '前後バイト数不明（旧形式）'
          : `${entry.bytesBefore}→${entry.bytesAfter} バイト`;
      sections.push(
        `- ${entry.slug}（${entry.cause}${action} / ${bytes}）${brief(entry.summary, 120)}`,
      );
    }
    sections.push(
      ...omitted(memoryUpdatesCount, shownMemoryUpdates.length, journalWhere('memory_update')),
    );
  }

  if (externalsCount > 0) {
    sections.push('', '## 届いた外部イベント');
    sections.push(
      'この件数は届いた合図の実数ではない —— 受信箱を通った合図は配達のたびに1行' +
        '書かれ（配り直し・畳んでターンを起こさない回も含む）、デーモンが受信箱を' +
        '通さず直接書く行（source `runner` / `boot-storage-footprint`）も混ざる。',
    );
    const shownExternals = externals.slice(0, MAX_ITEMS);
    for (const entry of shownExternals) {
      sections.push(`- ${entry.source}: ${brief(entry.summary, 120)}`);
    }
    sections.push(
      ...omitted(externalsCount, shownExternals.length, journalWhere('external_event')),
    );

    sections.push(
      '',
      '**発行元（source）別の件数（正確な総数。上限 `DIGEST_SOURCE_TALLY_LIMIT`=' +
        `${DIGEST_SOURCE_TALLY_LIMIT} 発行元まで追跡する）**`,
    );
    const bySourceRows = externalSourceTally.rows;
    const shownBySourceRows = bySourceRows.slice(0, MAX_ITEMS);
    for (const row of shownBySourceRows) {
      sections.push(`- ${row.source}: ${row.count} 件`);
    }
    // 畳むときは件数と発行元の数の両方を出す: 片方だけだと「何件消えたか」「何種類消えたか」のどちらかが分からなくなるため
    const foldedSourceRows = bySourceRows.slice(shownBySourceRows.length);
    if (foldedSourceRows.length > 0) {
      const foldedCount = foldedSourceRows.reduce((sum, row) => sum + row.count, 0);
      sections.push(`- その他: ${foldedCount} 件（${foldedSourceRows.length} の発行元）`);
    }
    if (externalSourceTally.overflowCount > 0) {
      sections.push(
        '- 上限（`DIGEST_SOURCE_TALLY_LIMIT`）を超えて現れた発行元: ' +
          `${externalSourceTally.overflowCount} 件（発行元の数は数えていない —— ` +
          'キー数に上限を置いている以上、数えるには上限を外すしかない）',
      );
    }
    // 本文の形は正確な総数側へ載せず、母数を明示した別ブロックにする: `summary` は可変値が付いて実質無限の異なり数を持つため
    sections.push(
      '',
      `**本文の形（保持した ${externals.length} 件の標本。上の件数とは母数が違う）** —— ` +
        '「本文の種類」は `summary` の完全一致で数える（末尾に畳んだ件数などの可変値が' +
        '付くことがあるため、完全一致は同じ出来事を過大に分けうる。正規化はしていない）。',
    );
    const bodyShapeRows = summarizeExternalSources(externals);
    const shownBodyShapeRows = bodyShapeRows.slice(0, MAX_ITEMS);
    for (const row of shownBodyShapeRows) {
      sections.push(
        `- ${row.source}: 同じ本文は ${row.distinctSummaries} 種。` +
          `最も多い1種が ${row.topSummaryCount} 件`,
      );
    }
    sections.push(
      ...omitted(
        bodyShapeRows.length,
        shownBodyShapeRows.length,
        `${journalWhere('external_event')}（source では絞れない。読み出した行を自分で ` +
          'source ごとに数える。ここは保持した標本の中の発行元数であって、総数ではない）',
      ),
    );
  }

  sections.push('', ...(await usageSection(stores, window.since, until)));

  return sections.join('\n');
}

// 取れなかったものを 0 と書かない: 台帳が無かった期間は「記録が無い」であって「使っていない」ではないため
async function usageSection(stores: Stores, since: Date, until: Date): Promise<string[]> {
  let aggregate;
  try {
    aggregate = await stores.usage.aggregate({
      from: usageDate(since),
      // 上端は含まないので 1ms 引いてから日付にする: 境界の日が余分に入らないため
      to: usageDate(new Date(until.getTime() - 1)),
    });
  } catch {
    return ['## 使った分', '（台帳を読めなかった。集計は出せない）'];
  }

  const lines = ['## 使った分'];
  // 取れなかったことをどの分岐よりも先に書く: 落とすと、取れなかったターンしか無い期間が「記録は無い」と読めるため
  const unreadableLines = describeUnreadableUsageRows(aggregate.unreadableRows);
  const unmeteredLines = describeUnmeteredUsage(aggregate.unmeteredRows);
  const gapLines = [...unreadableLines, ...unmeteredLines];
  lines.push(...gapLines);
  if (aggregate.since === null) {
    lines.push(
      gapLines.length > 0
        ? '（消費の金額の記録がまだ無い。この機能を入れる前の分は残っていない）'
        : '（台帳にまだ記録が無い。この機能を入れる前の分は残っていない）',
    );
    return lines;
  }

  const summary = summarizeUsage(aggregate.rows, aggregate.turnRows);
  if (aggregate.rows.length === 0) {
    lines.push(
      gapLines.length > 0 ? 'この期間、消費の金額を取れた記録は無い。' : 'この期間の記録は無い。',
    );
  } else {
    lines.push(`- 合計: ${formatUsd(summary.total.costUsd)}`);
    lines.push(
      `- 出力トークン: ${summary.total.outputTokens.toLocaleString('en-US')} / ` +
        `入力: ${summary.total.inputTokens.toLocaleString('en-US')} / ` +
        `キャッシュ読み: ${summary.total.cacheReadInputTokens.toLocaleString('en-US')}`,
    );
    const top = <T extends { totals: { costUsd: number } }>(entries: readonly T[]) =>
      [...entries].sort((a, b) => b.totals.costUsd - a.totals.costUsd).slice(0, MAX_ITEMS);
    const shownModels = top(summary.byModel);
    const modelExtra = usageOmitted(summary.byModel.length, shownModels.length, 'model', '件');
    lines.push(
      `- モデル別: ${shownModels
        .map((entry) => `${entry.model} ${formatUsd(entry.totals.costUsd)}`)
        .join(' / ')}${modelExtra === '' ? '' : ` / ${modelExtra}`}`,
    );
    // モデル別と別に層別を出す: `ALTEROID_CLONE_MODEL` を置けばクローンとマネージャーが同じモデル帯に並び、モデル名では層を見分けられないため
    const shownLayers = top(summary.byLayer);
    const layerExtra = usageOmitted(summary.byLayer.length, shownLayers.length, 'layer', '件');
    lines.push(
      `- 層別（誰が）: ${shownLayers
        .map((entry) => `${entry.layer} ${formatUsd(entry.totals.costUsd)}`)
        .join(' / ')}${layerExtra === '' ? '' : ` / ${layerExtra}`}`,
    );
    const shownSites = top(summary.bySite);
    const siteExtra = usageOmitted(summary.bySite.length, shownSites.length, 'site', '件');
    lines.push(
      `- 場所別（どこで）: ${shownSites
        .map((entry) => `${entry.site} ${formatUsd(entry.totals.costUsd)}`)
        .join(' / ')}${siteExtra === '' ? '' : ` / ${siteExtra}`}`,
    );
    lines.push('- 高かった委譲:');
    const shownManagers = top(summary.byManager);
    for (const entry of shownManagers) {
      lines.push(`  - ${entry.managerId}: ${formatUsd(entry.totals.costUsd)}`);
    }
    // 「`usage_read` で全部見える」と書かない: `usage_read` も軸ごとに打ち切るので嘘になるため
    const managerExtra = usageOmitted(
      summary.byManager.length,
      shownManagers.length,
      'manager',
      '本',
    );
    if (managerExtra !== '') lines.push(`  - ${managerExtra}`);
  }

  if (aggregate.beforeLedger) {
    lines.push(
      `- この期間の一部は台帳の始点（${aggregate.since}）より前で、**記録が無い**（0 ではない）`,
    );
  }
  if (aggregate.beforeLayers) {
    // 層の始点を台帳の始点と混ぜない: 層の軸のほうが後から入り、それより前の行の層と場所は既定値であって観測ではないため
    lines.push(
      '- この期間の一部は層と場所の軸の始点' +
        `（${aggregate.layersSince ?? 'まだ1件も記録が無い'}）より前で、` +
        'その分の層と場所は**既定値であって観測ではない**',
    );
  }
  lines.push(`- ${aggregate.notice}`);
  return lines;
}

function brief(value: string, limit = 200): string {
  return excerptLine(value, limit);
}
