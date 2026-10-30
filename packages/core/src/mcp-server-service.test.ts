import type { Options, Query, SDKMessage, query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createManagerPool, type ManagerPool } from './manager.js';
import { withEffectiveMcpServers } from './mcp-config-file.test-support.js';
import { createMcpServerService } from './mcp-server-service.js';
import { mcpServersFingerprintOf, type McpServers } from './mcp-servers.js';
import { createLocalRunner } from './runner-local.js';
import {
  createRunnerRegistry,
  RunnerHttpError,
  type RunnerClient,
} from './runner-protocol.js';
import { createMemoryStores } from './testing.js';
import type { Stores } from './store.js';

const REGISTRATION: McpServers = {
  github: { command: 'gh-mcp', env: { GITHUB_TOKEN: 'SECRET-IN-ENV' } },
};

function fakeSdk(): { fn: typeof sdkQuery; started: Options[] } {
  const started: Options[] = [];
  const fn = ((input: { options: Options }) => {
    started.push(withEffectiveMcpServers(input.options));
    let finish: (() => void) | undefined;
    async function* generate(): AsyncGenerator<SDKMessage, void> {
      yield {
        type: 'system',
        subtype: 'init',
        session_id: `sess-${started.length}`,
        uuid: `uuid-${started.length}`,
      } as unknown as SDKMessage;
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
    }
    return Object.assign(generate(), {
      close: () => finish?.(),
      interrupt: async () => undefined,
    }) as unknown as Query;
  }) as unknown as typeof sdkQuery;
  return { fn, started };
}

interface Setup {
  stores: Stores;
  runner: RunnerClient;
  pool: ManagerPool;
  started: Options[];
  service: ReturnType<typeof createMcpServerService>;
}

async function setup(): Promise<Setup> {
  const stores = createMemoryStores();
  const { fn, started } = fakeSdk();
  const runner = createLocalRunner({
    runnerId: 'runner-test',
    workspacePath: '/work/project',
    queryFn: fn,
    env: { PATH: '/usr/bin' },
  });
  const registry = createRunnerRegistry([runner]);
  const service = createMcpServerService({ stores, runners: registry });
  const pool = createManagerPool({
    stores,
    post: () => undefined,
    runners: registry,
    mcpServers: service,
  });
  return { stores, runner, pool, started, service };
}

describe('MCP の登録を置いて配る（apply）', () => {
  let s: Setup;
  beforeEach(async () => {
    s = await setup();
  });
  afterEach(async () => {
    await s.pool.stop();
  });

  it('保存して、繋がっている runner へ配り、runner ごとに名前と指紋だけを返す', async () => {
    const result = await s.service.apply(REGISTRATION);

    expect(result.names).toEqual(['github']);
    expect(result.sha256).toBe(mcpServersFingerprintOf(REGISTRATION));
    expect(result.runners).toEqual([
      {
        runnerId: 'runner-test',
        ok: true,
        mcpServers: {
          sha256: mcpServersFingerprintOf(REGISTRATION),
          names: ['github'],
          updatedAt: expect.any(String),
        },
      },
    ]);
    expect(JSON.stringify(result)).not.toContain('SECRET');
    expect((await s.stores.mcpServers.read())?.mcpServers).toEqual(REGISTRATION);

    await s.pool.start({ request: '走る' });
    expect(s.started.at(-1)?.mcpServers).toEqual(REGISTRATION);
  });

  it('空の登録は runner からも外す（指紋を返さない）', async () => {
    await s.service.apply(REGISTRATION);
    const result = await s.service.apply({});
    expect(result.names).toEqual([]);
    expect(result.sha256).toBeUndefined();
    expect(result.runners).toEqual([{ runnerId: 'runner-test', ok: true }]);
    expect(await s.runner.mcpServers?.()).toBeUndefined();
  });

  it('形が不正なら保存も配布もしない（前のものが残る）', async () => {
    await s.service.apply(REGISTRATION);
    await expect(
      s.service.apply({ bad: { command: 'x', nope: 1 } } as unknown as McpServers),
    ).rejects.toThrow();
    expect((await s.stores.mcpServers.read())?.mcpServers).toEqual(REGISTRATION);
    expect((await s.runner.mcpServers?.())?.sha256).toBe(mcpServersFingerprintOf(REGISTRATION));
  });

  it('口を持たない実装（setMcpServers が無い）へは配ったとも失敗したとも言わない', async () => {
    // メソッドは prototype に在るので、delete ではなく own の undefined で覆う。
    (s.runner as { setMcpServers?: unknown }).setMcpServers = undefined;
    const result = await s.service.apply(REGISTRATION);
    expect(result.runners).toEqual([]);
    expect(await s.service.syncRunner(s.runner)).toBeNull();
  });
});

