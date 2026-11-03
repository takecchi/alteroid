import { readFileSync, writeFileSync } from 'node:fs';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { DigestSessionDelta } from './digest-session-delta.js';
import type { ManagerPool, ManagerSummary, RunnerBacklogSnapshot } from './manager.js';
import type { ManagerDenial } from './denial-key.js';
import { createMemoryStores } from './testing.js';
import { createCloneTools } from './tools.js';

// `manager_list` の出力（全文と字数）を、場面ごとにコミットした固定値（clone-tools-manager-list-output-pin.json）と丸ごと比べる。
// `clone-tools-manager-list.ts` の `managerListTool`（456 行の式）を出力の部分ごとの小さな関数へ分けるとき、
// 出力が1文字も変わらないことを機械で確かめる歯。固定値の側で値を伏せず、入力（時計・id・時刻・並び）を固定して毎回同じ出力にする。
//
// 固定値の作り直し（意図して出力を変えたときだけ。PR 本文に理由を書く）:
//   UPDATE_MANAGER_LIST_PIN=1 pnpm -C <作業ツリー> --filter @alteroid/core exec vitest run src/clone-tools-manager-list-output-pin.test.ts --maxWorkers=2
//   pnpm -C <作業ツリー> exec prettier --write packages/core/src/clone-tools-manager-list-output-pin.json
// 手で json を書き換えない。作り直したら `git diff` で、どの場面が何字から何字に動いたかを読む。
// json の先頭の `lengths` が場面ごとの字数の一覧（どの部分が何字を出しているかを見る基準）。
//
// 時計は Date だけを固定する（`setTimeout` などは本物のまま。実時間の待ちは使わない）。

type Args = Record<string, unknown>;
type PreviousTexts = readonly string[];

interface Step {
  args?: Args | ((previous: PreviousTexts) => Args);
  /** この呼びの前に委譲の一覧を差し替える */
  mutate?: (managers: ManagerSummary[]) => ManagerSummary[];
}

interface LedgerRow {
  id: string;
  conversationId?: string;
  taskId?: string;
}

interface Scenario {
  name: string;
  /** 通る分岐の覚え書き（読み手のため。判定には使わない） */
  covers: string;
  managers: () => ManagerSummary[];
  steps: Step[];
  /** 控え（同じ会話の2回目からの畳み）を使うか */
  fold?: boolean;
  /** 台帳の行。省略すると全委譲が `conv-<id>` の起点つきで載る */
  ledger?: LedgerRow[] | 'unreadable';
  unreadableJobs?: { id?: string; reason: string }[];
  inbox?: unknown[];
  unreadableInbox?: { id?: string; reason: string }[];
  queued?: number;
  backlog?: RunnerBacklogSnapshot[];
  denials?: Record<string, ManagerDenial[]>;
  /** 真なら、全 runner が「背景処理待ちの印を送る版」と名乗る */
  capable?: boolean;
  models?: Record<string, { manager?: string; worker?: string }>;
}

const FROZEN_NOW = '2026-10-27T02:00:00.000Z';
const PIN_URL = new URL('./clone-tools-manager-list-output-pin.json', import.meta.url);
const UPDATE = process.env.UPDATE_MANAGER_LIST_PIN === '1';

function iso(minutesFromBase: number): string {
  return new Date(Date.UTC(2026, 9, 27, 0, 0, 0) + minutesFromBase * 60_000).toISOString();
}

function mgr(n: number, extra: Partial<ManagerSummary> = {}): ManagerSummary {
  return {
    managerId: `mgr-${String(n).padStart(3, '0')}`,
    status: 'done',
    live: false,
    cwd: '/work',
    request: `依頼文 ${String(n)}。短い依頼。`,
    startedAt: iso(n),
    updatedAt: iso(60),
    waiting: [],
    runnerId: 'runner-1',
    lastReport: `報告 ${String(n)}。終わった。`,
    lastReportAt: iso(60),
    ...extra,
  };
}

// 予算（LIST_BUDGET 8,000字）を越える行。抜粋の上限まで長い依頼文・報告を持つ
function bigMgr(n: number, extra: Partial<ManagerSummary> = {}): ManagerSummary {
  return mgr(n, {
    request: `依頼文 ${String(n)}。${'依頼の説明が続く。'.repeat(30)}`,
    lastReport: `報告 ${String(n)}。${'報告の本文が続く。'.repeat(30)}`,
    ...extra,
  });
}

