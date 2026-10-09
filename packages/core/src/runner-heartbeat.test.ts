import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createRunnerRegistry } from './runner-protocol.js';
import type {
  RunnerAnswerOutcome,
  RunnerClient,
  RunnerCredentialFingerprint,
  RunnerManagerState,
  RunnerProfileFingerprint,
  RunnerProfileResult,
} from './runner-protocol.js';

class FakeRunner implements RunnerClient {
  readonly runnerId: string;
  runnerIdKnown = true;
  readonly workspacePathKnown = true;
  readonly workspacePath = '/work/project';
  pings = 0;
  reply: 'ok' | 'error' | 'hang' = 'ok';
  closed = false;
  listReply: 'ok' | 'error' | 'hang' = 'ok';
  sessionsToReturn: string[] = [];
  backgroundToReturn: Record<string, number> = {};
  fingerprintToReturn: Record<string, string> = {};
  listCalls = 0;
  lastListSignal: AbortSignal | undefined;

  constructor(runnerId: string) {
    this.runnerId = runnerId;
  }

  async ping(): Promise<void> {
    this.pings += 1;
    if (this.reply === 'ok') return;
    if (this.reply === 'error') throw new Error('fetch failed');
    await new Promise<never>(() => undefined);
  }

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
  async list(options?: { signal?: AbortSignal }): Promise<RunnerManagerState[]> {
    this.listCalls += 1;
    this.lastListSignal = options?.signal;
    if (this.listReply === 'error') throw new Error('managers fetch failed');
    if (this.listReply === 'hang') {
      await new Promise<never>(() => undefined);
    }
    return this.sessionsToReturn.map((managerId) => ({
      managerId,
      status: 'running',
      cwd: '/work/project',
      request: '',
      waiting: [],
      ...(Object.hasOwn(this.backgroundToReturn, managerId)
        ? { liveBackgroundTasks: this.backgroundToReturn[managerId] }
        : {}),
      ...(Object.hasOwn(this.fingerprintToReturn, managerId)
        ? { tokenFingerprint: this.fingerprintToReturn[managerId] }
        : {}),
    }));
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
  async close(): Promise<void> {
    this.closed = true;
  }
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('runner の生存判定', () => {
  it('10秒ごとに /health を叩き、30秒応答が無ければ onLost が1回だけ出る', async () => {
    const lost: { label: string; runnerId?: string }[] = [];
    const runner = new FakeRunner('runner-a');
    const registry = createRunnerRegistry([], { onLost: (event) => lost.push(event) });
    await registry.register({ label: 'http://runner:4518', open: async () => runner });

    runner.reply = 'error';
    await vi.advanceTimersByTimeAsync(10_000);
    expect(runner.pings).toBe(1);
    expect(lost).toEqual([]);
    expect(registry.entries()).toMatchObject([{ state: 'connected' }]);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(lost).toEqual([]);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(lost).toMatchObject([{ label: 'http://runner:4518', runnerId: 'runner-a' }]);
    expect(registry.entries()).toMatchObject([{ state: 'lost' }]);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(lost).toHaveLength(1);
    expect(registry.entries()[0]?.error).toContain('fetch failed');

    await registry.stop();
  });

  it('runnerId を聞けていない runner が黙っても、runnerId を出さない（#330）', async () => {
    const lost: { label: string; runnerId?: string }[] = [];
    const runner = new FakeRunner('runner-primary');
    runner.runnerIdKnown = false;
    const registry = createRunnerRegistry([], { onLost: (event) => lost.push(event) });
    await registry.register({ label: 'http://runner:4518', open: async () => runner });

    runner.reply = 'error';
    await vi.advanceTimersByTimeAsync(30_000);

    expect(lost).toMatchObject([{ label: 'http://runner:4518' }]);
    expect(lost[0]).not.toHaveProperty('runnerId');

    await registry.stop();
  });

  it('返らない1台が、他の1台の名乗りを止めない', async () => {
    const lost: { label: string }[] = [];
    const silent = new FakeRunner('runner-silent');
    const answering = new FakeRunner('runner-alive');
    const registry = createRunnerRegistry([], { onLost: (event) => lost.push(event) });
    await registry.register({ label: '沈黙する器', open: async () => silent });
    await registry.register({ label: '応える器', open: async () => answering });

    silent.reply = 'hang';

    await vi.advanceTimersByTimeAsync(10_000);
    expect(silent.pings).toBe(1);
    expect(answering.pings).toBe(1);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(lost).toEqual([]);
    expect(registry.entries()).toMatchObject([
      { label: '沈黙する器', state: 'connected' },
      { label: '応える器', state: 'connected' },
    ]);

    await vi.advanceTimersByTimeAsync(25_000);
    expect(lost).toMatchObject([{ label: '沈黙する器' }]);
    expect(registry.entries()).toMatchObject([
      { label: '沈黙する器', state: 'lost' },
      { label: '応える器', state: 'connected' },
    ]);
    expect(answering.pings).toBe(4);

    await registry.stop();
  });

  it('黙った器が戻れば宛先に戻り、また黙れば改めて onLost が出る', async () => {
    const lost: { label: string }[] = [];
    const runner = new FakeRunner('runner-a');
    const registry = createRunnerRegistry([], { onLost: (event) => lost.push(event) });
    await registry.register({ label: 'http://runner:4518', open: async () => runner });

    runner.reply = 'error';
    await vi.advanceTimersByTimeAsync(30_000);
    expect(lost).toHaveLength(1);
    expect(await registry.list()).toEqual([]);

    runner.reply = 'ok';
    await vi.advanceTimersByTimeAsync(10_000);
    expect(registry.entries()).toMatchObject([{ state: 'connected' }]);
    expect(registry.entries()[0]?.error).toBeUndefined();
    expect(await registry.list()).toHaveLength(1);

    runner.reply = 'error';
    await vi.advanceTimersByTimeAsync(30_000);
    expect(lost).toHaveLength(2);
    expect(registry.entries()).toMatchObject([{ state: 'lost' }]);

    await registry.stop();
  });

  it('vacating な器は、heartbeat が何度成功しても connected へ黙って戻らない（#485 PR-2）', async () => {
    const runner = new FakeRunner('runner-a');
    const registry = createRunnerRegistry();
    await registry.register({ label: 'http://runner:4518', open: async () => runner });
    expect(registry.entries()).toMatchObject([{ state: 'connected' }]);

    registry.vacate('runner-a');
    expect(registry.entries()).toMatchObject([{ state: 'vacating' }]);

    runner.reply = 'ok';
    await vi.advanceTimersByTimeAsync(10_000);
    expect(runner.pings).toBe(1);
    expect(registry.entries()).toMatchObject([{ state: 'vacating' }]);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(registry.entries()).toMatchObject([{ state: 'vacating' }]);
    expect(await registry.list()).toEqual([]);

    await registry.stop();
  });

  it('vacating な器は、30秒以上の断のあと復帰しても connected へ黙って戻らない（#485 PR-2）', async () => {
    const runner = new FakeRunner('runner-a');
    const registry = createRunnerRegistry();
    await registry.register({ label: 'http://runner:4518', open: async () => runner });

    registry.vacate('runner-a');
    expect(registry.entries()).toMatchObject([{ state: 'vacating' }]);

    runner.reply = 'error';
    await vi.advanceTimersByTimeAsync(30_000);

    runner.reply = 'ok';
    await vi.advanceTimersByTimeAsync(10_000);

    expect(registry.entries()).toMatchObject([{ state: 'vacating' }]);
    expect(await registry.list()).toEqual([]);

    await registry.stop();
  });

  it('落ちた runner は新しい委譲の宛先から外れる（名簿には残る）', async () => {
    const runner = new FakeRunner('runner-a');
    const registry = createRunnerRegistry([], { selectWaitMs: 0 });
    await registry.register({ label: 'http://runner:4518', open: async () => runner });

    expect((await registry.select({})).runnerId).toBe('runner-a');

    runner.reply = 'error';
    await vi.advanceTimersByTimeAsync(30_000);

    await expect(registry.select({})).rejects.toThrow(/http:\/\/runner:4518 は lost/);
    expect(await registry.list()).toEqual([]);
    expect(registry.entries()).toMatchObject([{ label: 'http://runner:4518', state: 'lost' }]);

    await registry.stop();
  });

  it('stop() で名乗りを聞くのをやめる', async () => {
    const runner = new FakeRunner('runner-a');
    const registry = createRunnerRegistry();
    await registry.register({ label: 'http://runner:4518', open: async () => runner });

    await vi.advanceTimersByTimeAsync(10_000);
    expect(runner.pings).toBe(1);

    await registry.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(runner.pings).toBe(1);
  });
});

describe('runner が抱えているセッションの観測（#579）', () => {
  it('list() が返した鍵の指紋を、欄を名乗った委譲だけ sessionTokenFingerprints に載せる（#2877 PR2。値は持たない）', async () => {
    vi.setSystemTime(new Date('2026-10-05T00:00:00.000Z'));
    const runner = new FakeRunner('runner-a');
    runner.sessionsToReturn = ['mgr-new', 'mgr-old'];
    runner.fingerprintToReturn = { 'mgr-new': 'aaaaaaaaaaaa' };
    const registry = createRunnerRegistry([]);
    await registry.register({ label: 'http://runner:4518', open: async () => runner });

    await vi.advanceTimersByTimeAsync(10_000);

    const [entry] = registry.entries();
    expect(entry?.sessionTokenFingerprints).toEqual({ 'mgr-new': 'aaaaaaaaaaaa' });
    expect(entry?.sessionTokenFingerprints).not.toHaveProperty('mgr-old');

    await registry.stop();
  });

  it('list() が返した背景処理の本数を、欄を名乗った委譲だけ sessionBackgroundTasks に載せる（#2851。0 を捏造しない）', async () => {
    vi.setSystemTime(new Date('2026-10-05T00:00:00.000Z'));
    const runner = new FakeRunner('runner-a');
    runner.sessionsToReturn = ['mgr-new', 'mgr-zero', 'mgr-old'];
    runner.backgroundToReturn = { 'mgr-new': 2, 'mgr-zero': 0 };
    const registry = createRunnerRegistry([]);
    await registry.register({ label: 'http://runner:4518', open: async () => runner });

    await vi.advanceTimersByTimeAsync(10_000);

    const [entry] = registry.entries();
    expect(entry?.sessionBackgroundTasks).toEqual({ 'mgr-new': 2, 'mgr-zero': 0 });
    expect(entry?.sessionBackgroundTasks).not.toHaveProperty('mgr-old');

    await registry.stop();
  });

  it('10秒ごとの beat が list() も叩き、entries() に sessions と sessionsObservedAt が載る（観測時刻は beat の時刻）', async () => {
    vi.setSystemTime(new Date('2026-08-27T09:00:00.000Z'));
    const runner = new FakeRunner('runner-a');
    runner.sessionsToReturn = ['mgr-1', 'mgr-2'];
    const registry = createRunnerRegistry([]);
    await registry.register({ label: 'http://runner:4518', open: async () => runner });

    await vi.advanceTimersByTimeAsync(10_000);

    expect(runner.listCalls).toBe(1);
    expect(registry.entries()).toMatchObject([
      {
        sessions: ['mgr-1', 'mgr-2'],
        sessionsObservedAt: '2026-08-27T09:00:10.000Z',
      },
    ]);

    await registry.stop();
  });

  it('list() が投げても生死を倒さない（state は connected のままで onLost も出ない）', async () => {
    const lost: { label: string }[] = [];
    const runner = new FakeRunner('runner-a');
    runner.listReply = 'error';
    const registry = createRunnerRegistry([], { onLost: (event) => lost.push(event) });
    await registry.register({ label: 'http://runner:4518', open: async () => runner });

    await vi.advanceTimersByTimeAsync(60_000);

    expect(lost).toEqual([]);
    expect(registry.entries()).toMatchObject([{ state: 'connected' }]);
    expect(runner.listCalls).toBeGreaterThan(0);

    await registry.stop();
  });

  it('list() が投げた回は前の観測を消さない（1周目の sessions が2周目の失敗後も同じ値のまま残る）', async () => {
    const runner = new FakeRunner('runner-a');
    runner.sessionsToReturn = ['mgr-1'];
    const registry = createRunnerRegistry([]);
    await registry.register({ label: 'http://runner:4518', open: async () => runner });

    await vi.advanceTimersByTimeAsync(10_000);
    expect(registry.entries()).toMatchObject([{ sessions: ['mgr-1'] }]);
    const firstObservedAt = registry.entries()[0]?.sessionsObservedAt;
    expect(firstObservedAt).toBeDefined();

    runner.listReply = 'error';
    await vi.advanceTimersByTimeAsync(10_000);

    expect(registry.entries()).toMatchObject([
      { sessions: ['mgr-1'], sessionsObservedAt: firstObservedAt },
    ]);

    await registry.stop();
  });

  it('一度も list() が答えていない間は sessions が undefined（空配列で埋めない）', async () => {
    const runner = new FakeRunner('runner-a');
    runner.listReply = 'error';
    const registry = createRunnerRegistry([]);
    await registry.register({ label: 'http://runner:4518', open: async () => runner });

    expect(registry.entries()[0]).not.toHaveProperty('sessions');
    expect(registry.entries()[0]).not.toHaveProperty('sessionsObservedAt');

    await vi.advanceTimersByTimeAsync(10_000);
    expect(registry.entries()[0]).not.toHaveProperty('sessions');
    expect(registry.entries()[0]).not.toHaveProperty('sessionsObservedAt');

    await registry.stop();
  });

  it('list() が返らないとき、5秒（HEARTBEAT_PROBE_MS）で signal を中断し、次の周でまた list() が呼ばれる（錠が外れている）', async () => {
    const runner = new FakeRunner('runner-a');
    runner.listReply = 'hang';
    const registry = createRunnerRegistry([]);
    await registry.register({ label: 'http://runner:4518', open: async () => runner });

    await vi.advanceTimersByTimeAsync(10_000);
    expect(runner.listCalls).toBe(1);
    const firstSignal = runner.lastListSignal;
    expect(firstSignal).toBeDefined();
    expect(firstSignal?.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(4_000);
    expect(firstSignal?.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(firstSignal?.aborted).toBe(true);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(runner.listCalls).toBe(2);

    await registry.stop();
  });
});
