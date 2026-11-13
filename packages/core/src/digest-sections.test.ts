import { describe, expect, it } from 'vitest';

import {
  DIGEST_COUNTS_LINE_HEAD,
  DIGEST_COUNTS_TOOLS_NOTE,
  MAX_ITEMS,
  STANDING_SECTION_HEADING_HEAD,
  TASK_QUEUE_SECTION_HEADING_HEAD,
  describeManagerState,
  renderCountsDigest,
  renderDigestOpening,
  renderEscalationSection,
  renderManagersSection,
  renderStandingRow,
  renderStandingSection,
  renderTaskQueueSection,
} from './digest.js';
import type {
  CountsDigestInput,
  DigestOpeningInput,
  EscalationGroup,
  ManagersSectionInput,
} from './digest.js';
import { excerptLine } from './excerpt.js';
import type { ManagerAwaitingBackground } from './manager.js';
import type { Job, JournalEntry, ScheduledRequest, Task } from './schema.js';
import type { TaskList } from './store.js';
import { describeTaskQueueHead, TASK_QUEUE_HEAD_LIMIT } from './task-tools.js';

// B1（`buildActivityDigest` の節ごとの切り出し）の純関数が、切り出し前の式と 1 文字も違わないことの歯。
// 「移し替えで 1 文字も変えていない」ことの歯であって、文面の正しさの保証ではない（文面そのものは digest-full-text-pin.test.ts が全文で固定している）。
// 下の `legacy*` は、切り出し前の `buildActivityDigest` の局所クロージャ・式の写しである。
// `window.since` → `since`、`options.trimHistory !== false` → `foldOldTerminated` のように、局所の変数を引数の名前に置き換えただけで、式は変えていない。
// 切り出しの対象でない非公開の道具（`brief` / `omitted` / `journalWhere` / `classifyManagerForDigest` ほか）は、そのまま写してここに持つ
// （これらは切り出し前から動いていない。写しが本体と食い違ったら、それは別の変更である）。

// --- 旧式の写し ---

const OLD_DIGEST_IDLE_MANAGERS_NOTE =
  '依頼と直近の報告は、ここには載せていない。`manager_list`（`q` で依頼文から探せる）/ `manager_report`（依頼文・報告の全文）で引ける。';

const OLD_ESCALATION_RETAIN_CAPPED_NOTICE =
  '- ⚠ エスカレーションの件数は少なく出ている可能性がある（保持の上限に当たり、束ねた元の行を全部は読んでいない）';

const OLD_JOURNAL_SCAN_TRUNCATED_NOTICE =
  '⚠ この期間の日誌が多く、走査を `DIGEST_JOURNAL_SCAN_LIMIT` 件で打ち切った。' +
  'これより下の件数・一覧は、日誌の新しい側から読んだ範囲のものである' +
  '（実際はもっと多い可能性がある）。新しい側から読んでいるので、新しいものは' +
  '1件も落ちていない——足りないとすれば古い側である。';