const bigList = (): ManagerSummary[] => [
  bigMgr(0, { status: 'running', live: true }),
  ...Array.from({ length: 40 }, (_, i) => bigMgr(i + 1)),
];

// 並び替え（走行中・返事待ち → lost → 残り。群の中は startedAt の新しい順）が効く、状態の混ざった組
const mixedList = (): ManagerSummary[] => [
  mgr(1, {
    status: 'running',
    live: true,
    request: '走行中の依頼 WORLDBUILD-7 の続き',
    lastReport: '途中の報告。PR 6387 を出した',
    lastReportAt: iso(30),
    waiting: [
      {
        requestId: 'req-q1',
        summary: '次はどちらの方針で進めるか',
        kind: 'question',
        askedAt: iso(40),
      },
      {
        requestId: 'req-p1',
        summary: 'Bash: git push の許可',
        kind: 'permission',
        askedAt: iso(41),
      },
    ],
  }),
  mgr(2, {
    status: 'running',
    live: false,
    runnerLostSince: iso(50),
    request: '器が黙った走行中の委譲',
    lastReport: undefined,
    lastReportAt: undefined,
  }),
  mgr(3, {
    status: 'waiting_human',
    live: true,
    request: '返事待ちの委譲',
    waiting: [
      { requestId: 'req-q3', summary: '人間の確認が要る', kind: 'question', askedAt: iso(45) },
    ],
  }),
  mgr(4, {
    status: 'done',
    awaitingBackground: { tasks: 2, withheldReports: 1, breakdown: 'bash×2', since: iso(20) },
    request: '背景処理を待って畳んだ委譲',
  }),
  mgr(5, { status: 'done', request: '終わった委譲' }),
  mgr(6, {
    status: 'failed',
    request: '失敗で終わった委譲',
    lastReport: undefined,
    lastReportAt: undefined,
    lastSystemError: { code: 'ENOMEM', errno: -12, syscall: 'spawn', at: iso(55) },
  }),
  mgr(7, { status: 'lost', request: '前のセッションへ戻れなかった委譲', lastReport: undefined }),
  mgr(8, { status: 'stopped', request: '止めた委譲' }),
  mgr(9, { status: 'done', request: '報告が無いまま終わった委譲', lastReport: undefined }),
];

// 受信箱の滞留（人間起点を含む）。器の行の形は inbox-backlog.test.ts と同じ
const stuckInbox = (): unknown[] =>
  Array.from({ length: 12 }, (_, i) => ({
    id: `ev${String(i)}`,
    at: new Date(Date.UTC(2026, 9, 26, 12, 0, 0) - i * 3_600_000).toISOString(),
    deliveries: i % 3,
    event:
      i % 2 === 1
        ? { type: 'human_message', text: 'x', conversationId: 'c1' }
        : { type: 'manager_message', managerId: `mgr-${String(i)}`, text: 'y' },
  }));

const backlogSnapshots = (): RunnerBacklogSnapshot[] => [
  {
    runnerId: 'runner-1',
    pendingEvents: 3,
    oldestPendingAt: iso(-120),
    observedAt: iso(-10),
    legState: { status: 'connected', since: iso(-300), lastByteAt: iso(-11) },
  },
  {
    runnerId: 'runner-2',
    pendingEvents: 1,
    observedAt: iso(-5),
    legState: { status: 'down', since: iso(-100), lastFailureReason: 'ECONNRESET' },
  },
  { runnerId: 'runner-3', pendingEvents: 0, observedAt: iso(-5) },
  {
    runnerId: 'runner-4',
    pendingEvents: 2,
    oldestPendingAt: iso(-200),
    observedAt: iso(-20),
    instanceSwapped: true,
  },
];

function cursorOf(text: string | undefined): string {
  const found = /manager_list cursor=(\S+)/.exec(text ?? '');
  if (found?.[1] === undefined) throw new Error('出力に続きの cursor が無い');
  return found[1];
}

