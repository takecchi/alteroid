import { excerptLine } from './excerpt.js';
import { compareIsoInstant } from './iso-instant.js';
import { scanJournalPages } from './journal-scan.js';
// 型だけを取る: `manager.ts` との間に実行時の循環を作らないため
import type { ManagerAwaitingBackground, SessionMissingKind } from './manager.js';
import { describeScheduleSpec } from './schedule.js';
import type { Job, JobStatus, JournalEntry, PendingApproval, ScheduledRequest } from './schema.js';
import {
  UnreadableApprovalError,
  describeUnreadableApprovals,
  describeUnreadableJobs,
  describeUnreadableSchedules,
} from './store.js';
import type { Stores } from './store.js';
import {
  TASK_QUEUE_HEAD_LIMIT,
  describeTaskQueueCount,
  describeTaskQueueHead,
} from './task-tools.js';
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

// 履歴の性格の節は `MAX_ITEMS` より短くする: 次の判断の材料ではなく、毎回全文で出すと入力が嵩むため（省略の行から辿れる）
export const DIGEST_BODY_SHAPE_LIMIT = 5;

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

type TerminatedAtFields = Pick<
  Job,
  'status' | 'lease' | 'lastFailure' | 'lastSystemError' | 'lastUnreported' | 'lastReportAt'
>;

/**
 * 終端した担当が終端した時刻（ミリ秒）。取れなければ `undefined`（呼ぶ側は「新しい」側に倒す）。
 * `updatedAt` は使わない: `#persist` が終端した担当にも無条件に進める（退避・預かりの掃除・像の作り直し）ため、古い担当が毎回「新しい」に見える。
 * 代わりに `#persist` に押されない欄の最大を取る: `lease.releasedAt`（`closed` で返す）・`lastFailure.at`・`lastSystemError.at`・`lastUnreported.at`・`lastReportAt`（`report` で終端する done の印）。
 * 最大を取るのは、どれか1つだけでは足りないため: `closed(failed)` は `lastReportAt` を進めず、done は `report` で終端して貸し出しの返却を伴わない。
 * `failed` は終端そのものを刻む欄（返却・失敗・システムエラー）が1つも無ければ取れない扱い: `lastReportAt` だけでは、長く走った担当が今日落ちた回を古く見積もる。
 */
export function managerTerminatedAtMs(job: TerminatedAtFields): number | undefined {
  const stamps = [
    job.lease?.releasedAt,
    job.lastFailure?.at,
    job.lastSystemError?.at,
    job.lastUnreported?.at,
  ]
    .map((at) => (at === undefined ? Number.NaN : Date.parse(at)))
    .filter((ms) => !Number.isNaN(ms));
  if (job.status === 'failed' && stamps.length === 0) return undefined;
  const report = job.lastReportAt === undefined ? Number.NaN : Date.parse(job.lastReportAt);
  const all = Number.isNaN(report) ? stamps : [...stamps, report];
  return all.length === 0 ? undefined : Math.max(...all);
}

export type ManagerDigestFold = 'listed' | 'idle' | 'old-failed';

/**
 * 要約のマネージャーの節での扱い（#4938 の案1: 手が止まっている担当は1本ずつ出さず、本数と id だけの行に畳む）。
 * `lastFailure` 付きの done・stopped と failed は、判断の材料なので終端が窓の中なら1本ずつ出す。
 * `idle` は手が止まっている done・stopped の1行、`old-failed` は窓より前に終端した failed の1行。
 * `listed`（1本ずつ）に残すもの: 走行中・返事待ち・lost・窓の中で終端したもの・背景処理を待っているもの・終端した時刻が取れないもの。
 * 窓の判定は `updatedAt` ではなく `managerTerminatedAtMs`。
 */
