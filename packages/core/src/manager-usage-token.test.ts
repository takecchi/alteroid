import { describe, expect, it } from 'vitest';

import { createManagerPool } from './manager.js';
import { createProfileService } from './profile-service.js';
import {
  createRunnerRegistry,
  type RunnerAnswerOutcome,
  type RunnerClient,
  type RunnerEvent,
  type RunnerManagerState,
  type RunnerProfileFingerprint,
  type RunnerProfileResult,
} from './runner-protocol.js';
import type { InboxEvent, Job } from './schema.js';
import type { Stores } from './store.js';
import { createMemoryStores } from './testing.js';
import type { UsageTotals } from './usage.js';

/**
 * **どの認証トークンで使ったか**を、マネージャーの分についても台帳へ載せる
 * （Issue #393 受け入れ基準6）。
 *
 * ## 別ファイルにしてある理由
 *
 * `manager.test.ts` にも `describe('消費を台帳へ積む')` が在るが、そちらの `setup`
 * は `tokenIdentity` を受けない。**受けるようにする変更は #455 が同じファイルの
 * 同じ `SetupOptions` で既に持っている**ので、ここで同じものを足すと、どちらが
 * 後にマージされても衝突する。**測るものが増えるのは良いが、他の PR と同じ行を
 * 二重に書く理由は無い。** だから足場だけ小さく自分で持つ。
 *
 * ## ここが固定するもの
 *
 * **マネージャーが `record` へ何を渡すか、だけ**である。列の意味・鍵・軸の始点は
 * storage の2つの器（`@alteroid/storage-fs` / `@alteroid/storage-pg` の
 * `usage.test.ts`）が持ち、クローン側の同じ問いは `clone.test.ts` が持つ。
 */

/** 走っている仕事1本ぶんの台帳の行。`restore()` が引き取る対象になる。 */
const RUNNING_JOB: Job = {
  id: 'mgr-tok',
  managerId: 'mgr-tok',
  createdAt: '2026-08-25T00:00:00.000Z',
  updatedAt: '2026-08-25T01:00:00.000Z',
  status: 'running',
  summary: '調べもの',
  request: '調べておいて',
  cwd: '/work/project',
  sessionId: 'sess-1',
  runnerId: 'runner-primary',
};

function totals(over: Partial<UsageTotals>): UsageTotals {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    webSearchRequests: 0,
    costUsd: 0,
    ...over,
  };
}

/**
 * 消費のイベントだけを押し込める最小の偽 runner。
 *
 * `manager.test.ts` の `swappableRunner` の縮小版である。**縮めたのは「使わない
 * 口を空にした」ぶんだけで、判定に効く口（`connect` / `list` / `resume`）は
 * 同じことをする** — ここを緩めると、引き取りが起きていないのに起きたことになる。
 */
function usageRunner() {
  let emit: ((event: RunnerEvent) => void) | null = null;
  const alive: RunnerManagerState[] = [];

  const runner: RunnerClient = {
    runnerId: 'runner-primary',
    runnerIdKnown: true,
    workspacePath: '/work/project',
    workspacePathKnown: true,
    async connect(onEvent) {
      // **同期的に名乗らせない**（本物は `void this.#pump(...)` で即 return する）。
      emit = onEvent;
    },
    async start() {
      /* この検証では使わない */
    },
    async resume(command) {
      alive.push({
        managerId: command.managerId,
        status: 'running',
        cwd: command.cwd,
        request: command.request,
        waiting: [],
        sessionId: command.sessionId,
      });
    },
    async send() {
      /* この検証では使わない */
    },
    async answer(): Promise<RunnerAnswerOutcome> {
      return { delivered: false };
    },
    async stop() {
      /* この検証では使わない */
    },
    async list() {
      return [...alive];
    },
    async transcript() {
      return null;
    },
    async credentials() {
      return [];
    },
    async setCredentials() {
      return [];
    },
    async profile(): Promise<RunnerProfileFingerprint | undefined> {
      return undefined;
    },
    async setProfile(): Promise<RunnerProfileResult> {
      return { applied: false, reason: 'この検証では使わない' };
    },
    async close() {
      /* この検証では使わない */
    },
  };

  return {
    runner,
    /** 累積スナップショットを1つ降ろす（本物の runner が SSE で流すのと同じ形）。 */
    usage(models: Record<string, UsageTotals>): void {
      if (emit === null) throw new Error('connect されていない（名乗る前に流している）');
      emit({
        type: 'usage',
        managerId: 'mgr-tok',
        sessionId: 'sess-1',
        models,
      } as unknown as RunnerEvent);
    },
  };
}

