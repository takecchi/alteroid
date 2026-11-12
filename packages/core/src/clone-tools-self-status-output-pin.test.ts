import { readFileSync, writeFileSync } from 'node:fs';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { ManagerPool, RunnerFleetOverview } from './manager.js';
import { heuristicChars } from './quantity.js';
import type { CloneRuntimeFacts } from './self.js';
import type { Stores } from './store.js';
import { createMemoryStores } from './testing.js';
import { createCloneTools, type ToolContext } from './tools.js';
import { encodeUsageCursor } from './usage-cursor.js';

// `self_status` の出力（全文と字数）と、呼びの並び（`persona.list`・`persona.documents`・`usage.aggregate`・`codexAuth.get`・
// `journal.list`〈渡した types と limit〉・`context.runtime`・`context.runnerModels`・`context.runnerAnthropicRoutes`・
// マネージャーへの問い合わせ `managers.runners`）を、場面ごとにコミットした固定値
// （clone-tools-self-status-output-pin.json）と丸ごと比べる。
// `clone-tools-self.ts` の `tool('self_status', …)`（約 78 行・入れ子 8 段の式）を小さな関数へ分けるとき、
// 振る舞いが1文字も変わらないことを機械で確かめる歯。固定値の側で値を伏せず、入力（時計・id・時刻・並び）を固定して毎回同じにする。
// この道具は読むだけ: 出力と呼びの並びに加えて、呼ぶ前と後で記憶・日誌・台帳・Codex の認証が変わらないこと、
// 読みの口（上の5つ）以外の store の関数・マネージャーの別の口を呼ばないことも固定する。
//   - output: 道具の出力の全文と字数（isError・例外で返ったか・例外の名前）
//   - calls: 呼びの並び（呼んだ順）。`persona.list() -> 3 docs` のように、呼び・引数・結果の要約を1行にする。投げたら threw
//   - wrote / writeCalls: 記憶・日誌・台帳・Codex の認証が呼ぶ前から変わったか・読みの口以外の呼び。どの場面も false / 空
//
// 固定値の作り直し（意図して出力・呼びを変えたときだけ。PR 本文に理由を書く）:
//   UPDATE_SELF_STATUS_PIN=1 pnpm -C <作業ツリー> --filter @alteroid/core exec vitest run src/clone-tools-self-status-output-pin.test.ts --maxWorkers=2
//   pnpm -C <作業ツリー> exec prettier --write packages/core/src/clone-tools-self-status-output-pin.json
// 手で json を書き換えない。作り直したら `git diff` で、どの場面の出力が何字から何字に動いたかを読む。
// json の先頭の `lengths` が場面ごとの出力の字数の一覧（どの場面が何字を出しているかを見る基準）。
//
// 時計は Date だけを固定する（`setTimeout` などは本物のまま。実時間の待ちは使わない）。「焼かれてからの経過」は固定した現在時刻から出る。
// この道具の出力は環境変数に左右されない（実行時の事実は `context.runtime()` が渡し、モデルの別名の行も `context.*` が渡す）ので `vi.stubEnv` は要らない。
// 台帳の集計は `usage.record(accumulation: 'oneshot')` で積む。日誌の行は積むたびに時計を動かして `at` を決める（id は連番）。

type Args = Record<string, unknown>;
type ArgsOf = Args | ((previousTexts: string[]) => Args);

interface Step {
  args: ArgsOf;
  /** この呼びの前に、記憶・台帳・日誌へ仕込みを足す（読むだけの確認の「前」より前に走る） */
  before?: (stores: Stores) => Promise<void>;
}

interface DocSeed {
  slug: string;
  content: string;
}

interface UsageSeed {
  managerId: string;
  model: string;
  costUsd: number;
  layer?: 'clone' | 'manager';
  site?: 'session' | 'distill' | 'peer';
  /** 台帳の `at`（BASE からの分）。既定 0 */
  minute?: number;
}

type FailKey =
  | 'persona.list'
  | 'persona.documents'
  | 'usage.aggregate'
  | 'codexAuth.get'
  | 'journal.turn_timing'
  | 'journal.http_timing';

type RunnerLines = 'absent' | 'throws' | readonly string[];

type Managers = 'absent' | 'throws' | { runners: unknown[] };

interface Scenario {
  name: string;
  /** 通る分岐の覚え書き（読み手のため。判定には使わない） */
  covers: string;
  /** `context.runtime` が返す事実。`'absent'` は `context.runtime` が undefined を返す（記憶へ移す内部ターン） */
  runtime: CloneRuntimeFacts | 'absent';
  docs?: DocSeed[];
  usage?: UsageSeed[];
  codex?: 'none' | 'valid' | 'valid-bare' | 'failed';
  turnTiming?: Record<string, unknown>[];
  httpTiming?: Record<string, unknown>[];
  runnerModels?: RunnerLines;
  runnerRoutes?: RunnerLines;
  managers?: Managers;
  /** 投げさせる読みの口 */
  fail?: FailKey[];
  steps: Step[];
}

const BASE_ISO = '2026-10-27T12:00:00.000Z';
const PIN_URL = new URL('./clone-tools-self-status-output-pin.json', import.meta.url);
const UPDATE = process.env.UPDATE_SELF_STATUS_PIN === '1';

function iso(minutesFromBase: number): string {
  return new Date(Date.UTC(2026, 9, 27, 0, 0, 0) + minutesFromBase * 60_000).toISOString();
}

function pad3(value: number): string {
  return String(value).padStart(3, '0');
}

// ---- 実行時の事実 ----

const RT_UNOBSERVED: CloneRuntimeFacts = {
  revision: { commit: null, short: null, source: null },
  buildTime: { builtAt: null },
  declaredModel: 'fable',
  modelOverridden: false,
  modelEnvKey: 'ALTEROID_CLONE_MODEL',
  sdkModel: null,
  effort: null,
  requestedEffort: null,
  claudeCodeVersion: null,
  apiKeySource: null,
  permissionMode: null,
  requestedPermissionMode: 'auto',
  mcpServers: null,
  sessionId: null,
  resumedFrom: null,
  injectedMemoryChars: heuristicChars(0),
  systemPromptChars: heuristicChars(0),
  lastContextUsage: null,
};

const MODEL = 'claude-opus-5';

/** init を観測済み（`sdkModel` が在る）の最小の事実 */
const RT_MODEL: CloneRuntimeFacts = {
  ...RT_UNOBSERVED,
  declaredModel: 'opus',
  sdkModel: MODEL,
  mcpServers: [],
};

const RT_FULL: CloneRuntimeFacts = {
  revision: {
    commit: '0123456789abcdef0123456789abcdef01234567',
    short: '0123456',
    source: 'build',
  },
  buildTime: { builtAt: '2026-10-26T00:00:00.000Z' },
  declaredModel: 'opus',
  modelOverridden: true,
  modelEnvKey: 'ALTEROID_CLONE_MODEL',
  sdkModel: MODEL,
  effort: 'high',
  requestedEffort: 'high',
  claudeCodeVersion: '2.1.0',
  apiKeySource: 'ANTHROPIC_API_KEY',
  permissionMode: 'auto',
  requestedPermissionMode: 'auto',
  mcpServers: [
    { name: 'alteroid', status: 'connected' },
    { name: 'search', status: 'failed' },
  ],
  sessionId: 'sess-0001',
  resumedFrom: 'sess-0000',
  injectedMemoryChars: heuristicChars(12_345),
  systemPromptChars: heuristicChars(67_890),
  lastContextUsage: {
    durationMs: 120,
    categories: [
      { name: 'System prompt', tokens: 3_000, kind: 'used' },
      { name: 'Messages', tokens: 20_000, kind: 'used' },
      { name: 'Free space', tokens: 150_000, kind: 'free' },
      { name: 'Autocompact buffer', tokens: 30_000, kind: 'buffer' },
      { name: 'MCP tools (deferred)', tokens: 5_000, kind: 'deferred' },
      { name: 'Mystery', tokens: 7 },
    ],
  } as CloneRuntimeFacts['lastContextUsage'],
};

const RT_CTX_ERROR: CloneRuntimeFacts = {
  ...RT_MODEL,
  lastContextUsage: { durationMs: 5, error: 'getContextUsage が応答しなかった' },
};

const RT_CTX_NO_CATEGORIES: CloneRuntimeFacts = {
  ...RT_MODEL,
  lastContextUsage: { durationMs: 5 },
};

const RT_ROUTE_EMPTY: CloneRuntimeFacts = { ...RT_MODEL, anthropicRoute: [] };

const RT_ROUTE_LINES: CloneRuntimeFacts = {
  ...RT_MODEL,
  anthropicRoute: ['ANTHROPIC_BASE_URL: https://gateway.example/v1', 'opus → claude-opus-5'],
};

