import { readFileSync, writeFileSync } from 'node:fs';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { DigestSessionDelta } from './digest-session-delta.js';
import { UnreadableJournalEntryError } from './store.js';
import type { Stores } from './store.js';
import { createMemoryStores, dropLastRowPerPage } from './testing.js';
import { createCloneTools } from './tools.js';
import type { UsageTotals } from './usage.js';

// `journal_read` の出力（全文と字数）を、場面ごとにコミットした固定値（clone-tools-journal-read-output-pin.json）と丸ごと比べる。
// `clone-tools-journal.ts` の `tool('journal_read', …)`（約 340 行の式）を出力の部分ごとの小さな関数へ分けるとき、
// 出力が1文字も変わらないことを機械で確かめる歯。固定値の側で値を伏せず、入力（時計・id・時刻・並び）を固定して毎回同じ出力にする。
//
// 固定値の作り直し（意図して出力を変えたときだけ。PR 本文に理由を書く）:
//   UPDATE_JOURNAL_READ_PIN=1 pnpm -C <作業ツリー> --filter @alteroid/core exec vitest run src/clone-tools-journal-read-output-pin.test.ts --maxWorkers=2
//   pnpm -C <作業ツリー> exec prettier --write packages/core/src/clone-tools-journal-read-output-pin.json
// 手で json を書き換えない。作り直したら `git diff` で、どの場面が何字から何字に動いたかを読む。
// json の先頭の `lengths` が場面ごとの字数の一覧（どの部分が何字を出しているかを見る基準）。
//
// 時計は Date だけを固定する（`setTimeout` などは本物のまま。実時間の待ちは使わない）。
// 日誌の `at` は行を足す直前に Date を進めて決める（足した順に増える）。id はインメモリの日誌の採番（id-1, id-2, …）で、場面ごとに作り直すので毎回同じ。
// 語の検索の予算は、場面ごとに作る進み方の決まった時計（`journalSearch.clock`）で測る。実時間は見ない。

type Args = Record<string, unknown>;
type PreviousTexts = readonly string[];
type Anchor = { id: string; at: string };
type Anchors = Record<string, Anchor>;
type Append = Parameters<Stores['journal']['append']>[0];

interface Seeder {
  stores: Stores;
  /** 基準時刻から minute 分後の `at` で1行足す */
  put: (minute: number, entry: Append) => Promise<Anchor>;
}

interface Step {
  args?: Args | ((previous: PreviousTexts, anchors: Anchors) => Args);
}

interface SearchOptions {
  budgetMs?: number;
  sliceMs?: number;
  /** 呼びごとに step ずつ進む時計（0 なら止まった時計）。場面ごとに作り直す */
  clockStep: number;
}

interface Scenario {
  name: string;
  /** 通る分岐の覚え書き（読み手のため。判定には使わない） */
  covers: string;
  /** 日誌へ入れる行。返した値は steps の args から使える（cursor・id） */
  seed?: (seeder: Seeder) => Promise<Anchors | void>;
  /** 種を入れた後で器を差し替える（読めない行・頁が短くなる器など） */
  wrap?: (stores: Stores) => Stores;
  steps: Step[];
  /** 語の検索の口（now・clock・予算）。省くと本物の口（時計は performance.now、「いま」は固定の Date） */
  search?: SearchOptions;
  /** 控え（同じ会話の2回目からの畳み）の口を渡すか。journal_read は使わないはず */
  fold?: boolean;
  /** 真なら、この呼びをサブエージェントのものとして扱う */
  subagent?: boolean;
}

const FROZEN_NOW = '2026-10-29T00:00:00.000Z';
const PIN_URL = new URL('./clone-tools-journal-read-output-pin.json', import.meta.url);
const UPDATE = process.env.UPDATE_JOURNAL_READ_PIN === '1';
const DAY = 24 * 60;

/** 基準（2026-10-26T00:00Z）から minute 分後 */
function iso(minutesFromBase: number): string {
  return new Date(Date.UTC(2026, 9, 26, 0, 0, 0) + minutesFromBase * 60_000).toISOString();
}

function ex(
  conversationId: string | undefined,
  role: 'inbound' | 'outbound',
  text: string,
  extra: Record<string, unknown> = {},
): Append {
  return {
    type: 'exchange',
    with: 'human',
    role,
    text,
    ...(conversationId === undefined ? {} : { conversationId }),
    ...extra,
  } as Append;
}

function att(n: number, name = `file-${String(n)}.txt`): Record<string, unknown> {
  return {
    id: `att-${String(n)}`,
    name,
    mediaType: n % 2 === 0 ? 'image/png' : 'text/plain',
    size: 1000 * n,
    sha256: String(n % 10).repeat(64),
  };
}

const LONG_NAME = `${'とても長い名前のログ-'.repeat(12)}.log`;

function totals(
  cost: number,
  input: number,
  output: number,
  cacheRead = 0,
  cacheWrite = 0,
): UsageTotals {
  return {
    inputTokens: input,
    outputTokens: output,
    cacheReadInputTokens: cacheRead,
    cacheCreationInputTokens: cacheWrite,
    webSearchRequests: 0,
    costUsd: cost,
  };
}

const CTX_FULL = {
  durationMs: 120,
  totalTokens: 123_456,
  rawMaxTokens: 200_000,
  percentage: 62,
  systemPromptTokens: 5000,
  systemPromptSectionCount: 12,
  mcpToolTokens: 3000,
  mcpToolCount: 40,
  memoryFileTokens: 800,
  memoryFileCount: 2,
  categories: [
    { name: 'Messages', tokens: 90_000, kind: 'used' },
    { name: 'Free space', tokens: 70_000 },
  ],
  categoriesOmitted: 3,
  messageBreakdown: {
    toolCallTokens: 1000,
    toolResultTokens: 40_000,
    attachmentTokens: 0,
    assistantMessageTokens: 20_000,
    userMessageTokens: 5000,
    toolsByName: [
      { name: 'Bash', callTokens: 100, resultTokens: 30_000 },
      { name: 'Read', callTokens: 50, resultTokens: 9000 },
    ],
  },
};
const CTX_SPARSE = {
  durationMs: 3,
  percentage: 10,
  systemPromptTokens: 100,
  mcpToolTokens: 200,
  memoryFileTokens: 300,
  categories: [],
};
const CTX_ERROR = { durationMs: 1, error: 'タイムアウト' };
const CTX_BARE = { durationMs: 1, totalTokens: 10 };

