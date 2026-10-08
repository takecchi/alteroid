import { join } from 'node:path';

import type { Options, Query, SDKMessage, query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { makeTempDirSync } from '../../../vitest.tmpdir.js';

import { createCredentialService } from './credential-service.js';
import { createCredentialStore } from './credentials.js';
import { createManagerPool, WITHHELD_ENV_KEYS } from './manager.js';
import { createMcpServerService } from './mcp-server-service.js';
import { createProfileService } from './profile-service.js';
import { createRunnerHost, type RunnerHost } from './runner.js';
import type { RunnerEvent } from './runner-protocol.js';
import { createLocalRunner } from './runner-local.js';
import { createRunnerRegistry, RunnerHttpError } from './runner-protocol.js';
import { createMemoryStores } from './testing.js';

const FAKE_SECRET = 'sk-ant-api03-FAKEFAKEFAKEFAKEFAKEFAKEFAKE';

function leakyError(): Error {
  return new Error(`Failed query: insert into t values ($1)\nparams: ${FAKE_SECRET}`);
}

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

function setupPool() {
  const stores = createMemoryStores();
  const credentialStore = createCredentialStore({
    dir: join(makeTempDirSync('alteroid-2509-'), 'creds'),
  });
  const runner = createLocalRunner({
    runnerId: 'runner-test',
    workspacePath: '/work/project',
    queryFn: fakeSdk(),
    env: { PATH: '/usr/bin' },
    credentials: credentialStore,
  });
  const registry = createRunnerRegistry([runner]);
  const mcpServers = createMcpServerService({ stores, runners: registry });
  const profile = createProfileService({ stores, runners: registry });
  const credentials = createCredentialService({
    stores,
    runners: registry,
    withheldEnvKeys: [...WITHHELD_ENV_KEYS],
  });
  const pool = createManagerPool({
    stores,
    post: () => undefined,
    runners: registry,
    mcpServers,
    profile,
    credentials,
  });
  return { runner, pool, mcpServers, profile, credentials };
}

describe('配布の結果の error に、例外の2行目以降（束縛パラメータ）が載らない（#2509）', () => {
  it('プロファイル: apply の結果と runner_list の直近の押し込みの両方', async () => {
    const s = setupPool();
    await s.pool.start({ request: '走る' });
    s.runner.setProfile = async () => {
      throw leakyError();
    };

    const result = await s.profile.apply('export DUMMY_SETTING=not-a-secret');

    expect(JSON.stringify(result.runners)).not.toContain(FAKE_SECRET);
    const outcome = s.pool.pushHealthOf('runner-test')?.profile;
    expect(outcome?.status).toBe('failed');
    expect(outcome?.error).toContain('Failed query');
    expect(outcome?.error).not.toContain(FAKE_SECRET);
    await s.pool.stop();
  });

  it('鍵: apply の結果と runner_list の直近の押し込みの両方', async () => {
    const s = setupPool();
    await s.pool.start({ request: '走る' });
    s.runner.setCredentials = async () => {
      throw leakyError();
    };

    const result = await s.credentials.apply([{ name: 'DUMMY_TOKEN', value: 'not-a-real-secret' }]);

    expect(JSON.stringify(result.runners)).not.toContain(FAKE_SECRET);
    const outcome = s.pool.pushHealthOf('runner-test')?.credentials;
    expect(outcome?.status).toBe('failed');
    expect(outcome?.error).not.toContain(FAKE_SECRET);
    await s.pool.stop();
  });

  it('MCP の登録: apply の結果と runner_list の直近の押し込みの両方', async () => {
    const s = setupPool();
    await s.pool.start({ request: '走る' });
    s.runner.setMcpServers = async () => {
      throw leakyError();
    };

    const result = await s.mcpServers.apply({
      github: { command: 'gh-mcp', env: { GITHUB_TOKEN: 'dummy-not-a-real-secret' } },
    });

    expect(JSON.stringify(result.runners)).not.toContain(FAKE_SECRET);
    const outcome = s.pool.pushHealthOf('runner-test')?.mcpServers;
    expect(outcome?.status).toBe('failed');
    expect(outcome?.error).not.toContain(FAKE_SECRET);
    await s.pool.stop();
  });
});

describe('未 push の観測の reason に、例外の2行目以降が載らない（#2509）', () => {
  it('manager: runner への問い合わせが失敗したとき', async () => {
    const s = setupPool();
    const { managerId } = await s.pool.start({ request: '走る' });
    (s.runner as { unpushedWork?: unknown }).unpushedWork = async () => {
      throw leakyError();
    };

    const probe = await s.pool.unpushedWork(managerId);

    expect(probe.kind).toBe('unavailable');
    if (probe.kind !== 'unavailable') throw new Error('unreachable');
    expect(probe.reason).toContain('runner への問い合わせが失敗した');
    expect(probe.reason).not.toContain(FAKE_SECRET);
    await s.pool.stop();
  });

  describe('runner: 畳む直前の観測が例外で落ちたとき', () => {
    let hosts: RunnerHost[] = [];
    afterEach(async () => {
      await Promise.all(hosts.map((host) => host.shutdown().catch(() => undefined)));
      hosts = [];
    });

    it('shutdown_unpushed_work の reason', async () => {
      const events: RunnerEvent[] = [];
      const host = createRunnerHost({
        runnerId: 'runner-2509',
        workspacePath: '/work/project',
        emit: (event) => events.push(event),
        queryFn: fakeSdk(),
        env: { PATH: '/usr/bin' },
        readCgroupEventCountersFn: async () => ({}),
        finishUnpushedWorkFn: () => Promise.reject(leakyError()),
      });
      hosts.push(host);
      await host.start({ managerId: 'mgr-1', request: '最初の依頼', cwd: '/work/project' });

      await host.shutdown();

      const event = events.find((e) => e.type === 'shutdown_unpushed_work');
      if (event?.type !== 'shutdown_unpushed_work') throw new Error('見つからない');
      if (event.unpushedWork.kind !== 'unavailable') throw new Error('unavailable ではない');
      expect(event.unpushedWork.reason).toContain('確かめようとして例外が飛んだ');
      expect(event.unpushedWork.reason).not.toContain(FAKE_SECRET);
    });
  });
});

describe('受信箱の合成通知に、例外の2行目以降が載らない（#2509）', () => {
  it.each([
    [409, '食い違っています'],
    [400, '戻せなかった'],
  ])('runner.resume が %i で拒まれたときの知らせ', async (status, marker) => {
    const stores = createMemoryStores();
    const posted: { type: string; text?: string }[] = [];
    const runner = createLocalRunner({
      runnerId: 'runner-test',
      workspacePath: '/work/project',
      queryFn: fakeSdk(),
      env: { PATH: '/usr/bin' },
    });
    runner.resume = async () => {
      throw new RunnerHttpError(`resume rejected\nparams: ${FAKE_SECRET}`, status);
    };
    const registry = createRunnerRegistry([runner]);
    const pool = createManagerPool({
      stores,
      post: (event) => posted.push(event as { type: string; text?: string }),
      runners: registry,
      synthesizedNoticeWindowMs: 50,
    });
    await stores.jobs.putJob({
      id: 'mgr-lost',
      managerId: 'mgr-lost',
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T01:00:00.000Z',
      status: 'running',
      summary: '移行作業',
      request: 'DB の移行をやって',
      cwd: '/work/project',
      sessionId: 'sess-before-restart',
      projectKey: 'proj-key',
    });

    await pool.restore();
    const texts = await vi.waitFor(
      () => {
        const seen = posted.map((event) => event.text ?? '');
        expect(seen.some((text) => text.includes(marker))).toBe(true);
        return seen;
      },
      { timeout: 10_000 },
    );

    expect(texts.join('\n')).not.toContain(FAKE_SECRET);
    await pool.stop();
  });
});
