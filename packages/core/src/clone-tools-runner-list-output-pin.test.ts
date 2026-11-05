import { readFileSync, writeFileSync } from 'node:fs';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type {
  ManagerPool,
  RunnerFleetOverview,
  RunnerManagerEntry,
  RunnerOverview,
} from './manager.js';
import { encodeRunnerCursor } from './runner-cursor.js';
import { createMemoryStores } from './testing.js';
import { createCloneTools } from './tools.js';

// `runner_list` の出力（全文と字数）を、場面ごとにコミットした固定値（clone-tools-runner-list-output-pin.json）と丸ごと比べる。
// `clone-tools-ops.ts` の `tool('runner_list', …)`（約 497 行の式）を出力の部分ごとの小さな関数へ分けるとき、
// 出力が1文字も変わらないことを機械で確かめる歯。固定値の側で値を伏せず、入力（時計・時刻・id・並び）を固定して毎回同じ出力にする。
//
// 固定値の作り直し（意図して出力を変えたときだけ。PR 本文に理由を書く）:
//   UPDATE_RUNNER_LIST_PIN=1 pnpm -C <作業ツリー> --filter @alteroid/core exec vitest run src/clone-tools-runner-list-output-pin.test.ts --maxWorkers=2
//   pnpm -C <作業ツリー> exec prettier --write packages/core/src/clone-tools-runner-list-output-pin.json
// 手で json を書き換えない。作り直したら `git diff` で、どの場面が何字から何字に動いたかを読む。
// json の先頭の `lengths` が場面ごとの字数の一覧（どの部分が何字を出しているかを見る基準）。
//
// 時計は Date だけを固定する（`setTimeout` などは本物のまま。実時間の待ちは使わない）。
// 偽の `ManagerPool` は `runners()` だけを持ち、場面が決めた名簿（`RunnerFleetOverview`）をそのまま返す。
// 名簿の中の時刻・id・並びはすべて入力として固定してあり、固定値の側では何も伏せない。

type Args = Record<string, unknown>;
type PreviousTexts = readonly string[];

interface Step {
  args?: Args | ((previous: PreviousTexts) => Args);
  /** この呼びの前に名簿を差し替える */
  mutate?: (fleet: RunnerFleetOverview) => RunnerFleetOverview;
}

interface Scenario {
  name: string;
  /** 通る分岐の覚え書き（読み手のため。判定には使わない） */
  covers: string;
  /** 偽の pool を付けない（記憶へ移すための内部ターン） */
  noPool?: boolean;
  fleet?: () => RunnerFleetOverview;
  steps: Step[];
  /** 真なら、この呼びをサブエージェントのものとして扱う（畳まない） */
  subagent?: boolean;
}

const FROZEN_NOW = '2026-10-27T02:00:00.000Z';
const PIN_URL = new URL('./clone-tools-runner-list-output-pin.json', import.meta.url);
const UPDATE = process.env.UPDATE_RUNNER_LIST_PIN === '1';

function iso(minutesFromBase: number): string {
  return new Date(Date.UTC(2026, 9, 27, 0, 0, 0) + minutesFromBase * 60_000).toISOString();
}

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

const REV_BUILD = {
  status: 'known' as const,
  commit: SHA_A,
  short: SHA_A.slice(0, 7),
  source: 'build' as const,
};
const REV_WORKSPACE = {
  status: 'known' as const,
  commit: SHA_B,
  short: SHA_B.slice(0, 7),
  source: 'workspace' as const,
};
const REV_ENV = {
  status: 'known' as const,
  commit: 'c'.repeat(40),
  short: 'c'.repeat(7),
  source: 'env' as const,
};
const REV_PLATFORM = {
  status: 'known' as const,
  commit: 'd'.repeat(40),
  short: 'd'.repeat(7),
  source: 'platform' as const,
};

/** 名乗っていない最小の器（`runnerId`・`workspacePath`・`instanceId` が無い） */
function bare(n: number, extra: Partial<RunnerOverview> = {}): RunnerOverview {
  return {
    label: `runner-${String(n)}`,
    state: 'connecting',
    since: iso(n),
    managers: [],
    revision: { status: 'unheard' },
    ...extra,
  };
}

/** 名乗っている普通の器 */
function rn(n: number, extra: Partial<RunnerOverview> = {}): RunnerOverview {
  return {
    label: `runner-${String(n)}`,
    state: 'connected',
    since: iso(n),
    runnerId: `rid-${String(n)}`,
    workspacePath: `/work/r${String(n)}`,
    instanceId: `inst-${String(n)}`,
    instanceSince: iso(n + 1),
    managers: [],
    revision: REV_BUILD,
    ...extra,
  };
}

function me(n: number, extra: Partial<RunnerManagerEntry> = {}): RunnerManagerEntry {
  return {
    managerId: `mgr-${String(n).padStart(3, '0')}`,
    status: 'running',
    live: true,
    ...extra,
  };
}