const SCENARIOS: Scenario[] = [
  {
    name: 'empty',
    covers: '委譲が0本・受信箱も空（早期リターン）',
    managers: () => [],
    steps: [{}],
  },
  {
    name: 'empty-with-backlogs',
    covers:
      '委譲0本・読めない委譲あり・受信箱の滞留・メモリの待ち行列・runner の積み上がり（4種の脚の状態）',
    managers: () => [],
    unreadableJobs: [{ id: 'job-broken', reason: 'schema' }],
    inbox: stuckInbox(),
    queued: 2,
    backlog: backlogSnapshots(),
    steps: [{}],
  },
  {
    name: 'empty-inbox-unreadable-only',
    covers: '委譲0本・受信箱は読めない行だけ・メモリの待ち行列のみ',
    managers: () => [],
    unreadableInbox: [{ id: 'ev-bad', reason: 'schema' }],
    queued: 1,
    steps: [{}],
  },
  {
    name: 'empty-queued-only',
    covers: '委譲0本・器の行は空でメモリの待ち行列だけ',
    managers: () => [],
    queued: 4,
    steps: [{}],
  },
  {
    name: 'mixed',
    covers:
      '状態が混ざった並び替え・返事待ち（question/permission）・背景処理待ち・runner 消失の印・lost・failed の系統エラー・件数行・印の意味の節・起点の会話（task つき／会話のみ／会話なし／台帳に無い）・モデル',
    managers: mixedList,
    ledger: [
      { id: 'mgr-001', conversationId: 'conv-a', taskId: 'task-1' },
      { id: 'mgr-002', conversationId: 'conv-b' },
      { id: 'mgr-003' },
      { id: 'mgr-004', conversationId: 'conv-d', taskId: 'task-4' },
      { id: 'mgr-005', conversationId: 'conv-e' },
      { id: 'mgr-006' },
      { id: 'mgr-007', conversationId: 'conv-g' },
    ],
    models: { 'runner-1': { manager: 'opus', worker: 'sonnet' } },
    steps: [{}],
  },
  {
    name: 'mixed-ledger-unreadable',
    covers: '台帳（jobs.listJobs）が読めないときの起点の会話の行',
    managers: () => mixedList().slice(0, 3),
    ledger: 'unreadable',
    steps: [{}],
  },
  {
    name: 'mixed-fold',
    covers:
      '同じ会話の2回目から固定の文を札にする・行の畳み（前回と同じ）・畳まない行（lost・failed・⚠）・行が変わった回・refetch: true',
    managers: mixedList,
    fold: true,
    steps: [
      {},
      {},
      {
        mutate: (list) =>
          list.map((m) =>
            m.managerId === 'mgr-005' ? { ...m, lastReport: '報告 5。内容が変わった。' } : m,
          ),
      },
      { args: { refetch: true } },
    ],
  },
  {
    name: 'filter-status-running',
    covers: 'status の絞り込み（走行中だけ）。件数は絞る前の全体',
    managers: mixedList,
    steps: [{ args: { status: ['running'] } }],
  },
  {
    name: 'filter-status-multi',
    covers: 'status の絞り込み（複数・lost を含む）',
    managers: mixedList,
    steps: [{ args: { status: ['waiting_human', 'lost'] } }],
  },
  {
    name: 'filter-status-empty-array',
    covers: 'status: []（絞らず全件。その旨の注記）',
    managers: mixedList,
    steps: [{ args: { status: [] } }],
  },
  {
    name: 'filter-status-zero',
    covers: 'status の絞りに当たる委譲が0件',
    managers: () => [mgr(1), mgr(2)],
    steps: [{ args: { status: ['lost'] } }],
  },
  {
    name: 'filter-q',
    covers: 'q の絞り込み（依頼文の札・全角半角と大文字小文字の揃え）',
    managers: mixedList,
    steps: [{ args: { q: 'ＷｏｒＬＤＢＵＩＬＤ-7' } }],
  },
  {
    name: 'filter-q-id-and-report',
    covers: 'q が managerId・報告の本文に当たる',
    managers: mixedList,
    steps: [{ args: { q: 'mgr-00' } }, { args: { q: 'PR 6387' } }],
  },
  {
    name: 'filter-q-branch',
    covers: 'q が未 push の観測にある枝の名前に当たる（detached HEAD の枝 null は飛ばす）',
    managers: () => [
      mgr(1, {
        lastUnpushedWorkObservation: {
          kind: 'observed',
          at: iso(30),
          cwd: '/workspace/repo',
          worktrees: [
            { relativePath: '.', branch: 'feat/mob-add-kinds' },
            { relativePath: 'sub', branch: null },
          ],
        },
      }),
      mgr(2),
    ],
    steps: [{ args: { q: 'MOB-ADD' } }],
  },
  {
    name: 'filter-q-empty',
    covers: 'q が空文字・空白だけ（絞らず、その旨の注記）',
    managers: () => [mgr(1), mgr(2)],
    steps: [{ args: { q: '' } }, { args: { q: '   ' } }],
  },
  {
    name: 'filter-q-zero',
    covers: 'q に当たる委譲が0件（status なし・あり）',
    managers: mixedList,
    steps: [
      { args: { q: 'どこにも無い語' } },
      { args: { q: 'どこにも無い語', status: ['running'] } },
    ],
  },
  {
    name: 'filter-status-and-q',
    covers: 'status と q の併用',
    managers: mixedList,
    steps: [{ args: { status: ['running', 'done'], q: '委譲' } }],
  },
  {
    name: 'filter-fold',
    covers: '絞り込みの注記の固定の言い回しが2回目から札になる（status・q・空の q・空の status）',
    managers: mixedList,
    fold: true,
    steps: [
      { args: { status: ['running', 'done'], q: '委譲' } },
      { args: { status: ['running', 'done'], q: '委譲' } },
      { args: { status: [], q: ' ' } },
      { args: { status: [], q: ' ' } },
    ],
  },
  {
    name: 'budget-paging',
    covers: '予算（8,000字）を越えて「…ほか N 件は省略」・cursor で頁をたどる',
    managers: bigList,
    steps: [
      {},
      { args: (prev) => ({ cursor: cursorOf(prev[0]) }) },
      { args: (prev) => ({ cursor: cursorOf(prev[1]) }) },
      { args: (prev) => ({ cursor: cursorOf(prev[2]) }) },
    ],
  },
  {
    name: 'budget-paging-status-q',
    covers: '絞った一覧が予算で切れ、続きの案内に status と q が入る',
    managers: bigList,
    steps: [
      { args: { status: ['done'], q: '依頼' } },
      {
        args: (prev) => ({ status: ['done'], q: '依頼', cursor: cursorOf(prev[0]) }),
      },
    ],
  },
  {
    name: 'budget-fold',
    covers: '予算超過の一覧の2回目（省略の固定の文が札・先頭行の畳み・畳んだ件数）',
    managers: bigList,
    fold: true,
    steps: [{}, {}],
  },
  {
    name: 'cursor-errors',
    covers:
      'cursor が壊れている・status 不一致（絞りなし／絞りあり側）・q 不一致（q なし／q あり側）・最後の頁',
    managers: bigList,
    steps: [
      {},
      { args: { cursor: 'garbage' } },
      { args: (prev) => ({ cursor: cursorOf(prev[0]), status: ['done'] }) },
      { args: (prev) => ({ cursor: cursorOf(prev[0]), q: '依頼' }) },
      { args: { q: '依頼' } },
      { args: (prev) => ({ cursor: cursorOf(prev[4]) }) },
      { args: { status: ['done'] } },
      { args: (prev) => ({ cursor: cursorOf(prev[6]) }) },
      {
        // 並びの先頭側（走行中と、いちばん新しい数本）だけ残す: 1頁目の cursor より後ろに行が無くなり「これが最後の頁」になる
        mutate: (list) => [list[0]!, ...list.slice(-4)],
        args: (prev) => ({ cursor: cursorOf(prev[0]) }),
      },
    ],
  },
  {
    name: 'notes-liveness',
    covers:
      '器の消失・セッション無し（resume-failed／unlisted）・lost の注記と印の意味の節・RESTART_BEFORE_CHECK_ADVICE の重複排除・件数行の各軸',
    managers: () => [
      mgr(1, { status: 'running', live: false, runnerLostSince: iso(50) }),
      mgr(2, {
        status: 'running',
        live: true,
        sessionMissingSince: iso(52),
        sessionMissingKind: 'resume-failed',
        shutdownObservationArrivedAfterSwap: false,
      }),
      mgr(3, {
        status: 'running',
        live: true,
        sessionMissingSince: iso(53),
        sessionMissingKind: 'unlisted',
      }),
      mgr(4, { status: 'lost' }),
      mgr(5, { status: 'running', runnerVanished: true }),
    ],
    steps: [{}],
  },
  {
    name: 'notes-liveness-fold',
    covers: '印の意味の節が2回目から札になる',
    managers: () => [
      mgr(1, { status: 'running', live: false, runnerLostSince: iso(50) }),
      mgr(3, {
        status: 'running',
        live: true,
        sessionMissingSince: iso(53),
        sessionMissingKind: 'unlisted',
      }),
      mgr(4, { status: 'lost' }),
    ],
    fold: true,
    steps: [{}, {}],
  },
  {
    name: 'notes-failure-usage',
    covers:
      '失敗で終わった回（done／stopped／failed）・枠の停止（走行中／終端）・畳まれた回・畳まれず届かなかった回・系統エラーなしの failed・cgroup イベント',
    managers: () => [
      mgr(1, {
        status: 'done',
        lastFailure: { code: 'billing_error', via: 'assistant_error', at: iso(55) },
        usageStoppedAt: iso(54),
        lastReport: 'このターンは応答を返さずに終わった: 429',
      }),
      mgr(2, {
        status: 'stopped',
        lastFailure: { code: 'rate_limit', via: 'assistant_error', at: iso(55) },
        usageStoppedAt: iso(54),
      }),
      mgr(3, {
        status: 'failed',
        lastCgroupEvents: { oomKillDelta: 1, pidsMaxDelta: 2, at: iso(56) },
      }),
      mgr(4, { status: 'failed', lastFailure: { code: 'x', via: 'live', at: iso(57) } }),
      mgr(5, { status: 'running', live: true, usageStoppedAt: iso(54) }),
      mgr(6, {
        status: 'done',
        lastFoldedTurn: { text: '畳まれた本文', at: iso(58) },
        lastFailure: { code: 'y', via: 'live', at: iso(50) },
      }),
      mgr(7, {
        status: 'done',
        lastUnreported: { reason: 'closed', at: iso(59) },
        lastReport: '届かなかった途中経過',
      }),
    ],
    steps: [{}],
  },
  {
    name: 'notes-denials',
    covers: '拒否された道具・分類器の拒否の上限超え・確認待ちの peer',
    managers: () => [
      mgr(1, {
        status: 'running',
        live: true,
        classifierDenials: [
          { actor: 'manager', consecutive: 5, total: 7, firstReason: '危険な操作' },
          { actor: 'worker', consecutive: 3, total: 3 },
        ],
        pendingPeerApprovals: { count: 2, oldestSince: iso(30) },
      }),
      mgr(2, { status: 'running', live: true }),
    ],
    denials: {
      'mgr-001': [
        { tool: 'Bash', count: 3, actor: 'manager' },
        { tool: 'Write', count: 1, actor: 'worker' },
        { tool: 'Edit', count: 2 },
      ],
    },
    steps: [{}],
  },
  {
    name: 'notes-activity',
    covers:
      'ターン終了の症状（枠の壁・timestamp なし）・道具の応答待ちの矛盾（4本超）・道具を実行中・status の食い違い・畳む候補・畳む候補でない',
    managers: () => [
      mgr(1, {
        status: 'running',
        live: true,
        turnEndReason: 'stop_sequence',
        turnEndedAt: iso(90),
        turnEndTail: '末尾の言葉。'.repeat(40),
      }),
      mgr(2, { status: 'running', live: true, turnEndReason: 'end_turn' }),
      mgr(3, {
        status: 'running',
        live: true,
        toolUseStallPending: [
          { id: 't1', name: 'AskUserQuestion' },
          { id: 't2' },
          { id: 't3', name: 'Bash' },
          { id: 't4', name: 'Read' },
          { id: 't5', name: 'Grep' },
        ],
        toolUseStallAt: iso(80),
      }),
      mgr(4, {
        status: 'running',
        live: true,
        toolUseStallPending: [{ id: 't9', name: 'Bash' }],
      }),
      mgr(5, {
        status: 'done',
        lastReportStatus: 'running',
        lastReportAt: iso(1),
        updatedAt: iso(1),
      }),
      mgr(6, {
        status: 'done',
        turnEndReason: 'end_turn',
        turnEndedAt: iso(-1500),
        lastReportAt: iso(-1400),
        updatedAt: iso(-1500),
      }),
    ],
    capable: true,
    steps: [{}],
  },
  {
    name: 'notes-token',
    covers:
      '認証トークンの世代（不明3種・現役不明・一致・食い違い（背景処理 不明／0／N 本）・終端での食い違い）と resets 時刻の疑い',
    managers: () => [
      mgr(1, { status: 'running', live: true, tokenGenerationUnknownReason: 'pool-not-wired' }),
      mgr(2, { status: 'running', live: true, tokenGenerationUnknownReason: 'not-yet-observed' }),
      mgr(3, {
        status: 'running',
        live: true,
        tokenGenerationUnknownReason: 'reattached-across-restart',
      }),
      mgr(4, { status: 'running', live: true, tokenGeneration: 2 }),
      mgr(5, { status: 'running', live: true, tokenGeneration: 3, activeTokenGeneration: 3 }),
      mgr(6, { status: 'running', live: true, tokenGeneration: 1, activeTokenGeneration: 3 }),
      mgr(7, {
        status: 'running',
        live: true,
        tokenGeneration: 1,
        activeTokenGeneration: 3,
        liveBackgroundTasks: 0,
      }),
      mgr(8, {
        status: 'running',
        live: true,
        tokenGeneration: 1,
        activeTokenGeneration: 3,
        liveBackgroundTasks: 2,
      }),
      mgr(9, { status: 'failed', tokenGeneration: 1, activeTokenGeneration: 3 }),
      mgr(10, { status: 'running', live: true, resetTimeSkewMatch: 'stale' }),
      mgr(11, { status: 'running', live: true, resetTimeSkewMatch: 'active' }),
      mgr(12, {
        status: 'running',
        live: true,
        tokenGeneration: 1,
        activeTokenGeneration: 3,
        resetTimeSkewMatch: 'stale',
      }),
    ],
    steps: [{}],
  },
  {
    name: 'notes-work',
    covers:
      '未 push の観測（経路不明・closed・探しきっていない）・退避 ref・預かった未追跡のファイル・外へ出した成果・預かっている伝言・後継／前任',
    managers: () => [
      mgr(1, {
        status: 'running',
        live: true,
        lastUnpushedWorkObservation: {
          kind: 'observed',
          at: iso(30),
          cwd: '/workspace/mgr-1/repo',
          worktrees: [{ relativePath: '.', branch: 'feat/example' }],
        },
      }),
      mgr(2, {
        status: 'failed',
        lastUnpushedWorkObservation: {
          kind: 'observed',
          at: iso(30),
          source: 'closed',
          cwd: '/workspace/mgr-2/repo',
          worktrees: [{ relativePath: '.', branch: 'feat/closed' }],
          truncatedAtCount: 200,
          unreadableDirCount: 2,
        },
      }),
      mgr(3, {
        status: 'failed',
        lastRescue: {
          at: iso(40),
          worktrees: [
            {
              relativePath: '.',
              branch: 'main',
              at: iso(40),
              pushed: {
                ref: 'refs/alteroid-rescue/m/root-1234abcd',
                commit: 'c'.repeat(40),
                at: iso(40),
              },
              notPushed: { reason: 'push-failed', failureKind: 'auth' },
              untracked: { count: 8, paths: ['1', '2', '3', '4', '5', '6'], omitted: 2 },
              submoduleCount: 1,
            },
          ],
        },
        rescueStash: { count: 3, totalBytes: 2048, latestAt: iso(41) },
      }),
      mgr(4, {
        status: 'done',
        externalOutputs: [
          { at: iso(10), kind: 'mail', where: 'a@example.com', summary: '報告のメール' },
          { at: iso(20), kind: 'calendar', where: '会議室' },
        ],
        heldMessages: { count: 2, oldestHeldAt: iso(45) },
      }),
      mgr(5, { status: 'failed', supersededBy: 'mgr-006' }),
      mgr(6, { status: 'running', live: true, supersedes: 'mgr-005' }),
    ],
    steps: [{}],
  },
  {
    name: 'waiting-overflow',
    covers: '返事待ちが上限（10件）を越える1本（…ほか N 件の返事待ちは省略・長い要約の抜粋）',
    managers: () => [
      mgr(1, {
        status: 'waiting_human',
        live: true,
        waiting: Array.from({ length: 13 }, (_, i) => ({
          requestId: `req-${String(i)}`,
          summary: `質問 ${String(i)}。${'長い質問の文。'.repeat(40)}`,
          kind: i % 2 === 0 ? ('question' as const) : ('permission' as const),
          askedAt: iso(40 + i),
        })),
      }),
    ],
    steps: [{}],
  },
  {
    name: 'inbox-and-runner-backlog',
    covers:
      '受信箱の積み上がり（人間起点つき）・メモリの待ち行列・runner の積み上がり。2回目は内訳が札、refetch で全文',
    managers: () => [mgr(1), mgr(2)],
    fold: true,
    inbox: stuckInbox(),
    queued: 3,
    backlog: backlogSnapshots(),
    steps: [{}, {}, { args: { refetch: true } }],
  },
  {
    name: 'inbox-unreadable',
    covers: '受信箱に読めない行がある（内訳は全文のまま）',
    managers: () => [mgr(1)],
    fold: true,
    inbox: stuckInbox().slice(0, 4),
    unreadableInbox: [{ id: 'ev-bad', reason: 'schema' }],
    steps: [{}, {}],
  },
  {
    name: 'unreadable-jobs',
    covers: '読めない委譲の行を件数行の下に名乗る',
    managers: () => [mgr(1)],
    unreadableJobs: [{ id: 'job-x', reason: 'schema' }, { reason: 'json' }],
    steps: [{}],
  },
];