const RT_MCP_LONG: CloneRuntimeFacts = {
  ...RT_MODEL,
  mcpServers: Array.from({ length: 40 }, (_, index) => ({
    name: `server-${pad3(index)}`,
    status: 'connected',
  })),
};

// ---- 記憶 ----

function memoryDoc(kind: string, description: string, title: string, body: string): string {
  return `---\ntype: ${kind}\ndescription: ${description}\n---\n# ${title}\n${body}\n`;
}

const MIXED_DOCS: DocSeed[] = [
  {
    slug: 'values',
    content: memoryDoc(
      'premise',
      '価値観の芯',
      '価値観',
      `${'大切にすること。'.repeat(20)}\n\n## 節A\n本文A`,
    ),
  },
  {
    slug: 'project-notes',
    content: memoryDoc('indexed', '特定の作業の記憶', '作業メモ', `${'作業の経緯。'.repeat(10)}`),
  },
  { slug: 'about-me', content: memoryDoc('fact', '事実の蓄積', '事実', '好きな色は青') },
  { slug: 'no-frontmatter', content: '# 前書きなし\n本文だけの文書\n' },
  {
    slug: 'long-description',
    content: memoryDoc('fact', `長い説明${'あ'.repeat(300)}`, '長い説明の文書', '本文'),
  },
  { slug: 'malformed', content: '---\ndescription: 閉じが無い\n# 見出し\n本文\n' },
];

const MANY_FACT_DOCS: DocSeed[] = Array.from({ length: 60 }, (_, index) => ({
  slug: `fact-${pad3(index)}`,
  content: memoryDoc(
    'fact',
    `事実 ${String(index)} の説明。${'説明が続く。'.repeat(8)}`,
    `事実 ${String(index)}`,
    '本文',
  ),
}));

function sectionsOf(count: number): string {
  return Array.from({ length: count }, (_, index) => {
    const pad = pad3(index);
    return `# 節${pad}: ${'み'.repeat(60)}\n\n本文${pad}: ${'あ'.repeat(30)}\n`;
  }).join('\n');
}

/** premise のカードが束ねた予算（60,000 字）に当たって1行に落ちる文書の組 */
const BIG_PREMISE_DOCS: DocSeed[] = Array.from({ length: 9 }, (_, index) => ({
  slug: `big-${String(index)}`,
  content: `---\ndescription: 大きい前提 ${String(index)}\ntype: premise\n---\n${sectionsOf(100)}`,
}));

// ---- 台帳 ----

function bucketsOf(count: number, base = 1): UsageSeed[] {
  return Array.from({ length: count }, (_, index) => ({
    managerId: `m-${pad3(index)}`,
    model: MODEL,
    costUsd: base + index * 0.01,
    minute: index,
  }));
}

const FEW_BUCKETS: UsageSeed[] = [
  { managerId: 'clone', model: MODEL, costUsd: 1.25, layer: 'clone', site: 'session', minute: 1 },
  // 同じ「actor × 層 × 場所」の別日・別行は1つに合算される（minute は更新の新しい方が残る）
  { managerId: 'clone', model: MODEL, costUsd: 0.75, layer: 'clone', site: 'session', minute: 5 },
  { managerId: 'clone', model: MODEL, costUsd: 0.5, layer: 'clone', site: 'distill', minute: 2 },
  { managerId: 'mgr-001', model: MODEL, costUsd: 2, layer: 'manager', site: 'session', minute: 3 },
  // 同額（2）は managerId の昇順
  { managerId: 'mgr-000', model: MODEL, costUsd: 2, layer: 'manager', site: 'peer', minute: 4 },
  // 別のモデルの行は内訳に出ない
  { managerId: 'mgr-009', model: 'claude-sonnet-5', costUsd: 9, minute: 6 },
];

// ---- 日誌 ----

function turnTimingEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'turn_timing',
    triggers: ['human_message'],
    batchSize: 1,
    kinds: ['normal'],
    succeeded: true,
    totalMs: 61_000,
    firstTextMs: 45_000,
    firstResponseMs: 40_000,
    phases: {
      queue: 500,
      prepare: 1_500,
      'prepare.situation': 1_200,
      model: 58_000,
      finalize: 1_000,
    },
    tools: {
      count: 3,
      totalMs: 12_000,
      top: [
        { name: 'Bash', count: 2, totalMs: 10_000, maxMs: 9_000 },
        { name: 'Read', count: 1, totalMs: 2_000, maxMs: 2_000 },
      ],
    },
    sdk: { durationMs: 58_000, durationApiMs: 45_000, numTurns: 4 },
    tokens: { input: 10, cacheRead: 530_000, cacheCreation: 9_000, output: 800 },
    ...overrides,
  };
}

const TURN_TIMING_SOME: Record<string, unknown>[] = [
  turnTimingEntry(),
  turnTimingEntry({
    triggers: ['self_initiative'],
    totalMs: 9_000,
    firstTextMs: undefined,
    tools: undefined,
    phases: { queue: 100, model: 8_000, finalize: 900 },
    tokens: { input: 5, cacheRead: 100_000, cacheCreation: 0, output: 50 },
  }),
  turnTimingEntry({
    triggers: ['timer'],
    totalMs: 30_500,
    phases: { prepare: 20_000, 'prepare.memory': 15_000, 'prepare.digest': 4_000, model: 10_000 },
    compactions: { count: 1, totalMs: 6_000 },
  }),
  turnTimingEntry({
    triggers: ['human_message', 'timer'],
    kinds: ['distill'],
    succeeded: false,
    batchSize: 3,
    totalMs: 4_200,
    firstTextMs: undefined,
    phases: { queue: 3_000, model: 1_000 },
    tools: undefined,
    tokens: undefined,
    sdk: undefined,
  }),
  turnTimingEntry({
    triggers: [],
    kinds: [],
    totalMs: 800,
    phases: {},
    tools: undefined,
    tokens: undefined,
  }),
];

const TRIGGER_NAMES = [
  'human_message',
  'self_initiative',
  'timer',
  'manager_message',
  'schedule',
  'inbox',
  'peer_reply',
];

/** 35 件（読むのは 30 件まで）。最も古い 5 件だけ totalMs を桁違いにして、窓の外へ出たことを出力で見分ける */
const TURN_TIMING_MANY: Record<string, unknown>[] = Array.from({ length: 35 }, (_, index) =>
  turnTimingEntry({
    triggers: [TRIGGER_NAMES[index % TRIGGER_NAMES.length]],
    totalMs: index < 5 ? 900_000 + index : 1_000 * (index + 1),
    phases: { queue: 100, model: 1_000 * (index + 1) },
    tools: index % 2 === 0 ? undefined : turnTimingEntry().tools,
  }),
);

function httpDb(count: number, wallMs: number, waitMs = 0) {
  return { count, totalMs: wallMs, wallMs, waitMs };
}

function httpTimingEntry(index: number, overrides: Record<string, unknown> = {}) {
  return {
    type: 'http_timing',
    windowStartedAt: iso(index * 10 - 600),
    windowMs: 600_000,
    requests: index + 1,
    routes: [
      {
        route: `GET /route-${String(index % 3)}`,
        count: index + 1,
        errors: 0,
        p50Ms: 100,
        p90Ms: 500 + index,
        maxMs: 900 + index,
        totalMs: 1_000 * (index + 1),
        db: httpDb(2 * (index + 1), 400 * (index + 1)),
        serializeMs: 10,
        bytes: 10_000 * (index + 1),
        maxBytes: 20_000,
      },
    ],
    slowest: [
      {
        route: `GET /route-${String(index % 3)}`,
        status: 200,
        at: iso(index * 10 - 595),
        totalMs: 700 + index,
        db: { ...httpDb(1, 300), slowestMs: 250, slowestSql: 'select 1' },
        serializeMs: 5,
        bytes: 4_096,
      },
    ],
    ...overrides,
  };
}

const HTTP_TIMING_SOME: Record<string, unknown>[] = [
  httpTimingEntry(0),
  httpTimingEntry(1, {
    routes: [
      {
        route: 'POST /messages',
        count: 4,
        errors: 2,
        p50Ms: 300,
        p90Ms: 2_500,
        maxMs: 3_000,
        totalMs: 8_000,
        db: httpDb(40, 6_000, 1_500),
        serializeMs: 200,
        bytes: 400_000,
        maxBytes: 150_000,
      },
      {
        route: 'GET /empty',
        count: 0,
        errors: 0,
        p50Ms: 0,
        p90Ms: 0,
        maxMs: 0,
        totalMs: 0,
        db: httpDb(0, 0),
        serializeMs: 0,
        bytes: 0,
        maxBytes: 0,
      },
    ],
    slowest: [
      {
        route: 'POST /messages',
        status: 500,
        at: iso(-580),
        totalMs: 3_000,
        db: { ...httpDb(7, 2_800), slowestMs: 2_500 },
        serializeMs: 20,
      },
    ],
  }),
  httpTimingEntry(2),
];

