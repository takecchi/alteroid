import { describe, expect, it } from 'vitest';

import { createManagerPool, type ManagerPool } from './manager.js';
import { createLocalRunner } from './runner-local.js';
import {
  createRunnerRegistry,
  type RunnerClient,
  type RunnerEvent,
  type RunnerResumeCommand,
  type RunnerStartCommand,
} from './runner-protocol.js';
import { createMemoryStores } from './testing.js';

/**
 * `ManagerPool.start` の `provider`（#486 S7）。runner が `hello.managerProviders` で名乗って
 * いなければ、**送らずに断る**（旧い runner は `provider` 欄を黙って捨て、別の provider で動く）。
 */

interface Fake {
  runner: RunnerClient;
  starts: RunnerStartCommand[];
  resumes: RunnerResumeCommand[];
  emit(event: RunnerEvent): void;
}

/** 実セッションを起こさず、命令だけを記録する runner。`hello` の中身を選べる。 */
function fakeRunner(
  hello: { managerProviders?: string[]; managerProvider?: string },
  runnerId = 'runner-x',
): Fake {
  const base = createLocalRunner({ runnerId, workspacePath: '/work/project', env: {} });
  const starts: RunnerStartCommand[] = [];
  const resumes: RunnerResumeCommand[] = [];
  let emitter: ((event: RunnerEvent) => void) | null = null;
  const runner: RunnerClient = Object.create(base) as RunnerClient;
  Object.assign(runner, {
    runnerId,
    runnerIdKnown: true,
    workspacePathKnown: true,
    workspacePath: '/work/project',
    async connect(onEvent: (event: RunnerEvent) => void) {
      emitter = onEvent;
      onEvent({ type: 'hello', runnerId, ...hello });
    },
    async start(command: RunnerStartCommand) {
      starts.push(command);
      return { cwd: command.cwd };
    },
    async resume(command: RunnerResumeCommand) {
      resumes.push(command);
      return { cwd: command.cwd };
    },
    async send() {
      return false;
    },
    async list() {
      return [];
    },
  });
  return { runner, starts, resumes, emit: (event) => emitter?.(event) };
}

async function poolOf(fake: Fake): Promise<{ pool: ManagerPool; stop: () => Promise<void> }> {
  const registry = createRunnerRegistry([fake.runner]);
  const pool = createManagerPool({
    stores: createMemoryStores(),
    post: () => undefined,
    runners: registry,
  });
  return {
    pool,
    stop: async () => {
      await pool.stop();
      await registry.stop();
    },
  };
}