// 日誌の全種別（と各種別の枝）を1本ずつ。id は積んだ順に id-1, id-2, …
const KINDS: Append[] = [
  /* 1 */ ex('conv-a', 'inbound', 'こんにちは。デプロイの手順を教えて。'),
  /* 2 */ ex('conv-a', 'outbound', '添付を見ます。\n改行を含む返答です。', {
    attachments: [att(1, 'screenshot.png'), att(2, LONG_NAME)],
  }),
  /* 3 */ {
    type: 'exchange',
    with: 'manager',
    role: 'outbound',
    text: 'マネージャーへの依頼',
  } as Append,
  /* 4 */ { type: 'exchange', with: 'self', role: 'outbound', text: '' } as Append,
  /* 5 */ ex('conv-b', 'inbound', '添付が多い発言', {
    attachments: [1, 2, 3, 4, 5, 6, 7].map((n) => att(n)),
    rejectedAttachments: [
      { name: 'huge.bin', reason: '大きすぎる' },
      { name: LONG_NAME, reason: `${'理由が長い。'.repeat(30)}` },
      { name: 'c.txt', reason: '形式が違う' },
      { name: 'd.txt', reason: '同上' },
      { name: 'e.txt', reason: '同上' },
      { name: 'f.txt', reason: '同上' },
    ],
  }),
  /* 6 */ {
    type: 'decision',
    decision: '本番を触らずに待つ',
    grounds: '記憶 deploy-rules',
  } as Append,
  /* 7 */ {
    type: 'decision',
    decision: 'やり方を書き換えた',
    grounds: '人間の依頼',
    target: { kind: 'practice', slug: 'deploy-flow' },
  } as Append,
  /* 8 */ {
    type: 'decision',
    decision: 'task を閉じた',
    grounds: '人間の操作',
    target: { kind: 'task', id: 'task-1' },
    humanAction: {
      kind: 'task_close',
      target: 'task-1',
      via: { kind: 'operator', auth: 'disabled' },
    },
  } as Append,
  /* 9 */ {
    type: 'decision',
    decision: 'practice を消した',
    grounds: '人間の操作',
    target: { kind: 'practice', slug: 'old-flow' },
    humanAction: {
      kind: 'practice_remove',
      target: 'old-flow',
      via: { kind: 'account', accountId: 'acct-1' },
    },
  } as Append,
  /* 10 */ { type: 'escalation', question: '本番へ出してよいか', approvalId: 'ap-1' } as Append,
  /* 11 */ {
    type: 'escalation',
    question: '鍵を回してよいか',
    approvalId: 'ap-2',
    managerId: 'mgr-1',
    answeredAt: '2026-10-26T00:30:00.000Z',
    answer: 'よい',
    answeredVia: { kind: 'operator', auth: 'operator-token' },
  } as Append,
  /* 12 */ {
    type: 'escalation',
    question: '消してよいか',
    approvalId: 'ap-3',
    withdrawnAt: '2026-10-26T00:40:00.000Z',
    withdrawnReason: '状況が変わった',
  } as Append,
  /* 13 */ {
    type: 'escalation',
    question: '止めてよいか',
    approvalId: 'ap-4',
    withdrawnAt: '2026-10-26T00:50:00.000Z',
  } as Append,
  /* 14 */ {
    type: 'tool_use',
    actor: 'clone',
    tool: 'Bash',
    input: { command: 'git status', cwd: '/work' },
  } as Append,
  /* 15 */ { type: 'tool_use', actor: 'clone:sub:abc', tool: 'Read' } as Append,
  /* 16 */ { type: 'tool_use', actor: 'clone', tool: 'Odd', input: 12_345n } as unknown as Append,
  /* 17 */ {
    type: 'memory_update',
    slug: 'deploy-rules',
    cause: 'clone',
    action: 'write',
    bytesBefore: 100,
    bytesAfter: 180,
    summary: '手順を足した',
  } as Append,
  /* 18 */ {
    type: 'memory_update',
    slug: 'old-note',
    cause: 'distill',
    summary: '旧形式の更新',
  } as Append,
  /* 19 */ {
    type: 'daily_report',
    date: '2026-10-25',
    body: '昨日は静かだった。\n改行つきの日報。',
  } as Append,
  /* 20 */ {
    type: 'external_event',
    source: 'github',
    summary: 'PR が閉じられた',
    attachments: [1, 2, 3, 4, 5, 6].map((n) => att(n)),
  } as Append,
  /* 21 */ { type: 'external_event', source: 'cron', summary: '定刻の合図' } as Append,
  /* 22 */ {
    type: 'worker_wait',
    openedAt: '2026-10-26T01:00:00.000Z',
    tasks: 2,
    turns: 5,
    byCause: { input: 1, notification: 3, continuation: 1 },
    toolless: 2,
    notifications: 3,
    submits: 4,
    sources: { human: 1, task: 3 },
    settled: true,
  } as Append,
  /* 23 */ {
    type: 'worker_wait',
    openedAt: '2026-10-26T01:00:00.000Z',
    tasks: 1,
    turns: 1,
    byCause: { input: 0, notification: 1, continuation: 0 },
    toolless: 0,
    notifications: 1,
    submits: 0,
    settled: false,
  } as Append,
  /* 24 */ {
    type: 'turn_usage',
    layer: 'clone',
    site: 'session',
    managerId: 'clone',
    models: {
      'claude-opus': totals(1.2345, 1000, 200, 50_000, 3000),
      'claude-sonnet': totals(0.05, 300, 40),
      'claude-haiku': totals(0.001, 10, 1, 5, 0),
    },
  } as Append,
  /* 25 */ {
    type: 'turn_usage',
    layer: 'manager',
    site: 'distill',
    managerId: 'mgr-1',
    models: {
      'model-a': totals(1, 1, 1),
      'model-b': totals(2, 2, 2, 0, 9),
      'model-c': totals(3, 3, 3),
      'model-d': totals(4, 4, 4),
      'model-e': totals(5, 5, 5),
    },
    reset: { fromCostUsd: 12.5, toCostUsd: 0.5 },
    contextUsage: CTX_FULL,
    compactions: [
      { trigger: 'auto', preTokens: 180_000, postTokens: 30_000 },
      { trigger: 'manual', preTokens: 90_000 },
    ],
  } as Append,
  /* 26 */ {
    type: 'turn_usage',
    layer: 'clone',
    site: 'peer',
    managerId: 'clone',
    models: { 'claude-opus': totals(0.5, 10, 10) },
    contextUsage: CTX_ERROR,
  } as Append,
  /* 27 */ {
    type: 'turn_usage',
    layer: 'clone',
    site: 'session',
    managerId: 'clone',
    models: { 'claude-opus': totals(0.25, 10, 10) },
    contextUsage: CTX_SPARSE,
  } as Append,
  /* 28 */ {
    type: 'context_usage',
    layer: 'clone',
    site: 'session',
    managerId: 'clone',
    turnSucceeded: true,
    contextUsage: CTX_FULL,
  } as Append,
  /* 29 */ {
    type: 'context_usage',
    layer: 'manager',
    site: 'session',
    managerId: 'mgr-1',
    turnSucceeded: false,
    contextUsage: CTX_BARE,
  } as Append,
  /* 30 */ {
    type: 'turn_timing',
    triggers: ['human_message', 'timer'],
    batchSize: 2,
    kinds: ['normal'],
    conversationId: 'conv-a',
    succeeded: true,
    totalMs: 15_400,
    firstTextMs: 2300,
    firstResponseMs: 1800,
    phases: { queue: 500, model: 12_000, 'model.api': 9000, prepare: 900, finalize: 100 },
    tools: {
      count: 4,
      totalMs: 3000,
      top: [
        { name: 'Bash', count: 3, totalMs: 2500, maxMs: 1500 },
        { name: 'Read', count: 1, totalMs: 500, maxMs: 500 },
      ],
    },
    compactions: { count: 1, totalMs: 2000 },
    sdk: { durationMs: 12_000, durationApiMs: 9000, numTurns: 3 },
    contextTokens: 90_000,
    tokens: { input: 100, cacheRead: 80_000, cacheCreation: 5000, output: 400 },
  } as Append,
  /* 31 */ {
    type: 'turn_timing',
    triggers: [],
    batchSize: 0,
    kinds: [],
    succeeded: false,
    totalMs: 80,
    phases: {},
  } as Append,
  /* 32 */ {
    type: 'http_timing',
    windowStartedAt: '2026-10-26T02:00:00.000Z',
    windowMs: 600_000,
    requests: 40,
    routes: [
      {
        route: 'GET /journal',
        count: 30,
        errors: 2,
        p50Ms: 40,
        p90Ms: 900,
        maxMs: 2500,
        totalMs: 8000,
        db: { count: 60, totalMs: 4000, wallMs: 3500, waitMs: 200 },
        serializeMs: 300,
        bytes: 300_000,
        maxBytes: 90_000,
      },
      {
        route: 'GET /health',
        count: 10,
        errors: 0,
        p50Ms: 1,
        p90Ms: 2,
        maxMs: 3,
        totalMs: 20,
        db: { count: 0, totalMs: 0, wallMs: 0, waitMs: 0 },
        serializeMs: 0,
        bytes: 200,
        maxBytes: 20,
      },
    ],
    omittedRoutes: 3,
    slowest: [
      {
        route: 'GET /journal',
        status: 500,
        at: '2026-10-26T02:03:00.000Z',
        totalMs: 2500,
        db: {
          count: 3,
          totalMs: 2000,
          wallMs: 1800,
          waitMs: 0,
          slowestMs: 1500,
          slowestSql: 'SELECT 1',
        },
        serializeMs: 100,
        bytes: 90_000,
      },
    ],
  } as Append,
  /* 33 */ {
    type: 'http_timing',
    windowStartedAt: '2026-10-26T02:10:00.000Z',
    windowMs: 30_000,
    requests: 0,
    routes: [],
    slowest: [],
  } as Append,
  /* 34 */ {
    type: 'token_rotation',
    event: 'rotated',
    signal: 'reached',
    freshness: 'current',
    tokenId: 'tok-2',
    label: '予備',
    generation: 3,
    recoveredSource: 'trial',
    text: '鍵を撒き直した',
  } as Append,
  /* 35 */ {
    type: 'token_rotation',
    event: 'parked',
    tokenId: 'tok-1',
    earliestAt: '2026-10-26T05:00:00.000Z',
    text: '全部の鍵が止まった',
  } as Append,
  /* 36 */ { type: 'token_rotation', event: 'parked', text: '戻る時刻が取れない' } as Append,
  /* 37 */ {
    type: 'token_rotation',
    event: 'exhausted',
    signal: 'quota_rejected',
    earliestAt: '2026-10-26T06:00:00.000Z',
    text: '候補が尽きた',
  } as Append,
  /* 38 */ { type: 'token_rotation', event: 'exhausted', text: 'プールが空' } as Append,
  /* 39 */ {
    type: 'token_rotation',
    event: 'not_rotated',
    signal: 'none',
    freshness: 'stale',
    tokenId: 'tok-1',
    text: '見直したが変えなかった',
  } as Append,
  /* 40 */ {
    type: 'subagent_stall',
    agentId: 'agent-1',
    agentType: 'worker',
    ownedTaskCount: 2,
    sessionTaskCount: 5,
    wakeupCount: 1,
    outcome: 'woken',
    text: '空転したので起こした',
  } as Append,
  /* 41 */ {
    type: 'subagent_stall',
    agentId: 'agent-2',
    ownedTaskCount: 0,
    sessionTaskCount: 0,
    wakeupCount: 3,
    outcome: 'limit_reached',
    text: '再開の上限に達した',
  } as Append,
  /* 42 */ {
    type: 'inbox_flow',
    windowStartedAt: '2026-10-26T03:00:00.000Z',
    arrived: {
      total: 5,
      byType: [
        { type: 'human_message', count: 3 },
        { type: 'timer', count: 2 },
      ],
    },
    delivered: { total: 4, byType: [{ type: 'human_message', count: 4 }] },
    settled: { total: 0, byType: [] },
    pending: { count: 1, oldestAt: '2026-10-26T03:30:00.000Z' },
    retained: { unread: 1, redelivered: 0, pendingCollapse: 2 },
  } as Append,
  /* 43 */ {
    type: 'inbox_flow',
    windowStartedAt: '2026-10-26T03:00:00.000Z',
    arrived: { total: 0, byType: [] },
    delivered: { total: 0, byType: [] },
    settled: { total: 0, byType: [] },
    pending: { count: 0 },
  } as Append,
  /* 44 */ {
    type: 'github_observation',
    observedBy: 'clone',
    repo: 'acme/app',
    query: 'is:open',
    limit: 100,
    result: {
      status: 'ok',
      openIssues: 12,
      openPulls: 3,
      truncated: true,
      ci: { pulls: 3, success: 1, failure: 1, pending: 1, checks: 'build/test' },
    },
  } as Append,
  /* 45 */ {
    type: 'github_observation',
    observedBy: 'clone',
    repo: 'acme/app',
    query: 'is:open',
    result: { status: 'ok', openIssues: 0, openPulls: 0, truncated: false },
  } as Append,
  /* 46 */ {
    type: 'github_observation',
    observedBy: 'manager',
    repo: 'acme/lib',
    query: 'is:open label:bug',
    result: {
      status: 'ok',
      openIssues: 1,
      openPulls: 1,
      truncated: false,
      ciUnavailable: 'checks API が 403',
    },
  } as Append,
  /* 47 */ {
    type: 'github_observation',
    observedBy: 'clone',
    repo: 'acme/app',
    query: 'is:open',
    limit: 50,
    result: { status: 'failed', reason: 'rate limit' },
  } as Append,
  /* 48 */ {
    type: 'conversation_deleted',
    deletedConversationId: 'conv-gone',
    deletedBy: 'operator',
    hiddenCount: 4,
  } as Append,
];