async function setup(options: {
  stores: Stores;
  tokenIdentity?: () => { tokenId: string; generation: number } | undefined;
}) {
  await options.stores.jobs.putJob(RUNNING_JOB);
  const fake = usageRunner();
  const registry = createRunnerRegistry([fake.runner]);
  const inbox: InboxEvent[] = [];
  const pool = createManagerPool({
    stores: options.stores,
    post: (event) => inbox.push(event),
    runners: registry,
    profile: createProfileService({ stores: options.stores, runners: registry }),
    ...(options.tokenIdentity === undefined ? {} : { tokenIdentity: options.tokenIdentity }),
  });
  // 引き取りで `#rememberTokenIdentity` が走る（セッションが起きる瞬間である）。
  await pool.restore();
  return { pool, fake };
}

async function rowsOf(stores: Stores) {
  const { rows } = await stores.usage.aggregate({});
  return rows;
}

describe('マネージャーの消費に認証トークンの帰属が付く（#393 受け入れ基準6）', () => {
  it('現役の指名が在れば、その tokenId が行に載る', async () => {
    const stores = createMemoryStores();
    const s = await setup({
      stores,
      tokenIdentity: () => ({ tokenId: 'tok-a', generation: 7 }),
    });

    s.fake.usage({ opus: totals({ costUsd: 1 }) });
    await expect.poll(() => rowsOf(stores), { timeout: 2000 }).toHaveLength(1);

    const rows = await rowsOf(stores);
    expect(rows[0]?.tokenId).toBe('tok-a');
    expect(rows[0]?.managerId).toBe('mgr-tok');
    expect((await stores.usage.aggregate({})).tokensSince).not.toBeNull();

    await s.pool.stop();
  });

  it('現役の指名が無ければ帰属を渡さない（プールが空の器で軸が始まらない）', async () => {
    // **受け入れ基準7 の側である。** ここで何かを埋めると、プールを1本も持って
    // いない器が「そのトークンで使った」と名乗る。
    const stores = createMemoryStores();
    const s = await setup({ stores, tokenIdentity: () => undefined });

    s.fake.usage({ opus: totals({ costUsd: 1 }) });
    await expect.poll(() => rowsOf(stores), { timeout: 2000 }).toHaveLength(1);

    const aggregate = await stores.usage.aggregate({});
    expect(aggregate.rows[0]?.tokenId).toBeUndefined();
    // 台帳は始まっているのに、トークンの軸だけ始まっていない。
    expect(aggregate.since).not.toBeNull();
    expect(aggregate.tokensSince).toBeNull();

    await s.pool.stop();
  });

  it('`tokenIdentity` を渡していない器でも帰属は空（口が任意であることそのもの）', async () => {
    // **`tokenIdentity` を省いた形と、渡して undefined が返る形は別の道である。**
    // 前者は `#tokenIdentity` そのものが undefined で、後者は関数が在る。
    // 既定の構成（回し手を配線していない器）は前者なので、そちらも押さえる。
    const stores = createMemoryStores();
    const s = await setup({ stores });

    s.fake.usage({ opus: totals({ costUsd: 1 }) });
    await expect.poll(() => rowsOf(stores), { timeout: 2000 }).toHaveLength(1);

    expect((await stores.usage.aggregate({})).rows[0]?.tokenId).toBeUndefined();

    await s.pool.stop();
  });

  it('帰属は「セッションが起きた瞬間の身元」である（消費が届くたびに読み直さない）', async () => {
    // **これが世代の照合が在る理由そのものである。** 読み直すと、回した直後に
    // 届いた**前のセッションぶんの消費**が新しいトークンに付く（`manager.ts` の
    // `#tokenIdentities` の doc）。しかもその誤りは合計を変えないので、
    // 「どの区間がどのトークンだったか」を引いたときにだけ嘘になる。
    const stores = createMemoryStores();
    let current = { tokenId: 'tok-a', generation: 1 };
    const s = await setup({ stores, tokenIdentity: () => current });

    s.fake.usage({ opus: totals({ costUsd: 1 }) });
    await expect.poll(() => rowsOf(stores), { timeout: 2000 }).toHaveLength(1);

    // セッションは走ったまま、現役だけが入れ替わる（回し手が撒いた直後の状態）。
    current = { tokenId: 'tok-b', generation: 2 };
    s.fake.usage({ opus: totals({ costUsd: 3 }) });
    await expect
      .poll(async () => (await rowsOf(stores))[0]?.totals.costUsd, { timeout: 2000 })
      .toBe(3);

    const rows = await rowsOf(stores);
    // **行は1つのまま。** 読み直していれば `tok-b` の行が別に立ち、$2 がそちらへ乗る。
    expect(rows).toHaveLength(1);
    expect(rows[0]?.tokenId).toBe('tok-a');

    await s.pool.stop();
  });
});