describe('MCP の登録の押し込みの挑み直し', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-24T00:00:00.000Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('一時障害は次の hello を待たずに挑み直し、直れば ok になる', async () => {
    const s = await setup();
    await s.stores.mcpServers.write(REGISTRATION);
    const real = s.runner.setMcpServers?.bind(s.runner);
    let broken = true;
    s.runner.setMcpServers = async (servers) => {
      if (broken) throw new Error('mcp sync failed (test)');
      return real?.(servers);
    };

    await s.pool.start({ request: '走る' });
    expect(s.pool.pushHealthOf('runner-test')?.mcpServers?.status).toBe('failed');

    broken = false;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(s.pool.pushHealthOf('runner-test')?.mcpServers?.status).toBe('ok');
    expect((await s.runner.mcpServers?.())?.sha256).toBe(mcpServersFingerprintOf(REGISTRATION));

    await s.pool.stop();
  });

  it('口が 404 の runner も、ほかの HTTP の失敗と同じく記録し、挑み直しに数える', async () => {
    const s = await setup();
    await s.stores.mcpServers.write(REGISTRATION);
    let attempts = 0;
    s.runner.setMcpServers = async () => {
      attempts += 1;
      throw new RunnerHttpError('404 Not Found', 404);
    };

    await s.pool.start({ request: '走る' });
    expect(s.pool.pushHealthOf('runner-test')?.mcpServers?.status).toBe('failed');
    const afterConnect = attempts;

    await vi.advanceTimersByTimeAsync(180_000);
    expect(attempts).toBeGreaterThan(afterConnect);

    s.runner.setMcpServers = async () => ({
      sha256: mcpServersFingerprintOf(REGISTRATION),
      names: ['github'],
      updatedAt: new Date().toISOString(),
    });
    await s.pool.reattachRunner('runner-test');
    expect(s.pool.pushHealthOf('runner-test')?.mcpServers?.status).toBe('ok');
    expect(
      JSON.stringify(await s.stores.journal.list({})),
    ).not.toContain('SECRET');

    await s.pool.stop();
  });
});

describe('syncRunner: runner の指紋を読めなかった回（#2487）', () => {
  it('登録が空（want が無い）で指紋が読めなくても、「何も載っていない」と読まず、空を降ろす', async () => {
    const s = await setup();
    await s.runner.setMcpServers?.(REGISTRATION);
    const readReal = s.runner.mcpServers?.bind(s.runner);
    const placed: McpServers[] = [];
    const setReal = s.runner.setMcpServers?.bind(s.runner);
    s.runner.setMcpServers = async (servers) => {
      placed.push(servers);
      return setReal?.(servers);
    };
    s.runner.mcpServers = async () => {
      throw new Error('health unreadable (test)');
    };

    await s.service.syncRunner(s.runner);

    expect(placed).toEqual([{}]);
    expect(await readReal?.()).toBeUndefined();
    await s.pool.stop();
  });

  it('登録があって指紋が読めなくても、降ろす', async () => {
    const s = await setup();
    await s.stores.mcpServers.write(REGISTRATION);
    const placed: McpServers[] = [];
    s.runner.setMcpServers = async (servers) => {
      placed.push(servers);
      return undefined;
    };
    s.runner.mcpServers = async () => {
      throw new Error('health unreadable (test)');
    };

    await s.service.syncRunner(s.runner);

    expect(placed).toEqual([REGISTRATION]);
    await s.pool.stop();
  });

  it('対照: 読めて、空のままなら何もしない。読めて一致していれば何もしない', async () => {
    const s = await setup();
    const placed: McpServers[] = [];
    s.runner.setMcpServers = async (servers) => {
      placed.push(servers);
      return undefined;
    };
    s.runner.mcpServers = async () => undefined;
    expect(await s.service.syncRunner(s.runner)).toBeNull();

    await s.stores.mcpServers.write(REGISTRATION);
    s.runner.mcpServers = async () => ({
      sha256: mcpServersFingerprintOf(REGISTRATION),
      names: ['github'],
      updatedAt: new Date().toISOString(),
    });
    expect(await s.service.syncRunner(s.runner)).toBeNull();
    expect(placed).toEqual([]);
    await s.pool.stop();
  });

  it('対照: 読めて、空なのに runner に載っていれば、空を降ろす', async () => {
    const s = await setup();
    const placed: McpServers[] = [];
    s.runner.setMcpServers = async (servers) => {
      placed.push(servers);
      return undefined;
    };
    s.runner.mcpServers = async () => ({
      sha256: mcpServersFingerprintOf(REGISTRATION),
      names: ['github'],
      updatedAt: new Date().toISOString(),
    });
    await s.service.syncRunner(s.runner);
    expect(placed).toEqual([{}]);
    await s.pool.stop();
  });
});