export function classifyManagerForDigest(
  job: TerminatedAtFields,
  awaitingBackground: ManagerAwaitingBackground | undefined,
  since: Date,
  foldOldTerminated = true,
): ManagerDigestFold {
  if (awaitingBackground !== undefined) return 'listed';
  if (job.status !== 'done' && job.status !== 'stopped' && job.status !== 'failed') return 'listed';
  if (job.status !== 'failed' && job.lastFailure === undefined) return 'idle';
  // 窓より前に終端した担当を畳むのは #5331 から。畳まない（`ALTEROID_TOKEN_SAVING_EXCERPT` が無効）なら、失敗の印が付いた担当は終端の時刻を問わず1本ずつ出す
  if (!foldOldTerminated) return 'listed';
  const terminatedAt = managerTerminatedAtMs(job);
  if (terminatedAt === undefined || terminatedAt >= since.getTime()) return 'listed';
  return job.status === 'failed' ? 'old-failed' : 'idle';
}

/**
 * 要約の形（#4938 の案2）。`counts` は定期の依頼の tick 用で、担当の節と継続中の依頼の節だけを中身ごと出し、
 * 他の節は件数の行にまとめる。
 */
export type DigestShape = 'full' | 'counts';

export interface ActivityDigestOptions {
  /** 省略は `full`。 */
  shape?: DigestShape;
  /**
   * 履歴の節を抑える節約（#5331 の窓より前に終端した担当の畳み・#5332 の履歴系の節の上限）を掛けるか。省略は掛ける。
   * `false` は節約の前の形: 本文の形を `MAX_ITEMS` 件まで、失敗の印が付いた担当は終端の時刻を問わず1本ずつ出す。
   */
  trimHistory?: boolean;
}

/** 件数の形の要約（#4938 の案2）で、件数だけにした節の中身は道具で引けることを名乗る1行。 */
export const DIGEST_COUNTS_TOOLS_NOTE =
  '（#4938: 定期の依頼の回なので、担当と継続中の依頼のほかは件数だけにしている。中身は道具で引ける —— ' +
  '待ち行列は `task_list`、旧台帳は `commitment_list`、回答待ちは `approvals_list`、' +
  '決めたこと・エスカレーション・記憶の更新・外部イベントは `journal_read`、使った分は `usage_read`）';

/** 手が止まっている担当の行の次に出す固定の1行（依頼と直近の報告を載せていないことを名乗る）。 */
export const DIGEST_IDLE_MANAGERS_NOTE =
  '依頼と直近の報告は、ここには載せていない。`manager_list`（`q` で依頼文から探せる）/ `manager_report`（依頼文・報告の全文）で引ける。';

/**
 * 件数の形（`shape: 'counts'`）の固定の文言を、同じ会話の2回目以降は短い参照にする（#5392）。`text` は全文側の定数と1字も違わない。
 * `DIGEST_FIXED_PHRASES` とは別にする: あちらは `renderDigest`（自発の tick の差分）の対象で、件数の形は `renderDigest` を通らない（節の控えを上書きしないため）。
 */
export const DIGEST_COUNTS_FIXED_PHRASES: readonly { id: string; text: string; ref: string }[] = [
  {
    id: 'timer-counts-tools-note',
    text: DIGEST_COUNTS_TOOLS_NOTE,
    ref: '（#4938: 件数だけの節の引き口は会話の上と同じ。`task_list`・`commitment_list`・`approvals_list`・`journal_read`・`usage_read`）',
  },
  {
    id: 'timer-counts-idle-managers-note',
    text: DIGEST_IDLE_MANAGERS_NOTE,
    ref: '依頼と直近の報告は載せていない。引き口は `manager_list` / `manager_report`（会話の上と同じ）。',
  },
];

/** 継続中の依頼の節の見出しの先頭と、1件の2行目（状態の行）の前置き。節の組み立て（`standingSection`）と、定期の tick の行の畳み（`foldStandingRows`）が同じ文字列を使い、ずれないようにする。 */
export const STANDING_SECTION_HEADING_HEAD = '## 継続中の依頼';
export const STANDING_LAST_RUN_LABEL = '前回動いた時刻: ';

/**
 * 継続中の依頼の節の1件（2行）。節の組み立て（`standingSection`）と、`schedule_list` が「一覧で見せた版は定期の tick の控えと同じか」を比べる行が同じ字面を使う
 * （別々に組むと、同じ版なのに字面がずれて、控えが毎回捨てられる）。
 */
