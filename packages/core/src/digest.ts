import { providerGapsSection } from './provider-gaps.js';
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
  providerGaps?: readonly string[],
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
  // **読めない承認待ち（`unreadable`）を件数からもここからも消さない**（issue #2298）。
  // 0件のときは何も出さない（下の2か所とも `null` / 条件で出さない）。
  const unreadableApprovalNote = describeUnreadableApprovals(approvalList.unreadable);
  const pendingById = new Map(pending.map((approval) => [approval.id, approval] as const));
  // 継続中の依頼は期間で切らない。「いま何を頼まれたままか」は常に材料である
  // （これが無いと、発意 tick のたびに頼まれた仕事を思い出せるかの賭けになる）。
  const standingList = await stores.schedules.list();
  const standing = standingList.entries;
  // **読めない継続中の依頼（`unreadable`）を件数からもここからも消さない**（issue #2343）。
  // 0件のときは何も出さない（下の2か所とも `null` / 条件で出さない）。
  const unreadableStandingNote = describeUnreadableSchedules(standingList.unreadable);
  // 未了も期間で切らない。**切ると、この器の目的そのものが消える** — 24時間の窓で
  // 切れば、2日前に頼まれてまだ手を付けていない仕事だけが静かに落ちる（それは
  // いちばん落としてはいけないものである）。
  //
  // **`list()` は `{ entries, unreadable, trimmedClosed }` を返す
  // （issue #296 / #416）。** 読めない行を件数からもここからも消さないため、
  // `unreadable` を別に持ち回り、下の節へ渡す。`trimmedClosed`（保持上限を
  // 超えて物理削除された片付き行の累計）も同じ理由で持ち回る——この節を
  // 「この期間に片付けた仕事」の集計だと読む人に、fs 実装では歴史が
  // `CLOSED_HISTORY_LIMIT` を超えた時点で古い期間の集計が静かに減っている
  // ことを黙っていると、日報の材料としての信頼が静かに崩れる。
  const commitmentList = await stores.commitments.list();
  const commitments = commitmentList.entries;
  const unreadableCommitments = commitmentList.unreadable;
  const trimmedClosedCount = commitmentList.trimmedClosed;
  // **片付けたものは期間で切る。** 未了と逆で、こちらは「この期間に何を終えたか」
  // だからである（日報の「今日何をしたか」の材料になる）。切らないと、日報が
  // 過去に片付けた分を毎日並べ直すことになる。
  const settled = (await stores.commitments.list({ includeClosed: true })).entries.filter(
    (entry) =>
      entry.closedAt !== undefined &&
      // **実時刻で比べる**（#2451。文字列では `+09:00` 表記の時刻を数え違える。#3360）。
      compareIsoInstant(entry.closedAt, window.since.toISOString()) >= 0 &&
      compareIsoInstant(entry.closedAt, until.toISOString()) < 0,
  );

  // **境界を JS 側で切り直す理由。** `JournalQuery.until` は「以前＝含む」
  // （`store.ts` の `JournalQuery.until` の doc）だが、`DigestWindow.until`
  // は「含まない」（このファイル冒頭の doc）——意味が違う。クエリ側の
  // `until` は走査を早く打ち切るための粗い上限として渡し、正確な境界は
  // ここで `entry.at < untilIso` を掛けて決め直す。**二重に見えるが、
  // 片方だけでは足りない**——クエリ側を外すと OOM の本体（#1283）そのものに
  // 戻り、JS 側を外すと境界のミリ秒が1件ずれる。
  const withinWindow = (entry: JournalEntry): boolean => compareIsoInstant(entry.at, untilIso) < 0;

  // **`exchange` は別の走査にする。** `JournalQuery.with` はストアの絞りと
  // して `exchange` にしか効かない契約（`store.ts` の doc）——残り5種別と
  // 1本のクエリに混ぜると、非 exchange 行に対する `with` の意味が契約に
  // 無いまま動く形になる。**この digest はどこにも `exchange` の詳細一覧を
  // 出していない**（下の集計で使うのは件数だけ）ので、保持する配列は要らず
  // 数えるだけでよい。
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

  // **残り5種別は1本の走査にまとめる。** `with` を渡さないので、上の
  // exchange 走査を分けた理由（`with` の契約）はここには当たらない——
  // `types` だけの絞りは3実装とも「その種別だけを返す」契約
  // （`JournalQuery.types` の doc）を持つ。
  const decisionBucket =
    createRetainBucket<Extract<JournalEntry, { type: 'decision' }>>(DIGEST_RETAIN_LIMIT);
  const escalationBucket =
    createRetainBucket<Extract<JournalEntry, { type: 'escalation' }>>(DIGEST_RETAIN_LIMIT);
  const memoryUpdateBucket =
    createRetainBucket<Extract<JournalEntry, { type: 'memory_update' }>>(DIGEST_RETAIN_LIMIT);
  const externalBucket =
    createRetainBucket<Extract<JournalEntry, { type: 'external_event' }>>(DIGEST_RETAIN_LIMIT);
  /**
   * 発行元（`source`）別の**正確な**件数（issue #783）。`externalBucket` とは
   * 別の軸で有界にする——こちらはヒープに残す**行数**ではなく、追跡する
   * **source の異なり数**を `DIGEST_SOURCE_TALLY_LIMIT` で頭打ちにする
   * （`createSourceTally` の doc）。
   */
  const externalSourceTally = createSourceTally(DIGEST_SOURCE_TALLY_LIMIT);
  /**
   * ツール実行は**層で分ける**。
   *
   * クローンが自分の手で使った道具も同じ日誌へ落ちるようになった（#32）ので、
   * 1つの数にまとめると「委譲した量」として読める数がクローン自身の手の量で
   * 膨らむ（AGENTS.md「消費の層をモデル名で見分けるな ＝ 層は層の列で言う」と
   * 同じ話で、ここでの層の列は `actor` である）。**この数は digest を読む
   * クローン自身と日報の材料になるので、混ぜると委譲の判断がそのまま狂う。**
   *
   * **保持する配列は要らない。** `cloneToolUses` / `delegatedToolUses` は
   * この digest のどこにも詳細一覧を出さない（件数だけ）——だから
   * `createRetainBucket` ではなく素のカウンタでよい。
   */
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
            // **`retained` の上限の外で数える。** ここで数えなければ
            // `externalSourceTally` は保持した行だけを数えることになり、
            // `DIGEST_RETAIN_LIMIT` を超えた日に静かに retained を数える形へ
            // 戻ってしまう（このカウンタを置いた理由そのものが消える）。
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

  // **打ち切ったのは、どちらの走査でもよい。** 2本は別のクエリなので独立に
  // 打ち切りうる——どちらか一方でも打ち切っていれば、この digest の件数・
  // 一覧は「読んだ範囲のもの」になる。
  const journalScanTruncated = exchangeScan.truncated || activityScan.truncated;

  const decisions = decisionBucket.retained;
  const decisionsCount = decisionBucket.count;
  // **`approvalId` で束ねる。** 日誌は追記専用なので、1つの問いに「聞いた」
  // 行と「答えた」行が別々に積まれる（`EscalationGroup` の doc）。束ねずに
  // 行ごとに描くと、同じ問いが「未回答」と「回答あり」の両方として並ぶ。
  // **束ねた後、`at` の降順に並べ直す**（`EscalationGroup.at` の doc）。
  // `journal.list()` の既定（`order: 'desc'`）が新しい順を契約として保証
  // するので、この並べ替えは通常 no-op だが、その契約への依存をこの関数の
  // 外（`journal-order-with-contract.ts`）へ置かず、ここで明示する
  // （同 doc に詳しい理由がある）。**束ねる材料は `escalationBucket.retained`
  // ——保持の上限に当たっていれば、束ねる前の行を全部は見ていない**
  // （`ESCALATION_RETAIN_CAPPED_NOTICE` の doc）。
  const escalationGroups = groupEscalations(escalationBucket.retained).sort((a, b) =>
    b.at.localeCompare(a.at),
  );
  const escalationRetainCapped = escalationBucket.count > escalationBucket.retained.length;
  const memoryUpdates = memoryUpdateBucket.retained;
  const memoryUpdatesCount = memoryUpdateBucket.count;
  const externals = externalBucket.retained;
  const externalsCount = externalBucket.count;

  // 走行中・返事待ちは期間の外で始まったものも「いまの状態」として要る
  // （判定は `isManagerInFlight`（このファイルの上）。**`manager_list` と同じ
  // 分け方を使うため、ここに書き下ろさない**——そちらの doc を参照）。
  const inFlight = isManagerInFlight;
  // **上限で切っても「いまの状態」が落ちない順に並べる。** 材料の順序は器ごとに
  // 違う（pg は `createdAt` 昇順・fs は最終更新順・memory は挿入順）ので、並べ直さ
  // ないと、上で期間の外からわざわざ拾った走行中・返事待ちが古い `done` に押し
  // 出されて消えうる。それはこの節がやろうとしていることの逆である。
  const managers = jobs
    .filter((job) => job.updatedAt >= window.since.toISOString() || inFlight(job.status))
    .sort((a, b) => {
      if (inFlight(a.status) !== inFlight(b.status)) return inFlight(a.status) ? -1 : 1;
      return b.updatedAt.localeCompare(a.updatedAt);
    });

  // **束ねた問いの数であって、日誌の行数ではない。** 1問に「聞いた」
  // 「答えた」の2行が付くことがあるので、行数をそのまま出すと二重に数える
  // （`escalationGroups` の doc）。**escalation だけは exact なカウンタを
  // 持たない**（束ねる前の行を全部見ないと正確に数えられないため。上の
  // `escalationRetainCapped` の doc）ので、保持の上限に当たっていたときだけ
  // `ESCALATION_RETAIN_CAPPED_NOTICE` を添える——当たっていなければ、この
  // 行は直す前と1文字も変わらない。
  const escalationCountLine =
    `- エスカレーション: ${escalationGroups.length} 件` +
    (escalationRetainCapped ? ESCALATION_RETAIN_CAPPED_NOTICE : '');

  const sections: string[] = [
    `期間: ${window.since.toISOString()} 〜 ${until.toISOString()}`,
    // **打ち切ったら、冒頭ですぐに名乗る。** `期間: …` の行のすぐ後——
    // 空行より前に置く（`JOURNAL_SCAN_TRUNCATED_NOTICE` の doc）。
    ...(journalScanTruncated ? [JOURNAL_SCAN_TRUNCATED_NOTICE] : []),
    '',
    `- 人間からの発言: ${humanTurnsCount} 件`,
    `- マネージャーへの委譲（この期間に動いたもの）: ${managers.length} 本`,
    // **0件のときは行を作らない**（承認待ちの行と同じ。詳細は「マネージャー」の節）。
    ...(unreadableJobs.length === 0
      ? []
      : [`- 読めない委譲（壊れた行。上の本数には入っていない）: ${unreadableJobs.length} 件`]),
    `- 自分で決めたこと（日誌の decision）: ${decisionsCount} 件`,
    escalationCountLine,
    `- 記憶の更新: ${memoryUpdatesCount} 件`,
    // **日誌 external_event の行数であって、届いた合図の実数ではない**
    // （Issue #783）。受信箱を通った合図は配達のたびに1行書かれる —— 配り直しの
    // 回でも、畳んでターンを起こさない回でも同じ1行を書く（`clone.ts` の
    // `#journalIncomingBody` の doc。逐語は
    // `grep -Fn -- '配達のたびに書く' packages/core/src/clone.ts`）。加えて、
    // デーモンが受信箱を通さず直接書く行（source `runner` /
    // `boot-storage-footprint`。`apps/daemon/src/index.ts` と
    // `boot-footprint.ts`）も同じ型に混ざるので、「配達のたびに1行」は型全体には
    // 当てはまらない。発行元別の内訳は下の「届いた外部イベント」節にある
    // （`escalationCountLine` が「束ねた問いの数であって、日誌の行数ではない」と
    // 名乗るのと同じ形で、ここは逆に「日誌の行数であって合図の実数ではない」と
    // 名乗る）。
    //
    // **数えるのは `externalsCount`（走査で当たった全行）であって
    // `externals`（保持の上限で切られた側）ではない**（#1278 が分けた2つ）。
    // 上限に当たっている回に `externals.length` を出すと、この行が黙って
    // 少なく出る。発行元別の**正確な**内訳（保持の上限を受けない）は
    // `externalSourceTally`（`createSourceTally` の doc）が別に持つ——
    // こちらも同じ理由で `externals` からは作らない（issue #783 段2）。
    `- 外部イベント（日誌 external_event の行数）: ${externalsCount} 件`,
    `- マネージャー・作業者のツール実行: ${delegatedToolUsesCount} 件`,
    `- あなた自身が手を動かした回数（委譲せずに使った道具）: ${cloneToolUsesCount} 件`,
    `- いま人間の回答を待っているもの: ${pending.length} 件`,
    // **0件のときは行を作らない**（0 の行は「読めない行は無い」と読めるが、ここは
    // 読めない行が在ったときだけ言う。詳細は「人間の回答待ち」の節）。
    ...(approvalList.unreadable.length === 0
      ? []
      : [
          `- 読めない承認待ち（壊れた行。上の件数には入っていない）: ${approvalList.unreadable.length} 件`,
        ]),
    `- 継続中の依頼（定期の仕込み）: ${standing.length} 件`,
    // **0件のときは行を作らない**（承認待ちの行と同じ。詳細は「継続中の依頼」の節）。
    ...(standingList.unreadable.length === 0
      ? []
      : [
          `- 読めない継続中の依頼（壊れた行。上の件数には入っていない）: ${standingList.unreadable.length} 件`,
        ]),
    `- 引き受けたまま終わっていない仕事: ${commitments.length} 件`,
    // **0件でも出す**（他の行と同じ扱い）。台帳の破損は稀だが、無いことも
    // 常に言えるようにしておく（「取れない軸に0の行を作る」の逆 — ここは
    // 実際に取れている軸なので0を隠さない）。詳細は下の節（issue #296）。
    `- 読めない行（台帳が壊れている。片付いたのではない）: ${unreadableCommitments.length} 件`,
    `- この期間に片付けた仕事: ${settled.length} 件`,
    // **0件でも出す**（`unreadableCommitments` の直上の行と同じ理由）。
    // 保持上限を超えて物理削除された片付き行の累計（issue #416）。0件は
    // 「削除が起きていない」であって「数えていない」ではない（`CommitmentList`
    // の doc）。
    `- 保持上限を超えて物理削除された片付き行（累計。この記憶ストアが最初から数えている分）: ${trimmedClosedCount} 件`,
  ];

  // **読めない行が在れば、件数と一緒に節を出す（issue #296）。** `commitments`
  // （＝ `entries`）が0件でも読めない行だけは在りうるので、`commitments.length`
  // だけをこの節の出し分けの条件にしない。
  if (commitments.length > 0 || unreadableCommitments.length > 0) {
    sections.push(
      '',
      '## 引き受けたまま終わっていない仕事' +
        '（古い側と新しい側の両端。入り切らない分は真ん中を省く。' +
        '片付いたら `commitment_close` で閉じる）',
      '**順序はここには無い。** どれを先にやるかは記憶にある目的と価値観に照らして決めること。',
    );
    if (unreadableCommitments.length > 0) {
      // **件数やログではなくここでも明言する。** 「片付いたのではない」を
      // 落とすと、読めない行が静かに未了から消えたのと区別が付かなくなる
      // （`store.ts` の `CommitmentList` の doc と同じ理由）。
      const idsAll = unreadableCommitments
        .map((entry) => entry.id)
        .filter((id): id is string => id !== undefined);
      // **ここも上限を付ける。** `unreadableCommitments` は台帳の破損の度合いに
      // 比例して伸びるので、`ids.join(', ')` を無制限にすると台帳が壊れるほど
      // digest が伸びる（MAX_ITEMS で切っている他の一覧と同じ理由）。
      const ids = idsAll.slice(0, MAX_ITEMS);
      // **「commitment_list を呼べば全部出る」と書けるのは、実際に確かめたから
      // である。** `tools.ts` の `commitment_list`（id を渡さない一覧モード）が
      // 読めない行の id を出す節は `ids.join(', ')` をそのまま使っており、件数の
      // 上限を掛けていない（実装を読んで確認した。まだ上限が無い時点の話なので、
      // 後で上限が付いたらこの文言も直す必要がある）。
      // 省いた件数は、他の節と同じく**出した件数から引く**（`omitted()` の doc）。
      const idsExtra =
        idsAll.length > ids.length
          ? `（…ほか ${idsAll.length - ids.length} 件。id は commitment_list（id を指定しない一覧モード）を呼べば読めない行の id が全部出る）`
          : '';
      sections.push(
        `**読めない行が ${unreadableCommitments.length} 件ある（片付いたのではない）。**` +
          (ids.length === 0 ? '' : ` id: ${ids.join(', ')}${idsExtra}。`) +
          // **「全文が見られる」とは書かない。** `commitment_list id=<id>` の
          // 全文モードは `get(id)` が読めない行で throw するので、本文は
          // 返らない（`UnreadableCommitmentError` を捕まえて「読めない」と
          // 返すだけの3値目になる。`tools.ts` の該当箇所）。ここは実際に
          // できることだけを書く。
          '`commitment_list id=<id>` で状態は確かめられる（本文はここでは取れない）。',
      );
    }
    // **両端を出す（古い側を捨てない。かつ合計は `MAX_ITEMS` のまま）。**
    // 古い未了は「本当に放置されているもの」を見せる材料なので、件数が
    // 増えても先頭から押し出して消してはいけない。一方で、今夜作られた
    // 行が直後から1件も見えないのも困る——だから古い側と新しい側の両方を
    // 少しずつ出す。**合計を増やさない**ために、片方を増やした分は必ず
    // もう片方から削る（`oldestCount + newestCount` は常に
    // `min(commitments.length, MAX_ITEMS)` に揃う。下の算出がそれを保証する）。
    //
    // 奇数分割は古い側へ1件多く渡す（`Math.ceil`）——「古い側を捨てない」を
    // 量でも優先する判断。`commitments` は `CommitmentStore.list()` の契約に
    // より `at` 昇順（古い順）で来るので、先頭が最古・末尾が最新である。
    const oldestCount = Math.min(commitments.length, Math.ceil(MAX_ITEMS / 2));
    const newestCount = Math.min(commitments.length - oldestCount, MAX_ITEMS - oldestCount);
    const shownOldest = commitments.slice(0, oldestCount);
    // `newestCount === 0` のとき（未了が `oldestCount` 件以下）は
    // `slice(commitments.length, commitments.length)` と同値で空配列になるが、
    // 意図を読み手に残すため明示の分岐にしておく。
    const shownNewest =
      newestCount === 0 ? [] : commitments.slice(commitments.length - newestCount);
    const shownTotal = shownOldest.length + shownNewest.length;
    // **重なりを作らない。** 上の算出で `oldestCount + newestCount` は
    // `commitments.length` を超えないので、`shownOldest` と `shownNewest` の
    // 範囲（`[0, oldestCount)` と `[length-newestCount, length)`）は
    // 境界が一致するか離れるかのどちらかで、交差しない（同じ id が2回
    // 出ない）。`commitments.length <= MAX_ITEMS` のときは2範囲が隙間なく
    // 連続して全件を覆い、`commitments.length > MAX_ITEMS` のときだけ
    // 真ん中に隙間ができる。
    const renderCommitment = (entry: (typeof commitments)[number]) =>
      `- ${entry.id}（${entry.at} / ${entry.origin}${entry.source === undefined ? '' : ` / ${entry.source}`}）` +
      `\n  ${brief(entry.body)}`;
    for (const entry of shownOldest) {
      sections.push(renderCommitment(entry));
    }
    // **省いたのは古い側でも新しい側でもなく真ん中である。** 両端を出す形に
    // 変える前は「先頭から `MAX_ITEMS` 件」だったので、省かれるのは常に
    // 新しい側だった。両端を出す以上、省略の断り書きもそれに合わせて
    // 「真ん中を省いた」と言う必要がある——末尾に1行付けるだけだと「新しい側
    // の続きを省いた」に見えてしまうので、古い側の列と新しい側の列の**間**に
    // 置く（AGENTS.md `.claude/skills/listing-and-detail/SKILL.md`——
    // 「切ったなら必ず `omitted()` を通すこと」「続きの取り方を書く」）。
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
    // 黙って切らない。他の節は期間で切った一部だが、ここは「常に材料である」ことが
    // 趣旨なので、切ったことを見せないと「あるのに見えない」になる。
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
    // 束ねたグループを切る（行ではなく問いの数で MAX_ITEMS を適用する）。
    // **承認待ちキューへの個別の問い合わせ（`describeEscalationState` 内の
    // `getApproval`）は、ここで切った後の分だけに限られる**——切る前の
    // `escalationGroups` 全件に対して行うと、束ねてもなお呼び出し回数が
    // 問いの総数に比例してしまう（`describeEscalationState` の doc）。
    const shownEscalations = escalationGroups.slice(0, MAX_ITEMS);
    for (const group of shownEscalations) {
      const state = await describeEscalationState(stores, group, pendingById);
      // **行そのものに id を出す。** 依頼者の指摘どおり、直す前はここに id が
      // 一度も出ておらず、状態2の文言が「同じ id で出ている」と言いながら
      // 突き合わせる id を読み手が質問文から探すしかなかった。id の種類
      // （承認待ちキューの id か、マネージャーの requestId か）は
      // `escalationIdLabel` が journal だけから決める（store 呼び出し無し）。
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
    // ここだけは打ち切らない道具があるので「全部見える」と書ける。
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
      // `queries.ts` の `summarizeJournalEntry` と同じ言い方に揃える
      // （`action`/`cause` を1つの括弧にまとめ、バイトの注記を `/` で続ける）。
      // 単位はバイト（`schema.ts` の `bytesBefore`/`bytesAfter` の doc）。
      // `action`/`bytesBefore`/`bytesAfter` はこの区別が導入される前の
      // 古いエントリでは `undefined` — 無いことを `0` として出すと
      // 「変化が無かった」と読めてしまうので、値が無いときは「不明」と
      // 明示する（`tools.ts`/`queries.ts` と同じ扱い）。
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
    // **なぜ実数ではないか、をここでも1行で言う。** 上の件数行は単位（日誌の
    // 行数）だけを名乗り、理由はここに置く——1行を長くしすぎないための分け方
    // （行と節、両方の doc を参照）。
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

    // **発行元別の件数（正確な総数。Issue #783）。** 15,047 件がどの発行元の
    // ものかが分からなければ、そこから原因へ降りる経路が無い。既存の個別行・
    // `omitted()` の行は消さず、ここに足すだけ（`createSourceTally` の doc）。
    // **`retained` ではなく走査した全件を数えている**（`externalSourceTally`
    // は `DIGEST_RETAIN_LIMIT` の外で push している——上のコメント参照）。
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
    // **表示上限（`MAX_ITEMS`）を超えた、追跡済みの発行元を畳む。** 件数と
    // 発行元の数の両方を出す——片方だけだと「何件消えたか」「何種類消えたか」
    // のどちらかが分からなくなる。
    const foldedSourceRows = bySourceRows.slice(shownBySourceRows.length);
    if (foldedSourceRows.length > 0) {
      const foldedCount = foldedSourceRows.reduce((sum, row) => sum + row.count, 0);
      sections.push(`- その他: ${foldedCount} 件（${foldedSourceRows.length} の発行元）`);
    }
    // **上限（`DIGEST_SOURCE_TALLY_LIMIT`）を超えて現れた発行元ぶんの件数。**
    // 黙って捨てない——ただし発行元の「数」は原理的に出せない（キー数に上限を
    // 置いている以上、数えるには上限を外すしかない。`createSourceTally` の
    // doc）。この行は妥協の跡ではなく、有界であることそのものの帰結である。
    if (externalSourceTally.overflowCount > 0) {
      sections.push(
        '- 上限（`DIGEST_SOURCE_TALLY_LIMIT`）を超えて現れた発行元: ' +
          `${externalSourceTally.overflowCount} 件（発行元の数は数えていない —— ` +
          'キー数に上限を置いている以上、数えるには上限を外すしかない）',
      );
    }
    // ⚠️ **ここに「内訳が合計に届かない」注記は不要である。** `externalSourceTally`
    // は `DIGEST_RETAIN_LIMIT` の外（走査した全件）で数えているので、上の行の
    // 合計は常に `externalsCount` に一致する（`DIGEST_SOURCE_TALLY_LIMIT` に
    // 当たった分は「その他」「上限を超えて」の2行が黙らず引き受ける）。
    // 以前 main に着地した先行実装（issue #783、PR #1322）は `summarizeExternalSources`
    // （`externals`＝保持の上限で切られた側）から内訳を作っていたため、
    // 「合計が件数行に届かない」注記が要った——**この実装ではその前提が
    // 成り立たないので、その注記は復活させない**（同じ注記を残すと (b) の下では
    // 嘘になる）。

    // **本文の形（Issue #783。⚠️ ここは依頼の外で足した追加判断——`summarizeExternalSources`
    // が返す「本文の種類・最頻件数」を消さずに残すが、母数を上と分離する）。**
    // `summary` は `renderPayload` が末尾へ可変値を付けることがある実質無限の
    // 異なり数を持つ軸なので、正確な総数側（上）へは載せない——**保持した標本**
    // （`externals` = `externalBucket.retained`）を母数に明示し、別ブロックに
    // 分ける（`summarizeExternalSources` の doc）。
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

  // provider が持たない能力。空・未指定なら何も足さない（出力は変わらない）。
  const gapSection = providerGapsSection(providerGaps);
  if (gapSection.length > 0) sections.push('', ...gapSection);

  return sections.join('\n');
}

/**
 * この期間にいくら使ったか。
 *
 * **これは判断の材料である。** 委譲を続けてよいか、重い仕事をいま投げてよいかは、
 * 使った量が見えなければ勘で決めるしかない。実際に支出上限へ当たって走行中の
 * マネージャーが2本同時に落ちたことがあり、そのときクローンには事前に知る手段が
 * 無かった。日報では「どの委譲が高かったか」「どの層（クローン / マネージャー / 作業者）が
 * 高いか」が、委譲の粒度を直す材料になる。
 *
 * **取れなかったものを 0 と書かない。** 台帳が無かった期間は「記録が無い」であって
 * 「使っていない」ではない。
 */
async function usageSection(stores: Stores, since: Date, until: Date): Promise<string[]> {
  let aggregate;
  try {
    aggregate = await stores.usage.aggregate({
      from: usageDate(since),
      // 上端は含まないので 1ms 引いてから日付にする（境界の日が余分に入らない）。
      to: usageDate(new Date(until.getTime() - 1)),
    });
  } catch {
    // 台帳が読めないこと自体で digest を落とさない。ただし黙らない。
    return ['## 使った分', '（台帳を読めなかった。集計は出せない）'];
  }

  const lines = ['## 使った分'];
  // **取れなかったことは、どの分岐よりも先に書く**（Issue #3359）。消費を報告しない
  // provider のターン（#486 M7）と、読めずに外した行（#2427）は、`usage_read` が
  // 同じ関数で出している。ここで落とすと、取れなかったことが日報から消え、
  // 取れなかったターンしか無い期間が「記録は無い」と読める。無ければ空配列。
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
    // 高い順。どの層・どの委譲に効くかを先に見せる。
    const top = <T extends { totals: { costUsd: number } }>(entries: readonly T[]) =>
      [...entries].sort((a, b) => b.totals.costUsd - a.totals.costUsd).slice(0, MAX_ITEMS);
    // **合図は `usageOmitted` から取る（4軸とも同じ関数を通す）。** 超えて
    // いなければ空文字が返るので、その行には何も足さない。
    const shownModels = top(summary.byModel);
    const modelExtra = usageOmitted(summary.byModel.length, shownModels.length, 'model', '件');
    lines.push(
      `- モデル別: ${shownModels
        .map((entry) => `${entry.model} ${formatUsd(entry.totals.costUsd)}`)
        .join(' / ')}${modelExtra === '' ? '' : ` / ${modelExtra}`}`,
    );
    // **誰が**使ったか。モデル別と別に出す — `ALTEROID_CLONE_MODEL` を置けば
    // クローンとマネージャーは同じモデル帯に並び、モデル名では層を見分けられない。
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
    // **「`usage_read` で全部見える」と書かない。** あちらも軸ごとに打ち切るので
    // 嘘になる。実際に打てる手（続きを辿る呼び方）をそのまま書く——文言は
    // `usageOmitted` から取る（同じ関数を4軸とも通す理由は同関数の doc）。
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
    // **層の始点を台帳の始点と混ぜない。** 層の軸のほうが後から入ったので、それより
    // 前の行の層と場所は既定値であって観測ではない。
    lines.push(
      '- この期間の一部は層と場所の軸の始点' +
        `（${aggregate.layersSince ?? 'まだ1件も記録が無い'}）より前で、` +
        'その分の層と場所は**既定値であって観測ではない**',
    );
  }
  lines.push(`- ${aggregate.notice}`);
  return lines;
}

/**
 * 一覧に載せるための抜粋。
 *
 * **切ったことを黙らない。** 省いた分量が出ていれば、続きが要るかどうかを
 * 読んだ側が判断できる（報告の全文は `manager_report` で取れる）。
 */
function brief(value: string, limit = 200): string {
  return excerptLine(value, limit);
}