const ALL_TYPES = [
  'exchange',
  'decision',
  'escalation',
  'tool_use',
  'memory_update',
  'daily_report',
  'external_event',
  'worker_wait',
  'turn_usage',
  'token_rotation',
  'subagent_stall',
  'context_usage',
  'turn_timing',
  'http_timing',
  'inbox_flow',
  'github_observation',
  'conversation_deleted',
];

async function seedKinds(s: Seeder): Promise<void> {
  for (const [index, entry] of KINDS.entries()) await s.put(index, entry);
}

// 窓・絞り・件数の場面で使う、種別の混ざった小さな日誌。1日ごとに3日ぶん（語の検索の窓の境目をまたぐ）
async function seedMixed(s: Seeder): Promise<Anchors> {
  const first = await s.put(
    0,
    ex('conv-a', 'inbound', 'デプロイの手順を教えて。Deploy が止まる。'),
  );
  await s.put(1, ex('conv-a', 'outbound', 'まず build を回してから push します。'));
  await s.put(2, {
    type: 'tool_use',
    actor: 'clone',
    tool: 'Bash',
    input: { command: 'deploy --dry-run' },
  } as Append);
  await s.put(3, {
    type: 'decision',
    decision: '待つ',
    grounds: 'deploy は止まっている',
  } as Append);
  await s.put(4, { type: 'exchange', with: 'manager', role: 'inbound', text: '委譲の往復トマト' });
  await s.put(DAY, ex('conv-b', 'inbound', '別の日の質問。deploy の続き。'));
  await s.put(DAY + 1, {
    type: 'tool_use',
    actor: 'clone',
    tool: 'Read',
    input: { path: '/a' },
  } as Append);
  await s.put(DAY + 2, {
    type: 'tool_use',
    actor: 'clone',
    tool: 'Grep',
    input: { q: 'x' },
  } as Append);
  await s.put(2 * DAY, {
    type: 'memory_update',
    slug: 'deploy-rules',
    cause: 'clone',
    action: 'append',
    bytesBefore: 10,
    bytesAfter: 20,
    summary: 'deploy の注意を足した',
  } as Append);
  const last = await s.put(2 * DAY + 60, ex(undefined, 'inbound', '会話 id の無い発言 Deploy'));
  return { first, last };
}