const OLD_COUNT_ITEMS: readonly { prefix: string; suffix: string }[] = [
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

function oldCountItem(index: number, value: number): string {
  const item = OLD_COUNT_ITEMS[index];
  if (item === undefined) throw new Error(`件数の項目が無い: ${String(index)}`);
  return `${item.prefix}${String(value)}${item.suffix}`;
}

function oldBrief(value: string, limit = 200): string {
  return excerptLine(value, limit);
}

function oldOmitted(total: number, shown: number, where: string): string[] {
  if (total <= shown) return [];
  return [`- …ほか ${total - shown} 件（${where}）`];
}

function oldJournalWhere(type: JournalEntry['type']): string {
  return (
    `新しい側だけ出している。続きは \`journal_read\` に types=["${type}"] と until を渡して掘る` +
    '（あちらも予算で打ち切り、残りの件数が本文に出る）'
  );
}

function oldDescribeLastFailureLine(failure: Job['lastFailure']): string {
  if (failure === undefined) return '';
  return (
    `\n  ⚠ 直近のターンは失敗で終わっている: ${oldBrief(failure.code, 60)}` +
    `（via: ${oldBrief(failure.via, 60)}, ${failure.at}）。` +
    '全文と次の一手は `manager_list` / `manager_report` で見る。'
  );
}

function oldManagerTerminatedAtMs(job: Job): number | undefined {
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

function oldClassifyManagerForDigest(
  job: Job,
  awaitingBackground: ManagerAwaitingBackground | undefined,
  since: Date,
  foldOldTerminated = true,
): 'listed' | 'idle' | 'old-failed' {
  if (awaitingBackground !== undefined) return 'listed';
  if (job.status !== 'done' && job.status !== 'stopped' && job.status !== 'failed') return 'listed';
  if (job.status !== 'failed' && job.lastFailure === undefined) return 'idle';
  if (!foldOldTerminated) return 'listed';
  const terminatedAt = oldManagerTerminatedAtMs(job);
  if (terminatedAt === undefined || terminatedAt >= since.getTime()) return 'listed';
  return job.status === 'failed' ? 'old-failed' : 'idle';
}

function oldEscalationIdLabel(group: EscalationGroup): string {
  if (group.managerId !== undefined) {
    return `requestId: ${group.approvalId}（マネージャー ${group.managerId} 発。承認待ちキューの id ではない）`;
  }
  return `id: ${group.approvalId}`;
}

/** 切り出し前の `standingSection`（局所クロージャ）。 */
function legacyStandingSection(
  standing: readonly ScheduledRequest[],
  unreadableStandingNote: string | null,
): string[] {
  if (standing.length === 0 && unreadableStandingNote === null) return [];
  const lines = [
    '',
    `${STANDING_SECTION_HEADING_HEAD}（時刻が来れば届く。前回からの続きがあるか見ること）`,
  ];
  const shownStanding = standing.slice(0, MAX_ITEMS);
  for (const plan of shownStanding) lines.push(renderStandingRow(plan));
  if (standing.length > 0) {
    lines.push(
      ...oldOmitted(standing.length, shownStanding.length, '`schedule_list` で全部見える'),
    );
  }
  if (unreadableStandingNote !== null) lines.push(`- ${unreadableStandingNote}`);
  return lines;
}

/** 切り出し前の `managersSection`（局所クロージャ）。 */
function legacyManagersSection(input: ManagersSectionInput): string[] {
  const managers = input.managers;
  const unreadableJobNote = input.unreadableJobNote;
  const liveness = input.liveness;
  const awaitingBackground = input.awaitingBackground;
  const since = input.since;
  if (managers.length === 0 && unreadableJobNote === null) return [];
  const lines = ['', '## マネージャー（走行中・返事待ちから先に出す）'];
  const foldOf = new Map(
    managers.map((job) => [
      job,
      oldClassifyManagerForDigest(
        job,
        awaitingBackground?.get(job.id),
        since,
        input.foldOldTerminated,
      ),
    ]),
  );
  const foldedManagers = managers.filter((job) => foldOf.get(job) === 'idle');
  const oldFailedManagers = managers.filter((job) => foldOf.get(job) === 'old-failed');
  const listedManagers = managers.filter((job) => foldOf.get(job) === 'listed');
  const shownManagers = listedManagers.slice(0, MAX_ITEMS);
  for (const job of shownManagers) {
    lines.push(
      `- ${job.id} [${describeManagerState(job.status, liveness?.get(job.id), awaitingBackground?.get(job.id))}] ${oldBrief(job.request ?? job.summary)}` +
        (job.lastReport === undefined ? '' : `\n  直近の報告: ${oldBrief(job.lastReport)}`) +
        oldDescribeLastFailureLine(job.lastFailure),
    );
  }
  if (listedManagers.length > 0) {
    lines.push(
      ...oldOmitted(
        listedManagers.length,
        shownManagers.length,
        '`manager_list` で状態を見る。あちらも入る分までで、残りの件数が本文に出る',
      ),
    );
  }
  if (foldedManagers.length > 0) {
    const foldedIds = foldedManagers.slice(0, MAX_ITEMS).map((job) => job.id);
    const foldedRest = foldedManagers.length - foldedIds.length;
    lines.push(
      `- 手が止まっている担当（done・stopped）${foldedManagers.length} 本: ${foldedIds.join(', ')}` +
        (foldedRest === 0 ? '' : ` …ほか ${foldedRest} 件`),
      OLD_DIGEST_IDLE_MANAGERS_NOTE,
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
}

/** 切り出し前の全体の形の先頭（`const sections: string[] = [...]`）。 */
function legacyOpening(input: DigestOpeningInput): string[] {
  const since = input.since;
  const until = input.until;
  // 旧式は「打ち切ったか」の真偽と、名乗りの文を別々の局所変数で持っていた
  const journalScanTruncated = input.journalScanTruncatedNotice !== undefined;
  const journalScanTruncatedNotice = input.journalScanTruncatedNotice ?? '';
  const escalationRetainCapped = input.escalationRetainCapped;
  return [
    `期間: ${since.toISOString()} 〜 ${until.toISOString()}`,
    ...(journalScanTruncated ? [journalScanTruncatedNotice] : []),
    '',
    `${DIGEST_COUNTS_LINE_HEAD}${[
      oldCountItem(0, input.counts.humanTurns),
      oldCountItem(1, input.counts.pending),
      oldCountItem(2, input.counts.escalations),
      oldCountItem(3, input.counts.managers),
      oldCountItem(4, input.counts.decisions),
      oldCountItem(5, input.counts.memoryUpdates),
      oldCountItem(6, input.counts.externals),
      oldCountItem(7, input.counts.delegatedToolUses),
      oldCountItem(8, input.counts.cloneToolUses),
      oldCountItem(9, input.counts.standing),
    ].join(' / ')}`,
    ...(escalationRetainCapped ? [OLD_ESCALATION_RETAIN_CAPPED_NOTICE] : []),
    ...(input.unreadable.jobs === 0
      ? []
      : [`- 読めない委譲（壊れた行。上の本数には入っていない）: ${input.unreadable.jobs} 件`]),
    ...(input.unreadable.approvals === 0
      ? []
      : [
          `- 読めない承認待ち（壊れた行。上の件数には入っていない）: ${input.unreadable.approvals} 件`,
        ]),
    ...(input.unreadable.schedules === 0
      ? []
      : [
          `- 読めない継続中の依頼（壊れた行。上の件数には入っていない）: ${input.unreadable.schedules} 件`,
        ]),
  ];
}

/** 切り出し前の待ち行列の先頭の `sections.push(...)`。 */
function legacyTaskQueue(taskList: TaskList, nowMs: number): string[] {
  const sections: string[] = [];
  sections.push(
    '',
    TASK_QUEUE_SECTION_HEADING_HEAD,
    ...describeTaskQueueHead(taskList, { limit: TASK_QUEUE_HEAD_LIMIT, nowMs }),
  );
  return sections;
}

/** 切り出し前のエスカレーションの節（`if (escalationGroups.length > 0) {…}`）。状態の文は台帳を引いて作るので、引いた後の値を渡す。 */
function legacyEscalation(
  escalationGroups: readonly EscalationGroup[],
  stateOf: (group: EscalationGroup) => string,
): string[] {
  const sections: string[] = [];
  if (escalationGroups.length > 0) {
    sections.push('', '## エスカレーション');
    const shownEscalations = escalationGroups.slice(0, MAX_ITEMS);
    for (const group of shownEscalations) {
      const state = stateOf(group);
      sections.push(`- ${oldBrief(group.question)} → ${state}（${oldEscalationIdLabel(group)}）`);
    }
    sections.push(
      ...oldOmitted(
        escalationGroups.length,
        shownEscalations.length,
        oldJournalWhere('escalation'),
      ),
    );
  }
  return sections;
}

/** 切り出し前の `options.shape === 'counts'` の `return [...].join('\n')`。 */
function legacyCountsDigest(input: CountsDigestInput): string {
  const window = { since: input.since };
  const until = input.until;
  const journalScanTruncated = input.journalScanTruncated;
  const pending = { length: input.pending };
  const escalationGroups = { length: input.escalations };
  const decisionsCount = input.decisions;
  const memoryUpdatesCount = input.memoryUpdates;
  const externalsCount = input.externals;
  const humanTurnsCount = input.humanTurns;
  const taskList = input.taskList;
  const approvalList = { unreadable: { length: input.unreadable.approvals } };
  const standingSection = (): string[] => [...input.standingLines];
  const managersSection = (): string[] => [...input.managerLines];
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
    ...(journalScanTruncated ? [OLD_JOURNAL_SCAN_TRUNCATED_NOTICE] : []),
    ...standingSection(),
    ...managersSection(),
    '',
    `- 回答待ち ${pending.length}` +
      ` / エスカレーション ${escalationGroups.length}` +
      ` / 聞かずに決めたこと ${decisionsCount} / 記憶の更新 ${memoryUpdatesCount}` +
      ` / 外部イベント ${externalsCount}` +
      ` / 人間からの発言 ${humanTurnsCount}`,
    // 待ち行列の件数の行は外した（断り書きの先頭が同じ行を持つため）。切り出し前の形からこの1行だけ差し引いてある
    ...(unreadableLine === ''
      ? []
      : [`- 読めない行（壊れた行。上の件数には入っていない）: ${unreadableLine}`]),
    DIGEST_COUNTS_TOOLS_NOTE,
  ].join('\n');
}

// --- 入力 ---

const SINCE = new Date('2026-10-31T15:00:00.000Z');
const UNTIL = new Date('2026-11-01T09:00:00.001Z');
const NOW_MS = Date.parse('2026-11-01T09:00:00.000Z');
const at = (msAgo: number): string => new Date(NOW_MS - msAgo).toISOString();
const MIN = 60_000;
const DAY = 86_400_000;

const long = (label: string, n = 300): string => `${label}${'あ'.repeat(n)}`;

function plan(index: number, withLastRun: boolean, request?: string): ScheduledRequest {
  return {
    kind: `kind-${String(index)}`,
    spec: { type: 'daily', at: '09:00' },
    request: request ?? `依頼 ${String(index)}`,
    createdAt: at(5 * DAY),
    updatedAt: at(5 * DAY),
    ...(withLastRun ? { lastRunAt: at(index * MIN) } : {}),
  };
}

function job(
  id: string,
  status: Job['status'],
  extra: Partial<Omit<Job, 'id' | 'status'>> = {},
): Job {
  return {
    id,
    createdAt: at(3 * DAY),
    updatedAt: at(10 * MIN),
    status,
    summary: `${id} の要約`,
    request: `${id} の依頼`,
    ...extra,
  };
}

const failureAt = (ms: number, code = 'boom'): Job['lastFailure'] => ({
  code,
  via: 'sdk',
  at: at(ms),
});

function jobsOfEveryKind(): Job[] {
  return [
    job('mgr-run', 'running', { lastReport: '途中の報告' }),
    job('mgr-wait', 'waiting_human', { request: long('長い依頼') }),
    job('mgr-lost', 'lost', { request: undefined }),
    job('mgr-fresh-failed', 'failed', {
      lastFailure: failureAt(8 * MIN, `code-${'c'.repeat(100)}`),
      lastReport: long('失敗の報告'),
    }),
    job('mgr-bg', 'done'),
    job('mgr-done', 'done'),
    job('mgr-done-with-failure-old', 'done', { lastFailure: failureAt(14 * DAY) }),
    job('mgr-done-with-failure-new', 'done', { lastFailure: failureAt(MIN) }),
    job('mgr-stopped', 'stopped'),
    job('mgr-old-failed', 'failed', { lastFailure: failureAt(14 * DAY) }),
    job('mgr-failed-released-old', 'failed', {
      lease: {
        runnerId: 'r',
        fence: 1,
        grantedAt: at(15 * DAY),
        seenAt: at(15 * DAY),
        ttlMs: 60_000,
        releasedAt: at(14 * DAY),
      },
    }),
    job('mgr-failed-no-stamps', 'failed'),
  ];
}

function manyJobs(n: number, status: Job['status'], extra: Partial<Job> = {}): Job[] {
  return Array.from({ length: n }, (_, i) => job(`${status}-${String(i)}`, status, extra));
}

const LIVENESS = new Map([
  ['mgr-run', true],
  ['mgr-wait', false],
  ['mgr-lost', true],
]);
const AWAITING = new Map<string, ManagerAwaitingBackground>([
  ['mgr-bg', { tasks: 2, withheldReports: 1, breakdown: 'x', since: at(2 * 60 * MIN) }],
  ['mgr-run', { tasks: 1, withheldReports: 0, breakdown: 'y', since: at(MIN) }],
]);

function task(id: string, status: Task['status'], updatedAt: string): Task {
  return {
    id,
    createdAt: at(9 * DAY),
    updatedAt,
    status,
    origin: 'self',
    title: `title-${id}`,
    body: `body-${id}`,
  };
}

const taskList = (entries: Task[], unreadable: TaskList['unreadable'] = []): TaskList => ({
  entries,
  unreadable,
});

function group(i: number, over: Partial<EscalationGroup> = {}): EscalationGroup {
  return {
    approvalId: `ap-${String(i)}`,
    question: i % 4 === 0 ? long('長い問い') : `問い ${String(i)}`,
    managerId: i % 3 === 0 ? `mgr-${String(i)}` : undefined,
    at: at(i * MIN),
    answeredInWindow: undefined,
    withdrawnInWindow: undefined,
    ...over,
  };
}

describe('旧式との 1 文字比べ（B1: buildActivityDigest の節ごとの切り出し）', () => {
  it('継続中の依頼の節: 件数 0 / 1 / 2 / MAX_ITEMS / MAX_ITEMS + 1 × 読めない行の断り（有り・無し）× 長い本文・動いた/動いていない', () => {
    let compared = 0;
    let nonEmpty = 0;
    for (const count of [0, 1, 2, MAX_ITEMS, MAX_ITEMS + 1, MAX_ITEMS + 5]) {
      for (const note of [null, '読めない継続中の依頼が 1 件ある（kind: broken）。']) {
        const standing = Array.from({ length: count }, (_, i) =>
          plan(i, i % 2 === 0, i % 5 === 0 ? long('長い依頼') : undefined),
        );
        const actual = renderStandingSection(standing, note);
        expect(actual.join('\n')).toBe(legacyStandingSection(standing, note).join('\n'));
        expect(actual).toEqual(legacyStandingSection(standing, note));
        compared += 1;
        if (actual.length > 0) nonEmpty += 1;
      }
    }
    // 前提: 「出ない」と「出る」の両方を比べている
    expect(compared).toBe(12);
    expect(nonEmpty).toBe(11);
  });

  it('マネージャーの節: 担当の種類の全部入り・件数の境目・畳む/畳まない × liveness × 背景処理待ち × 読めない行の断り', () => {
    const sets: { name: string; managers: Job[] }[] = [
      { name: '空', managers: [] },
      { name: '全部入り', managers: jobsOfEveryKind() },
      { name: '走行中 MAX_ITEMS', managers: manyJobs(MAX_ITEMS, 'running') },
      { name: '走行中 MAX_ITEMS + 1', managers: manyJobs(MAX_ITEMS + 1, 'running') },
      { name: '畳む done MAX_ITEMS + 1', managers: manyJobs(MAX_ITEMS + 1, 'done') },
      {
        name: '窓より前の failed MAX_ITEMS + 2',
        managers: manyJobs(MAX_ITEMS + 2, 'failed', { lastFailure: failureAt(14 * DAY) }),
      },
      {
        name: '全部入り + 走行中 MAX_ITEMS',
        managers: [...jobsOfEveryKind(), ...manyJobs(MAX_ITEMS, 'running')],
      },
    ];
    let compared = 0;
    const seen = new Set<string>();
    for (const { name, managers } of sets) {
      for (const note of [null, '読めない委譲が 1 件ある（id: mgr-bad）。']) {
        for (const foldOldTerminated of [true, false]) {
          for (const liveness of [undefined, LIVENESS]) {
            for (const awaitingBackground of [undefined, AWAITING]) {
              const input: ManagersSectionInput = {
                managers,
                unreadableJobNote: note,
                liveness,
                awaitingBackground,
                since: SINCE,
                foldOldTerminated,
              };
              const actual = renderManagersSection(input);
              expect(actual.join('\n'), name).toBe(legacyManagersSection(input).join('\n'));
              expect(actual, name).toEqual(legacyManagersSection(input));
              seen.add(actual.join('\n'));
              compared += 1;
            }
          }
        }
      }
    }
    expect(compared).toBe(7 * 2 * 2 * 2 * 2);
    // 前提: 入力の違いが出力の違いになっている（全部が同じ出力になる退化をしていない）
    expect(seen.size).toBeGreaterThan(40);
  });

  it('先頭（期間・打ち切りの名乗り・件数の行・保持の上限・読めない行）: 各項目の有り・無しの組み合わせ', () => {
    const counts = {
      humanTurns: 7,
      pending: 3,
      escalations: 2,
      managers: 12,
      decisions: 4,
      memoryUpdates: 5,
      externals: 6,
      delegatedToolUses: 8,
      cloneToolUses: 9,
      standing: 10,
    };
    const zeroCounts = Object.fromEntries(Object.keys(counts).map((k) => [k, 0])) as typeof counts;
    let compared = 0;
    for (const notice of [undefined, OLD_JOURNAL_SCAN_TRUNCATED_NOTICE]) {
      for (const c of [counts, zeroCounts]) {
        for (const escalationRetainCapped of [false, true]) {
          for (const jobs of [0, 3]) {
            for (const approvals of [0, 2]) {
              for (const schedules of [0, 1]) {
                const input: DigestOpeningInput = {
                  since: SINCE,
                  until: UNTIL,
                  journalScanTruncatedNotice: notice,
                  counts: c,
                  escalationRetainCapped,
                  unreadable: { jobs, approvals, schedules },
                };
                const actual = renderDigestOpening(input);
                expect(actual.join('\n')).toBe(legacyOpening(input).join('\n'));
                expect(actual).toEqual(legacyOpening(input));
                compared += 1;
              }
            }
          }
        }
      }
    }
    expect(compared).toBe(2 * 2 * 2 * 2 * 2 * 2);
  });

  it('待ち行列の先頭: 件数 0 / 先頭の上限の前後 / 滞留（waiting・needs_decision）の有り・無し × 基準時刻 × 読めない行', () => {
    const lists = [
      taskList([]),
      taskList([task('q-1', 'queued', at(2 * DAY))]),
      taskList(
        Array.from({ length: TASK_QUEUE_HEAD_LIMIT + 2 }, (_, i) =>
          task(`q-${String(i)}`, 'queued', at(2 * DAY)),
        ),
      ),
      taskList([
        task('n-1', 'needs_decision', at(4 * DAY)),
        task('w-1', 'waiting', at(30 * 60 * MIN)),
        task('q-1', 'queued', at(2 * DAY)),
      ]),
      taskList([task('q-1', 'queued', at(2 * DAY))], [{ id: 't-bad', reason: '不正な欄' }]),
    ];
    let compared = 0;
    for (const list of lists) {
      for (const nowMs of [NOW_MS, NOW_MS + 7 * DAY, 0]) {
        const actual = renderTaskQueueSection(list, nowMs);
        expect(actual.join('\n')).toBe(legacyTaskQueue(list, nowMs).join('\n'));
        expect(actual).toEqual(legacyTaskQueue(list, nowMs));
        compared += 1;
      }
    }
    expect(compared).toBe(15);
  });

  it('エスカレーションの節: 件数 0 / 1 / MAX_ITEMS / MAX_ITEMS + 1 / 多数 × 状態の文（長い本文・マネージャー発を含む）', () => {
    const stateOf = (g: EscalationGroup): string =>
      g.approvalId.endsWith('1') ? `回答: ${long('答え', 120)}` : `未回答（${g.approvalId}）`;
    let compared = 0;
    for (const count of [0, 1, 2, MAX_ITEMS, MAX_ITEMS + 1, 200]) {
      const groups = Array.from({ length: count }, (_, i) => group(i));
      const shown = groups.slice(0, MAX_ITEMS).map((g) => ({ group: g, state: stateOf(g) }));
      const actual = renderEscalationSection(groups.length, shown);
      expect(actual.join('\n')).toBe(legacyEscalation(groups, stateOf).join('\n'));
      expect(actual).toEqual(legacyEscalation(groups, stateOf));
      compared += 1;
    }
    expect(compared).toBe(6);
  });

  it('件数の形の全文: 節の行の有り・無し × 打ち切り × 件数 × 読めない行（承認待ち・待ち行列の片方・両方）', () => {
    const standingLines = legacyStandingSection([plan(1, true), plan(2, false)], null);
    const managerLines = legacyManagersSection({
      managers: jobsOfEveryKind(),
      unreadableJobNote: null,
      liveness: LIVENESS,
      awaitingBackground: AWAITING,
      since: SINCE,
      foldOldTerminated: true,
    });
    let compared = 0;
    const seen = new Set<string>();
    for (const lines of [
      { standingLines: [], managerLines: [] },
      { standingLines, managerLines },
      { standingLines, managerLines: [] },
    ]) {
      for (const journalScanTruncated of [false, true]) {
        for (const list of [taskList([]), taskList([task('q-1', 'queued', at(DAY))])]) {
          for (const unreadable of [
            { approvals: 0, tasks: 0 },
            { approvals: 2, tasks: 0 },
            { approvals: 0, tasks: 3 },
            { approvals: 1, tasks: 1 },
          ]) {
            const input: CountsDigestInput = {
              since: SINCE,
              until: UNTIL,
              journalScanTruncated,
              ...lines,
              pending: 3,
              escalations: 2,
              decisions: 4,
              memoryUpdates: 5,
              externals: 6,
              humanTurns: 7,
              taskList: list,
              unreadable,
            };
            // 待ち行列の読めない行の件数は `taskList.unreadable.length`（呼び元が `unreadable.tasks` に同じ値を入れる）
            const withUnreadableTasks: CountsDigestInput = {
              ...input,
              taskList: {
                ...list,
                unreadable: Array.from({ length: unreadable.tasks }, (_, i) => ({
                  id: `t-${String(i)}`,
                  reason: '不正',
                })),
              },
            };
            const actual = renderCountsDigest(withUnreadableTasks);
            expect(actual).toBe(legacyCountsDigest(withUnreadableTasks));
            seen.add(actual);
            compared += 1;
          }
        }
      }
    }
    expect(compared).toBe(3 * 2 * 2 * 4);
    // 待ち行列の件数の行を外したので、開いている件の有無（list の2通り）は出力に現れない。読めない行の件数（unreadable）の違いは今も現れる
    expect(seen.size).toBe(compared / 2);
  });
});
