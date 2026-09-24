import type { Options, Query, SDKMessage, query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createManagerPool, type ManagerPool } from './manager.js';
import { createMcpServerService } from './mcp-server-service.js';
import { mcpServersFingerprintOf, type McpServers } from './mcp-servers.js';
import { createLocalRunner } from './runner-local.js';
import {
  createRunnerRegistry,
  RunnerMcpServersUnsupportedError,
  type RunnerClient,
} from './runner-protocol.js';
import { createMemoryStores } from './testing.js';
import type { Stores } from './store.js';

/**
 * MCP の登録を置いて runner へ配る1本道（`mcp-server-service.ts`）と、名乗りのたびの
 * 降ろし直し（`manager.ts` の `#pushMcpServers`）。#325 段3。
 *
 * HTTP 境界越しの形（404 の扱い・制御面の 400）は `apps/daemon/src/
 * runner-mcp-servers.test.ts` が撃つ。ここはプールの側の判断 —— 配布の結果の形、
 * 古い runner を挑み直しに数えないこと、一時障害は諦めずに挑み直すこと —— を固定する。
 */

const REGISTRATION: McpServers = {
  github: { command: 'gh-mcp', env: { GITHUB_TOKEN: 'SECRET-IN-ENV' } },
};

function fakeSdk(): { fn: typeof sdkQuery; started: Options[] } {
  const started: Options[] = [];
  const fn = ((input: { options: Options }) => {
    started.push(input.options);
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

    // 配った登録が、これから開くマネージャーのセッションに載る。
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

  it('古い runner は unsupported として返し、一時障害と混ぜない', async () => {
    s.runner.setMcpServers = async () => {
      throw new RunnerMcpServersUnsupportedError('runner-test');
    };
    const result = await s.service.apply(REGISTRATION);
    expect(result.runners[0]).toMatchObject({
      runnerId: 'runner-test',
      ok: false,
      unsupported: true,
    });
  });

  it('口を持たない実装（setMcpServers が無い）へは配ったとも失敗したとも言わない', async () => {
    // メソッドは prototype に在るので、delete ではなく own の undefined で覆う。
    (s.runner as { setMcpServers?: unknown }).setMcpServers = undefined;
    const result = await s.service.apply(REGISTRATION);
    expect(result.runners).toEqual([]);
    expect(await s.service.syncRunner(s.runner)).toBeNull();
  });
});

/**
 * 押し込みの挑み直し（`#settlePushRetry`）。**時計は手で進める**
 * （`manager.test.ts` の同名の describe と同じ理由）。
 */
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

  it('古い runner（口が無い）は記録するが、挑み直しに数えない（日誌を積み続けない）', async () => {
    const s = await setup();
    await s.stores.mcpServers.write(REGISTRATION);
    let attempts = 0;
    s.runner.setMcpServers = async () => {
      attempts += 1;
      throw new RunnerMcpServersUnsupportedError('runner-test');
    };

    await s.pool.start({ request: '走る' });
    const outcome = s.pool.pushHealthOf('runner-test')?.mcpServers;
    expect(outcome?.status).toBe('failed');
    expect(outcome?.error).toContain('MCP の登録を受け取る口を持たない');
    const afterConnect = attempts;

    await vi.advanceTimersByTimeAsync(180_000);
    expect(attempts).toBe(afterConnect);

    // 日誌には1度だけ残り、値は書かない。
    const lines = (await s.stores.journal.list({})).filter(
      (e) => e.type === 'exchange' && e.text.includes('MCP サーバの登録を降ろせなかった'),
    );
    expect(lines).toHaveLength(afterConnect);
    expect(JSON.stringify(lines)).not.toContain('SECRET');

    // runner を上げた（口ができた）後の名乗り直しで降りる。
    s.runner.setMcpServers = async () => ({
      sha256: mcpServersFingerprintOf(REGISTRATION),
      names: ['github'],
      updatedAt: new Date().toISOString(),
    });
    await s.pool.reattachRunner('runner-test');
    expect(s.pool.pushHealthOf('runner-test')?.mcpServers?.status).toBe('ok');

    await s.pool.stop();
  });
});