/** 14 窓（読むのは 12 窓まで）。最も古い 2 窓だけ要求数を桁違いにして、窓の外へ出たことを出力で見分ける */
const HTTP_TIMING_MANY: Record<string, unknown>[] = Array.from({ length: 14 }, (_, index) =>
  httpTimingEntry(index, index < 2 ? { requests: 5_000 + index } : {}),
);

// ---- マネージャーの器 ----

function runner(
  label: string,
  runnerId: string | undefined,
  managerPeers: unknown,
): Record<string, unknown> {
  return {
    label,
    ...(runnerId === undefined ? {} : { runnerId }),
    state: 'connected',
    since: iso(0),
    managers: [],
    ...(managerPeers === undefined ? {} : { managerPeers }),
  };
}

const PEERS_OPEN = {
  status: 'named',
  peers: [{ provider: 'codex', models: ['gpt-5', 'gpt-5-mini'] }, { provider: 'claude' }],
};

const PEERS_CLOSED = {
  status: 'named',
  peers: [],
  closed: [
    { provider: 'codex', reason: 'ログイン済みだが CODEX_HOME が runner に届いていない' },
    { provider: 'gemini', reason: '未対応' },
  ],
};

const PEERS_UNKNOWN = { status: 'unknown' };

const PEERS_EMPTY = { status: 'named', peers: [] };

const MANAGERS_PEERS: Managers = {
  runners: [
    runner('local', undefined, PEERS_OPEN),
    runner('railway', 'runner-1', PEERS_CLOSED),
    runner('old', 'runner-2', PEERS_UNKNOWN),
    // 開閉どちらも無い器・欄の無い器は行にしない
    runner('empty', 'runner-3', PEERS_EMPTY),
    runner('bare', 'runner-4', undefined),
  ],
};

const MANAGERS_MANY: Managers = {
  runners: Array.from({ length: 30 }, (_, index) =>
    runner(`label-${pad3(index)}`, `runner-${pad3(index)}`, {
      status: 'named',
      peers: [],
      closed: [{ provider: 'codex', reason: `閉じている理由 ${'長い理由。'.repeat(60)}` }],
    }),
  ),
};

// ---- 場面 ----

const status = (args: Args = {}): Step => ({ args });

/** 前の呼びの出力が案内した ledgerCursor（`ledgerCursor=… で続きが出る`）を取る */
function cursorFrom(previousTexts: string[], which: number): string {
  const text = previousTexts[which] ?? '';
  const found = /ledgerCursor=([A-Za-z0-9_-]+) で続きが出る/.exec(text);
  if (found?.[1] === undefined) throw new Error('前の呼びの出力に ledgerCursor の案内が無い');
  return found[1];
}

const withCursor = (which: number): Step => ({
  args: (previous) => ({ ledgerCursor: cursorFrom(previous, which) }),
});

/** 台帳の最後の 1 件（m-119）の後ろを指す、自前の cursor。内訳が尽きた頁（最後の頁）を作る */
const LAST_ANCHOR = encodeUsageCursor({
  axis: 'ledger',
  label: ['m-000', 'manager', 'session'].join('\u0000'),
  cost: 0,
});

const bump =
  (rows: UsageSeed[]) =>
  async (stores: Stores): Promise<void> => {
    await seedUsage(stores, rows);
  };