// 語の検索の予算の場面用。「いま」（FROZEN_NOW = 基準から 3 日後 = 4320 分）から 1 日ずつ遡る窓は
//   1 つ目 [2880, 4320]（昨日の 2 行）・2 つ目 [1440, 2879]（2000 分の行）・3 つ目 [0, 1439]（最古の行で探し切る）
async function seedOwl(s: Seeder): Promise<void> {
  await s.put(0, ex('conv-a', 'inbound', 'ふくろう とても古い'));
  await s.put(1, ex('conv-a', 'outbound', '当たらない行'));
  await s.put(2000, ex('conv-b', 'inbound', 'ふくろう 二つ目の窓'));
  await s.put(3000, ex('conv-b', 'outbound', '昨日の発言'));
  await s.put(4000, ex('conv-b', 'inbound', '昨日の遅い発言'));
}

const LONG_BODY = '長い発言本文。'.repeat(40);

// 予算（8,000字）を越える日誌。長い発言を 60 行
async function seedBig(s: Seeder): Promise<void> {
  for (let i = 0; i < 60; i += 1) {
    await s.put(i, ex(`conv-${String(i % 4)}`, 'inbound', `[msg-${String(i)}] ${LONG_BODY}`));
  }
}

function continuation(text: string | undefined): { id: string; at: string } {
  const found = /afterId=(\S+) afterAt=(\S+)/.exec(text ?? '');
  if (found?.[1] === undefined || found[2] === undefined) {
    throw new Error('出力に続きの位置が無い');
  }
  return { id: found[1], at: found[2] };
}

function offsetOf(text: string | undefined): number {
  const found = /offset=(\d+)/.exec(text ?? '');
  if (found?.[1] === undefined) throw new Error('出力に続きの offset が無い');
  return Number(found[1]);
}

/** 直前の出力の続きの位置を、同じ絞りと一緒に次の呼びへ渡す */
function next(extra: Args, order?: 'asc'): Step['args'] {
  return (previous) => {
    const { id, at } = continuation(previous[previous.length - 1]);
    return { ...extra, afterId: id, afterAt: at, ...(order === undefined ? {} : { order }) };
  };
}