function stepKey(scenario: Scenario, index: number): string {
  return scenario.steps.length === 1 ? scenario.name : `${scenario.name}#${String(index + 1)}`;
}

const ALL_KEYS: string[] = SCENARIOS.flatMap((scenario) =>
  scenario.steps.map((_, index) => stepKey(scenario, index)),
);

function buildPool(scenario: Scenario, state: { managers: ManagerSummary[] }): ManagerPool {
  const notUsed = () => {
    throw new Error('この歯では使わない');
  };
  return {
    async list() {
      return state.managers.map((manager) => ({ ...manager }));
    },
    denials(managerId: string) {
      return scenario.denials?.[managerId] ?? [];
    },
    runnerBacklog() {
      return scenario.backlog ?? [];
    },
    ...(scenario.capable === true ? { runnerHasCapability: () => true } : {}),
    ...(scenario.models === undefined
      ? {}
      : { runnerReportedModels: (runnerId: string) => scenario.models?.[runnerId] }),
    start: notUsed,
    send: notUsed,
    abort: notUsed,
  } as unknown as ManagerPool;
}

async function runScenario(scenario: Scenario): Promise<string[]> {
  const state = { managers: scenario.managers() };
  const stores = createMemoryStores();
  if (scenario.inbox !== undefined || scenario.unreadableInbox !== undefined) {
    const entries = scenario.inbox ?? [];
    const unreadable = scenario.unreadableInbox ?? [];
    (stores.inbox as { peekPending: () => Promise<unknown> }).peekPending = async () => ({
      entries,
      unreadable,
    });
  }
  if (scenario.unreadableJobs !== undefined) {
    const rows = scenario.unreadableJobs;
    stores.jobs.listUnreadableJobs = async () => rows;
  }
  if (scenario.ledger === 'unreadable') {
    stores.jobs.listJobs = async () => {
      throw new Error('台帳が読めない');
    };
  } else {
    const rows: LedgerRow[] =
      scenario.ledger ??
      state.managers.map((manager) => ({
        id: manager.managerId,
        conversationId: `conv-${manager.managerId}`,
      }));
    for (const row of rows) {
      await stores.jobs.putJob({
        id: row.id,
        managerId: row.id,
        createdAt: iso(0),
        updatedAt: iso(0),
        status: 'done',
        summary: '依頼',
        ...(row.conversationId === undefined ? {} : { conversationId: row.conversationId }),
        ...(row.taskId === undefined ? {} : { taskId: row.taskId }),
      });
    }
  }
  const delta = scenario.fold === true ? new DigestSessionDelta() : null;
  const tools = createCloneTools({
    stores,
    emit: () => undefined,
    memoryCause: () => 'clone',
    conversationId: () => undefined,
    ...(scenario.queued === undefined ? {} : { queuedInMemory: () => scenario.queued }),
    managers: buildPool(scenario, state),
    ...(delta === null
      ? {}
      : {
          foldFixed: (id: string, full: string, ref: string, supersedes?: string) =>
            delta.fixedInTurn(id, full, ref, supersedes),
        }),
  });
  const found = tools.find((entry) => entry.name === 'manager_list');
  if (!found) throw new Error('manager_list が無い');
  const outputs: string[] = [];
  for (const step of scenario.steps) {
    if (step.mutate !== undefined) state.managers = step.mutate(state.managers);
    const args = typeof step.args === 'function' ? step.args(outputs) : (step.args ?? {});
    const result = await found.handler(args as never, {});
    outputs.push(
      (result.content ?? []).map((block) => (block.type === 'text' ? block.text : '')).join(''),
    );
  }
  return outputs;
}

