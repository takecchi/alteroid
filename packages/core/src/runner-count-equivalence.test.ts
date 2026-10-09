import type {
  query as sdkQuery,
  AgentDefinition,
  CanUseTool,
  Options,
  PermissionResult,
  Query,
  SDKMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';

import { createManagerPool, MANAGER_MODEL, WORKER_AGENT_NAME, WORKER_MODEL } from './manager.js';
import { createProfileService } from './profile-service.js';
import { createLocalRunner } from './runner-local.js';
import {
  createRunnerRegistry,
  type RunnerAnswerCommand,
  type RunnerAnswerOutcome,
  type RunnerClient,
  type RunnerCredentialFingerprint,
  type RunnerEvent,
  type RunnerManagerState,
  type RunnerPlacementResources,
  type RunnerProfileFingerprint,
  type RunnerProfileResult,
  type RunnerRegistry,
  type RunnerResumeCommand,
} from './runner-protocol.js';
import type { InboxEvent, Job } from './schema.js';
import type { Stores } from './store.js';
import { createMemoryStores } from './testing.js';

class PlacementFakeRunner implements RunnerClient {
  readonly runnerId: string;
  readonly runnerIdKnown = true;
  readonly workspacePathKnown = true;
  readonly workspacePath = '/work/project';
  report: RunnerPlacementResources | undefined;
  asked = 0;

  constructor(runnerId: string, report?: RunnerPlacementResources) {
    this.runnerId = runnerId;
    this.report = report;
  }

  async resources(): Promise<RunnerPlacementResources | undefined> {
    this.asked += 1;
    return this.report;
  }

  async ping(): Promise<void> {}
  async connect(): Promise<void> {}
  async start(): Promise<{ cwd?: string }> {
    return {};
  }
  async resume(): Promise<{ cwd?: string }> {
    return {};
  }
  async send(): Promise<boolean> {
    return true;
  }
  async answer(): Promise<RunnerAnswerOutcome> {
    return { delivered: false };
  }
  async stop(): Promise<void> {}
  async list(): Promise<RunnerManagerState[]> {
    return [];
  }
  async transcript(): Promise<string | null> {
    return null;
  }
  async credentials(): Promise<RunnerCredentialFingerprint[]> {
    return [];
  }
  async setCredentials(): Promise<RunnerCredentialFingerprint[]> {
    return [];
  }
  async profile(): Promise<RunnerProfileFingerprint | undefined> {
    return undefined;
  }
  async setProfile(): Promise<RunnerProfileResult> {
    return { ok: true };
  }
  async close(): Promise<void> {}
}

async function placementRegistryOf(...runners: PlacementFakeRunner[]): Promise<RunnerRegistry> {
  const registry = createRunnerRegistry();
  for (const runner of runners) {
    await registry.register({ label: `http://${runner.runnerId}`, open: async () => runner });
  }
  return registry;
}

describe('配置の規約は runner 台数で変わらない（M5 ゴール / PR7）', () => {
  it('資源が最も空いている器を、1台構成の即答経路と3台構成の資源計算経路の両方で同じに選ぶ', async () => {
    // best は先頭ではなく最後に登録する: 登録順の先頭を返す壊れ方を潰すため。
    const bestReport: RunnerPlacementResources = {
      memory: { limitBytes: 32_000_000_000, usedBytes: 1_000_000_000, source: 'cgroup' },
      managers: 0,
    };
    const decoyTightReport: RunnerPlacementResources = {
      memory: { limitBytes: 32_000_000_000, usedBytes: 31_000_000_000, source: 'cgroup' },
      managers: 5,
    };
    const decoyBusyReport: RunnerPlacementResources = {
      memory: { limitBytes: 32_000_000_000, usedBytes: 20_000_000_000, source: 'cgroup' },
      managers: 9,
    };

    const solo = new PlacementFakeRunner('runner-best', bestReport);
    const soloRegistry = await placementRegistryOf(solo);
    const chosenAt1 = await soloRegistry.select({});
    expect(chosenAt1.runnerId).toBe('runner-best');
    expect(solo.asked).toBe(0);
    await soloRegistry.stop();

    const decoyTight = new PlacementFakeRunner('runner-decoy-tight', decoyTightReport);
    const decoyBusy = new PlacementFakeRunner('runner-decoy-busy', decoyBusyReport);
    const best = new PlacementFakeRunner('runner-best', bestReport);
    const fleetRegistry = await placementRegistryOf(decoyTight, decoyBusy, best);
    const chosenAt3 = await fleetRegistry.select({});
    expect(chosenAt3.runnerId).toBe('runner-best');
    expect([decoyTight.asked, decoyBusy.asked, best.asked]).toEqual([1, 1, 1]);
    await fleetRegistry.stop();

    expect(chosenAt3.runnerId).toBe(chosenAt1.runnerId);
  });

  it('全台が資源を使い切っていても、1台構成・3台構成のどちらも置き先を返す（定員で断らない）', async () => {
    const full: RunnerPlacementResources = {
      memory: { limitBytes: 32_000_000_000, usedBytes: 32_000_000_000, source: 'cgroup' },
      managers: 3,
    };

    const solo = new PlacementFakeRunner('runner-full-solo', full);
    const soloRegistry = await placementRegistryOf(solo);
    await expect(soloRegistry.select({})).resolves.toMatchObject({ runnerId: 'runner-full-solo' });
    await soloRegistry.stop();

    const a = new PlacementFakeRunner('runner-full-a', full);
    const b = new PlacementFakeRunner('runner-full-b', full);
    const c = new PlacementFakeRunner('runner-full-c', full);
    const fleetRegistry = await placementRegistryOf(a, b, c);
    await expect(fleetRegistry.select({})).resolves.toMatchObject({});
    await fleetRegistry.stop();
  });
});

class RoutingFakeRunner implements RunnerClient {
  readonly runnerId: string;
  readonly runnerIdKnown = true;
  readonly workspacePathKnown = true;
  readonly workspacePath = '/work/project';
  readonly sessions = new Map<string, RunnerManagerState>();
  readonly sends: { managerId: string; text: string }[] = [];
  readonly resumes: RunnerResumeCommand[] = [];
  readonly stops: string[] = [];
  readonly answers: { managerId: string; answer: RunnerAnswerCommand }[] = [];
  #onEvent: ((event: RunnerEvent) => void) | null = null;

  constructor(runnerId: string) {
    this.runnerId = runnerId;
  }

  ask(managerId: string, requestId: string, summary: string): void {
    if (this.#onEvent === null) {
      throw new Error(`${this.runnerId} はまだ connect していない（ask を流せない）`);
    }
    this.#onEvent({
      type: 'ask',
      managerId,
      requestId,
      kind: 'permission',
      summary,
      askedAt: new Date().toISOString(),
    });
  }

  get receivedCount(): number {
    return this.sends.length + this.resumes.length + this.stops.length + this.answers.length;
  }

  hold(managerId: string): void {
    this.sessions.set(managerId, {
      managerId,
      status: 'running',
      cwd: this.workspacePath,
      request: `${managerId} の依頼`,
      waiting: [],
      sessionId: `sess-${managerId}`,
    });
  }

  async connect(onEvent: (event: RunnerEvent) => void): Promise<void> {
    this.#onEvent = onEvent;
  }
  async start(command: { managerId: string }): Promise<{ cwd?: string }> {
    this.hold(command.managerId);
    return {};
  }
  async resume(command: RunnerResumeCommand): Promise<{ cwd?: string }> {
    this.resumes.push(command);
    this.hold(command.managerId);
    return {};
  }
  async send(managerId: string, text: string): Promise<boolean> {
    this.sends.push({ managerId, text });
    return true;
  }
  async answer(managerId: string, answer: RunnerAnswerCommand): Promise<RunnerAnswerOutcome> {
    this.answers.push({ managerId, answer });
    this.#onEvent?.({ type: 'settled', managerId, requestId: answer.requestId });
    return { delivered: true };
  }
  async stop(managerId: string): Promise<void> {
    this.stops.push(managerId);
    this.sessions.delete(managerId);
  }
  async list(): Promise<RunnerManagerState[]> {
    return [...this.sessions.values()];
  }
  async transcript(): Promise<string | null> {
    return null;
  }
  async credentials(): Promise<RunnerCredentialFingerprint[]> {
    return [];
  }
  async setCredentials(): Promise<RunnerCredentialFingerprint[]> {
    return [];
  }
  async profile(): Promise<RunnerProfileFingerprint | undefined> {
    return undefined;
  }
  async setProfile(): Promise<RunnerProfileResult> {
    return { ok: true };
  }
  async close(): Promise<void> {}
}