export function renderStandingRow(
  plan: Pick<ScheduledRequest, 'kind' | 'spec' | 'request' | 'lastRunAt'>,
): string {
  return (
    `- ${plan.kind}（${describeScheduleSpec(plan.spec)}）${brief(plan.request)}` +
    `\n  ${STANDING_LAST_RUN_LABEL}${plan.lastRunAt ?? '（まだ一度も動いていない）'}`
  );
}

/** 全文の要約の件数の行（先頭）。 */
export const DIGEST_COUNTS_LINE_HEAD = '- 件数: ';

// 件数の行の項目。行の組み立て（`countItem`）と、同じ会話の2回目以降の畳み（`foldDigestCountsLine`）が同じ表を使い、文言がずれないようにする
const COUNT_ITEMS: readonly { prefix: string; suffix: string }[] = [
  { prefix: '人間の発言 ', suffix: '' },
  { prefix: '回答待ち ', suffix: '' },
  { prefix: 'エスカレーション ', suffix: '' },
  { prefix: '委譲（この期間に動いた）', suffix: ' 本' },
  { prefix: '自分で決めたこと ', suffix: '' },
  { prefix: '記憶の更新 ', suffix: '' },
  { prefix: '外部イベント（日誌の行数）', suffix: '' },
  { prefix: '委譲側のツール実行 ', suffix: '' },
  { prefix: '自分の手（委譲せず使った道具）', suffix: '' },
  { prefix: '継続中の依頼 ', suffix: '' },
];

function countItem(index: number, value: number): string {
  const item = COUNT_ITEMS[index];
  if (item === undefined) throw new Error(`件数の項目が無い: ${String(index)}`);
  return `${item.prefix}${String(value)}${item.suffix}`;
}

/**
 * 件数の行（全文）を、2回目以降用の短い行にする。0 でない項目だけ名前つきで残し、0 の項目は「省いた = 0」と名乗る（位置だけの数字列にしない: 並びの読み違いを防ぐため）。
 * 行が想定の形でない・短くならないときは `null`（呼び出し側は全文のまま出す）。
 */
