import type { query as sdkQuery, Options, Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it, vi } from 'vitest';

import { createManagerPool } from './manager.js';
import { createLocalRunner } from './runner-local.js';
import { createRunnerRegistry, RunnerHttpError } from './runner-protocol.js';
import type { RunnerClient } from './runner-protocol.js';
import type { InboxEvent } from './schema.js';
import { createMemoryStores } from './testing.js';

/** `vi.mock` は使わない: 名簿が本物の `RunnerClient` を開けることまで見たいので、差し替えるのは SDK の口だけにする。 */
function fakeSdk(sessions: { options: Options }[] = []): typeof sdkQuery {
  return ((params: { prompt: unknown; options?: Options }) => {
    sessions.push({ options: params.options ?? {} });
    let close = (): void => undefined;
    const closed = new Promise<void>((resolve) => {
      close = resolve;
    });

    async function* generate(): AsyncGenerator<SDKMessage, void> {
      yield {
        type: 'system',
        subtype: 'init',
        session_id: 'sess-late',
        uuid: 'uuid-init',
      } as unknown as SDKMessage;

      void (async () => {
        for await (const message of params.prompt as AsyncIterable<unknown>) {
          void message;
        }
      })();

      await closed;
    }

    return Object.assign(generate(), {
      close: () => close(),
      interrupt: async () => undefined,
    }) as unknown as Query;
  }) as unknown as typeof sdkQuery;
}