interface RoutingFleet {
  pool: ReturnType<typeof createManagerPool>;
  registry: RunnerRegistry;
  stores: Stores;
  inbox: InboxEvent[];
  runners: RoutingFakeRunner[];
  close: () => Promise<void>;
}

function jobFor(managerId: string, runnerId: string): Job {
  const at = '2026-08-01T00:00:00.000Z';
  return {
    id: managerId,
    managerId,
    createdAt: at,
    updatedAt: at,
    status: 'running',
    summary: `${managerId} の仕事`,
    request: `${managerId} の依頼`,
    cwd: '/work/project',
    sessionId: `sess-${managerId}`,
    runnerId,
  };
}

async function routingFleetOf(size: number): Promise<RoutingFleet> {
  const runners = Array.from(
    { length: size },
    (_, index) => new RoutingFakeRunner(`runner-${index}`),
  );
  const registry = createRunnerRegistry();
  for (const runner of runners) {
    await registry.register({ label: `http://${runner.runnerId}`, open: async () => runner });
  }
  const stores = createMemoryStores();
  const inbox: InboxEvent[] = [];
  const pool = createManagerPool({ stores, post: (event) => inbox.push(event), runners: registry });

  for (const runner of runners) {
    const managerId = `mgr-on-${runner.runnerId}`;
    await stores.jobs.putJob(jobFor(managerId, runner.runnerId));
    runner.hold(managerId);
  }
  await pool.restore();

  return {
    pool,
    registry,
    stores,
    inbox,
    runners,
    close: async () => {
      await pool.stop();
      await registry.stop();
    },
  };
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe.each([1, 3])(
  'manager_id → runner_id のルーティングは runner %i 台構成でも変わらない',
  (size) => {
    // 標的は名簿の最後の器にする: 先頭固定の壊れ方（`#runnerOf` が先頭だけを見る形）を拾うため。
    function targetOf(fleet: RoutingFleet): RoutingFakeRunner {
      const target = fleet.runners.at(-1);
      if (target === undefined) throw new Error('fleet が空');
      return target;
    }

    it('send は台帳の runnerId が指す器へ届き、他の器は1度も受けない（managers の数も変わらない）', async () => {
      const fleet = await routingFleetOf(size);
      const target = targetOf(fleet);
      const others = fleet.runners.filter((runner) => runner !== target);
      const managerId = `mgr-on-${target.runnerId}`;

      expect((await fleet.pool.list()).length).toBe(size);

      const result = await fleet.pool.send(managerId, '続きを進めて');

      expect(result.outcome).toBe('delivered');
      expect(target.sends).toEqual([{ managerId, text: '続きを進めて' }]);
      for (const other of others) expect(other.receivedCount).toBe(0);

      await fleet.close();
    });

    it('許可確認の回答は台帳の runnerId が指す器にだけ届く（質問の text も変わらない）', async () => {
      const fleet = await routingFleetOf(size);
      const target = targetOf(fleet);
      const others = fleet.runners.filter((runner) => runner !== target);
      const managerId = `mgr-on-${target.runnerId}`;

      target.ask(managerId, 'req-equiv', 'Bash の実行許可: ls -la');
      await tick();
      const waitingBefore = (await fleet.pool.list()).find(
        (m) => m.managerId === managerId,
      )?.waiting;
      expect(waitingBefore).toEqual([
        {
          requestId: 'req-equiv',
          summary: 'Bash の実行許可: ls -la',
          kind: 'permission',
          askedAt: expect.any(String),
        },
      ]);

      const result = await fleet.pool.send(managerId, '許可します', {
        requestId: 'req-equiv',
        decision: 'allow',
      });

      expect(result.outcome).toBe('answered');
      expect(target.answers).toEqual([
        { managerId, answer: { requestId: 'req-equiv', message: '許可します', decision: 'allow' } },
      ]);
      for (const other of others) expect(other.receivedCount).toBe(0);

      await fleet.close();
    });
  },
);

interface FakeSession {
  options: Options;
  ask(
    toolName: string,
    input: Record<string, unknown>,
    requestId?: string,
  ): Promise<PermissionResult>;
  report(text: string): Promise<void>;
}

function fakeSdkForOptions(): { fn: typeof sdkQuery; sessions: FakeSession[] } {
  const sessions: FakeSession[] = [];

  const fn = ((params: { prompt: unknown; options?: Options }) => {
    const options = params.options ?? {};
    let emit: ((message: SDKMessage) => void) | null = null;
    let reports = 0;
    let asks = 0;
    const buffered: SDKMessage[] = [];

    const push = (message: SDKMessage) => {
      if (emit) emit(message);
      else buffered.push(message);
    };

    const session: FakeSession = {
      options,
      async ask(toolName, input, requestId) {
        const canUseTool = options.canUseTool as CanUseTool;
        const id = requestId ?? `req-${(asks += 1)}`;
        const result = await canUseTool(toolName, input, {
          signal: new AbortController().signal,
          toolUseID: `tool-${id}`,
          requestId: id,
        } as never);
        if (result === null) throw new Error('canUseTool が null を返した（返事が届かない）');
        return result;
      },
      async report(text) {
        push({
          type: 'result',
          subtype: 'success',
          result: text,
          session_id: 'sess-mgr',
          uuid: `uuid-result-${(reports += 1)}`,
        } as unknown as SDKMessage);
        await new Promise((resolve) => setTimeout(resolve, 0));
      },
    };
    sessions.push(session);

    async function* generate(): AsyncGenerator<SDKMessage, void> {
      yield {
        type: 'system',
        subtype: 'init',
        session_id: 'sess-mgr',
        uuid: 'uuid-init',
      } as unknown as SDKMessage;

      void (async () => {
        // `for await (const message of ...)` にしない: `message` を使わず、未使用変数の lint に当たるため。
        const iterator = (params.prompt as AsyncIterable<unknown>)[Symbol.asyncIterator]();
        for (;;) {
          const step = await iterator.next();
          if (step.done === true) break;
        }
      })();

      for (;;) {
        const next = buffered.shift();
        if (next !== undefined) {
          yield next;
          continue;
        }
        const message = await new Promise<SDKMessage | null>((resolve) => {
          emit = resolve;
        });
        emit = null;
        if (message === null) return;
        yield message;
      }
    }

    const generator = generate();
    return Object.assign(generator, {
      close: () => {
        if (emit) emit(null as unknown as SDKMessage);
      },
      interrupt: async () => undefined,
    }) as unknown as Query;
  }) as unknown as typeof sdkQuery;

  return { fn, sessions };
}

/** 関数フィールドは比較しない: runner ごとに別クロージャで、同一になりようが無い。 */
function capabilitySnapshot(options: Options) {
  const worker = (options.agents ?? {})[WORKER_AGENT_NAME] as AgentDefinition | undefined;
  return {
    model: options.model,
    tools: options.tools,
    allowedTools: options.allowedTools,
    disallowedTools: options.disallowedTools,
    maxTurns: options.maxTurns,
    maxBudgetUsd: options.maxBudgetUsd,
    permissionMode: options.permissionMode,
    settingSources: options.settingSources,
    worker:
      worker === undefined
        ? undefined
        : { model: worker.model, tools: worker.tools, maxTurns: worker.maxTurns },
  };
}

const EQUIVALENCE_ENV: NodeJS.ProcessEnv = {
  PATH: '/usr/bin',
  ALTEROID_HOME: '/secret',
  // `default` にする: 既定の `auto` では `Bash` のような道具は確認を出さず、許可確認の経路を通らない。
  ALTEROID_MANAGER_PERMISSION_MODE: 'default',
};

interface EquivalenceResult {
  capability: ReturnType<typeof capabilitySnapshot>;
  protocol: {
    askOutcome: string;
    questionText: string | undefined;
    answerOutcome: string;
    managersCount: number;
    lastReport: string | undefined;
  };
}

async function runDelegationOn(count: number): Promise<EquivalenceResult> {
  const fleet = Array.from({ length: count }, (_, index) => {
    const { fn, sessions } = fakeSdkForOptions();
    const runner = createLocalRunner({
      runnerId: `runner-${index}`,
      workspacePath: '/work/project',
      queryFn: fn,
      env: EQUIVALENCE_ENV,
    });
    return { runner, sessions };
  });
  const registry = createRunnerRegistry(fleet.map((entry) => entry.runner));
  const stores = createMemoryStores();
  const inbox: InboxEvent[] = [];
  const pool = createManagerPool({
    stores,
    post: (event) => inbox.push(event),
    runners: registry,
    profile: createProfileService({ stores, runners: registry }),
  });

  const { managerId } = await pool.start({ request: 'デプロイして' });
  const used = fleet.find((entry) => entry.sessions.length > 0);
  if (used === undefined) {
    throw new Error(`${count} 台構成のどの runner もセッションを受けていない`);
  }
  const session = used.sessions[0];
  if (session === undefined) throw new Error('内部整合性エラー: session が無い');

  const asked = session.ask('Bash', { command: 'git push' }, 'req-equiv');
  await tick();
  const waiting = (await pool.list()).find((m) => m.managerId === managerId)?.waiting;
  const managersCount = (await pool.list()).length;

  const sendResult = await pool.send(managerId, '許可します', {
    requestId: 'req-equiv',
    decision: 'allow',
  });
  const askOutcome = (await asked).behavior;

  await session.report('デプロイした');
  const [summary] = await pool.list();

  const result: EquivalenceResult = {
    capability: capabilitySnapshot(session.options),
    protocol: {
      askOutcome,
      questionText: waiting?.[0]?.summary,
      answerOutcome: sendResult.outcome,
      managersCount,
      lastReport: summary?.lastReport,
    },
  };

  await pool.stop();
  await registry.stop();
  return result;
}

describe('能力・プロトコルの等価性（M5 ゴール本文 / PR7）', () => {
  it('委譲→許可確認→回答→報告を通しても、1台構成と3台構成の結果は直接一致する', async () => {
    const at1 = await runDelegationOn(1);
    const at3 = await runDelegationOn(3);

    expect(at3.capability).toEqual(at1.capability);
    expect(at3.protocol).toEqual(at1.protocol);

    for (const result of [at1, at3]) {
      expect(result.capability.model).toBe(MANAGER_MODEL);
      expect(result.capability.tools).toBeUndefined();
      expect(result.capability.allowedTools).toBeUndefined();
      expect(result.capability.disallowedTools).toBeUndefined();
      expect(result.capability.maxTurns).toBeUndefined();
      expect(result.capability.maxBudgetUsd).toBeUndefined();
      expect(result.capability.permissionMode).toBe('default');
      expect(result.capability.settingSources).toEqual(['user', 'project', 'local']);
      expect(result.capability.worker?.model).toBe(WORKER_MODEL);
      expect(result.capability.worker?.tools).toBeUndefined();
      expect(result.capability.worker?.maxTurns).toBeUndefined();

      expect(result.protocol.askOutcome).toBe('allow');
      expect(result.protocol.questionText).toBe('Bash の実行許可: {"command":"git push"}');
      expect(result.protocol.answerOutcome).toBe('answered');
      expect(result.protocol.managersCount).toBe(1);
      expect(result.protocol.lastReport).toBe('デプロイした');
    }
  });
});

/**
 * 候補は空ける1台と控え1台の2台に絞る: `relocateFrom` は他の接続中の器すべてへ
 * `#reattach` を起こし、3台以上だと `#resuming` の取り合いのタイミングに成否が依存する。
 */
async function runDelegationWithRelocation(): Promise<
  EquivalenceResult & { originalRunnerId: string; relocatedRunnerId: string }
> {
  const fleet = Array.from({ length: 2 }, (_, index) => {
    const runnerId = `runner-relocate-${index}`;
    const { fn, sessions } = fakeSdkForOptions();
    const runner = createLocalRunner({
      runnerId,
      workspacePath: '/work/project',
      queryFn: fn,
      env: EQUIVALENCE_ENV,
    });
    return { runner, sessions };
  });
  const registry = createRunnerRegistry(fleet.map((entry) => entry.runner));
  const stores = createMemoryStores();
  const inbox: InboxEvent[] = [];
  const pool = createManagerPool({
    stores,
    post: (event) => inbox.push(event),
    runners: registry,
    profile: createProfileService({ stores, runners: registry }),
  });

  const { managerId } = await pool.start({ request: 'デプロイして' });
  const originalIndex = fleet.findIndex((entry) => entry.sessions.length > 0);
  if (originalIndex === -1) {
    throw new Error('委譲がどの runner のセッションも受けていない');
  }
  const originalRunnerId = `runner-relocate-${originalIndex}`;
  const backupIndex = originalIndex === 0 ? 1 : 0;
  const backup = fleet[backupIndex];
  if (backup === undefined) throw new Error('内部整合性エラー: 控えの runner が無い');
  const relocatedRunnerId = `runner-relocate-${backupIndex}`;

  // `registry.vacate()` を直接呼ばない: 移送は `ManagerPool.vacate` を通らないと起きない。
  await pool.vacate(originalRunnerId);

  await expect.poll(() => backup.sessions.length, { timeout: 2000 }).toBeGreaterThan(0);

  const session = backup.sessions[backup.sessions.length - 1];
  if (session === undefined) throw new Error('内部整合性エラー: 移送先のセッションが無い');

  const job = (await stores.jobs.listJobs()).find((entry) => entry.id === managerId);
  expect(job?.runnerId).toBe(relocatedRunnerId);

  const asked = session.ask('Bash', { command: 'git push' }, 'req-equiv');
  await tick();
  const waiting = (await pool.list()).find((m) => m.managerId === managerId)?.waiting;
  const managersCount = (await pool.list()).length;

  const sendResult = await pool.send(managerId, '許可します', {
    requestId: 'req-equiv',
    decision: 'allow',
  });
  const askOutcome = (await asked).behavior;

  await session.report('デプロイした');
  const [summary] = await pool.list();

  const result = {
    capability: capabilitySnapshot(session.options),
    protocol: {
      askOutcome,
      questionText: waiting?.[0]?.summary,
      answerOutcome: sendResult.outcome,
      managersCount,
      lastReport: summary?.lastReport,
    },
    originalRunnerId,
    relocatedRunnerId,
  };

  await pool.stop();
  await registry.stop();
  return result;
}

describe('移送を跨いだ等価性（Issue #1022 / #614〜#616 を等価性の対象に含める）', () => {
  it('委譲→vacate→移送→許可確認→回答→報告を通しても、1台構成と移送後の結果は直接一致する', async () => {
    const at1 = await runDelegationOn(1);
    const relocated = await runDelegationWithRelocation();

    expect(relocated.relocatedRunnerId).not.toBe(relocated.originalRunnerId);

    expect(relocated.capability).toEqual(at1.capability);
    expect(relocated.protocol).toEqual(at1.protocol);

    for (const result of [at1, relocated]) {
      expect(result.capability.model).toBe(MANAGER_MODEL);
      expect(result.capability.tools).toBeUndefined();
      expect(result.capability.permissionMode).toBe('default');
      expect(result.capability.settingSources).toEqual(['user', 'project', 'local']);
      expect(result.capability.worker?.model).toBe(WORKER_MODEL);

      expect(result.protocol.askOutcome).toBe('allow');
      expect(result.protocol.questionText).toBe('Bash の実行許可: {"command":"git push"}');
      expect(result.protocol.answerOutcome).toBe('answered');
      expect(result.protocol.managersCount).toBe(1);
      expect(result.protocol.lastReport).toBe('デプロイした');
    }
  });
});

async function placementFleetWithPool(...runners: PlacementFakeRunner[]): Promise<{
  pool: ReturnType<typeof createManagerPool>;
  registry: RunnerRegistry;
  close: () => Promise<void>;
}> {
  const registry = await placementRegistryOf(...runners);
  const stores = createMemoryStores();
  const pool = createManagerPool({ stores, post: () => undefined, runners: registry });
  return {
    pool,
    registry,
    close: async () => {
      await pool.stop();
      await registry.stop();
    },
  };
}

describe('vacate した器は、即答経路でも資源計算経路でも置き先から外れる（Issue #1022）', () => {
  it('3台構成: 明らかに最良の器を pool.vacate しても、資源計算経路（#place）はそれを選ばない。置き先は必ず返る', async () => {
    const bestReport: RunnerPlacementResources = {
      memory: { limitBytes: 32_000_000_000, usedBytes: 1_000_000_000, source: 'cgroup' },
      managers: 0,
    };
    const decoyTightReport: RunnerPlacementResources = {
      memory: { limitBytes: 32_000_000_000, usedBytes: 31_000_000_000, source: 'cgroup' },
      managers: 5,
    };
    const decoyBusyReport: RunnerPlacementResources = {
      memory: { limitBytes: 32_000_000_000, usedBytes: 20_000_000_000, source: 'cgroup' },
      managers: 9,
    };
    const best = new PlacementFakeRunner('runner-best', bestReport);
    const decoyTight = new PlacementFakeRunner('runner-decoy-tight', decoyTightReport);
    const decoyBusy = new PlacementFakeRunner('runner-decoy-busy', decoyBusyReport);

    const { pool, registry, close } = await placementFleetWithPool(decoyTight, decoyBusy, best);

    await pool.vacate('runner-best');

    const chosen = await registry.select({});
    expect(chosen.runnerId).not.toBe('runner-best');
    expect([decoyTight.asked, decoyBusy.asked]).toEqual([1, 1]);
    expect(best.asked).toBe(0);

    await close();
  });

  it('2台構成: 空けると残り1台になり即答経路（open.length === 1）へ入る。それでも空けた器は選ばれない', async () => {
    const bestReport: RunnerPlacementResources = {
      memory: { limitBytes: 32_000_000_000, usedBytes: 1_000_000_000, source: 'cgroup' },
      managers: 0,
    };
    const otherReport: RunnerPlacementResources = {
      memory: { limitBytes: 32_000_000_000, usedBytes: 20_000_000_000, source: 'cgroup' },
      managers: 3,
    };
    const best = new PlacementFakeRunner('runner-best', bestReport);
    const other = new PlacementFakeRunner('runner-other', otherReport);

    const { pool, registry, close } = await placementFleetWithPool(best, other);

    await pool.vacate('runner-best');

    const chosen = await registry.select({});
    expect(other.asked).toBe(0);
    expect(chosen.runnerId).toBe('runner-other');
    expect(chosen.runnerId).not.toBe('runner-best');

    await close();
  });
});
