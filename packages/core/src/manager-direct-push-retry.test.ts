import type { Options, Query, SDKMessage, query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createManagerPool } from './manager.js';
import { createMcpServerService } from './mcp-server-service.js';
import { mcpServersFingerprintOf, type McpServers } from './mcp-servers.js';
import { createProfileService } from './profile-service.js';
import { createLocalRunner } from './runner-local.js';
import { createRunnerRegistry } from './runner-protocol.js';
import { createMemoryStores } from './testing.js';

/**
 * **`apply()` の即時の配布が失敗しても、名乗りのときの配布と同じ帳面に積み、諦めずに
 * 挑み直す（Issue #1699）。**
 *
 * `PUT /mcp-servers` / `PUT /profile` / `profile_write` は、保存の直後に繋がっている
 * runner へその場で直接配る（`McpServerService.apply` / `ProfileService.apply`）。
 * この経路は `ManagerPool` の押し込みの帳面（`pushHealthOf`）も挑み直しも通らなかった
 * ので、一時的な障害で配り損ねても `runner_list` の「直近の押し込み」は前の「ok」の
 * ままで、runner が名乗り直すまで古い版のまま走っていた。値はすべて偽物である。
 */

const REGISTRATION: McpServers = {
  github: { command: 'gh-mcp', env: { GITHUB_TOKEN: 'dummy-not-a-real-secret' } },
};

function fakeSdk(): typeof sdkQuery {
  return ((input: { options: Options }) => {
    void input;
    let finish: (() => void) | undefined;
    async function* generate(): AsyncGenerator<SDKMessage, void> {
      yield {
        type: 'system',
        subtype: 'init',
        session_id: 'sess-1',
        uuid: 'uuid-1',
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
}

function setup() {
  const stores = createMemoryStores();
  const runner = createLocalRunner({
    runnerId: 'runner-test',
    workspacePath: '/work/project',
    queryFn: fakeSdk(),
    env: { PATH: '/usr/bin' },
  });
  const registry = createRunnerRegistry([runner]);
  const mcpServers = createMcpServerService({ stores, runners: registry });
  const profile = createProfileService({ stores, runners: registry });
  const pool = createManagerPool({
    stores,
    post: () => undefined,
    runners: registry,
    mcpServers,
    profile,
  });
  return { stores, runner, pool, mcpServers, profile };
}

describe('apply() の即時の配布の失敗も、同じ帳面に積んで挑み直す（#1699）', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-27T00:00:00.000Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('MCP の登録: 一時的に配り損ねたら帳面が failed になり、挑み直されて届き、ok に戻る', async () => {
    const s = setup();
    await s.pool.start({ request: '走る' });
    expect(s.pool.pushHealthOf('runner-test')?.mcpServers?.status).toBe('ok');

    let calls = 0;
    let broken = true;
    const real = s.runner.setMcpServers?.bind(s.runner);
    s.runner.setMcpServers = async (servers) => {
      calls += 1;
      if (broken) throw new Error('mcp sync failed (test, transient)');
      return real?.(servers);
    };

    const result = await s.mcpServers.apply(REGISTRATION);
    expect(result.runners).toEqual([
      expect.objectContaining({ runnerId: 'runner-test', ok: false }),
    ]);
    // 配り損ねたことが、runner_list の「直近の押し込み」の元にすぐ出る。
    expect(s.pool.pushHealthOf('runner-test')?.mcpServers?.status).toBe('failed');

    broken = false;
    await vi.advanceTimersByTimeAsync(10 * 60_000);

    expect(calls).toBeGreaterThan(1);
    expect((await s.runner.mcpServers?.())?.sha256).toBe(mcpServersFingerprintOf(REGISTRATION));
    expect(s.pool.pushHealthOf('runner-test')?.mcpServers?.status).toBe('ok');

    await s.pool.stop();
  });

  it('実行環境プロファイル: 一時的に配り損ねたら帳面が failed になり、挑み直されて ok に戻る', async () => {
    const s = setup();
    await s.pool.start({ request: '走る' });

    let calls = 0;
    let broken = true;
    s.runner.setProfile = async () => {
      calls += 1;
      if (broken) throw new Error('profile sync failed (test, transient)');
      return { ok: true };
    };

    const result = await s.profile.apply('export DUMMY_SETTING=not-a-secret');
    expect(result.runners).toEqual([
      expect.objectContaining({ runnerId: 'runner-test', ok: false }),
    ]);
    expect(s.pool.pushHealthOf('runner-test')?.profile?.status).toBe('failed');

    broken = false;
    await vi.advanceTimersByTimeAsync(10 * 60_000);

    expect(calls).toBeGreaterThan(1);
    expect(s.pool.pushHealthOf('runner-test')?.profile?.status).toBe('ok');

    await s.pool.stop();
  });

  it('止めた後の配布の結果は、帳面にも挑み直しにも積まない（購読を外す）', async () => {
    const s = setup();
    await s.pool.start({ request: '走る' });
    await s.pool.stop();

    let calls = 0;
    s.runner.setMcpServers = async () => {
      calls += 1;
      throw new Error('mcp sync failed (test)');
    };
    await s.mcpServers.apply(REGISTRATION);
    await vi.advanceTimersByTimeAsync(10 * 60_000);

    expect(calls).toBe(1);
  });
});