const SCENARIOS: Scenario[] = [
  // ---- runtime ----
  {
    name: 'runtime-absent',
    covers:
      '記憶へ移す内部ターン（context.runtime() が undefined）→ 断りの文だけ。ledgerCursor を渡しても同じ。記憶・台帳・日誌・Codex・器には触れない（context.runtime のみ）',
    runtime: 'absent',
    docs: MIXED_DOCS,
    usage: FEW_BUCKETS,
    codex: 'valid',
    managers: MANAGERS_PEERS,
    runnerModels: ['m'],
    steps: [status(), status({ ledgerCursor: 'garbage' })],
  },
  {
    name: 'runtime-unobserved',
    covers:
      'init 未観測（sdkModel null・MCP null・effort ほか null・リビジョン不明・焼いた時刻不明・context usage 無し）。台帳は読まない（usage.aggregate を呼ばない）。記憶 0 文書・Codex なし・時間の日誌なし・器なし。同じ呼びを2回',
    runtime: RT_UNOBSERVED,
    steps: [status(), status()],
  },
  {
    name: 'runtime-model-mcp-empty',
    covers:
      'sdkModel が在る・MCP は観測済みで 0 本（「0本（init は観測済み）」）。台帳に1件も無い →「台帳にはまだ1件も記録が無い」。usage.aggregate を1回読む',
    runtime: RT_MODEL,
    steps: [status()],
  },
  {
    name: 'runtime-full',
    covers:
      '全項目が埋まる（リビジョン既知・焼いた時刻と経過・宣言モデルを人間が置いた・effort・MCP 2 本・resume 元・context usage の内訳〈used/free/buffer/deferred/未分類〉）。台帳は空',
    runtime: RT_FULL,
    steps: [status()],
  },
  {
    name: 'runtime-mcp-long',
    covers: 'MCP サーバが 40 本 → 400 字の抜粋に切れる',
    runtime: RT_MCP_LONG,
    steps: [status()],
  },
  {
    name: 'runtime-context-error',
    covers:
      'context usage の観測が失敗している（error あり）→ 使った入力・払っていない枠の両行が理由つき',
    runtime: RT_CTX_ERROR,
    steps: [status()],
  },
  {
    name: 'runtime-context-no-categories',
    covers: 'context usage に categories が無い → 内訳なしの断り',
    runtime: RT_CTX_NO_CATEGORIES,
    steps: [status()],
  },
  {
    name: 'runtime-route-empty',
    covers:
      'runtime に anthropicRoute: []（見たが何も置かれていない）→ 節の見出しと「置かれていない」の行を出す',
    runtime: RT_ROUTE_EMPTY,
    steps: [status()],
  },
  {
    name: 'runtime-route-lines',
    covers: 'runtime に anthropicRoute の行（クローン自身の層）→ 見出しと行',
    runtime: RT_ROUTE_LINES,
    steps: [status()],
  },
  // ---- runner の項目 ----
  {
    name: 'runner-models',
    covers:
      'context.runnerModels が行を返す・runnerAnthropicRoutes は口が無い → 「接続中の runner が名乗ったモデル」の節だけ。runnerModels を1回呼ぶ',
    runtime: RT_MODEL,
    runnerModels: ['runner-1: manager=opus / worker=sonnet', 'runner-2: manager=fable'],
    steps: [status()],
  },
  {
    name: 'runner-routes',
    covers:
      'runnerModels は口が無い・context.runnerAnthropicRoutes が行を返す → 「接続中の runner の SDK の接続先」の節だけ',
    runtime: RT_MODEL,
    runnerRoutes: ['runner-1: ANTHROPIC_BASE_URL=https://gateway.example/v1'],
    steps: [status()],
  },
  {
    name: 'runner-both-with-route-lines',
    covers:
      '2つの口が行を返し、runtime には anthropicRoute: [] もある → 並びは runner のモデル・クローンの接続先（置かれていない）・runner の接続先',
    runtime: RT_ROUTE_EMPTY,
    runnerModels: ['runner-1: manager=opus'],
    runnerRoutes: [
      'runner-1: ANTHROPIC_BASE_URL=https://gateway.example/v1',
      'runner-2: （置かれていない）',
    ],
    steps: [status()],
  },
  {
    name: 'runner-empty-lines',
    covers: '2つの口は在るが空配列を返す → どちらの節も出さない（呼びは2回とも在る）',
    runtime: RT_MODEL,
    runnerModels: [],
    runnerRoutes: [],
    steps: [status()],
  },
  {
    name: 'runner-models-throws',
    covers:
      'runnerModels が投げる → その節だけ「読めなかった」の断りの文にして、ほかの節（runnerAnthropicRoutes・記憶・台帳など）は出す（#6486）',
    runtime: RT_MODEL,
    runnerModels: 'throws',
    runnerRoutes: ['r'],
    steps: [status()],
  },
  {
    name: 'runner-routes-throws',
    covers:
      'runnerModels は返り、runnerAnthropicRoutes が投げる → その節だけ断りの文にして、記憶などのほかの節は出す（#6486）',
    runtime: RT_MODEL,
    runnerModels: ['r'],
    runnerRoutes: 'throws',
    steps: [status()],
  },
  // ---- 台帳（cursor なし） ----
  {
    name: 'ledger-other-model',
    covers:
      '台帳に行は在るが、いまのモデル id と同じ行が無い →「モデル id … と同じ行は無い（台帳の始点: …）」',
    runtime: RT_MODEL,
    usage: [{ managerId: 'mgr-009', model: 'claude-sonnet-5', costUsd: 9, minute: 6 }],
    steps: [status()],
  },
  {
    name: 'ledger-few',
    covers:
      '内訳が 4 件（同じ actor × 層 × 場所は合算・同額は managerId の昇順・別モデルの行は除く）。打ち切りなし・cursor なし',
    runtime: RT_MODEL,
    usage: FEW_BUCKETS,
    steps: [status()],
  },
  {
    name: 'ledger-exact-14',
    covers: '内訳がちょうど 14 件 → 打ち切りの行は付かない',
    runtime: RT_MODEL,
    usage: bucketsOf(14),
    steps: [status()],
  },
  {
    name: 'ledger-15-truncated',
    covers: '内訳が 15 件 → 14 件で打ち切り「残り 1 件」と ledgerCursor が付く',
    runtime: RT_MODEL,
    usage: bucketsOf(15),
    steps: [status()],
  },
  // ---- 台帳（cursor あり） ----
  {
    name: 'ledger-paging',
    covers:
      '内訳 120 件を ledgerCursor でたどる: 先頭 14 件（全体の出力）→ cursor の頁（その節だけ・100 件・残りあり）→ 次の頁（残り 6 件・最後）→ 尽きた cursor（「これが最後の頁」）',
    runtime: RT_MODEL,
    usage: bucketsOf(120),
    steps: [status(), withCursor(0), withCursor(1), status({ ledgerCursor: LAST_ANCHOR })],
  },
  {
    name: 'ledger-cursor-risen',
    covers:
      '20 件・先頭頁の cursor を取った後に記録が増え、頁の外にあった行が上位へ上がる → cursor の頁の末尾に「順位が上がった…」の別枠',
    runtime: RT_MODEL,
    usage: bucketsOf(20),
    steps: [
      status(),
      {
        before: bump([{ managerId: 'm-000', model: MODEL, costUsd: 10, minute: 1_000 }]),
        args: (previous) => ({ ledgerCursor: cursorFrom(previous, 0) }),
      },
    ],
  },
  {
    name: 'ledger-cursor-risen-overflow',
    covers:
      '40 件・先頭頁の後に 20 件が上位へ上がる → 別枠は 14 件で打ち切り「…ほか 6 件は省略」。cursor の頁の本体と重複しない',
    runtime: RT_MODEL,
    usage: bucketsOf(40),
    steps: [
      status(),
      {
        before: bump(
          Array.from({ length: 20 }, (_, index) => ({
            managerId: `m-${pad3(index)}`,
            model: MODEL,
            costUsd: 100 + index,
            minute: 1_000 + index,
          })),
        ),
        args: (previous) => ({ ledgerCursor: cursorFrom(previous, 0) }),
      },
    ],
  },
  {
    name: 'ledger-cursor-errors',
    covers:
      'cursor の断り: 壊れた文字列・空文字・別の文脈（axis が違う）の cursor。正しい cursor は内訳の続き。いずれも usage.aggregate を1回読み、記憶・日誌などは読まない',
    runtime: RT_MODEL,
    usage: FEW_BUCKETS,
    steps: [
      status({ ledgerCursor: 'garbage' }),
      status({ ledgerCursor: '' }),
      status({ ledgerCursor: encodeUsageCursor({ axis: 'model', label: 'x', cost: 1 }) }),
      status({
        ledgerCursor: encodeUsageCursor({
          axis: 'ledger',
          label: ['clone', 'clone', 'session'].join('\u0000'),
          cost: 2,
        }),
      }),
    ],
  },
  {
    name: 'ledger-cursor-sdk-null',
    covers:
      'cursor あり・sdkModel が null →「まだ init を観測していない」。台帳は読まない（usage.aggregate を呼ばない）',
    runtime: RT_UNOBSERVED,
    usage: FEW_BUCKETS,
    steps: [status({ ledgerCursor: 'garbage' })],
  },
  {
    name: 'ledger-cursor-empty-ledger',
    covers: 'cursor あり・台帳が空 → cursor が壊れていても「台帳にはまだ1件も記録が無い」が先',
    runtime: RT_MODEL,
    steps: [status({ ledgerCursor: 'garbage' })],
  },
  {
    name: 'ledger-cursor-other-model',
    covers: 'cursor あり・同じモデルの行が無い → 「同じ行は無い」が先（cursor を見ない）',
    runtime: RT_MODEL,
    usage: [{ managerId: 'mgr-009', model: 'claude-sonnet-5', costUsd: 9, minute: 6 }],
    steps: [status({ ledgerCursor: 'garbage' })],
  },
  {
    name: 'ledger-cursor-aggregate-fails',
    covers:
      'cursor あり・usage.aggregate が投げる → 台帳の節を「読めなかった」の断りの文にして返す（#6486）',
    runtime: RT_MODEL,
    usage: FEW_BUCKETS,
    fail: ['usage.aggregate'],
    steps: [status({ ledgerCursor: 'garbage' })],
  },
  // ---- 記憶 ----
  {
    name: 'memory-mixed',
    covers:
      '記憶 6 文書（premise・indexed・fact・前書き無し・長い説明の抜粋・壊れた前書き）→ 寄与の大きい順・区分ごとの小計。作成/更新の時刻つき',
    runtime: RT_MODEL,
    docs: MIXED_DOCS,
    steps: [status()],
  },
  {
    name: 'memory-many',
    covers: '記憶 60 文書（fact）→ 一覧の予算（3,500 字）で「…ほか N 文書は省略」',
    runtime: RT_MODEL,
    docs: MANY_FACT_DOCS,
    steps: [status()],
  },
  {
    name: 'memory-demoted',
    covers:
      '大きい premise 9 件が束ねた予算に当たり、カードを落とした件数を premise の行で名乗る（⚠️）',
    runtime: RT_MODEL,
    docs: BIG_PREMISE_DOCS,
    steps: [status()],
  },
  {
    name: 'memory-persona-list-fails',
    covers:
      'persona.list が投げる → 記憶の節だけ断りの文にして、ほかの節は出す（他の読みは始まっている）（#6486）',
    runtime: RT_MODEL,
    docs: MIXED_DOCS,
    fail: ['persona.list'],
    steps: [status()],
  },
  {
    name: 'memory-persona-documents-fails',
    covers: 'persona.documents が投げる → 記憶の節だけ断りの文にして、ほかの節は出す（#6486）',
    runtime: RT_MODEL,
    docs: MIXED_DOCS,
    fail: ['persona.documents'],
    steps: [status()],
  },
  {
    name: 'ledger-aggregate-fails',
    covers:
      'cursor なし・usage.aggregate が投げる → 台帳の節だけ断りの文にして、ほかの節は出す（#6486）',
    runtime: RT_MODEL,
    usage: FEW_BUCKETS,
    fail: ['usage.aggregate'],
    steps: [status()],
  },
  // ---- Codex の認証 ----
  {
    name: 'codex-none',
    covers: 'Codex のログインが無い（record null）→ 行を足さない（「なし」の文は出ない）',
    runtime: RT_MODEL,
    codex: 'none',
    steps: [status()],
  },
  {
    name: 'codex-valid',
    covers: 'Codex にログイン済み → アカウント・プラン・最終更新と peer の案内（値は出ない）',
    runtime: RT_MODEL,
    codex: 'valid',
    steps: [status()],
  },
  {
    name: 'codex-valid-bare',
    covers: 'ログイン済みでアカウント・プランが null →「(アカウント不明)・(プラン不明)」',
    runtime: RT_MODEL,
    codex: 'valid-bare',
    steps: [status()],
  },
  {
    name: 'codex-failed',
    covers: 'ログイン済みで切れている（failure あり）→ 理由と再ログインの促し',
    runtime: RT_MODEL,
    codex: 'failed',
    steps: [status()],
  },
  {
    name: 'codex-unreadable',
    covers: 'codexAuth.get が投げる →「正本を読めなかった（理由）」を足して続ける（例外にしない）',
    runtime: RT_MODEL,
    fail: ['codexAuth.get'],
    steps: [status()],
  },
  // ---- 時間の日誌 ----
  {
    name: 'timing-turn-some',
    covers:
      'turn_timing が 5 件（成功・失敗・distill・束ねた合図・道具なし・段なし・合図なし）→ 中央値・90% 点・段の割合・合図別の入力・道具を呼ばなかった割合・最も長い 3 件。http_timing は無し',
    runtime: RT_MODEL,
    turnTiming: TURN_TIMING_SOME,
    steps: [status()],
  },
  {
    name: 'timing-turn-many',
    covers:
      'turn_timing が 35 件 → 読むのは 30 件（limit 30）。窓の外の古い 5 件は集計に入らない。合図が 7 種で「他 2 種」',
    runtime: RT_MODEL,
    turnTiming: TURN_TIMING_MANY,
    steps: [status()],
  },
  {
    name: 'timing-turn-unreadable',
    covers:
      'turn_timing の journal.list が投げる →「直近のターンの時間: 日誌を読めなかった（理由）。」で続ける。http_timing は読めて 0 件',
    runtime: RT_MODEL,
    fail: ['journal.turn_timing'],
    steps: [status()],
  },
  {
    name: 'timing-http-some',
    covers:
      'http_timing が 3 窓（空き待ちあり・500 番台あり・回数 0 の経路・SQL なし／bytes なしの遅い要求）→ 経路ごとの合計・DB の割合・最も遅かった要求。turn_timing は無し',
    runtime: RT_MODEL,
    httpTiming: HTTP_TIMING_SOME,
    steps: [status()],
  },
  {
    name: 'timing-http-many',
    covers:
      'http_timing が 14 窓 → 読むのは 12 窓（limit 12）。窓の外の古い 2 窓は要求数に入らない',
    runtime: RT_MODEL,
    httpTiming: HTTP_TIMING_MANY,
    steps: [status()],
  },
  {
    name: 'timing-http-unreadable',
    covers:
      'http_timing の journal.list が投げる →「HTTP API の時間: 日誌を読めなかった（理由）。」で続ける。turn_timing は読めて 0 件',
    runtime: RT_MODEL,
    fail: ['journal.http_timing'],
    steps: [status()],
  },
  {
    name: 'timing-both-unreadable',
    covers: '2つの日誌の読みが両方投げる → 2行とも「読めなかった」で、残りの節は出る',
    runtime: RT_MODEL,
    fail: ['journal.turn_timing', 'journal.http_timing'],
    steps: [status()],
  },
  // ---- マネージャー（器） ----
  {
    name: 'managers-peers',
    covers:
      'マネージャーが在る・5 つの器（開いている peer とモデル・閉じている理由つき・不明・開閉どちらも無い・欄なし）→ 行になる器だけが並ぶ。label か runnerId を名前にする。managers.runners を1回',
    runtime: RT_MODEL,
    managers: MANAGERS_PEERS,
    steps: [status()],
  },
  {
    name: 'managers-no-rows',
    covers: 'マネージャーが在るが器が 0 → 節を出さない（runners は呼ぶ）',
    runtime: RT_MODEL,
    managers: { runners: [] },
    steps: [status()],
  },
  {
    name: 'managers-only-silent-rows',
    covers: '器は在るが、行になる器が1つも無い（開閉どちらも無い・欄なし）→ 節を出さない',
    runtime: RT_MODEL,
    managers: {
      runners: [runner('empty', 'runner-3', PEERS_EMPTY), runner('bare', 'runner-4', undefined)],
    },
    steps: [status()],
  },
  {
    name: 'managers-runners-throws',
    covers: 'managers.runners が投げる → 断りの文を1行出す（本題は落とさない）（#6486）',
    runtime: RT_MODEL,
    managers: 'throws',
    steps: [status()],
  },
  {
    name: 'managers-many',
    covers: '器が 30 台 → 予算 1,600 字で「…ほか N 台は省略」・1 行は抜粋に切れる',
    runtime: RT_MODEL,
    managers: MANAGERS_MANY,
    steps: [status()],
  },
  // ---- すべて同居 ----
  {
    name: 'everything',
    covers:
      '全部が同居する並び: 実行時・Codex（ログイン済み）・記憶・台帳（15 件で打ち切り）・時間の日誌 2 本・マネージャーの器。runner の2つの口も在る',
    runtime: RT_FULL,
    docs: MIXED_DOCS,
    usage: bucketsOf(15),
    codex: 'valid',
    turnTiming: TURN_TIMING_SOME,
    httpTiming: HTTP_TIMING_SOME,
    runnerModels: ['runner-1: manager=opus'],
    runnerRoutes: ['runner-1: ANTHROPIC_BASE_URL=https://gateway.example/v1'],
    managers: MANAGERS_PEERS,
    steps: [status(), withCursor(0)],
  },
];