function fleet(
  runners: RunnerOverview[],
  extra: Partial<RunnerFleetOverview> = {},
): RunnerFleetOverview {
  return { runners, unassigned: [], daemonRevision: REV_BUILD, ...extra };
}

const NOW_PUSH = { status: 'ok' as const, at: iso(5) };

// 状態・版・名乗りの違う3台
const multiStates = (): RunnerFleetOverview =>
  fleet([
    rn(1, { managers: [me(1), me(2, { status: 'done', live: false })] }),
    rn(2, {
      state: 'lost',
      error: 'heartbeat が途絶えた（最後に聞いたのは 10 分前）',
      revision: REV_WORKSPACE,
      managers: [me(3, { status: 'running', live: false })],
    }),
    bare(3, { state: 'unreachable', error: 'connect ECONNREFUSED 10.0.0.3:7000' }),
    rn(4, { state: 'vacating', revision: REV_ENV, instanceSince: undefined }),
    rn(5, { state: 'unusable', revision: { status: 'unknown' } }),
    rn(6, { state: 'connected', revision: REV_PLATFORM, workspacePath: undefined }),
  ]);

const peerCase = (n: number, managerPeers: RunnerOverview['managerPeers']): RunnerOverview =>
  rn(n, { managerPeers });

const manyModels = Array.from({ length: 30 }, (_, i) => `gpt-5.${String(i)}-codex-long-name`);

const fingerprintFleet = (): RunnerFleetOverview =>
  fleet([
    rn(1, {
      credentials: [
        { name: 'GH_TOKEN', sha256: 'e'.repeat(64), updatedAt: iso(1) },
        { name: 'NPM_TOKEN', sha256: 'f'.repeat(64), updatedAt: iso(1) },
      ],
      credentialsProbe: { status: 'asked' },
      profile: { sha256: '1'.repeat(64), bytes: 120, updatedAt: iso(1) },
      profileProbe: { status: 'asked' },
      mcpServers: { names: ['github', 'linear'], sha256: '2'.repeat(64), updatedAt: iso(1) },
      mcpServersProbe: { status: 'asked' },
    }),
    rn(2, {
      credentials: [],
      credentialsProbe: { status: 'asked' },
      profileProbe: { status: 'asked' },
      mcpServers: { names: [], sha256: '3'.repeat(64), updatedAt: iso(1) },
      mcpServersProbe: { status: 'asked' },
    }),
    rn(3, {
      state: 'unreachable',
      credentialsProbe: { status: 'unheard' },
      profileProbe: { status: 'unheard' },
      mcpServersProbe: { status: 'unheard' },
    }),
    rn(4, {
      credentialsProbe: { status: 'failed', error: 'RPC timeout' },
      profileProbe: { status: 'failed', error: 'profile 500' },
      mcpServersProbe: { status: 'failed', error: 'mcp 502' },
    }),
    rn(5, { mcpServersProbe: { status: 'unsupported' } }),
    rn(6, {
      credentials: Array.from({ length: 12 }, (_, i) => ({
        name: `SECRET_NUMBER_${String(i)}`,
        sha256: String(i % 10).repeat(64),
        updatedAt: iso(1),
      })),
      credentialsProbe: { status: 'asked' },
      mcpServers: {
        names: Array.from({ length: 40 }, (_, i) => `mcp-server-${String(i)}`),
        sha256: '4'.repeat(64),
        updatedAt: iso(1),
      },
      mcpServersProbe: { status: 'asked' },
    }),
    // 欄が丸ごと無い器（probe も値も無い）
    rn(7),
  ]);

const pushFleet = (): RunnerFleetOverview =>
  fleet([
    rn(1, {
      pushHealth: {
        profile: NOW_PUSH,
        credentials: { status: 'failed', at: iso(6), error: 'EACCES: 鍵を置けない' },
        agentToken: { status: 'failed', at: iso(7) },
        mcpServers: NOW_PUSH,
        plugins: { status: 'failed', at: iso(8), error: 'plugin 展開に失敗' },
        permissionRules: NOW_PUSH,
      },
    }),
    rn(2, { pushHealth: { agentToken: NOW_PUSH } }),
    rn(3, { pushHealth: {} }),
    rn(4, {
      pushHealth: { permissionRules: { status: 'failed', at: iso(9), error: '無視される' } },
    }),
    rn(5),
  ]);