describe('runner の名簿', () => {
  it('後から register した runner へ委譲できる', async () => {
    const stores = createMemoryStores();
    const inbox: InboxEvent[] = [];

    const registry = createRunnerRegistry();
    const pool = createManagerPool({
      stores,
      post: (event) => inbox.push(event),
      runners: registry,
    });
    expect(await registry.list()).toEqual([]);

    await registry.register({
      label: '同一プロセス',
      open: async () =>
        createLocalRunner({
          runnerId: 'runner-late',
          workspacePath: '/work/project',
          queryFn: fakeSdk(),
          env: {},
        }),
    });

    const manager = await pool.start({ request: '後から来た runner に頼む' });
    expect(manager.runnerId).toBe('runner-late');
    expect(manager.cwd).toBe('/work/project');

    await pool.stop();
    await registry.stop();
  });

  it('後から register した runner が、台帳に残っていた委譲を引き取る', async () => {
    const stores = createMemoryStores();
    const at = new Date().toISOString();
    await stores.jobs.putJob({
      id: 'mgr-old',
      managerId: 'mgr-old',
      createdAt: at,
      updatedAt: at,
      status: 'running',
      summary: '前回から走っている仕事',
      request: '前回から走っている仕事',
      cwd: '/work/project',
      sessionId: 'sess-old',
      runnerId: 'runner-late',
    });

    const inbox: InboxEvent[] = [];
    const registry = createRunnerRegistry();
    const pool = createManagerPool({
      stores,
      post: (event) => inbox.push(event),
      runners: registry,
    });

    const sessions: { options: Options }[] = [];
    await registry.register({
      label: '同一プロセス',
      open: async () =>
        createLocalRunner({
          runnerId: 'runner-late',
          workspacePath: '/work/project',
          queryFn: fakeSdk(sessions),
          env: {},
        }),
    });

    for (let i = 0; i < 100 && sessions.length === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(sessions[0]?.options.resume).toBe('sess-old');

    await pool.stop();
    await registry.stop();
  });

  it('上がってこない runner を背景で挑み直し、上がったら委譲の宛先になる', async () => {
    let attempts = 0;
    const registry = createRunnerRegistry([], { retryBaseMs: 5, retryMaxMs: 5 });

    await registry.register({
      label: 'http://runner:4518',
      open: async () => {
        attempts += 1;
        if (attempts < 3) throw new Error('fetch failed');
        return createLocalRunner({
          runnerId: 'runner-slow',
          workspacePath: '/work/project',
          queryFn: fakeSdk(),
          env: {},
        });
      },
    });

    expect(registry.entries()).toMatchObject([
      { label: 'http://runner:4518', state: 'unreachable' },
    ]);

    const runner = await registry.select({});
    expect(runner.runnerId).toBe('runner-slow');
    expect(attempts).toBe(3);
    expect(registry.entries()).toMatchObject([{ state: 'connected', runnerId: 'runner-slow' }]);

    await runner.close();
    await registry.stop();
  });

  it('挑み直しても直らない失敗は、挑み直さずにクローンへ知らせる', async () => {
    const failures: { label: string; error: string }[] = [];
    let attempts = 0;
    const registry = createRunnerRegistry([], {
      retryBaseMs: 1,
      retryMaxMs: 1,
      notify: (failure) => failures.push(failure),
    });

    await registry.register({
      label: 'http://runner:4518',
      open: async () => {
        attempts += 1;
        throw new RunnerHttpError('鍵を拒まれた', 401);
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(attempts).toBe(1);
    expect(failures).toHaveLength(1);
    expect(failures[0]?.label).toBe('http://runner:4518');
    expect(registry.entries()).toMatchObject([{ state: 'unusable' }]);

    const started = Date.now();
    await expect(registry.select({})).rejects.toThrow(/どれも使えない/);
    expect(Date.now() - started).toBeLessThan(500);

    await registry.stop();
  });

  it('クローンへの知らせは伏せ字を通す: URL の資格と params: 以降は載らない（issue #2559）', async () => {
    const failures: { label: string; error: string }[] = [];
    const registry = createRunnerRegistry([], {
      retryBaseMs: 1,
      retryMaxMs: 1,
      notify: (failure) => failures.push(failure),
    });

    await registry.register({
      label: 'http://runner:4518',
      open: async () => {
        throw new RunnerHttpError(
          '鍵を拒まれた: http://alteroid:FAKEPASS2559@runner:4518\nparams: FAKE_SECRET_VALUE_2559',
          401,
        );
      },
    });

    await vi.waitFor(() => {
      expect(failures).toHaveLength(1);
    });
    const error = failures[0]?.error ?? '';
    expect(error).toContain('鍵を拒まれた');
    expect(error).not.toContain('FAKEPASS2559');
    expect(error).not.toContain('FAKE_SECRET_VALUE_2559');
    expect(registry.entries()).toMatchObject([{ state: 'unusable', error }]);

    await registry.stop();
  });

  it('繋がっていないときは、猶予を過ぎたら状態を添えて失敗する', async () => {
    const registry = createRunnerRegistry([], {
      retryBaseMs: 10_000,
      retryMaxMs: 10_000,
      selectWaitMs: 50,
    });
    await registry.register({
      label: 'http://runner:4518',
      open: () => Promise.reject(new Error('fetch failed')),
    });

    await expect(registry.select({})).rejects.toThrow(/http:\/\/runner:4518 は unreachable/);
    await expect(registry.select({})).rejects.toThrow(/fetch failed/);
    await expect(registry.select({})).rejects.not.toThrow(/1台も登録されていない/);

    await registry.stop();
  });

  it('登録が0台のときは、設定の問題として即座に返す', async () => {
    const registry = createRunnerRegistry();
    const started = Date.now();
    await expect(registry.select({})).rejects.toThrow(/1台も登録されていない/);
    expect(Date.now() - started).toBeLessThan(500);
    await registry.stop();
  });

  it('stop() で背景の挑み直しが畳まれる', async () => {
    let attempts = 0;
    const registry = createRunnerRegistry([], { retryBaseMs: 5, retryMaxMs: 5 });
    await registry.register({
      label: 'http://runner:4518',
      open: async () => {
        attempts += 1;
        throw new Error('fetch failed');
      },
    });

    await registry.stop();
    const after = attempts;
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(attempts).toBe(after);
  });

  it('unregister した runner は宛先から外れる', async () => {
    const registry = createRunnerRegistry();
    let opened: RunnerClient | null = null;
    await registry.register({
      label: '同一プロセス',
      open: async () => {
        opened = createLocalRunner({
          runnerId: 'runner-gone',
          workspacePath: '/work/project',
          queryFn: fakeSdk(),
          env: {},
        });
        return opened;
      },
    });
    expect(await registry.get('runner-gone')).not.toBeNull();

    await registry.unregister('同一プロセス');
    expect(registry.entries()).toEqual([]);
    expect(await registry.list()).toEqual([]);
    expect(await registry.get('runner-gone')).toBeNull();

    await registry.stop();
  });

  it('vacate した runner は list() の置き先から外れるが、entries() には vacating で残り get() でも引ける', async () => {
    const registry = createRunnerRegistry();
    await registry.register({
      label: '同一プロセス',
      open: async () =>
        createLocalRunner({
          runnerId: 'runner-vacating',
          workspacePath: '/work/project',
          queryFn: fakeSdk(),
          env: {},
        }),
    });
    expect(await registry.list()).toHaveLength(1);

    registry.vacate('runner-vacating');

    expect(await registry.list()).toEqual([]);
    expect(registry.entries()).toMatchObject([
      { label: '同一プロセス', state: 'vacating', runnerId: 'runner-vacating' },
    ]);
    expect(await registry.get('runner-vacating')).not.toBeNull();

    await registry.stop();
  });

  it('名簿に無い runnerId を vacate しても何も起きない', async () => {
    const registry = createRunnerRegistry();
    expect(() => registry.vacate('runner-ghost')).not.toThrow();
    expect(registry.entries()).toEqual([]);
    await registry.stop();
  });
});