function stepKey(scenario: Scenario, index: number): string {
  return scenario.steps.length === 1 ? scenario.name : `${scenario.name}#${String(index + 1)}`;
}

const ALL_KEYS: string[] = SCENARIOS.flatMap((scenario) =>
  scenario.steps.map((_, index) => stepKey(scenario, index)),
);

// ---- 記録の形 ----

interface PinnedOutput {
  length: number;
  text: string;
  isError: boolean;
  /** 道具が例外を投げて返ったか（その場合 text は例外の message） */
  thrown: boolean;
  /** 例外で返ったときの例外の名前（返らなければ null） */
  errorName: string | null;
}

interface PinnedStep {
  output: PinnedOutput;
  /** 呼びの並び（呼んだ順） */
  calls: string[];
  /** 記憶・日誌・台帳・Codex の認証が呼ぶ前から変わったか（読むだけの道具なので常に false） */
  wrote: boolean;
  /** 読みの口（persona.list / persona.documents / usage.aggregate / codexAuth.get / journal.list）以外の呼び（常に空） */
  writeCalls: string[];
}

interface PinFile {
  /** 場面ごとの出力の字数の一覧（`output.length`）。どの場面が何字を出しているかを1か所で読む */
  lengths: Record<string, number>;
  scenarios: Record<string, PinnedStep>;
}

const READ_CALLS = [
  'persona.list',
  'persona.documents',
  'usage.aggregate',
  'codexAuth.get',
  'journal.list',
  'context.runtime',
  'context.runnerModels',
  'context.runnerAnthropicRoutes',
  'managers.runners',
];

function plain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function errorNameOf(error: unknown): string {
  return error instanceof Error ? error.name : 'unknown';
}

async function seedUsage(stores: Stores, rows: UsageSeed[]): Promise<void> {
  for (const row of rows) {
    await stores.usage.record({
      layer: row.layer ?? 'manager',
      site: row.site ?? 'session',
      managerId: row.managerId,
      date: '2026-10-27',
      at: iso(row.minute ?? 0),
      accumulation: 'oneshot',
      snapshot: {
        models: {
          [row.model]: {
            inputTokens: 10,
            outputTokens: 100,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
            webSearchRequests: 0,
            costUsd: row.costUsd,
          },
        },
      },
    });
  }
}

async function seedStores(base: Stores, scenario: Scenario): Promise<void> {
  for (const [index, doc] of (scenario.docs ?? []).entries()) {
    vi.setSystemTime(new Date(iso(index - 2_000)));
    await base.persona.write(doc.slug, doc.content);
  }
  await seedUsage(base, scenario.usage ?? []);
  const codex = scenario.codex ?? 'none';
  if (codex !== 'none') {
    await base.codexAuth.replace({
      value: '{"tokens":{"refresh_token":"rt-pin-fake"}}',
      revision: 'r1',
      updatedAt: '2026-10-07T00:00:00.000Z',
      email: codex === 'valid-bare' ? null : 'me@example.com',
      planType: codex === 'valid-bare' ? null : 'plus',
      failure:
        codex === 'failed'
          ? { at: '2026-10-07T01:00:00.000Z', reason: 'refresh token was revoked' }
          : null,
    });
  }
  // 古い順に積む（日誌は新しい行から limit 件読む）
  for (const [index, entry] of (scenario.turnTiming ?? []).entries()) {
    vi.setSystemTime(new Date(iso(index - 1_500)));
    await base.journal.append(entry as never);
  }
  for (const [index, entry] of (scenario.httpTiming ?? []).entries()) {
    vi.setSystemTime(new Date(iso(index - 1_000)));
    await base.journal.append(entry as never);
  }
}

async function snapshot(base: Stores): Promise<string> {
  return JSON.stringify({
    list: await base.persona.list(),
    documents: await base.persona.documents(),
    journal: await base.journal.list({ order: 'asc' }),
    usage: await base.usage.aggregate({}),
    codex: await base.codexAuth.get(),
  });
}

function summarize(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `${String(value.length)} items`;
  if (typeof value === 'object' && value !== undefined) {
    const record = value as { rows?: unknown[]; since?: unknown };
    if (Array.isArray(record.rows)) {
      return `rows=${String(record.rows.length)} since=${String(record.since)}`;
    }
    return 'record';
  }
  return String(value);
}