const reclaimFull = {
  mode: 'reclaim' as const,
  subreaper: { command: 'tini' },
  candidates: 12,
  candidateThreads: 30,
  roots: 3,
  largestTreeCandidates: 7,
  singletonTrees: 2,
  oldestAgeSec: 5400,
  medianAgeSec: 130,
  ageBuckets: [
    { upToSec: 60, count: 1 },
    { upToSec: 600, count: 2 },
    { upToSec: 3600, count: 3 },
    { upToSec: 21600, count: 4 },
    { upToSec: 90000, count: 5 },
    { count: 6 },
  ],
  signalled: 4,
  killed: 3,
  freedThreads: 9,
  lastRunAt: 1_700_000_000,
  pidsAtScan: { current: 900, max: 1000 },
  notFired: {
    outsideRoots: {
      total: 8,
      parentInScan: 5,
      bySid: {
        wouldFire: 1,
        sidUnknown: 2,
        sidLive: 3,
        sidLeaderPresent: 4,
        sidUnrecognised: 5,
        unrecognisedBy: { ownerLive: 1, ownerListed: 2, ownerUnknown: 2 },
      },
    },
    held: {
      sidUnknown: 1,
      sidLive: 2,
      sidLeaderPresent: 3,
      sidUnrecognised: 4,
      unrecognisedBy: { ownerLive: 1, ownerListed: 1, ownerUnknown: 2 },
    },
    observeOnly: 6,
  },
};

const reclaimMinimal = {
  mode: 'observe' as const,
  candidates: 0,
  candidateThreads: 0,
  signalled: 0,
  killed: 0,
  freedThreads: 0,
  lastRunAt: 1_700_000_100,
};

// resources: true の枝（pids の読めた／読めない／訊けない、内訳、孤児、持ち主の記録）
const resourceFleet = (): RunnerFleetOverview =>
  fleet([
    // 読めて、内訳が全部ある
    rn(1, {
      resources: {
        pids: { current: 812, max: 1000 },
        pidOwnerRecords: { remembered: 1234, cap: 5000, forgottenTotal: 1_234_567 },
        tasks: {
          threads: 900,
          processes: 300,
          zombies: 40,
          zombieCommands: [
            { command: 'node', count: 30 },
            { command: 'git', count: 10 },
          ],
          oldestZombieSeconds: 45,
          reclaim: reclaimFull,
        },
      },
    }),
    // 読めて、内訳（tasks）が無い古い runner
    rn(2, { resources: { pids: { current: 10, max: 100 } } }),
    // 内訳はあるが zombieCommands が空・oldest が分以上
    rn(3, {
      resources: {
        pids: { current: 50, max: 100 },
        tasks: {
          threads: 80,
          processes: 20,
          zombies: 5,
          zombieCommands: [],
          oldestZombieSeconds: 7200,
        },
      },
    }),
    // 孤児の欄が最小（観測のみ・走査時 pids も年齢も無い）
    rn(4, {
      resources: {
        pids: { current: 5, max: 100 },
        tasks: { threads: 10, processes: 5, zombies: 0, reclaim: reclaimMinimal },
      },
    }),
    // 孤児の別の枝: subreaper が null・roots だけ（3つ揃わない）・hold が無い・bySid が無い
    rn(5, {
      resources: {
        pids: { current: 5, max: 100 },
        tasks: {
          threads: 10,
          processes: 5,
          zombies: 1,
          oldestZombieSeconds: 200_000,
          reclaim: {
            ...reclaimMinimal,
            mode: 'reclaim',
            candidates: 2,
            candidateThreads: 4,
            oldestAgeSec: 30,
            subreaper: { command: null },
            roots: 1,
            medianAgeSec: 20,
            notFired: { outsideRoots: { total: 1, parentInScan: 0 } },
          },
        },
      },
    }),
    // pids が読めない（cgroup 無し）。持ち主の記録だけある
    rn(6, {
      resources: { pidOwnerRecords: { remembered: 0, cap: 10, forgottenTotal: 0 } },
    }),
    // 資源が無い理由の4つ + 理由の欄すら無い
    rn(7, { state: 'unreachable', resourcesProbe: { status: 'unheard' } }),
    rn(8, { resourcesProbe: { status: 'failed', error: 'resources() が落ちた' } }),
    rn(9, { resourcesProbe: { status: 'unsupported' } }),
    rn(10, { resourcesProbe: { status: 'asked' } }),
    rn(11),
  ]);

const saturationFleet = (): RunnerFleetOverview =>
  fleet([
    rn(1, {
      pidsSaturation: {
        windowMs: 300_000,
        basis: [{ kind: 'at-limit', current: 1000, max: 1000 }],
      },
    }),
    rn(2, {
      pidsSaturation: { windowMs: 300_000, basis: [{ kind: 'eagain', count: 3 }] },
    }),
    rn(3, {
      pidsSaturation: { windowMs: 300_000, basis: [{ kind: 'fork-denied', count: 2 }] },
    }),
    rn(4, {
      pidsSaturation: {
        windowMs: 300_000,
        basis: [
          { kind: 'at-limit', current: 64, max: 64 },
          { kind: 'eagain', count: 1 },
          { kind: 'fork-denied', count: 1 },
        ],
      },
      resources: { pids: { current: 64, max: 64 } },
    }),
    rn(5),
  ]);