const SCENARIOS: Scenario[] = [
  // ---- 引数の検査 ----
  {
    name: 'arg-errors',
    covers:
      'limit／offset の範囲の外・整数でない・q と order=asc の組・since／until が読めない・afterId／afterAt の片方だけ・afterAt が日時でない・検査の優先順（日誌は読んでいない）',
    seed: seedMixed,
    steps: [
      { args: { limit: 0 } },
      { args: { limit: 201 } },
      { args: { limit: 1.5 } },
      { args: { offset: -1 } },
      { args: { offset: 1.5 } },
      { args: { limit: 0, offset: -1 } },
      { args: { limit: 0, since: 'not-a-datetime' } },
      { args: { q: 'deploy', order: 'asc' } },
      { args: { q: 'deploy', order: 'asc', since: 'not-a-datetime' } },
      { args: { since: 'not-a-datetime' } },
      { args: { until: 'not-a-datetime' } },
      { args: { since: 'not-a-datetime', until: 'also-bad' } },
      { args: { since: '2026-13-45' } },
      { args: { since: '' } },
      { args: { afterId: 'id-1' } },
      { args: { afterAt: iso(0) } },
      { args: { afterId: 'id-1', afterAt: 'ひどい日時' } },
      { args: { afterId: 'id-1', since: 'not-a-datetime' } },
    ],
  },
  // ---- id（1件を全文で） ----
  {
    name: 'id-kinds',
    covers:
      '全種別（17 種・各種別の枝）を id で全文読み: exchange の相手・添付と受け取れなかった添付（全件）・本文が空・decision の宛先と人間の操作・escalation の4状態・tool_use の入力（object／無し／JSON にならない値）・memory_update の旧形式・turn_usage の内訳・文脈・compaction・context_usage・turn_timing・http_timing・token_rotation の各 event・subagent_stall・inbox_flow・github_observation・conversation_deleted',
    seed: seedKinds,
    steps: KINDS.map((_, index) => ({ args: { id: `id-${String(index + 1)}` } })),
  },
  {
    name: 'id-paged',
    covers:
      '長い本文の頁（先頭・続き・最後の頁・ちょうど頁の境目・範囲外・小数の offset は断る）・続きの案内',
    seed: async (s) => {
      await s.put(
        0,
        ex(
          'conv-long',
          'inbound',
          `先頭の目印${'あ'.repeat(10_000)}末尾の目印${'い'.repeat(9000)}`,
        ),
      );
      await s.put(1, ex('conv-long', 'outbound', 'ち'.repeat(8000)));
    },
    steps: [
      { args: { id: 'id-1' } },
      { args: (p) => ({ id: 'id-1', offset: offsetOf(p[0]) }) },
      { args: (p) => ({ id: 'id-1', offset: offsetOf(p[1]) }) },
      { args: { id: 'id-1', offset: 99_999 } },
      { args: { id: 'id-1', offset: 19_000 } },
      { args: { id: 'id-2' } },
      { args: { id: 'id-2', offset: 7999 } },
      { args: { id: 'id-2', offset: 0.5 } },
    ],
  },
  {
    name: 'id-lookup',
    covers:
      '無い id・在るが読めない行（UnreadableJournalEntryError）・消した会話の発言（無い扱い）・id を渡すと他の条件（q・order=asc・types・不正な since・afterId の片方）を無視する',
    seed: async (s) => {
      await s.put(0, ex('conv-x', 'inbound', '消す会話の発言'));
      await s.put(1, ex('conv-y', 'inbound', '残る会話の発言。deploy'));
      await s.put(2, {
        type: 'conversation_deleted',
        deletedConversationId: 'conv-x',
        deletedBy: 'operator',
        hiddenCount: 1,
      } as Append);
    },
    wrap: (stores) => ({
      ...stores,
      journal: {
        ...stores.journal,
        get: (id: string) =>
          id === 'bad-1'
            ? Promise.reject(new UnreadableJournalEntryError({ id }))
            : stores.journal.get(id),
      },
    }),
    steps: [
      { args: { id: 'no-such-id' } },
      { args: { id: 'bad-1' } },
      { args: { id: 'id-1' } },
      { args: { id: 'id-2' } },
      {
        args: {
          id: 'id-2',
          q: 'x',
          order: 'asc',
          types: ['decision'],
          since: 'not-a-datetime',
          afterId: 'id-1',
        },
      },
    ],
  },
  // ---- 一覧: 種別 ----
  {
    name: 'list-kinds',
    covers:
      '種別ごとの一覧の見出しと抜粋（types を1つずつ）・turn_usage のモデル行（3 本まで・ほか N モデル・残りの行）・添付の「ほか N 件」・全種別の一覧の予算での省略・asc／desc',
    seed: seedKinds,
    steps: [
      ...ALL_TYPES.map((type) => ({ args: { types: [type] } })),
      { args: { limit: 200 } },
      { args: { limit: 200, order: 'asc' } },
      { args: { types: ['exchange', 'decision', 'escalation'], order: 'asc' } },
    ],
  },
  // ---- 一覧: 基本と窓・絞り ----
  {
    name: 'list-basic',
    covers:
      '既定の一覧（新しい順・件数の既定 20）・limit・order=asc・since／until の窓（秒の省略・オフセット付きの正規化）・types／with の絞り・tool_use の注記（全種別・tool_use と他・tool_use だけ・重複指定・件数が0）・q 空は絞らない',
    seed: seedMixed,
    steps: [
      { args: {} },
      { args: { limit: 3 } },
      { args: { limit: 3, order: 'asc' } },
      { args: { limit: 1 } },
      { args: { since: iso(DAY) } },
      { args: { until: iso(5) } },
      { args: { since: '2026-10-26T00:02Z', until: '2026-10-26T00:04:30+00:00' } },
      { args: { since: '2026-10-26T09:00:00+09:00', until: iso(DAY + 2) } },
      { args: { since: iso(0), order: 'asc', limit: 4 } },
      { args: { types: ['decision'] } },
      { args: { types: ['tool_use'] } },
      { args: { types: ['tool_use', 'tool_use'] } },
      { args: { types: ['tool_use', 'decision'] } },
      { args: { types: ['exchange'], with: ['human'] } },
      { args: { with: ['manager'] } },
      { args: { with: ['human', 'manager'], order: 'asc' } },
      { args: { types: ['decision', 'tool_use'], with: ['human'] } },
      { args: { q: '' } },
      { args: { q: '', order: 'asc', limit: 2 } },
    ],
  },
  {
    name: 'list-empty',
    covers:
      '日誌が空（まだ空）・条件つきで空（その条件に当たる日誌は無い）・types／with が空配列（0件の契約）・窓が日誌の最古より前（判定できない）・窓がまるごと最古より後（言い切れる）・q 空で空',
    steps: [
      { args: {} },
      { args: { limit: 5, order: 'asc' } },
      { args: { since: iso(0) } },
      { args: { types: [] } },
      { args: { q: '' } },
      { args: { q: '', since: iso(0) } },
    ],
  },
  {
    name: 'list-empty-seeded',
    covers:
      '日誌は在るが条件に当たる行が無い・types／with が空配列・窓が最古より前にかかる（判定できない・since 指定／until のみ）・窓が最古より後で空（注記なし）・since が最古ちょうど',
    seed: seedMixed,
    steps: [
      { args: { types: ['daily_report'] } },
      { args: { types: [] } },
      { args: { with: [] } },
      { args: { with: ['self'] } },
      { args: { since: '2099-01-01T00:00:00.000Z' } },
      { args: { until: '2020-01-01T00:00:00.000Z' } },
      { args: { since: '2020-01-01T00:00:00.000Z', until: '2020-02-01T00:00:00.000Z' } },
      { args: { since: iso(0), types: ['daily_report'] } },
      { args: { since: iso(10), types: ['daily_report'] } },
    ],
  },
  {
    name: 'list-horizon',
    covers:
      '日誌の最古の注記: 窓の始点が最古より前（非空・since を名乗る）・until だけ（それより前は）・始点が最古以降（注記なし）・秒省略の since',
    seed: seedMixed,
    steps: [
      { args: { since: '2020-01-01', limit: 2 } },
      { args: { until: iso(DAY) } },
      { args: { since: iso(1), until: iso(DAY) } },
      { args: { since: '2026-10-26T00:00Z', limit: 1 } },
      { args: { since: '2026-10-25T23:59Z', until: iso(2), order: 'asc' } },
    ],
  },
  // ---- 一覧: 頁送り ----
  {
    name: 'list-paging',
    covers:
      'afterId／afterAt の頁送り（新しい順・古い順・絞りを引き継ぐ）・最後の頁（続きの行が出ない）・位置より先に行が無い（日誌が空なのではない・新しい側／古い側）・since があるときは別の言い方・types を引き継ぐ',
    seed: seedMixed,
    steps: [
      { args: { limit: 4 } },
      { args: next({ limit: 4 }) },
      { args: next({ limit: 4 }) },
      { args: (_p, a) => ({ afterId: a.first!.id, afterAt: a.first!.at }) },
      { args: (_p, a) => ({ afterId: a.last!.id, afterAt: a.last!.at, order: 'asc' }) },
      { args: (_p, a) => ({ afterId: a.first!.id, afterAt: a.first!.at, since: iso(0) }) },
      { args: { limit: 4, order: 'asc' } },
      { args: next({ limit: 4 }, 'asc') },
      { args: next({ limit: 4 }, 'asc') },
      { args: { limit: 2, types: ['exchange'] } },
      { args: next({ limit: 2, types: ['exchange'] }) },
      { args: next({ limit: 2, types: ['exchange'] }) },
    ],
  },
  {
    name: 'list-cursor-errors',
    covers:
      '錨が見つからない（id が違う・at が違う・両方・q つき・asc）・afterAt が実在の行の時刻でも id が違えば判定できない',
    seed: seedMixed,
    steps: [
      { args: { afterId: 'id-9999', afterAt: iso(0) } },
      { args: { afterId: 'id-1', afterAt: iso(999) } },
      { args: { afterId: 'id-9999', afterAt: iso(0), q: 'deploy' } },
      { args: { afterId: 'id-9999', afterAt: iso(0), order: 'asc' } },
      { args: { afterId: 'id-2', afterAt: iso(0) } },
    ],
  },
  {
    name: 'list-unreadable-page',
    covers:
      '読めない行を捨てて頁が短くなった器（ストアが続きを言っている）: 空の頁（読めない行だけ・新しい／古い側・窓の注記つき）・短くなった非空の頁（続きの位置は next）・q（窓で区切る検索）でも同じ',
    seed: seedMixed,
    wrap: dropLastRowPerPage,
    steps: [
      { args: { limit: 1 } },
      { args: { limit: 1, order: 'asc' } },
      { args: { limit: 1, since: '2020-01-01' } },
      { args: { limit: 1, since: iso(1), order: 'asc' } },
      { args: { limit: 3 } },
      { args: { limit: 3, order: 'asc' } },
      { args: { limit: 1, q: 'deploy' } },
      { args: { limit: 3, q: 'deploy' } },
    ],
  },
  {
    name: 'list-conv-legend',
    covers:
      '会話の凡例（2 件以上の会話 id だけ conv#N の札にして先頭に凡例の行・札の番号は一覧に出る順・1 件だけの会話 id はそのまま・会話 id の無い発言・manager／self の往復）と、id 読みでは札にしない',
    seed: async (s) => {
      await s.put(0, ex('conv-aaa', 'inbound', 'a1'));
      await s.put(1, ex('conv-bbb', 'inbound', 'b1'));
      await s.put(2, ex('conv-aaa', 'outbound', 'a2'));
      await s.put(3, ex('conv-solo', 'inbound', 's1'));
      await s.put(4, ex(undefined, 'inbound', 'n1'));
      await s.put(5, ex('conv-bbb', 'outbound', 'b2'));
      await s.put(6, ex('conv-aaa', 'inbound', 'a3'));
      await s.put(7, { type: 'exchange', with: 'manager', role: 'inbound', text: 'm1' });
    },
    steps: [
      { args: {} },
      { args: { order: 'asc' } },
      { args: { limit: 2 } },
      { args: { types: ['exchange'], with: ['human'], limit: 5 } },
      { args: { id: 'id-3' } },
    ],
  },
  // ---- 一覧: 予算 ----
  {
    name: 'list-budget',
    covers:
      '予算（8,000字）での打ち切り（ほか N 件は省略・新しい順／古い順の言い方・asc では q を勧めない・省略した行から読み継ぐ cursor＝表示した最後の行）・件数が埋まって next がある回の cursor・予算に収まる limit・読み継いだ続き・tool_use の注記',
    seed: seedBig,
    steps: [
      { args: { limit: 200 } },
      { args: next({ limit: 200 }) },
      { args: { limit: 200, order: 'asc' } },
      { args: next({ limit: 200 }, 'asc') },
      { args: { limit: 5 } },
      { args: { limit: 60 } },
      { args: { limit: 20, order: 'asc' } },
    ],
  },
  {
    name: 'list-budget-single',
    covers:
      '1件だけで予算を越える行は丸ごと落とさず excerpt で切る（その1件は全文字数つき）・続きの案内',
    seed: async (s) => {
      await s.put(0, ex('conv-a', 'inbound', '手前の発言'));
      await s.put(1, {
        type: 'escalation',
        question: '長い id の承認',
        approvalId: `ap-${'x'.repeat(9000)}`,
      } as Append);
      await s.put(2, ex('conv-a', 'inbound', '奥の発言'));
    },
    steps: [
      { args: { limit: 1, types: ['escalation'] } },
      { args: { limit: 2 } },
      { args: { limit: 3 } },
    ],
  },
  {
    name: 'list-budget-tool-use',
    covers:
      'tool_use が多い日誌の注記（今回の N 件中 M 件・予算で省略された回は shown ではなく取れた件数で数える）と types=tool_use のときは注記なし',
    seed: async (s) => {
      for (let i = 0; i < 60; i += 1) {
        await s.put(i, {
          type: 'tool_use',
          actor: 'clone',
          tool: 'Bash',
          input: { command: `echo ${String(i)} ${'あ'.repeat(200)}` },
        } as Append);
      }
      await s.put(60, { type: 'decision', decision: '最新の判断', grounds: '根拠' } as Append);
    },
    steps: [
      { args: { limit: 100 } },
      { args: { limit: 100, types: ['tool_use'] } },
      { args: { limit: 100, order: 'asc' } },
    ],
  },
  // ---- q（語の検索。窓で区切って遡る） ----
  {
    name: 'q-search',
    covers:
      '語の検索（大文字小文字を区別しない部分一致・窓をまたいで遡る・複数の日にまたがる当たり）・types／with／since／until との併用・limit で件数が埋まる（続きの cursor・日をまたぐ前に埋まる）・探索対象に入らない欄の語（tool_use の input）は当たらない・当たらない語（日誌の先頭まで探した／since まで探した）・q と afterId',
    seed: seedMixed,
    search: { clockStep: 0 },
    steps: [
      { args: { q: 'deploy' } },
      { args: { q: 'DEPLOY', limit: 2 } },
      { args: next({ q: 'DEPLOY', limit: 2 }) },
      { args: { q: 'deploy', limit: 3 } },
      { args: { q: 'deploy', types: ['exchange'] } },
      { args: { q: 'deploy', with: ['human'] } },
      { args: { q: 'deploy', since: iso(DAY) } },
      { args: { q: 'deploy', until: iso(DAY - 1) } },
      { args: { q: 'deploy', since: iso(0), until: iso(DAY + 5) } },
      { args: { q: 'deploy', types: ['decision'], with: ['human'] } },
      { args: { q: '存在しない語' } },
      { args: { q: '存在しない語', since: iso(0) } },
      { args: { q: '存在しない語', since: '2020-01-01' } },
      { args: { q: '存在しない語', types: [] } },
      { args: { q: '--dry-run' } },
      { args: { q: 'トマト' } },
      { args: (_p, a) => ({ q: 'deploy', afterId: a.last!.id, afterAt: a.last!.at }) },
      { args: { q: 'deploy', afterId: 'id-9999', afterAt: iso(0) } },
    ],
  },
  {
    name: 'q-default-search',
    covers:
      '語の検索の口（journalSearch）を渡さない器: 本物の時計と、固定の Date の「いま」で、予算内に探し切る',
    seed: seedMixed,
    steps: [
      { args: { q: 'deploy' } },
      { args: { q: '存在しない語' } },
      { args: { q: 'deploy', since: iso(0) } },
    ],
  },
  {
    name: 'q-empty-journal',
    covers: '日誌が空のときの語の検索（oldestAt が無い・探し切った0件）',
    search: { clockStep: 0 },
    steps: [{ args: { q: 'deploy' } }, { args: { q: 'deploy', since: iso(0) } }],
  },
  {
    name: 'q-budget-zero',
    covers:
      '時間の予算を使い切った語の検索: 0件で打ち切り（この窓には無い・判定できない・続きの until）・since つき・until つき（窓の上端が until）・当たる語が窓の外（古い側）にだけある',
    seed: seedOwl,
    search: { clockStep: 10_000 },
    steps: [
      { args: { q: 'ふくろう' } },
      { args: { q: '当たらない語', since: iso(0) } },
      { args: { q: 'ふくろう', until: iso(DAY + 10) } },
    ],
  },
  {
    name: 'q-budget-hits',
    covers:
      '時間の予算を使い切ったが当たりがある語の検索: 最初の行に未探索の範囲・当たった行は一覧に出る・limit が小さく窓の中で件数が埋まる（打ち切りの名乗りは出ず cursor）・types／with 併用・since が最古の窓で探し切る',
    seed: seedOwl,
    search: { clockStep: 10_000 },
    steps: [
      { args: { q: '昨日' } },
      { args: { q: '昨日', limit: 1 } },
      { args: { q: '昨日', types: ['exchange'], with: ['human'] } },
      { args: { q: '昨日', since: iso(2900) } },
    ],
  },
  {
    name: 'q-budget-seconds',
    covers: '予算 2.5 秒は「3 秒」に丸めて名乗る（0件・当たりあり。2 つ目の窓の終わりで使い切る）',
    seed: seedOwl,
    search: { clockStep: 1500, budgetMs: 2500 },
    steps: [{ args: { q: 'ふくろう' } }, { args: { q: '当たらない語' } }],
  },
  {
    name: 'q-budget-second-slice',
    covers:
      '最初の窓では打ち切らず、2つ目の窓を終えたところで予算を使い切る（当たりのある窓を探した範囲に含む）',
    seed: seedOwl,
    search: { clockStep: 4000, budgetMs: 8000 },
    steps: [{ args: { q: 'ふくろう' } }, { args: { q: '当たらない語' } }],
  },
  {
    name: 'q-budget-slice-wide',
    covers: '窓の幅を広げる（sliceMs）と最古まで 1 窓で探し切れる（予算は使い切らない）',
    seed: seedOwl,
    search: { clockStep: 10_000, sliceMs: 10 * DAY * 60_000 },
    steps: [{ args: { q: 'ふくろう' } }, { args: { q: '当たらない語' } }],
  },
  // ---- 畳み・サブエージェント ----
  {
    name: 'fold-ignored',
    covers:
      '畳みの口（foldFixed）を渡しても、2 回目も全文のまま（journal_read は固定文を畳まない）',
    fold: true,
    seed: seedMixed,
    steps: [
      { args: { limit: 3 } },
      { args: { limit: 3 } },
      { args: { q: 'deploy' } },
      { args: { q: 'deploy' } },
      { args: { id: 'id-1' } },
      { args: { id: 'id-1' } },
    ],
  },
  {
    name: 'subagent-ignored',
    covers: 'サブエージェントの呼びも出力は変わらない（畳みの口があっても全文のまま）',
    fold: true,
    subagent: true,
    seed: seedMixed,
    steps: [{ args: { limit: 3 } }, { args: { limit: 3 } }, { args: { id: 'id-1' } }],
  },
];