async function runScenario(scenario: Scenario): Promise<PinnedStep[]> {
  const base = createMemoryStores();
  vi.setSystemTime(new Date(BASE_ISO));
  await seedStores(base, scenario);
  vi.setSystemTime(new Date(BASE_ISO));

  let calls: string[] = [];
  const failures = new Set<string>(scenario.fail ?? []);

  /** 1つの store を、関数の呼びを記録する Proxy で包む（呼びは始まった順に積み、結果の要約は同じ行へ書き足す） */
  const wrap = <T extends object>(storeName: string, store: T): T =>
    new Proxy(store, {
      get(target, prop, receiver) {
        const member = Reflect.get(target, prop, receiver) as unknown;
        if (typeof member !== 'function' || typeof prop !== 'string') return member;
        return async (...args: unknown[]): Promise<unknown> => {
          const name = `${storeName}.${prop}`;
          const label = `${name}(${args.map((arg) => JSON.stringify(arg)).join(', ')})`;
          const index = calls.push(label) - 1;
          const first = args[0] as { types?: string[] } | undefined;
          const failKey = name === 'journal.list' ? `journal.${first?.types?.[0] ?? ''}` : name;
          try {
            if (failures.has(failKey)) throw new Error(`${failKey} が読めない`);
            const result = await (member as (...inner: unknown[]) => Promise<unknown>).apply(
              target,
              args,
            );
            calls[index] = `${label} -> ${summarize(result)}`;
            return result;
          } catch (error) {
            calls[index] = `${label} -> threw ${errorNameOf(error)}`;
            throw error;
          }
        };
      },
    });

  const stores = Object.fromEntries(
    Object.entries(base).map(([key, value]) => [
      key,
      typeof value === 'object' && value !== null ? wrap(key, value as object) : value,
    ]),
  ) as unknown as Stores;

  const lines = (
    mode: RunnerLines | undefined,
    name: string,
  ): (() => Promise<readonly string[]>) | undefined => {
    if (mode === undefined || mode === 'absent') return undefined;
    return async () => {
      if (mode === 'throws') {
        calls.push(`${name}() -> threw Error`);
        throw new Error(`${name} が落ちた`);
      }
      calls.push(`${name}() -> ${String(mode.length)} lines`);
      return mode;
    };
  };

  const managersMode = scenario.managers ?? 'absent';
  const managers =
    managersMode === 'absent'
      ? undefined
      : (new Proxy(
          {},
          {
            get(_target, prop) {
              if (typeof prop !== 'string') return undefined;
              return async (...args: unknown[]): Promise<unknown> => {
                const label = `managers.${prop}(${args.map((arg) => JSON.stringify(arg)).join(', ')})`;
                if (prop !== 'runners') {
                  calls.push(label);
                  return undefined;
                }
                if (managersMode === 'throws') {
                  calls.push(`${label} -> threw Error`);
                  throw new Error('名簿が読めない');
                }
                calls.push(`${label} -> ${String(managersMode.runners.length)} runners`);
                return {
                  runners: managersMode.runners,
                  unassigned: [],
                } as unknown as RunnerFleetOverview;
              };
            },
          },
        ) as unknown as ManagerPool);

  const runtimeFacts = scenario.runtime;
  const context = {
    stores,
    emit: () => undefined,
    memoryCause: () => 'clone',
    conversationId: () => undefined,
    runtime: () => {
      calls.push(`context.runtime() -> ${runtimeFacts === 'absent' ? 'undefined' : 'facts'}`);
      return runtimeFacts === 'absent' ? undefined : runtimeFacts;
    },
    ...(lines(scenario.runnerModels, 'context.runnerModels') === undefined
      ? {}
      : { runnerModels: lines(scenario.runnerModels, 'context.runnerModels') }),
    ...(lines(scenario.runnerRoutes, 'context.runnerAnthropicRoutes') === undefined
      ? {}
      : { runnerAnthropicRoutes: lines(scenario.runnerRoutes, 'context.runnerAnthropicRoutes') }),
    ...(managers === undefined ? {} : { managers }),
  } as unknown as ToolContext;
  const found = createCloneTools(context).find((entry) => entry.name === 'self_status');
  if (!found) throw new Error('self_status が無い');

  const results: PinnedStep[] = [];
  const previousTexts: string[] = [];
  for (const [index, step] of scenario.steps.entries()) {
    if (step.before !== undefined) await step.before(base);
    calls = [];
    const before = await snapshot(base);
    const args = typeof step.args === 'function' ? step.args(previousTexts) : step.args;
    let output: PinnedOutput;
    try {
      const result = await found.handler(args as never, {} as never);
      const text = (result.content ?? [])
        .map((block) => (block.type === 'text' ? block.text : ''))
        .join('');
      output = {
        length: text.length,
        text,
        isError: result.isError === true,
        thrown: false,
        errorName: null,
      };
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      output = {
        length: text.length,
        text,
        isError: true,
        thrown: true,
        errorName: errorNameOf(error),
      };
    }
    previousTexts.push(output.text);
    const recorded = plain(calls);
    const after = await snapshot(base);
    const wrote = before !== after;
    results.push({
      output,
      calls: recorded,
      wrote,
      writeCalls: recorded.filter(
        (line) => !READ_CALLS.some((name) => line.startsWith(`${name}(`)),
      ),
    });
    expect(
      wrote,
      `場面 ${stepKey(scenario, index)}: 読むだけの道具が記憶・日誌・台帳・認証を変えた`,
    ).toBe(false);
  }
  return results;
}

async function runAll(): Promise<Record<string, PinnedStep>> {
  const out: Record<string, PinnedStep> = {};
  for (const scenario of SCENARIOS) {
    const results = await runScenario(scenario);
    for (const [index, result] of results.entries()) out[stepKey(scenario, index)] = result;
  }
  return out;
}