// 予算（8,000字）を越える名簿。fingerprints: true の鍵の抜粋で1台あたり約 700 字
function bigFleet(count: number): RunnerFleetOverview {
  return fleet(
    Array.from({ length: count }, (_, i) =>
      rn(i + 1, {
        credentials: Array.from({ length: 10 }, (_, k) => ({
          name: `K${String(i)}_${String(k)}`,
          sha256: String((i + k) % 10).repeat(64),
          updatedAt: iso(1),
        })),
        credentialsProbe: { status: 'asked' },
        managers: [me(i + 1)],
      }),
    ),
  );
}

const AUTO_FOLDED = [
  {
    managerId: 'mgr-001',
    runnerId: 'rid-1',
    outcome: 'folded' as const,
    detail: '畳んだ（done・背景なし）',
  },
  {
    managerId: 'mgr-002',
    runnerId: 'rid-1',
    outcome: 'blocked-unpushed-work' as const,
    detail: '未 push の実装が 2 件ある',
  },
  {
    managerId: 'mgr-003',
    runnerId: 'rid-2',
    outcome: 'unknown' as const,
    detail: '確認できなかった',
  },
];

function cursorOf(text: string | undefined): string {
  const found = /runner_list cursor=(\S+)/.exec(text ?? '');
  if (found?.[1] === undefined) throw new Error('出力に続きの cursor が無い');
  return found[1];
}