interface PinnedOutput {
  length: number;
  text: string;
}

interface PinFile {
  /** 場面ごとの字数の一覧（`text.length`）。どの場面が何字を出しているかを1か所で読む */
  lengths: Record<string, number>;
  scenarios: Record<string, PinnedOutput>;
}

async function runAll(): Promise<Record<string, PinnedOutput>> {
  const out: Record<string, PinnedOutput> = {};
  for (const scenario of SCENARIOS) {
    const texts = await runScenario(scenario);
    for (const [index, text] of texts.entries()) {
      out[stepKey(scenario, index)] = { length: text.length, text };
    }
  }
  return out;
}

describe('manager_list の出力の固定（場面ごとの全文と字数）', () => {
  let actual: Record<string, PinnedOutput> = {};
  let pinned: PinFile = { lengths: {}, scenarios: {} };

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(FROZEN_NOW));
    actual = await runAll();
    if (UPDATE) {
      const file: PinFile = {
        lengths: Object.fromEntries(ALL_KEYS.map((key) => [key, actual[key]?.length ?? -1])),
        scenarios: actual,
      };
      writeFileSync(PIN_URL, `${JSON.stringify(file, null, 2)}\n`);
    }
    pinned = JSON.parse(readFileSync(PIN_URL, 'utf8')) as PinFile;
  });

  afterAll(() => {
    vi.useRealTimers();
  });

  it('空振りでない（場面が在り、固定値と実際の場面の名前の並びが同じ）', () => {
    expect(
      Object.keys(pinned.scenarios).length,
      '固定値が空である。この歯は何も測っていない',
    ).toBeGreaterThan(0);
    expect(Object.keys(actual)).toEqual(ALL_KEYS);
    expect(Object.keys(pinned.scenarios)).toEqual(ALL_KEYS);
    for (const key of ALL_KEYS) {
      expect(actual[key]?.text.length, `${key} が空の出力である`).toBeGreaterThan(0);
    }
  });

  it('場面ごとの字数の一覧が固定値と同じ（どの場面の字数が動いたかを1か所で読む）', () => {
    const lengths = Object.fromEntries(ALL_KEYS.map((key) => [key, actual[key]?.length ?? -1]));
    expect(lengths).toEqual(pinned.lengths);
  });

  it('固定値の字数が、固定値の全文の長さと合っている（json を手で書き換えていない）', () => {
    for (const [key, entry] of Object.entries(pinned.scenarios)) {
      expect(entry.text.length, `${key}: json の length と text.length が食い違う`).toBe(
        entry.length,
      );
      expect(pinned.lengths[key], `${key}: lengths の一覧と食い違う`).toBe(entry.length);
    }
  });

  describe.each(SCENARIOS)('場面 $name', (scenario) => {
    for (const [index] of scenario.steps.entries()) {
      const key = stepKey(scenario, index);
      it(`${key} の出力が固定値と同じ（${scenario.covers}）`, () => {
        const want = pinned.scenarios[key];
        const got = actual[key];
        expect(want, `${key} が固定値に無い`).toBeDefined();
        expect(got, `${key} が実際の出力に無い`).toBeDefined();
        // 先に字数を比べて、どの場面が何字から何字へ動いたかを文言に出す
        expect(
          got?.text.length,
          `場面 ${key} の字数が変わった: 固定値 ${String(want?.length)} 字 → いま ${String(got?.text.length)} 字`,
        ).toBe(want?.length);
        expect(
          got?.text,
          `場面 ${key} の出力が固定値からずれた（字数は ${String(got?.text.length)} 字で同じ）`,
        ).toBe(want?.text);
      });
    }
  });

  it('同じ入力で2回回すと、全場面で同じ出力になる（時計・採番・順序が固定されている）', async () => {
    expect(await runAll()).toEqual(actual);
  });

  it('場面が狙った分岐を通っている（固定値が別の分岐へ流れていないことの目印）', () => {
    const text = (key: string): string => actual[key]?.text ?? '';
    expect(text('empty')).toContain('（マネージャーは1本も居ない）');
    expect(text('empty-with-backlogs')).toContain('読めたマネージャーは無い');
    expect(text('mixed-fold#2')).toContain('前回と同じ');
    expect(text('mixed-fold#4')).not.toContain('前回と同じ行');
    expect(text('filter-status-empty-array')).toContain('絞らずに全件を出した');
    expect(text('filter-q-empty#1')).toContain('q が空');
    expect(text('budget-paging#1')).toContain('…ほか');
    expect(text('cursor-errors#2')).toContain('cursor が壊れている');
    expect(text('cursor-errors#3')).toContain('status: 絞っていない の一覧から出た続き');
    expect(text('cursor-errors#9')).toContain('これが最後の頁');
    expect(text('notes-liveness')).toContain('行の印の意味');
    expect(text('notes-failure-usage')).toContain('枠(利用上限)で止まっている');
    expect(text('notes-activity')).toContain('畳む候補');
    expect(text('notes-work')).toContain('未push観測');
    expect(text('inbox-and-runner-backlog#1')).toContain('クローンの受信箱に未処理の合図が');
    expect(text('inbox-and-runner-backlog#2')).toContain('前回と同じ');
  });
});