describe('self_status の出力と呼びの並びの固定（場面ごとの出力の全文・読みの口の呼び）', () => {
  let actual: Record<string, PinnedStep> = {};
  let pinned: PinFile = { lengths: {}, scenarios: {} };

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(BASE_ISO));
    actual = await runAll();
    if (UPDATE) {
      const file: PinFile = {
        lengths: Object.fromEntries(ALL_KEYS.map((key) => [key, actual[key]?.output.length ?? -1])),
        scenarios: actual,
      };
      writeFileSync(PIN_URL, `${JSON.stringify(file, null, 2)}\n`);
    }
    pinned = JSON.parse(readFileSync(PIN_URL, 'utf8')) as PinFile;
  }, 120_000);

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
      expect(actual[key]?.output.text.length, `${key} が空の出力である`).toBeGreaterThan(0);
    }
  });

  it('場面ごとの出力の字数の一覧が固定値と同じ（どの場面の字数が動いたかを1か所で読む）', () => {
    const lengths = Object.fromEntries(
      ALL_KEYS.map((key) => [key, actual[key]?.output.length ?? -1]),
    );
    expect(lengths).toEqual(pinned.lengths);
  });

  it('固定値の字数が、固定値の全文の長さと合っている（json を手で書き換えていない）', () => {
    for (const [key, entry] of Object.entries(pinned.scenarios)) {
      expect(entry.output.text.length, `${key}: json の length と text.length が食い違う`).toBe(
        entry.output.length,
      );
      expect(pinned.lengths[key], `${key}: lengths の一覧と食い違う`).toBe(entry.output.length);
    }
  });

  it('読むだけである（どの場面も、記憶・日誌・台帳・認証が変わらず、読みの口以外を呼ばない。固定値の側も同じ）', () => {
    for (const key of ALL_KEYS) {
      expect(actual[key]?.wrote, `${key}: 書き込みが起きた`).toBe(false);
      expect(actual[key]?.writeCalls, `${key}: 読みの口以外が呼ばれた`).toEqual([]);
      expect(pinned.scenarios[key]?.wrote, `${key}: 固定値の wrote`).toBe(false);
      expect(pinned.scenarios[key]?.writeCalls, `${key}: 固定値の writeCalls`).toEqual([]);
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
          got?.output.text.length,
          `場面 ${key} の出力の字数が変わった: 固定値 ${String(want?.output.length)} 字 → いま ${String(got?.output.text.length)} 字`,
        ).toBe(want?.output.length);
        expect(
          got?.output.text,
          `場面 ${key} の出力が固定値からずれた（字数は ${String(got?.output.text.length)} 字で同じ）`,
        ).toBe(want?.output.text);
        expect(
          { isError: got?.output.isError, thrown: got?.output.thrown, name: got?.output.errorName },
          `場面 ${key} の出力の isError／例外で返ったか／例外の名前、が変わった`,
        ).toEqual({
          isError: want?.output.isError,
          thrown: want?.output.thrown,
          name: want?.output.errorName,
        });
      });

      it(`${key} の呼びの並び（記憶・台帳・認証・日誌・context・器）が固定値と同じ`, () => {
        const want = pinned.scenarios[key];
        const got = actual[key];
        expect(want, `${key} が固定値に無い`).toBeDefined();
        expect(
          got?.calls.length,
          `場面 ${key} の呼びの数が変わった: 固定値 ${String(want?.calls.length)} 回 → いま ${String(got?.calls.length)} 回`,
        ).toBe(want?.calls.length);
        expect(
          got?.calls,
          `場面 ${key} の呼びの並び（呼んだ順・引数・結果）が固定値からずれた`,
        ).toEqual(want?.calls);
      });
    }
  });

  it('同じ入力で2回回すと、全場面で同じ出力・呼びの並びになる（時計・並びが固定されている）', async () => {
    expect(await runAll()).toEqual(actual);
  });

  it('場面が狙った分岐を通っている（固定値が別の分岐へ流れていないことの目印）', () => {
    const step = (key: string): PinnedStep | undefined => actual[key];
    const text = (key: string): string => step(key)?.output.text ?? '';
    const calls = (key: string): string[] => step(key)?.calls ?? [];
    const callsOf = (key: string, head: string): number =>
      calls(key).filter((line) => line.startsWith(head)).length;
    const count = (haystack: string, needle: string): number => haystack.split(needle).length - 1;
    const TURN_CALL = 'journal.list({"types":["turn_timing"],"limit":30}) -> ';
    const HTTP_CALL = 'journal.list({"types":["http_timing"],"limit":12}) -> ';
    const READS = [
      'persona.list(',
      'persona.documents(',
      'usage.aggregate(',
      'codexAuth.get(',
      'journal.list(',
    ];
    const readsOf = (key: string): number =>
      READS.reduce((sum, head) => sum + callsOf(key, head), 0);

    // runtime
    expect(text('runtime-absent#1')).toBe(
      'いまは自分の実行時の事実を読めない場面である（記憶へ移すための内部ターン）。次の会話で呼ぶこと。',
    );
    expect(text('runtime-absent#2')).toBe(text('runtime-absent#1'));
    for (const key of ['runtime-absent#1', 'runtime-absent#2']) {
      expect(calls(key), key).toEqual(['context.runtime() -> undefined']);
    }
    expect(text('runtime-unobserved#1')).toBe(text('runtime-unobserved#2'));
    expect(text('runtime-unobserved#1')).toContain('まだ init を観測していないので');
    expect(text('runtime-unobserved#1')).toContain('MCP サーバ: まだ分からない（init 未観測）');
    expect(callsOf('runtime-unobserved#1', 'usage.aggregate('), 'sdkModel null').toBe(0);
    expect(callsOf('runtime-unobserved#1', 'persona.list('), 'persona.list').toBe(1);
    expect(text('runtime-model-mcp-empty')).toContain('MCP サーバ: 0本（init は観測済み）');
    expect(text('runtime-model-mcp-empty')).toContain(
      `台帳にはまだ1件も記録が無い（いまのモデル id: ${MODEL}）`,
    );
    expect(callsOf('runtime-model-mcp-empty', 'usage.aggregate('), 'sdkModel あり').toBe(1);
    expect(text('runtime-full')).toContain(
      '0123456（イメージに焼き込み済み、フル 0123456789abcdef',
    );
    expect(text('runtime-full')).toContain('2026-10-26T00:00:00.000Z（');
    expect(text('runtime-full')).toContain('人間が `ALTEROID_CLONE_MODEL` に置いた値');
    expect(text('runtime-full')).toContain('alteroid(connected), search(failed)');
    expect(text('runtime-full')).toContain('分類できず 7 トークン（1 軸）');
    expect(text('runtime-mcp-long')).toContain('…');
    expect(text('runtime-context-error')).toContain(
      '観測を試みて失敗した（理由: getContextUsage が応答しなかった）',
    );
    expect(text('runtime-context-no-categories')).toContain('SDK がカテゴリ別の内訳を返さなかった');
    expect(text('runtime-route-empty')).toContain('## SDK の接続先とモデルの別名');
    expect(text('runtime-route-lines')).toContain('  opus → claude-opus-5');
    // runner の項目
    expect(callsOf('runtime-model-mcp-empty', 'context.runnerModels('), 'runner 口なし').toBe(0);
    expect(text('runtime-model-mcp-empty')).not.toContain('## 接続中の runner');
    expect(text('runner-models')).toContain(
      '## 接続中の runner が名乗ったモデル（マネージャー・作業者）',
    );
    expect(text('runner-models')).not.toContain('## 接続中の runner の SDK の接続先');
    expect(callsOf('runner-models', 'context.runnerModels('), 'runnerModels').toBe(1);
    expect(callsOf('runner-models', 'context.runnerAnthropicRoutes('), 'routes 口なし').toBe(0);
    expect(text('runner-routes')).toContain('## 接続中の runner の SDK の接続先とモデルの別名');
    expect(text('runner-routes')).not.toContain('## 接続中の runner が名乗ったモデル');
    expect(
      text('runner-both-with-route-lines').indexOf('接続中の runner が名乗ったモデル'),
    ).toBeLessThan(text('runner-both-with-route-lines').indexOf('## SDK の接続先とモデルの別名'));
    expect(
      text('runner-both-with-route-lines').indexOf('## SDK の接続先とモデルの別名'),
    ).toBeLessThan(
      text('runner-both-with-route-lines').indexOf('## 接続中の runner の SDK の接続先'),
    );
    expect(text('runner-empty-lines')).not.toContain('## 接続中の runner');
    expect(
      callsOf('runner-empty-lines', 'context.runnerModels('),
      'runner-empty-lines models',
    ).toBe(1);
    expect(
      callsOf('runner-empty-lines', 'context.runnerAnthropicRoutes('),
      'runner-empty-lines routes',
    ).toBe(1);
    // 読みが落ちた節は断りの文にして、ほかの節は出す（#6486）
    expect(step('runner-models-throws')?.output.thrown).toBe(false);
    expect(text('runner-models-throws')).toContain(
      '接続中の runner が名乗ったモデル: 読めなかった（Error: context.runnerModels が落ちた）',
    );
    expect(text('runner-models-throws')).toContain('## 記憶の大きさ');
    expect(text('runner-models-throws')).toContain('## 台帳との突き合わせ');
    expect(
      callsOf('runner-models-throws', 'context.runnerAnthropicRoutes('),
      'routes にも進む',
    ).toBe(1);
    expect(step('runner-routes-throws')?.output.thrown).toBe(false);
    expect(text('runner-routes-throws')).toContain(
      '接続中の runner の SDK の接続先: 読めなかった（Error: context.runnerAnthropicRoutes が落ちた）',
    );
    expect(text('runner-routes-throws')).toContain('## 記憶の大きさ');
    // 台帳（cursor なし）
    expect(text('ledger-other-model')).toContain(`モデル id ${MODEL} と同じ行は無い（台帳の始点: `);
    expect(text('ledger-few')).toContain('行の内訳（台帳の軸そのもの。');
    expect(count(text('ledger-few'), '\n  - managerId:'), 'ledger-few の件数').toBe(4);
    expect(text('ledger-few')).toContain(
      'managerId: "clone" / layer: clone / site: session / 合計 $2.00',
    );
    expect(text('ledger-few')).not.toContain('mgr-009');
    expect(text('ledger-few')).not.toContain('ledgerCursor=');
    expect(count(text('ledger-exact-14'), '\n  - managerId:'), 'ledger-exact-14').toBe(14);
    expect(text('ledger-exact-14')).not.toContain('ledgerCursor=');
    expect(count(text('ledger-15-truncated'), '\n  - managerId:'), 'ledger-15-truncated').toBe(14);
    expect(text('ledger-15-truncated')).toContain('残り 1 件は出していない。');
    // 台帳（cursor あり）
    expect(text('ledger-paging#1')).toContain('残り 106 件は出していない。');
    expect(text('ledger-paging#2')).toContain('モデル id claude-opus-5 の行の内訳（全 120 件）:');
    expect(text('ledger-paging#2')).not.toContain('## いまどう走っているか');
    expect(count(text('ledger-paging#2'), '\n  - managerId:'), 'ledger-paging#2').toBe(100);
    expect(text('ledger-paging#2')).toContain('残り 6 件は出していない。');
    expect(count(text('ledger-paging#3'), '\n  - managerId:'), 'ledger-paging#3').toBe(6);
    expect(text('ledger-paging#3')).not.toContain('ledgerCursor=');
    expect(text('ledger-paging#4')).toContain('（ledgerCursor より後ろは無い。これが最後の頁）');
    for (const n of [2, 3, 4]) {
      expect(readsOf(`ledger-paging#${String(n)}`), `cursor の頁 ${String(n)} の読み`).toBe(1);
      expect(
        callsOf(`ledger-paging#${String(n)}`, 'usage.aggregate('),
        `aggregate ${String(n)}`,
      ).toBe(1);
    }
    expect(text('ledger-cursor-risen#2')).toContain(
      '⚠ 順位が上がった、または既に見せた行が伸びた可能性がある行',
    );
    expect(text('ledger-cursor-risen#2')).toContain('managerId: "m-000"');
    expect(text('ledger-cursor-risen-overflow#2')).toContain('…ほか 6 件は省略。');
    expect(text('ledger-cursor-errors#1')).toContain('ledgerCursor が壊れている');
    expect(text('ledger-cursor-errors#2')).toContain('ledgerCursor が壊れている');
    expect(text('ledger-cursor-errors#3')).toContain(
      'ledgerCursor が別の文脈（usage_read の axis 用など）のものである',
    );
    expect(text('ledger-cursor-errors#4')).toContain('全 4 件');
    expect(text('ledger-cursor-sdk-null')).toContain('まだ init を観測していないので');
    expect(callsOf('ledger-cursor-sdk-null', 'usage.aggregate('), 'cursor sdk null').toBe(0);
    expect(text('ledger-cursor-empty-ledger')).toContain('台帳にはまだ1件も記録が無い');
    expect(text('ledger-cursor-other-model')).toContain('と同じ行は無い');
    expect(step('ledger-cursor-aggregate-fails')?.output.thrown).toBe(false);
    expect(text('ledger-cursor-aggregate-fails')).toContain(
      '台帳を読めなかった（Error: usage.aggregate が読めない）。',
    );
    expect(step('ledger-aggregate-fails')?.output.thrown).toBe(false);
    expect(text('ledger-aggregate-fails')).toContain(
      '台帳を読めなかった（Error: usage.aggregate が読めない）。',
    );
    expect(text('ledger-aggregate-fails')).toContain('## 記憶の大きさ');
    // 記憶
    expect(text('runtime-unobserved#1')).toContain('- 総文字数: 0 文字（0 文書）');
    expect(text('memory-mixed')).toContain('文書）');
    expect(text('memory-mixed')).toContain('[premise] values:');
    expect(text('memory-mixed')).toContain('[fact] about-me:');
    expect(text('memory-mixed')).toContain('…');
    expect(text('memory-many')).toContain('…ほか ');
    expect(text('memory-many')).toContain('文書は省略（全 60 文書のうち ');
    expect(text('memory-mixed')).not.toContain('カードを落とし');
    expect(text('memory-demoted')).toContain('⚠️ うち ');
    expect(text('memory-demoted')).toContain('カードを落とし、1行になっている');
    expect(step('memory-persona-list-fails')?.output.thrown).toBe(false);
    expect(text('memory-persona-list-fails')).toContain(
      '記憶を読めなかった（Error: persona.list が読めない）。',
    );
    expect(text('memory-persona-list-fails')).toContain('## 台帳との突き合わせ');
    expect(
      callsOf('memory-persona-list-fails', 'journal.list('),
      'list 失敗でも他の読みは始まっている',
    ).toBe(2);
    expect(step('memory-persona-documents-fails')?.output.thrown).toBe(false);
    expect(text('memory-persona-documents-fails')).toContain(
      '記憶を読めなかった（Error: persona.documents が読めない）。',
    );
    // Codex
    expect(text('codex-none')).not.toContain('Codex');
    expect(text('codex-valid')).toContain(
      'Codex の ChatGPT ログイン: あり（me@example.com・plus。',
    );
    expect(text('codex-valid')).not.toContain('rt-pin-fake');
    expect(text('codex-valid-bare')).toContain('(アカウント不明)・(プラン不明)');
    expect(text('codex-failed')).toContain('refresh token was revoked');
    expect(text('codex-failed')).toContain('alteroid codex login');
    expect(text('codex-unreadable')).toContain(
      'Codex の ChatGPT ログイン: 正本を読めなかった（Error: codexAuth.get が読めない）',
    );
    expect(step('codex-unreadable')?.output.thrown).toBe(false);
    // 日誌
    expect(text('runtime-model-mcp-empty')).toContain('直近のターンの時間: まだ記録が無い');
    expect(text('runtime-model-mcp-empty')).toContain('HTTP API の時間: まだ記録が無い');
    expect(calls('runtime-model-mcp-empty')).toContain(`${TURN_CALL}0 items`);
    expect(calls('runtime-model-mcp-empty')).toContain(`${HTTP_CALL}0 items`);
    expect(text('timing-turn-some')).toContain('直近のターンの時間（5 件。');
    expect(text('timing-turn-some')).toContain('- 道具を1回も呼ばなかったターン: ');
    expect(text('timing-turn-some')).toContain('束 1 ターン');
    expect(calls('timing-turn-some')).toContain(`${TURN_CALL}5 items`);
    expect(text('timing-turn-many')).toContain('直近のターンの時間（30 件。');
    expect(text('timing-turn-many')).toContain(' / 他 2 種');
    expect(calls('timing-turn-many')).toContain(`${TURN_CALL}30 items`);
    expect(text('timing-turn-unreadable')).toContain(
      '直近のターンの時間: 日誌を読めなかった（Error: journal.turn_timing が読めない）。',
    );
    expect(text('timing-turn-unreadable')).toContain('HTTP API の時間: まだ記録が無い');
    expect(calls('timing-turn-unreadable')).toContain(`${TURN_CALL.slice(0, -4)} -> threw Error`);
    expect(text('timing-http-some')).toContain('HTTP API の時間（3 窓・要求 ');
    expect(text('timing-http-some')).toContain('POST /messages:');
    expect(calls('timing-http-some')).toContain(`${HTTP_CALL}3 items`);
    expect(text('timing-http-many')).toContain('HTTP API の時間（12 窓・');
    expect(text('timing-http-many')).not.toContain('5000');
    expect(calls('timing-http-many')).toContain(`${HTTP_CALL}12 items`);
    expect(text('timing-http-unreadable')).toContain(
      'HTTP API の時間: 日誌を読めなかった（Error: journal.http_timing が読めない）。',
    );
    expect(text('timing-http-unreadable')).toContain('直近のターンの時間: まだ記録が無い');
    expect(text('timing-both-unreadable')).toContain('直近のターンの時間: 日誌を読めなかった');
    expect(text('timing-both-unreadable')).toContain('HTTP API の時間: 日誌を読めなかった');
    // マネージャー
    expect(callsOf('runtime-model-mcp-empty', 'managers.'), 'managers 無し').toBe(0);
    expect(text('managers-peers')).toContain(
      'マネージャーが peer（Codex など）に作業を頼めるか（器ごと。',
    );
    expect(text('managers-peers')).toContain(
      '- local: Codex に作業を頼める（peer: codex。名指しできるモデル: gpt-5, gpt-5-mini） / Claude に作業を頼める',
    );
    expect(text('managers-peers')).toContain('- runner-1: Codex は閉じている（');
    expect(text('managers-peers')).toContain('- runner-2: 不明（');
    expect(text('managers-peers')).not.toContain('runner-3');
    expect(text('managers-peers')).not.toContain('runner-4');
    expect(calls('managers-peers')).toContain('managers.runners() -> 5 runners');
    expect(text('managers-no-rows')).not.toContain('マネージャーが peer');
    expect(calls('managers-no-rows')).toContain('managers.runners() -> 0 runners');
    expect(text('managers-only-silent-rows')).not.toContain('マネージャーが peer');
    expect(calls('managers-only-silent-rows')).toContain('managers.runners() -> 2 runners');
    expect(text('managers-runners-throws')).not.toContain('マネージャーが peer（Codex など）');
    expect(text('managers-runners-throws')).toContain(
      'マネージャーの peer の届き先: 器の名簿を読めなかった（Error: ',
    );
    expect(step('managers-runners-throws')?.output.thrown).toBe(false);
    expect(calls('managers-runners-throws')).toContain('managers.runners() -> threw Error');
    expect(text('managers-many')).toContain('…ほか ');
    expect(text('managers-many')).toContain('台は省略（全 30 台のうち ');
    // 呼びの並び（Promise.all の6つが始まる順）
    expect(calls('everything#1')).toEqual([
      'context.runtime() -> facts',
      'context.runnerModels() -> 1 lines',
      'context.runnerAnthropicRoutes() -> 1 lines',
      'persona.list() -> 6 items',
      'persona.documents() -> 6 items',
      expect.stringMatching(/^usage\.aggregate\(\{\}\) -> rows=15 since=/),
      'codexAuth.get() -> record',
      `${TURN_CALL}5 items`,
      `${HTTP_CALL}3 items`,
      'managers.runners() -> 5 runners',
    ]);
    expect(count(text('everything#1'), '\n## '), 'everything の節').toBeGreaterThanOrEqual(4);
    expect(text('everything#2')).toContain('行の内訳（全 15 件）');
    expect(readsOf('everything#2')).toBe(1);
  });
});