export function foldDigestCountsLine(line: string): string | null {
  if (!line.startsWith(DIGEST_COUNTS_LINE_HEAD)) return null;
  const parts = line.slice(DIGEST_COUNTS_LINE_HEAD.length).split(' / ');
  if (parts.length !== COUNT_ITEMS.length) return null;
  const nonZero: string[] = [];
  for (const [index, part] of parts.entries()) {
    const item = COUNT_ITEMS[index];
    if (item === undefined || !part.startsWith(item.prefix) || !part.endsWith(item.suffix)) {
      return null;
    }
    const value = part.slice(item.prefix.length, part.length - item.suffix.length);
    if (!/^\d+$/.test(value)) return null;
    if (value !== '0') nonZero.push(part);
  }
  const folded =
    nonZero.length === 0
      ? '- 件数: すべて 0（項目は会話の上の件数の行と同じ）'
      : `- 件数（項目は会話の上の件数の行と同じ。載せていない項目は 0）: ${nonZero.join(' / ')}`;
  return folded.length < line.length ? folded : null;
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

// `manager_list` が行の中の固定の一文を畳むとき、行の字面と突き合わせるために出す（字面をあちらで写さない）
export function describeReportState(state: UnobservedReportState): string {
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

// ツール実行の件数は打ち切りの外で数えているので、そのことを言う: 言わないと、窓の全部を数えた件数まで「足りないかもしれない」と読めるため
const TOOL_USE_COUNTED_IN_FULL_NOTICE =
  'ただし「ツール実行」の2つの件数は、この走査とは別に窓の全部を数えたもので、打ち切りの影響を受けない。';

const ESCALATION_RETAIN_CAPPED_NOTICE =
  '- ⚠ エスカレーションの件数は少なく出ている可能性がある（保持の上限に当たり、束ねた元の行を全部は読んでいない）';

// 以下は要約の中の固定の注記（#4937）。文言を変えずに定数へ出しただけで、`digest-session-delta.ts` が同じ会話で2回目以降を短い参照に置き換える
const EXTERNAL_EVENT_NOTE =
  'この件数は届いた合図の実数ではない —— 受信箱を通った合図は配達のたびに1行' +
  '書かれ（配り直し・畳んでターンを起こさない回も含む）、デーモンが受信箱を' +
  '通さず直接書く行（source `runner` / `boot-storage-footprint` / `boot-tool-search`）も混ざる。';
// 「使った分」の推定値の注記は、台帳の全文（`USAGE_ESTIMATE_NOTICE`）ではなく短い1行にする: 毎回同じ固定文で、全文は `usage_read` の説明と応答にある。
// 短い行は差分の対象（`DIGEST_FIXED_PHRASES`）にしない: 参照に置き換えても、参照のほうが長くなるため。「請求明細ではない」は落とさない（確定した金額に読まれるため）
const USAGE_ESTIMATE_DIGEST_LINE = '- 推定値（請求明細ではない。詳しくは `usage_read`）';
export const SOURCE_TALLY_HEADING =
  '**発行元（source）別の件数（正確な総数。上限 `DIGEST_SOURCE_TALLY_LIMIT`=' +
  `${DIGEST_SOURCE_TALLY_LIMIT} 発行元まで追跡する）**`;
const BODY_SHAPE_NOTE_TAIL =
  '「本文の種類」は `summary` の完全一致で数える（末尾に畳んだ件数などの可変値が' +
  '付くことがあるため、完全一致は同じ出来事を過大に分けうる。正規化はしていない）。';

/**
 * 同じ会話の2回目以降の要約で、短い参照に置き換える固定の注記（#4937）。`text` は上の定数と1字も違わない。
 * 要約の中で変わる値（件数・時刻・金額）を含むものは入れない。
 */
export const DIGEST_FIXED_PHRASES: readonly { id: string; text: string; ref: string }[] = [
  {
    id: 'external-event-note',
    text: EXTERNAL_EVENT_NOTE,
    ref: '（外部イベントの件数についての固定の注記は会話の上と同じ）',
  },
  {
    id: 'source-tally-heading',
    text: SOURCE_TALLY_HEADING,
    ref: '**発行元（source）別の件数**（見出しの固定の注記は会話の上と同じ）',
  },
  {
    id: 'body-shape-note',
    text: BODY_SHAPE_NOTE_TAIL,
    ref: '（本文の種類の数え方についての固定の注記は会話の上と同じ）',
  },
];

/** 行が項目の節（見出しの先頭が一致するもの）。同じ会話の2回目以降は、前回と同じ行を省く（#4937）。見出しと固定の注記は行の差分の対象外。 */
export const DIGEST_LIST_SECTION_NAMES: readonly string[] = [
  '継続中の依頼',
  'マネージャー',
  '聞かずに決めたこと',
  'エスカレーション',
  '人間の回答待ち',
  '記憶の更新',
  '届いた外部イベント',
];

/**
 * 待ち行列の先頭の節の見出しの先頭（#5469 P6b）。`digest-session-delta.ts` が同じ文字列で「この節は差分にせず毎回全文」を判定する。
 * 一覧の節（`DIGEST_LIST_SECTION_NAMES`）に入れない: 先頭の3件は「前回と同じ」と畳まず、tick のたびに目の前に出すため。
 */
export const TASK_QUEUE_SECTION_HEADING_HEAD = '## 待ち行列の先頭';

// 旧台帳に開いている行が残る間だけ出す1行（節ではなく件数だけ）。台帳の移行（P7）が済めばこの1行ごと撤去する。
// 0件でも読めない行だけは在りうるので、両方0のときだけ出さない（読めない行を 0 に丸めない）
export function describeLegacyLedgerLine(open: number, unreadable: number): string[] {
  if (open === 0 && unreadable === 0) return [];
  const unreadablePart =
    unreadable > 0 ? `読めない行が ${unreadable} 件ある（片付いたのではない）。` : '';
  return [
    `- 旧台帳に開いている ${open} 件は未了で、Task に同じ id が無い。${unreadablePart}中身は \`commitment_list\` で読む` +
      '（人間の依頼は同じ id で Task にも載り、返答で task が done になっても台帳の行は開いたままなので、数えない。数えるのは task の無い行: 人間の回答・自分の記帳・蒸留の未了の問いなど）',
  ];
}

/**
 * 旧台帳に開いている行のうち、同じ id の task が（閉じたものも含めて）無い行の数と、読めない行の数。digest の1行と発意 tick の門（`initiative-gate.ts`）が同じ数え方を使うための共有。
 * 人間の依頼は台帳と Task に同じ id で載り、返答で task だけが done になる（台帳の行は開いたまま）ので、その行は数えない。
 * 読みが失敗したら投げる（丸めない）。台帳が空なら task の全件読みは要らない。
 * #5469 P7 で台帳を撤去するときに、この関数ごと消える。
 */
export async function countLegacyOnlyOpen(
  stores: Pick<Stores, 'commitments' | 'tasks'>,
): Promise<{ readonly open: number; readonly unreadable: number }> {
  const legacyLedger = await stores.commitments.list();
  const taskIds =
    legacyLedger.entries.length === 0
      ? new Set<string>()
      : new Set((await stores.tasks.list({ includeClosed: true })).entries.map((task) => task.id));
  return {
    open: legacyLedger.entries.filter((entry) => !taskIds.has(entry.id)).length,
    unreadable: legacyLedger.unreadable.length,
  };
}

// `liveness` を必須にしない: 省略時は全件 `/セッション不明` になり、黙って「繋がっている」と名乗らないため
// `awaitingBackground` を必須にしない: 省略時は何も書き足さず、取れていないことを「手が空いている」と偽らないため
export async function buildActivityDigest(
  stores: Stores,
  window: DigestWindow,
  liveness?: ManagerLiveness,
  awaitingBackground?: ManagerAwaitingBackgroundMap,
  options: ActivityDigestOptions = {},
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
  // 継続中の依頼・待ち行列・旧台帳の未了を期間で切らない: 切ると、2日前に頼まれてまだ手を付けていない仕事だけが静かに落ちるため
  // 待ち行列は `list()` の並びのまま持つ（器は並べ直さない）。旧台帳は件数だけを使う（節は出さない）
  const taskList = await stores.tasks.list();
  const legacy = await countLegacyOnlyOpen(stores);
  const legacyLedgerLine = describeLegacyLedgerLine(legacy.open, legacy.unreadable);

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
  let routineDecisionsCount = 0;
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

  // 口が在れば `tool_use` を走査から外す: 窓の行の大半は `tool_use` で、使うのは層ごとの件数だけなのに、頁ごとに全件を本文（道具の入力）ごと運んでいたため。
  // 口の `until` は含む側なので `until` の1ms 前を渡す: `withinWindow`（`until` を含まない）と同じ答えにするため。`at` はミリ秒精度で、1ms 前までが「`until` より前」の全部になる
  const countToolUsesByActor = stores.journal.countToolUsesByActor?.bind(stores.journal);
  if (countToolUsesByActor !== undefined) {
    const counted = await countToolUsesByActor({
      since: sinceIso,
      until: new Date(until.getTime() - 1).toISOString(),
    });
    for (const { actor, count } of counted) {
      if (isCloneActor(actor)) cloneToolUsesCount += count;
      else delegatedToolUsesCount += count;
    }
  }

  const activityScan = await scanJournalPages(
    stores.journal,
    {
      types: [
        'decision',
        'escalation',
        'memory_update',
        'external_event',
        ...(countToolUsesByActor === undefined ? (['tool_use'] as const) : []),
      ],
      since: sinceIso,
      until: untilIso,
      order: 'desc',
    },
    (page) => {
      for (const entry of page) {
        if (!withinWindow(entry)) continue;
        switch (entry.type) {
          case 'decision':
            // 定型の行は保持の枠（`DIGEST_RETAIN_LIMIT`）に入れず別に数える: 判断の材料の行を押し出さないため
            if (entry.routine === true) routineDecisionsCount += 1;
            else decisionBucket.push(entry);
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
  const journalScanTruncatedNotice =
    countToolUsesByActor === undefined
      ? JOURNAL_SCAN_TRUNCATED_NOTICE
      : `${JOURNAL_SCAN_TRUNCATED_NOTICE}${TOOL_USE_COUNTED_IN_FULL_NOTICE}`;

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

  // エスカレーションは束ねた問いの数を出す（日誌の行数ではない）: 1問に「聞いた」「答えた」の2行が付くことがあり、二重に数えるため

  // 担当の節と継続中の依頼の節は、全体の形と定期の依頼の形（`counts`）で同じものを使う: 2つの形で文面がずれると、同じ担当が別の言い方で出るため
  const standingSection = (): string[] => {
    if (standing.length === 0 && unreadableStandingNote === null) return [];
    const lines = [
      '',
      `${STANDING_SECTION_HEADING_HEAD}（時刻が来れば届く。前回からの続きがあるか見ること）`,
    ];
    const shownStanding = standing.slice(0, MAX_ITEMS);
    for (const plan of shownStanding) lines.push(renderStandingRow(plan));
    if (standing.length > 0) {
      lines.push(...omitted(standing.length, shownStanding.length, '`schedule_list` で全部見える'));
    }
    if (unreadableStandingNote !== null) lines.push(`- ${unreadableStandingNote}`);
    return lines;
  };

  const managersSection = (): string[] => {
    if (managers.length === 0 && unreadableJobNote === null) return [];
    const lines = ['', '## マネージャー（走行中・返事待ちから先に出す）'];
    // #4938 の案1: 手が止まっている担当（done・stopped）は1本ずつ出さず、本数と id だけの1行に畳む
    // 窓より前に終端した failed は別の行に畳む（failed と見えるように）。窓の判定は `updatedAt` ではなく終端の時刻（`classifyManagerForDigest`）
    const foldOf = new Map(
      managers.map((job) => [
        job,
        classifyManagerForDigest(
          job,
          awaitingBackground?.get(job.id),
          window.since,
          options.trimHistory !== false,
        ),
      ]),
    );
    const foldedManagers = managers.filter((job) => foldOf.get(job) === 'idle');
    const oldFailedManagers = managers.filter((job) => foldOf.get(job) === 'old-failed');
    const listedManagers = managers.filter((job) => foldOf.get(job) === 'listed');
    const shownManagers = listedManagers.slice(0, MAX_ITEMS);
    for (const job of shownManagers) {
      lines.push(
        `- ${job.id} [${describeManagerState(job.status, liveness?.get(job.id), awaitingBackground?.get(job.id))}] ${brief(job.request ?? job.summary)}` +
          (job.lastReport === undefined ? '' : `\n  直近の報告: ${brief(job.lastReport)}`) +
          describeLastFailureLine(job.lastFailure),
      );
    }
    if (listedManagers.length > 0) {
      lines.push(
        ...omitted(
          listedManagers.length,
          shownManagers.length,
          '`manager_list` で状態を見る。あちらも入る分までで、残りの件数が本文に出る',
        ),
      );
    }
    if (foldedManagers.length > 0) {
      // id の並びにも上限を置く（一覧の節と同じ `MAX_ITEMS`）: 終わった担当が溜まるほど1行が伸びるため
      const foldedIds = foldedManagers.slice(0, MAX_ITEMS).map((job) => job.id);
      const foldedRest = foldedManagers.length - foldedIds.length;
      lines.push(
        `- 手が止まっている担当（done・stopped）${foldedManagers.length} 本: ${foldedIds.join(', ')}` +
          (foldedRest === 0 ? '' : ` …ほか ${foldedRest} 件`),
        DIGEST_IDLE_MANAGERS_NOTE,
      );
    }
    if (oldFailedManagers.length > 0) {
      const oldFailedIds = oldFailedManagers.slice(0, MAX_ITEMS).map((job) => job.id);
      const oldFailedRest = oldFailedManagers.length - oldFailedIds.length;
      lines.push(
        `- 終端して窓より前の failed ${oldFailedManagers.length} 本: ${oldFailedIds.join(', ')}` +
          (oldFailedRest === 0 ? '' : ` …ほか ${oldFailedRest} 件`),
        '失敗の中身と依頼・報告は、ここには載せていない。`manager_list`（`q` で依頼文から探せる）/ `manager_report`（依頼文・報告の全文）で引ける。',
      );
    }
    if (unreadableJobNote !== null) lines.push(`- ${unreadableJobNote}`);
    return lines;
  };

  // #4938 の案2: 定期の依頼の tick には、担当の節と継続中の依頼の節だけを中身ごと出し、他の節は件数の行にまとめる。
  // この2節を残す理由: 定期の依頼の指示（`TIMER_REQUEST_INSTRUCTIONS`）が「前回からの続きがあるかを `manager_list` で見る」で、最低限要るのがこの2節のため。
  // 依頼ごとに節を選ぶ欄は足さない: 共通の既定にする決め（2026-10-18）で、依頼の側に節の名前を覚えさせないため。
  // 件数の行に担当の status 別の数・継続中の依頼の数を重ねて載せない: 中身を出した2節と二重になり、食い違って見えるため
  if (options.shape === 'counts') {
    // 担当・継続中の依頼の読めない行は、上の2節が自分の断りを持っている。旧台帳の読めない行は旧台帳の1行が持つ
    const unreadableParts = [
      ['承認待ち', approvalList.unreadable.length],
      ['待ち行列の task', taskList.unreadable.length],
    ] as const;
    const unreadableLine = unreadableParts
      .filter(([, count]) => count > 0)
      .map(([label, count]) => `${label} ${count}`)
      .join(' / ');
    return [
      `期間: ${window.since.toISOString()} 〜 ${until.toISOString()}`,
      ...(journalScanTruncated ? [JOURNAL_SCAN_TRUNCATED_NOTICE] : []),
      ...standingSection(),
      ...managersSection(),
      '',
      `- 回答待ち ${pending.length}` +
        ` / エスカレーション ${escalationGroups.length}` +
        ` / 聞かずに決めたこと ${decisionsCount} / 記憶の更新 ${memoryUpdatesCount}` +
        ` / 外部イベント ${externalsCount}` +
        ` / 人間からの発言 ${humanTurnsCount}`,
      // 定期の依頼は仕事の一覧を前提にしない: 件数の1行だけで、先頭の描画は出さない
      `- ${describeTaskQueueCount(taskList)}`,
      ...legacyLedgerLine,
      // 0件のときは行を作らない: 0 の行は「読めない行は無い」と読めてしまうため
      ...(unreadableLine === ''
        ? []
        : [`- 読めない行（壊れた行。上の件数には入っていない）: ${unreadableLine}`]),
      DIGEST_COUNTS_TOOLS_NOTE,
    ].join('\n');
  }

  const sections: string[] = [
    `期間: ${window.since.toISOString()} 〜 ${until.toISOString()}`,
    ...(journalScanTruncated ? [journalScanTruncatedNotice] : []),
    '',
    // 件数は1行にまとめる（毎回同じ14行・約370字の枠を畳む）。0 も書く: 取れている軸の 0 は「無かった」という情報で、行ごと消すと取れていないのと区別が付かないため。
    // 次の行動のきっかけになる件数（回答待ち・エスカレーション）は先頭側に置く。`externals.length` ではなく `externalsCount` を出す: 上限に当たっている回に、黙って少なく出るため
    `${DIGEST_COUNTS_LINE_HEAD}${[
      countItem(0, humanTurnsCount),
      countItem(1, pending.length),
      countItem(2, escalationGroups.length),
      countItem(3, managers.length),
      countItem(4, decisionsCount),
      countItem(5, memoryUpdatesCount),
      countItem(6, externalsCount),
      countItem(7, delegatedToolUsesCount),
      countItem(8, cloneToolUsesCount),
      countItem(9, standing.length),
    ].join(' / ')}`,
    ...(escalationRetainCapped ? [ESCALATION_RETAIN_CAPPED_NOTICE] : []),
    // 0件のときは行を作らない: 0 の行は「読めない行は無い」と読めてしまうため
    ...(unreadableJobs.length === 0
      ? []
      : [`- 読めない委譲（壊れた行。上の本数には入っていない）: ${unreadableJobs.length} 件`]),
    ...(approvalList.unreadable.length === 0
      ? []
      : [
          `- 読めない承認待ち（壊れた行。上の件数には入っていない）: ${approvalList.unreadable.length} 件`,
        ]),
    ...(standingList.unreadable.length === 0
      ? []
      : [
          `- 読めない継続中の依頼（壊れた行。上の件数には入っていない）: ${standingList.unreadable.length} 件`,
        ]),
  ];

  // 旧台帳に開いている行が残る間だけ、件数の1行（節ではなく件数だけ）。撤去は P7
  sections.push(...legacyLedgerLine);

  // 待ち行列の先頭（#5469 P6b）。並びは `stores.tasks.list()` のまま。0件でも件数の行は出す（0 は「無かった」という情報）
  sections.push(
    '',
    TASK_QUEUE_SECTION_HEADING_HEAD,
    ...describeTaskQueueHead(taskList, { limit: TASK_QUEUE_HEAD_LIMIT }),
  );

  sections.push(...standingSection());

  sections.push(...managersSection());

  if (decisionsCount > 0 || routineDecisionsCount > 0) {
    sections.push('', '## 聞かずに決めたこと');
    const shownDecisions = decisions.slice(0, MAX_ITEMS);
    for (const entry of shownDecisions) {
      sections.push(`- ${entry.at} ${brief(entry.decision)}（根拠: ${brief(entry.grounds, 80)}）`);
    }
    sections.push(...omitted(decisionsCount, shownDecisions.length, journalWhere('decision')));
    if (routineDecisionsCount > 0) {
      sections.push(
        `（器の機構が定型で書いた記録 ${routineDecisionsCount} 件は一覧に入れていない。` +
          '`journal_read` の types=["decision"] で見える）',
      );
    }
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
    sections.push(EXTERNAL_EVENT_NOTE);
    const shownExternals = externals.slice(0, MAX_ITEMS);
    for (const entry of shownExternals) {
      sections.push(`- ${entry.source}: ${brief(entry.summary, 120)}`);
    }
    sections.push(
      ...omitted(externalsCount, shownExternals.length, journalWhere('external_event')),
    );

    sections.push('', SOURCE_TALLY_HEADING);
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
        BODY_SHAPE_NOTE_TAIL,
    );
    const bodyShapeRows = summarizeExternalSources(externals);
    const shownBodyShapeRows = bodyShapeRows.slice(
      0,
      options.trimHistory === false ? MAX_ITEMS : DIGEST_BODY_SHAPE_LIMIT,
    );
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

function isLocalMidnight(at: Date): boolean {
  return (
    at.getHours() === 0 &&
    at.getMinutes() === 0 &&
    at.getSeconds() === 0 &&
    at.getMilliseconds() === 0
  );
}

// 取れなかったものを 0 と書かない: 台帳が無かった期間は「記録が無い」であって「使っていない」ではないため
async function usageSection(stores: Stores, since: Date, until: Date): Promise<string[]> {
  const from = usageDate(since);
  // 上端は含まないので 1ms 引いてから日付にする: 境界の日が余分に入らないため
  const to = usageDate(new Date(until.getTime() - 1));
  let aggregate;
  try {
    aggregate = await stores.usage.aggregate({ from, to });
  } catch {
    return ['## 使った分', '（台帳を読めなかった。集計は出せない）'];
  }

  const lines = ['## 使った分'];
  // 日に揃わない窓（直近24時間など）では集計した日付を名乗る（#4756）: 台帳は日ごとにしか持たず、黙ると見出しの期間より広い額が期間の分として読まれるため
  if (!isLocalMidnight(since) || !isLocalMidnight(until)) {
    lines.push(
      `（台帳は日ごとに持つので、${from === to ? from : `${from}〜${to}`} の日ぶんの合計。上の期間より広い）`,
    );
  }
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
  lines.push(USAGE_ESTIMATE_DIGEST_LINE);
  return lines;
}

function brief(value: string, limit = 200): string {
  return excerptLine(value, limit);
}