describe('ManagerPool.start の provider（#486 S7）', () => {
  it('省略なら、命令にも台帳にも provider を載せない（従来どおり）', async () => {
    const fake = fakeRunner({ managerProviders: ['claude', 'codex'] });
    const { pool, stop } = await poolOf(fake);
    const summary = await pool.start({ request: '普通に' });
    expect(fake.starts).toHaveLength(1);
    expect(fake.starts[0]).not.toHaveProperty('provider');
    expect(summary).not.toHaveProperty('managerProvider');
    await stop();
  });

  it('runner が名乗っていれば、命令へ載せ、台帳（summary）へ実際の provider を残す', async () => {
    const fake = fakeRunner({ managerProviders: ['claude', 'codex'], managerProvider: 'claude' });
    const { pool, stop } = await poolOf(fake);
    const summary = await pool.start({ request: 'レビュー', provider: 'codex' });
    expect(fake.starts[0]?.provider).toBe('codex');
    expect(summary.managerProvider).toBe('codex');
    expect(
      (await pool.list()).find((m) => m.managerId === summary.managerId)?.managerProvider,
    ).toBe('codex');
    await stop();
  });

  it('名乗っていない旧い runner へは送らずに断る。台帳にも残さない', async () => {
    const fake = fakeRunner({});
    const { pool, stop } = await poolOf(fake);
    await expect(pool.start({ request: 'x', provider: 'codex' })).rejects.toThrow(
      /指名起動を受けられない/,
    );
    expect(fake.starts).toEqual([]);
    expect(await pool.list()).toEqual([]);
    await stop();
  });

  it('名乗っていない runner でも、指名が runner の既定と同じなら送らずに起こす（嘘にならない）', async () => {
    const fake = fakeRunner({ managerProvider: 'codex' });
    const { pool, stop } = await poolOf(fake);
    const summary = await pool.start({ request: 'x', provider: 'codex' });
    expect(fake.starts[0]).not.toHaveProperty('provider');
    expect(summary.managerProvider).toBe('codex');
    await stop();
  });

  it('知らない provider は断る', async () => {
    const fake = fakeRunner({ managerProviders: ['claude', 'codex'] });
    const { pool, stop } = await poolOf(fake);
    await expect(pool.start({ request: 'x', provider: 'gemini' })).rejects.toThrow(/知らない/);
    expect(fake.starts).toEqual([]);
    await stop();
  });

  it('resume は、指名されていた委譲の provider を runner へ送り直す（指名の無い委譲は送らない）', async () => {
    const fake = fakeRunner({ managerProviders: ['claude', 'codex'] });
    const { pool, stop } = await poolOf(fake);
    const named = await pool.start({ request: 'a', provider: 'codex' });
    const plain = await pool.start({ request: 'b' });
    for (const id of [named.managerId, plain.managerId]) {
      fake.emit({ type: 'session', managerId: id, sessionId: `sess-${id}` });
    }
    await expect
      .poll(async () => (await pool.list()).filter((m) => m.sessionId !== undefined).length)
      .toBe(2);
    await pool.send(named.managerId, 'つづき');
    await pool.send(plain.managerId, 'つづき');
    const byId = new Map(fake.resumes.map((r) => [r.managerId, r]));
    expect(byId.get(named.managerId)?.provider).toBe('codex');
    expect(byId.get(plain.managerId)).toBeDefined();
    expect(byId.get(plain.managerId)).not.toHaveProperty('provider');
    await stop();
  });
});

describe('provider だけ指名したときの自動配置（#486 S7）', () => {
  function twoRunners(a: Fake, b: Fake) {
    return a.runner.runnerId === b.runner.runnerId;
  }

  it('選ばれた器が受けられなければ、受けられる別の器へ置く。指名の runnerId は覆さない', async () => {
    const a = fakeRunner({ managerProviders: ['claude'] }, 'runner-a');
    const b = fakeRunner({ managerProviders: ['claude', 'codex'] }, 'runner-b');
    expect(twoRunners(a, b)).toBe(false);
    const registry = createRunnerRegistry([a.runner, b.runner]);
    const pool = createManagerPool({
      stores: createMemoryStores(),
      post: () => undefined,
      runners: registry,
    });
    const summary = await pool.start({ request: 'x', provider: 'codex' });
    expect(summary.runnerId).toBe('runner-b');
    expect(b.starts[0]?.provider).toBe('codex');
    expect(a.starts).toEqual([]);
    // runnerId を名指しすれば、受けられない器でも覆さず断る
    await expect(
      pool.start({ request: 'y', provider: 'codex', runnerId: 'runner-a' }),
    ).rejects.toThrow(/指名起動を受けられない/);
    await pool.stop();
    await registry.stop();
  });

  it('どの器も受けられなければ、明確に断る', async () => {
    const a = fakeRunner({ managerProviders: ['claude'] }, 'runner-a');
    const b = fakeRunner({}, 'runner-b');
    const registry = createRunnerRegistry([a.runner, b.runner]);
    const pool = createManagerPool({
      stores: createMemoryStores(),
      post: () => undefined,
      runners: registry,
    });
    await expect(pool.start({ request: 'x', provider: 'codex' })).rejects.toThrow(
      /指名起動を受けられない/,
    );
    expect(a.starts).toEqual([]);
    expect(b.starts).toEqual([]);
    await pool.stop();
    await registry.stop();
  });
});