const SCENARIOS: Scenario[] = [
  {
    name: 'no-pool',
    covers: 'managers が無い（記憶へ移すための内部ターン）で NO_POOL を返す',
    noPool: true,
    steps: [{}],
  },
  {
    name: 'zero-runners',
    covers:
      'runner が0台（版の行だけ。引数・cursor を付けても同じ。壊れた cursor は0台より先に弾く）',
    fleet: () => fleet([]),
    steps: [
      {},
      { args: { resources: true, fingerprints: true } },
      { args: { cursor: encodeRunnerCursor({ label: 'runner-x' }) } },
      { args: { cursor: 'これは cursor ではない' } },
    ],
  },
  {
    name: 'zero-runners-daemon-unknown',
    covers: 'runner が0台でデーモンの版が不明',
    fleet: () => fleet([], { daemonRevision: { status: 'unknown' } }),
    steps: [{}],
  },
  {
    name: 'zero-runners-autofolded',
    covers: '0台のときの自動畳みの注記（候補なし／あり）。壊れた cursor にも付く',
    fleet: () => fleet([], { autoFolded: [] }),
    steps: [
      { args: { resources: true } },
      {
        args: { resources: true },
        mutate: (f) => ({ ...f, autoFolded: AUTO_FOLDED }),
      },
      { args: { cursor: 'こわれた' } },
    ],
  },
  {
    name: 'single-bare',
    covers: '1台のみ（分散していない）・名乗っていない器・マネージャー無し・版は未確認',
    fleet: () => fleet([bare(1)]),
    steps: [{}],
  },
  {
    name: 'single-full',
    covers:
      '1台のみ・名乗っている器・直近の失敗・peer（Codex）・pids 飽和・マネージャーと「どの器か分からない」',
    fleet: () =>
      fleet(
        [
          rn(1, {
            error: '直近の接続で 1 度失敗した',
            managerPeers: {
              status: 'named',
              peers: [{ provider: 'codex', models: ['gpt-5-codex', 'gpt-5.1-codex-max'] }],
            },
            pidsSaturation: {
              windowMs: 300_000,
              basis: [{ kind: 'eagain', count: 2 }],
            },
            managers: [me(1), me(2, { status: 'done', live: false })],
          }),
        ],
        { unassigned: [me(90, { status: 'lost', live: false })] },
      ),
    steps: [{}, { args: { resources: true } }],
  },
  {
    name: 'multi-states',
    covers: '複数台・6値の state・版の4種と不明・instanceSince/workspacePath/runnerId の有無',
    fleet: multiStates,
    steps: [{}],
  },
  {
    name: 'peers',
    covers:
      'peer の行: 名乗り不明／開いている peer が無い（行なし）／Codex（モデル有無）／Claude／他の provider／閉じている／開閉の混在／長くて切れる',
    fleet: () =>
      fleet([
        peerCase(1, { status: 'unknown' }),
        peerCase(2, { status: 'named', peers: [] }),
        peerCase(3, { status: 'named', peers: [{ provider: 'codex' }] }),
        peerCase(4, { status: 'named', peers: [{ provider: 'codex', models: [] }] }),
        peerCase(5, {
          status: 'named',
          peers: [{ provider: 'claude', models: ['opus', 'sonnet'] }, { provider: 'other-llm' }],
        }),
        peerCase(6, {
          status: 'named',
          peers: [],
          closed: [{ provider: 'codex', reason: '認証が切れている' }],
        }),
        peerCase(7, {
          status: 'named',
          peers: [{ provider: 'codex', models: ['gpt-5-codex'] }],
          closed: [{ provider: 'claude', reason: '枠が尽きた' }],
        }),
        peerCase(8, { status: 'named', peers: [{ provider: 'codex', models: manyModels }] }),
        rn(9),
      ]),
    steps: [{}],
  },
  {
    name: 'manager-states',
    covers:
      'マネージャーの状態の字面（切断・不明・背景処理待ち）と世代ずれの印（一致・材料なし・食い違い）',
    fleet: () =>
      fleet(
        [
          rn(1, {
            managers: [
              me(1),
              me(2, { live: false }),
              me(3, { live: undefined as unknown as boolean }),
              me(4, {
                status: 'done',
                live: false,
                awaitingBackground: {
                  tasks: 2,
                  withheldReports: 1,
                  breakdown: 'bash×2',
                  since: iso(20),
                },
              }),
              me(5, { status: 'waiting_human' }),
              me(6, { tokenGeneration: 3, activeTokenGeneration: 3 }),
              me(7, { tokenGeneration: 2, activeTokenGeneration: 5 }),
              me(8, { tokenGeneration: 2 }),
              me(9, { activeTokenGeneration: 2 }),
            ],
          }),
        ],
        {
          unassigned: [
            me(80, { tokenGeneration: 1, activeTokenGeneration: 4 }),
            me(81, { status: 'stopped', live: false }),
          ],
        },
      ),
    steps: [{}],
  },
  {
    name: 'managers-overflow',
    covers: 'マネージャーが 20 本を越えて省略される（器の内訳と「どの器か分からない」の両方）',
    fleet: () =>
      fleet(
        [
          rn(1, { managers: Array.from({ length: 25 }, (_, i) => me(i + 1)) }),
          rn(2, { managers: Array.from({ length: 20 }, (_, i) => me(i + 101)) }),
        ],
        { unassigned: Array.from({ length: 23 }, (_, i) => me(i + 201)) },
      ),
    steps: [{}],
  },
  {
    name: 'unassigned-only',
    covers: '器のマネージャーは無く、どの器か分からないものだけが在る（ちょうど 20 本）',
    fleet: () => fleet([rn(1)], { unassigned: Array.from({ length: 20 }, (_, i) => me(i + 1)) }),
    steps: [{}],
  },
  {
    name: 'fingerprints',
    covers:
      'fingerprints 無し（出さない）と有り: 鍵・プロファイル・MCP の 聞いていない／失敗／0件／在る／口が無い／長くて切れる／欄が無い',
    fleet: fingerprintFleet,
    steps: [{}, { args: { fingerprints: true } }, { args: { fingerprints: false } }],
  },
  {
    name: 'push-health',
    covers:
      '直近の押し込み: ok／失敗（理由あり・理由不明）／一部だけ／空／未試行（permissionRules は出ない）',
    fleet: pushFleet,
    steps: [{}],
  },
  {
    name: 'resources',
    covers:
      'resources 無し（出さない）と有り: pids・内訳・ゾンビ・孤児（reclaim/observe・引き取り手・木・齢・notFired）・持ち主の記録・資源が無い理由',
    fleet: resourceFleet,
    steps: [{}, { args: { resources: true } }, { args: { resources: false } }],
  },
  {
    name: 'saturation',
    covers:
      'pids 飽和の行: 上限到達／EAGAIN／fork 拒否／3つ全部／材料なし（行なし）。resources 有無',
    fleet: saturationFleet,
    steps: [{}, { args: { resources: true } }],
  },
  {
    name: 'everything',
    covers: 'fingerprints と resources を両方付けた全部入り（選択肢の組み合わせ）',
    fleet: () =>
      fleet(
        [...fingerprintFleet().runners, ...resourceFleet().runners.slice(0, 2)].map(
          (runner, i) => ({
            ...runner,
            label: `all-${String(i + 1)}`,
          }),
        ),
        { unassigned: [me(70)] },
      ),
    steps: [{ args: { fingerprints: true, resources: true } }],
  },
  {
    name: 'autofolded',
    covers:
      '自動畳みの注記が器の一覧の末尾（固定の2文の前）に付く／候補なし／最後の頁・消えた器の cursor でも付く',
    fleet: () => fleet([rn(1), rn(2)], { autoFolded: AUTO_FOLDED }),
    steps: [
      { args: { resources: true } },
      {
        args: { resources: true },
        mutate: (f) => ({ ...f, autoFolded: [] }),
      },
      { args: { cursor: encodeRunnerCursor({ label: 'runner-2' }) } },
      { args: { cursor: encodeRunnerCursor({ label: 'runner-x' }) } },
    ],
  },
  {
    name: 'cursor',
    covers:
      'cursor: 先頭／途中から／最後の器の後（最後の頁）／消えた器（先頭から出し直す）／壊れた cursor／runnerId が無い器の錨',
    fleet: () => fleet([rn(1), rn(2), bare(3), rn(4)]),
    steps: [
      { args: { cursor: encodeRunnerCursor({ label: 'runner-1' }) } },
      { args: { cursor: encodeRunnerCursor({ label: 'runner-3' }) } },
      { args: { cursor: encodeRunnerCursor({ label: 'runner-4' }) } },
      { args: { cursor: encodeRunnerCursor({ label: 'runner-gone' }) } },
      { args: { cursor: 'x' } },
      { args: { cursor: '' } },
    ],
  },
  {
    name: 'cursor-vanished',
    covers: '前の応答の cursor が指す器が、次の呼びまでに名簿から外れた（出し直しの警告）',
    fleet: () => bigFleet(14),
    steps: [
      { args: { fingerprints: true } },
      {
        args: (previous) => ({ fingerprints: true, cursor: cursorOf(previous[0]) }),
        mutate: (f) => ({ ...f, runners: f.runners.slice(0, 2) }),
      },
    ],
  },
  {
    name: 'budget',
    covers: '予算（8,000字）を越える名簿: 省略の断り書きと続きの cursor を辿って最後の頁まで',
    fleet: () => bigFleet(24),
    steps: [
      { args: { fingerprints: true } },
      { args: (previous) => ({ fingerprints: true, cursor: cursorOf(previous[0]) }) },
      { args: (previous) => ({ fingerprints: true, cursor: cursorOf(previous[1]) }) },
    ],
  },
  {
    name: 'budget-resources',
    covers: '予算を越える名簿に resources を付ける（末尾の固定文・pids の注記も省略の後ろに付く）',
    fleet: () => ({ ...bigFleet(14), autoFolded: [] }),
    steps: [{ args: { fingerprints: true, resources: true } }],
  },
  {
    name: 'budget-single-huge',
    covers: '1台だけで予算を越える（その1台を切る）',
    fleet: () => fleet([rn(1, { error: `長い失敗の文言。${'x'.repeat(9_000)}` }), rn(2)]),
    steps: [{}],
  },
  {
    name: 'fold-subagent',
    covers: 'サブエージェントの呼びは畳みの口があっても全文のまま',
    subagent: true,
    fleet: () => fleet([rn(1), rn(2)]),
    steps: [{}, {}, { args: { resources: true } }, { args: { resources: true } }],
  },
];