function stepKey(scenario: Scenario, index: number): string {
  return scenario.steps.length === 1 ? scenario.name : `${scenario.name}#${String(index + 1)}`;
}

const ALL_KEYS: string[] = SCENARIOS.flatMap((scenario) =>
  scenario.steps.map((_, index) => stepKey(scenario, index)),
);

async function runScenario(scenario: Scenario): Promise<string[]> {
  const base = createMemoryStores();
  const seeder: Seeder = {
    stores: base,
    put: async (minute, entry) => {
      vi.setSystemTime(new Date(iso(minute)));
      const row = await base.journal.append(entry);
      return { id: row.id, at: row.at };
    },
  };
  const anchors = (await scenario.seed?.(seeder)) ?? {};
  vi.setSystemTime(new Date(FROZEN_NOW));
  const stores = scenario.wrap === undefined ? base : scenario.wrap(base);
  const delta = scenario.fold === true ? new DigestSessionDelta() : null;
  const search = scenario.search;
  let ticks = 0;
  const tools = createCloneTools({
    stores,
    emit: () => undefined,
    memoryCause: () => 'clone',
    conversationId: () => undefined,
    ...(search === undefined
      ? {}
      : {
          journalSearch: {
            now: () => new Date(FROZEN_NOW),
            clock: () => {
              ticks += search.clockStep;
              return ticks;
            },
            ...(search.budgetMs === undefined ? {} : { budgetMs: search.budgetMs }),
            ...(search.sliceMs === undefined ? {} : { sliceMs: search.sliceMs }),
          },
        }),
    ...(delta === null
      ? {}
      : {
          foldFixed: (id: string, full: string, ref: string, supersedes?: string) =>
            delta.fixedInTurn(id, full, ref, supersedes),
        }),
    ...(scenario.subagent === true ? { isSubagentCall: () => true } : {}),
  });
  const found = tools.find((entry) => entry.name === 'journal_read');
  if (!found) throw new Error('journal_read が無い');
  const outputs: string[] = [];
  for (const step of scenario.steps) {
    const args = typeof step.args === 'function' ? step.args(outputs, anchors) : (step.args ?? {});
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

describe('journal_read の出力の固定（場面ごとの全文と字数）', () => {
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
    expect(text('arg-errors#1')).toContain('limit 0 は使えない');
    expect(text('arg-errors#8')).toContain('order=asc とは合わない');
    expect(text('arg-errors#10')).toContain('since に渡された');
    expect(text('arg-errors#15')).toContain('afterId と afterAt は両方一緒に渡す');
    expect(text('arg-errors#17')).toContain('日時として読めない');
    expect(text('id-kinds#5')).toContain('rejectedAttachments=[');
    expect(text('id-kinds#5')).toContain('id=att-7');
    expect(text('id-kinds#7')).toContain('practice=deploy-flow');
    expect(text('id-kinds#8')).toContain('humanAction=task_close target=task-1');
    expect(text('id-kinds#10')).toContain('未回答');
    expect(text('id-kinds#11')).toContain('回答済み');
    expect(text('id-kinds#12')).toContain('状況が変わった');
    expect(text('id-kinds#13')).toContain('理由の記録なし');
    expect(text('id-kinds#15')).toContain('undefined');
    expect(text('id-kinds#16')).toContain('12345');
    expect(text('id-kinds#18')).toContain('bytes=不明(旧形式)');
    expect(text('id-kinds#25')).toContain('⚠reset');
    expect(text('id-kinds#25')).toContain('[分類なし]');
    expect(text('id-kinds#26')).toContain('測れなかった');
    expect(text('id-kinds#34')).toContain('src=trial');
    expect(text('id-kinds#35')).toContain('撒いた鍵は 2026-10-26T05:00:00.000Z まで通らない');
    expect(text('id-kinds#36')).toContain('通るようになる時刻が取れていない');
    expect(text('id-kinds#37')).toContain('いちばん早く戻る');
    expect(text('id-kinds#38')).toContain('候補が1本も無い');
    expect(text('id-kinds#42')).toContain('残存: unread=1');
    expect(text('id-kinds#43')).toContain('（無し）');
    expect(text('id-kinds#44')).toContain('limit に達した');
    expect(text('id-kinds#47')).toContain('取れなかった: rate limit');
    expect(text('id-kinds#48')).toContain('会話 conv-gone を削除した');
    expect(text('id-paged#1')).toContain('ここで切れている');
    expect(text('id-paged#4')).toContain('末尾を越えている');
    expect(text('id-lookup#2')).toContain('在るが読めない');
    expect(text('id-lookup#3')).toContain('は無い');
    expect(text('list-kinds#1')).toContain('ほか 2 件（全件は journal_read id=<id>）');
    expect(text('list-kinds#9')).toContain('…ほか 2 モデル');
    expect(text('list-basic#1')).toContain('tool_use が今回の');
    expect(text('list-basic#11')).not.toContain('tool_use が今回の');
    expect(text('list-basic#12')).not.toContain('tool_use が今回の');
    expect(text('list-basic#13')).toContain('tool_use が今回の');
    expect(text('list-empty#1')).toBe('（日誌はまだ空）');
    expect(text('list-empty-seeded#1')).toBe('（その条件に当たる日誌は無い）');
    expect(text('list-empty-seeded#6')).toContain('それより前は判定できない');
    expect(text('list-horizon#1')).toContain('指定の since（2020-01-01T00:00:00.000Z）');
    expect(text('list-paging#1')).toContain('続きは journal_read afterId=');
    expect(text('list-paging#3')).not.toContain('続きは');
    expect(text('list-paging#4')).toContain('この位置より先（古い側）');
    expect(text('list-paging#5')).toContain('この位置より先（新しい側）');
    expect(text('list-paging#7')).toContain('order=asc');
    expect(text('list-cursor-errors#1')).toContain('続きの位置は判定できない');
    expect(text('list-unreadable-page#1')).toContain('読めない形の行だけ');
    expect(text('list-unreadable-page#2')).toContain('さらに新しい側');
    expect(text('list-conv-legend#1')).toContain('（conv#1 = conversation conv-aaa）');
    expect(text('list-conv-legend#1')).toContain('conversation=conv-solo');
    expect(text('list-conv-legend#5')).not.toContain('conv#');
    expect(text('list-budget#1')).toContain('件は省略');
    expect(text('list-budget#1')).toContain('q を指定する');
    expect(text('list-budget#3')).toContain('古い順に');
    expect(text('list-budget#3')).not.toContain('q を指定する');
    expect(text('list-budget-single#1')).toContain('文字省略。全');
    expect(text('list-budget-tool-use#1')).toContain('件は省略');
    expect(text('list-budget-tool-use#1')).toContain('tool_use が今回の');
    expect(text('list-budget-tool-use#2')).not.toContain('tool_use が今回の');
    expect(text('q-search#12')).toContain('since=2026-10-26T00:00:00.000Z まで探した');
    expect(text('q-search#15')).toContain('（日誌の先頭まで探した）');
    expect(text('q-search#3')).toContain('続きは journal_read afterId=');
    expect(text('q-budget-zero#1')).toContain('には無い（判定できない）');
    expect(text('q-budget-hits#1')).toContain('時間の予算（8 秒）を使い切った。');
    expect(text('q-budget-seconds#1')).toContain('時間の予算（3 秒）');
    expect(text('q-budget-slice-wide#1')).not.toContain('時間の予算');
    expect(text('fold-ignored#2')).toBe(text('fold-ignored#1'));
    expect(text('fold-ignored#4')).toBe(text('fold-ignored#3'));
    expect(text('fold-ignored#6')).toBe(text('fold-ignored#5'));
    expect(text('subagent-ignored#2')).toBe(text('subagent-ignored#1'));
  });
});