function stepKey(scenario: Scenario, index: number): string {
  return scenario.steps.length === 1 ? scenario.name : `${scenario.name}#${String(index + 1)}`;
}

const ALL_KEYS: string[] = SCENARIOS.flatMap((scenario) =>
  scenario.steps.map((_, index) => stepKey(scenario, index)),
);

interface RunResult {
  texts: string[];
  /** `runners()` へ渡った引数（呼びごと） */
  options: unknown[];
}

async function runScenario(scenario: Scenario): Promise<RunResult> {
  let current = scenario.fleet?.() ?? fleet([]);
  const options: unknown[] = [];
  const pool = {
    async runners(option?: unknown) {
      options.push(option);
      return current;
    },
  } as unknown as ManagerPool;
  const tools = createCloneTools({
    stores: createMemoryStores(),
    emit: () => undefined,
    memoryCause: () => 'clone',
    conversationId: () => undefined,
    ...(scenario.noPool === true ? {} : { managers: pool }),
    ...(scenario.subagent === true ? { isSubagentCall: () => true } : {}),
  });
  const found = tools.find((entry) => entry.name === 'runner_list');
  if (!found) throw new Error('runner_list が無い');
  const texts: string[] = [];
  for (const step of scenario.steps) {
    if (step.mutate !== undefined) current = step.mutate(current);
    const args = typeof step.args === 'function' ? step.args(texts) : (step.args ?? {});
    const result = await found.handler(args as never, {});
    texts.push(
      (result.content ?? []).map((block) => (block.type === 'text' ? block.text : '')).join(''),
    );
  }
  return { texts, options };
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

async function runAll(): Promise<{
  outputs: Record<string, PinnedOutput>;
  options: Record<string, unknown[]>;
}> {
  const outputs: Record<string, PinnedOutput> = {};
  const options: Record<string, unknown[]> = {};
  for (const scenario of SCENARIOS) {
    const result = await runScenario(scenario);
    options[scenario.name] = result.options;
    for (const [index, text] of result.texts.entries()) {
      outputs[stepKey(scenario, index)] = { length: text.length, text };
    }
  }
  return { outputs, options };
}

describe('runner_list の出力の固定（場面ごとの全文と字数）', () => {
  let actual: Record<string, PinnedOutput> = {};
  let options: Record<string, unknown[]> = {};
  let pinned: PinFile = { lengths: {}, scenarios: {} };

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(FROZEN_NOW));
    ({ outputs: actual, options } = await runAll());
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

  it('同じ入力で2回回すと、全場面で同じ出力になる（時計・並びが固定されている）', async () => {
    const again = await runAll();
    expect(again.outputs).toEqual(actual);
  });

  it('引数が runners() へそのまま渡っている（指定した軸だけ。省略した軸は渡さない）', () => {
    expect(options['zero-runners']).toEqual([{}, { fingerprints: true, resources: true }, {}, {}]);
    expect(options['fingerprints']).toEqual([{}, { fingerprints: true }, { fingerprints: false }]);
    expect(options['resources']).toEqual([{}, { resources: true }, { resources: false }]);
    expect(options['no-pool']).toEqual([]);
  });

  it('場面が狙った分岐を通っている（固定値が別の分岐へ流れていないことの目印）', () => {
    const text = (key: string): string => actual[key]?.text ?? '';
    expect(text('no-pool')).toContain('いまは委譲できない場面である');
    expect(text('zero-runners#1')).toContain('登録されている runner は0台である');
    expect(text('zero-runners#3')).toContain('登録されている runner は0台である');
    expect(text('zero-runners#4')).toContain('この cursor は読めない');
    expect(text('zero-runners-daemon-unknown')).toContain('不明（応答は返ったが');
    expect(text('zero-runners-autofolded#1')).toContain('畳む候補が無かった');
    expect(text('zero-runners-autofolded#2')).toContain('この呼び出しで自動畳みが働いた');
    expect(text('zero-runners-autofolded#3')).toContain('この cursor は読めない');
    expect(text('zero-runners-autofolded#3')).toContain('この呼び出しで自動畳みが働いた');
    expect(text('single-bare')).toContain('runner は1台のみ登録されている（分散していない）');
    expect(text('single-bare')).toContain('runnerId は未確定');
    expect(text('single-bare')).toContain('名乗っていない（この器では入れ替わりを判定できない）');
    expect(text('single-bare')).toContain('未確認（名乗りをまだ一度も聞けていない）');
    expect(text('single-bare')).toContain('マネージャー: 無し');
    expect(text('single-full#1')).toContain('peer: Codex に作業を頼める');
    expect(text('single-full#1')).toContain('pids 飽和: 新しい委譲を置けない');
    expect(text('single-full#1')).toContain('どの器か分からない: 1件');
    expect(text('single-full#1')).toContain('直近の失敗:');
    expect(text('multi-states')).toContain('runner は6台登録されている。');
    expect(text('multi-states')).toContain('[vacating]');
    expect(text('multi-states')).toContain('[unusable]');
    expect(text('multi-states')).toContain('イメージに焼き込み済み');
    expect(text('multi-states')).toContain('実行時に ALTEROID_BUILD_REV で指定');
    expect(text('multi-states')).toContain('Railway が実行時に注入');
    expect(text('multi-states')).toContain('ビルド時の作業ツリーから取得');
    expect(text('peers')).toContain('不明（この runner は名乗らない旧い版');
    expect(text('peers')).toContain('モデルは Codex の既定');
    expect(text('peers')).toContain('Claude に作業を頼める');
    expect(text('peers')).toContain('は閉じている（認証が切れている）');
    expect(text('peers')).toContain('…');
    expect(text('manager-states')).toContain('running/セッション切断');
    expect(text('manager-states')).toContain('running/セッション不明');
    expect(text('manager-states')).toContain('背景処理待ち×2');
    expect(text('manager-states')).toContain('⚠世代2≠現役5');
    expect(text('manager-states')).toContain('⚠世代1≠現役4');
    expect(text('managers-overflow')).toContain('…ほか 5 本は省略');
    expect(text('managers-overflow')).toContain('…ほか 3 本は省略');
    expect(text('unassigned-only')).not.toContain('…ほか');
    expect(text('fingerprints#1')).not.toContain('鍵');
    expect(text('fingerprints#2')).toContain('鍵の指紋:');
    expect(text('fingerprints#2')).toContain('鍵: 無し');
    expect(text('fingerprints#2')).toContain('鍵: 確かめていない');
    expect(text('fingerprints#2')).toContain('鍵を確かめられなかった: RPC timeout');
    expect(text('fingerprints#2')).toContain('プロファイルの指紋:');
    expect(text('fingerprints#2')).toContain('プロファイル: 確かめていない');
    expect(text('fingerprints#2')).toContain('プロファイルを確かめられなかった: profile 500');
    expect(text('fingerprints#2')).toContain('MCP の登録: github, linear（指紋');
    expect(text('fingerprints#2')).toContain('MCP の登録: 確かめていない');
    expect(text('fingerprints#2')).toContain('MCP の登録: 確かめられない');
    expect(text('fingerprints#2')).toContain('MCP の登録を確かめられなかった: mcp 502');
    expect(text('fingerprints#3')).toBe(text('fingerprints#1'));
    expect(text('push-health')).toContain('プロファイル ok（');
    expect(text('push-health')).toContain('環境変数 失敗（');
    expect(text('push-health')).toContain('認証トークン 失敗（');
    expect(text('push-health')).toContain('理由不明');
    expect(text('push-health')).not.toContain('無視される');
    expect(text('resources#1')).not.toContain('pids:');
    expect(text('resources#3')).toBe(text('resources#1'));
    expect(text('resources#2')).toContain('pids: 812 / 1000');
    expect(text('resources#2')).toContain('内訳: ゾンビ 40');
    expect(text('resources#2')).toContain('ゾンビの comm: node 30, git 10');
    expect(text('resources#2')).toContain('いちばん古いゾンビ: 45秒前');
    expect(text('resources#2')).toContain('孤児（回収（既定）: 素性の分からない孤児も撃つ）');
    expect(text('resources#2')).toContain('孤児（observe: 終端した委譲の木だけ畳む）');
    expect(text('resources#2')).toContain('委譲の引き取り手: tini -s');
    expect(text('resources#2')).toContain('委譲の引き取り手: 無し（tini が PATH に無い');
    expect(text('resources#2')).toContain('孤児の木: ルート 3 本');
    expect(text('resources#2')).toContain('孤児の齢（⚠ 起動から');
    expect(text('resources#2')).toContain('1分未満 1 / 10分未満 2 / 1時間未満 3 / 6時間未満 4');
    expect(text('resources#2')).toContain('それ以上 6');
    expect(text('resources#2')).toContain('90000秒未満 5');
    expect(text('resources#2')).toContain('孤児ルート外: 8（うち親が生存 5');
    expect(text('resources#2')).toContain('仮に孤児ルートに入っていたら: 撃つ 1');
    expect(text('resources#2')).toContain('hold（候補のうち撃たなかった理由）');
    expect(text('resources#2')).toContain('hold の内訳: この走査には判定材料');
    expect(text('resources#2')).toContain('reclaim でないので撃たなかった: 6');
    expect(text('resources#2')).toContain('持ち主の記録 1,234/5,000・上限で忘れた累計 1,234,567');
    expect(text('resources#2')).toContain('pids: 訊けたが読めない器だった');
    expect(text('resources#2')).toContain('pids: 確かめていない');
    expect(text('resources#2')).toContain('pids: 訊いたが失敗した: resources() が落ちた');
    expect(text('resources#2')).toContain('pids: 確かめられない');
    expect(text('resources#2')).toContain('pids: 訊けたが、応答に資源が無かった');
    expect(text('resources#2')).toContain('pids: runner に訊けなかった');
    expect(text('resources#2')).toContain('pids について:');
    expect(text('saturation#1')).toContain('pids 1000/1000 で上限に達している');
    expect(text('saturation#1')).toContain('spawn が EAGAIN で失敗 3 回');
    expect(text('saturation#1')).toContain('fork が pids 上限で拒まれた委譲 2 本');
    expect(text('everything')).toContain('鍵の指紋:');
    expect(text('everything')).toContain('pids: 812 / 1000');
    expect(text('everything')).toContain('どの器か分からない: 1件');
    expect(text('autofolded#1')).toContain('この呼び出しで自動畳みが働いた');
    expect(text('autofolded#1')).toContain(
      '[mgr-002] blocked-unpushed-work: 未 push の実装が 2 件ある',
    );
    expect(text('autofolded#2')).toContain('畳む候補が無かった');
    expect(text('autofolded#3')).toContain('これが最後の頁');
    // 2回目の mutate で候補なしになり、3回目以降もそのまま
    expect(text('autofolded#3')).toContain('畳む候補が無かった');
    expect(text('autofolded#4')).toContain('畳む候補が無かった');
    expect(text('autofolded#4')).toContain('先頭から出し直した');
    expect(text('cursor#1')).toContain('runner は4台登録されている。');
    expect(text('cursor#1')).not.toContain('- runner-1 ');
    expect(text('cursor#1')).toContain('- runner-2 ');
    expect(text('cursor#2')).not.toContain('- runner-3 ');
    expect(text('cursor#3')).toContain('これが最後の頁');
    expect(text('cursor#4')).toContain('先頭から出し直した');
    expect(text('cursor#5')).toContain('この cursor は読めない');
    expect(text('cursor#6')).toContain('この cursor は読めない');
    expect(text('cursor-vanished#1')).toContain('台は省略（登録は 14 台あり');
    expect(text('cursor-vanished#2')).toContain('先頭から出し直した');
    expect(text('budget#1')).toContain('台は省略（登録は 24 台あり');
    expect(text('budget#1')).toContain('続きは runner_list cursor=');
    expect(text('budget#2')).not.toContain('先頭から出し直した');
    expect(text('budget#3')).not.toContain('これが最後の頁');
    expect(text('budget-resources')).toContain('台は省略');
    expect(text('budget-resources')).toContain('pids について:');
    expect(text('budget-single-huge')).toContain('…');
    expect(text('fold-subagent#2')).toBe(text('fold-subagent#1'));
    expect(text('fold-subagent#4')).toBe(text('fold-subagent#3'));
  });
});
