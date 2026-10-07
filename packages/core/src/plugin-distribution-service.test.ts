import type { Options, Query, SDKMessage, query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { chmodSync, lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { makeTempDirSync } from '../../../vitest.tmpdir.js';

import { createManagerPool, type ManagerPool } from './manager.js';
import { createPluginDistributionService } from './plugin-distribution-service.js';
import type { PluginInput } from './plugins.js';
import { createLocalRunner } from './runner-local.js';
import {
  createRunnerRegistry,
  RunnerPluginsUnsupportedError,
  type RunnerClient,
} from './runner-protocol.js';
import type { Stores } from './store.js';
import { createMemoryStores } from './testing.js';

/**
 * plugin を runner へ配る1本道（`plugin-distribution-service.ts`）と、名乗りのたびの降ろし直し
 * （`manager.ts` の `#pushPlugins`）。`mcp-server-service.test.ts` の写し。
 *
 * HTTP 境界越しの形（base64・404・制御面の 400/413）は `apps/daemon/src/runner-plugins.test.ts` と
 * `apps/runner/src/plugins-routes.test.ts` が撃つ。ここはサービスとプールの判断を固定する。
 * 値はすべて偽物である。
 */

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

function pluginInput(name: string, overrides: Partial<PluginInput> = {}): PluginInput {
  return {
    name,
    source: { kind: 'url', url: 'https://example.invalid/plugins.git', sha: SHA_A },
    scope: 'all',
    files: [
      {
        path: '.claude-plugin/plugin.json',
        executable: false,
        content: Buffer.from('dummy-content'),
      },
      { path: 'scripts/run.sh', executable: true, content: Buffer.from('dummy-script') },
    ],
    installedAt: '2026-10-07T00:00:00.000Z',
    installedBy: 'tester',
    ...overrides,
  } as PluginInput;
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

/** promise だけで進む連鎖を使い切る。実時間の待ちは混むと賭けになるので使わない。 */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 50; i += 1) await Promise.resolve();
}

interface Setup {
  stores: Stores;
  runner: RunnerClient;
  pool: ManagerPool;
  service: ReturnType<typeof createPluginDistributionService>;
}

const pluginBases: string[] = [];

/** 展開先は読み取り専用（0o555）なので、掃除が消せるように書込み可へ戻す。 */
function makeWritableSync(dir: string): void {
  const info = lstatSync(dir, { throwIfNoEntry: false });
  if (info === undefined || !info.isDirectory()) return;
  chmodSync(dir, 0o700);
  for (const name of readdirSync(dir)) makeWritableSync(join(dir, name));
}

afterEach(() => {
  for (const base of pluginBases.splice(0)) makeWritableSync(base);
});

function setup(): Setup {
  const stores = createMemoryStores();
  const pluginsBase = makeTempDirSync('alteroid-plugin-distribution-');
  pluginBases.push(pluginsBase);
  const runner = createLocalRunner({
    runnerId: 'runner-test',
    pluginsRoot: join(pluginsBase, 'alteroid-plugins'),
    workspacePath: '/work/project',
    queryFn: fakeSdk(),
    env: { PATH: '/usr/bin' },
  });
  const registry = createRunnerRegistry([runner]);
  const service = createPluginDistributionService({ stores, runners: registry });
  const pool = createManagerPool({
    stores,
    post: () => undefined,
    runners: registry,
    plugins: service,
  });
  return { stores, runner, pool, service };
}

describe('plugin を配る（apply / syncRunner）', () => {
  let s: Setup;
  beforeEach(() => {
    s = setup();
  });
  afterEach(async () => {
    await s.pool.stop();
  });

  it('scope が all / runner のものだけを配り、app のものは送らない', async () => {
    await s.stores.plugins.put(pluginInput('p-all', { scope: 'all' }));
    await s.stores.plugins.put(pluginInput('p-runner', { scope: 'runner' }));
    await s.stores.plugins.put(pluginInput('p-app', { scope: 'app' }));
    const sent: string[] = [];
    const real = s.runner.setPlugin?.bind(s.runner);
    s.runner.setPlugin = async (plugin) => {
      sent.push(plugin.name);
      return real!(plugin);
    };

    const result = await s.service.apply();

    expect(result.names).toEqual(['p-all', 'p-runner']);
    expect(sent.sort()).toEqual(['p-all', 'p-runner']);
    expect((await s.runner.plugins?.())?.plugins.map((p) => p.name)).toEqual(['p-all', 'p-runner']);
  });

  it('結果に files の中身（バイト）を載せない。指紋は runner が返すものと一致する', async () => {
    await s.stores.plugins.put(pluginInput('p-all'));
    const result = await s.service.apply();

    const json = JSON.stringify(result);
    expect(json).not.toContain('dummy-content');
    expect(json).not.toContain(Buffer.from('dummy-content').toString('base64'));
    expect(result.runners).toEqual([
      {
        runnerId: 'runner-test',
        ok: true,
        plugins: {
          sha256: result.sha256,
          plugins: [
            {
              name: 'p-all',
              sha: SHA_A,
              contentSha256: (await s.stores.plugins.get('p-all'))!.contentSha256,
            },
          ],
          updatedAt: expect.any(String),
        },
      },
    ]);
  });

  it('runner の指紋と同じなら送らない（往復を足さない）', async () => {
    await s.stores.plugins.put(pluginInput('p-all'));
    await s.service.apply();
    let sent = 0;
    let retained = 0;
    const realSet = s.runner.setPlugin?.bind(s.runner);
    const realRetain = s.runner.retainPlugins?.bind(s.runner);
    s.runner.setPlugin = async (plugin) => {
      sent += 1;
      return realSet!(plugin);
    };
    s.runner.retainPlugins = async (names) => {
      retained += 1;
      return realRetain!(names);
    };

    expect(await s.service.syncRunner(s.runner)).toBeNull();
    expect(sent).toBe(0);
    expect(retained).toBe(0);
  });

  it('差のある plugin だけを1本ずつ送り、最後に残す名前の一覧を送る', async () => {
    await s.stores.plugins.put(pluginInput('p-one'));
    await s.stores.plugins.put(pluginInput('p-two'));
    await s.service.apply();
    // p-two の取り元の sha が変わる。
    await s.stores.plugins.put(
      pluginInput('p-two', {
        source: { kind: 'url', url: 'https://example.invalid/plugins.git', sha: SHA_B },
      }),
    );
    const calls: string[] = [];
    const realSet = s.runner.setPlugin?.bind(s.runner);
    const realRetain = s.runner.retainPlugins?.bind(s.runner);
    s.runner.setPlugin = async (plugin) => {
      calls.push(`set:${plugin.name}`);
      return realSet!(plugin);
    };
    s.runner.retainPlugins = async (names) => {
      calls.push(`retain:${names.join(',')}`);
      return realRetain!(names);
    };

    await s.service.syncRunner(s.runner);

    expect(calls).toEqual(['set:p-two', 'retain:p-one,p-two']);
    expect((await s.runner.plugins?.())?.plugins.find((p) => p.name === 'p-two')?.sha).toBe(SHA_B);
  });

  it('全部外したとき、runner に残っていたものを外させる（空の一覧を送る）', async () => {
    await s.stores.plugins.put(pluginInput('p-all'));
    await s.service.apply();
    expect(await s.runner.plugins?.()).toBeDefined();

    await s.stores.plugins.remove('p-all');
    const result = await s.service.apply();

    expect(result.names).toEqual([]);
    expect(result.sha256).toBeUndefined();
    expect(result.runners).toEqual([{ runnerId: 'runner-test', ok: true }]);
    expect(await s.runner.plugins?.()).toBeUndefined();
  });

  it('scope を app へ変えたものも、runner からは外れる', async () => {
    await s.stores.plugins.put(pluginInput('p-all'));
    await s.service.apply();
    await s.stores.plugins.put(pluginInput('p-all', { scope: 'app' }));
    await s.service.apply();
    expect(await s.runner.plugins?.()).toBeUndefined();
  });

  it('対照: 何も無く、runner も何も持たないなら何も呼ばない', async () => {
    let called = 0;
    s.runner.setPlugin = async () => {
      called += 1;
      throw new Error('呼ばれないはず');
    };
    s.runner.retainPlugins = async () => {
      called += 1;
      return undefined;
    };
    expect(await s.service.syncRunner(s.runner)).toBeNull();
    expect(called).toBe(0);
  });

  it('指紋が読めなければ「差がある」に倒す（同じ版でも全部送り直し、余りを外させる）', async () => {
    await s.stores.plugins.put(pluginInput('p-all'));
    await s.service.apply();
    s.runner.plugins = async () => {
      throw new Error('health unreadable (test)');
    };
    const sent: string[] = [];
    const retained: string[][] = [];
    const realSet = s.runner.setPlugin?.bind(s.runner);
    s.runner.setPlugin = async (plugin) => {
      sent.push(plugin.name);
      return realSet!(plugin);
    };
    s.runner.retainPlugins = async (names) => {
      retained.push([...names]);
      return undefined;
    };

    await s.service.syncRunner(s.runner);
    expect(sent).toEqual(['p-all']);
    expect(retained).toEqual([['p-all']]);
  });

  it('指紋が読めず、正本が空でも、空の一覧を送る（読めなかったを「何も無い」にしない）', async () => {
    const retained: string[][] = [];
    s.runner.plugins = async () => {
      throw new Error('health unreadable (test)');
    };
    s.runner.retainPlugins = async (names) => {
      retained.push([...names]);
      return undefined;
    };
    await s.service.syncRunner(s.runner);
    expect(retained).toEqual([[]]);
  });

  it('途中の1本が失敗したら、残す一覧は送らない（前の状態を巻き込まない）', async () => {
    await s.stores.plugins.put(pluginInput('p-one'));
    let retained = 0;
    s.runner.setPlugin = async () => {
      throw new Error('plugin sync failed (test)');
    };
    s.runner.retainPlugins = async () => {
      retained += 1;
      return undefined;
    };
    await expect(s.service.syncRunner(s.runner)).rejects.toThrow('plugin sync failed');
    expect(retained).toBe(0);
  });

  it('古い runner（404）は unsupported として返し、一時障害と混ぜない', async () => {
    await s.stores.plugins.put(pluginInput('p-all'));
    s.runner.setPlugin = async () => {
      throw new RunnerPluginsUnsupportedError('runner-test');
    };
    const result = await s.service.apply();
    expect(result.runners[0]).toMatchObject({
      runnerId: 'runner-test',
      ok: false,
      unsupported: true,
    });
  });

  it('口を持たない実装（setPlugin が無い）へは配ったとも失敗したとも言わない', async () => {
    await s.stores.plugins.put(pluginInput('p-all'));
    (s.runner as { setPlugin?: unknown }).setPlugin = undefined;
    const result = await s.service.apply();
    expect(result.runners).toEqual([]);
    expect(await s.service.syncRunner(s.runner)).toBeNull();
  });

  it('serial: 同時に呼んでも、1本ずつ順に走る（古い一覧が新しい一覧を上書きしない）', async () => {
    await s.stores.plugins.put(pluginInput('p-all'));
    const order: string[] = [];
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const realSet = s.runner.setPlugin?.bind(s.runner);
    let first = true;
    s.runner.setPlugin = async (plugin) => {
      order.push('set:start');
      if (first) {
        first = false;
        await gate;
      }
      order.push('set:end');
      return realSet!(plugin);
    };
    const a = s.service.syncRunner(s.runner);
    const b = s.service.apply();
    // a が止まっている間、b は始まらない。順番待ちは promise だけで進むので、
    // 時間ではなくマイクロタスクを使い切って確かめる。
    await flushMicrotasks();
    expect(order).toEqual(['set:start']);
    release?.();
    await Promise.all([a, b]);
    expect(order[1]).toBe('set:end');
  });
});

describe('plugin の降ろし直しと挑み直し（名乗り）', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-07T00:00:00.000Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('hello で降り、帳面は ok になる', async () => {
    const s = setup();
    await s.stores.plugins.put(pluginInput('p-all'));
    await s.pool.start({ request: '走る' });
    expect(s.pool.pushHealthOf('runner-test')?.plugins?.status).toBe('ok');
    expect((await s.runner.plugins?.())?.plugins.map((p) => p.name)).toEqual(['p-all']);
    await s.pool.stop();
  });

  it('runner が失ったら、名乗り直し（reattach）で降り直す', async () => {
    const s = setup();
    await s.stores.plugins.put(pluginInput('p-all'));
    await s.pool.start({ request: '走る' });
    await s.runner.retainPlugins?.([]);
    expect(await s.runner.plugins?.()).toBeUndefined();

    await s.pool.reattachRunner('runner-test');
    expect((await s.runner.plugins?.())?.plugins.map((p) => p.name)).toEqual(['p-all']);
    await s.pool.stop();
  });

  it('一時障害は日誌に残し、次の hello を待たずに挑み直し、直れば ok になる', async () => {
    const s = setup();
    await s.stores.plugins.put(pluginInput('p-all'));
    const real = s.runner.setPlugin?.bind(s.runner);
    let broken = true;
    s.runner.setPlugin = async (plugin) => {
      if (broken) throw new Error('plugin sync failed (test)');
      return real!(plugin);
    };

    await s.pool.start({ request: '走る' });
    expect(s.pool.pushHealthOf('runner-test')?.plugins?.status).toBe('failed');
    const lines = (await s.stores.journal.list({})).filter(
      (e) => e.type === 'exchange' && e.text.includes('plugin を降ろせなかった'),
    );
    expect(lines).toHaveLength(1);
    expect(JSON.stringify(lines)).not.toContain('dummy-content');

    broken = false;
    await vi.advanceTimersByTimeAsync(10_000);
    // 展開は実際のファイル I/O なので、偽の時計を進めただけでは終わらない。
    await vi.waitFor(() => expect(s.pool.pushHealthOf('runner-test')?.plugins?.status).toBe('ok'));
    expect((await s.runner.plugins?.())?.plugins.map((p) => p.name)).toEqual(['p-all']);
    await s.pool.stop();
  });

  it('古い runner（口が無い）は記録するが、挑み直しに数えない', async () => {
    const s = setup();
    await s.stores.plugins.put(pluginInput('p-all'));
    let attempts = 0;
    s.runner.setPlugin = async () => {
      attempts += 1;
      throw new RunnerPluginsUnsupportedError('runner-test');
    };

    await s.pool.start({ request: '走る' });
    const outcome = s.pool.pushHealthOf('runner-test')?.plugins;
    expect(outcome?.status).toBe('failed');
    expect(outcome?.error).toContain('plugin を受け取る口を持たない');
    const afterConnect = attempts;

    await vi.advanceTimersByTimeAsync(180_000);
    expect(attempts).toBe(afterConnect);

    // runner を上げた後の名乗り直しで降りる。
    s.runner.setPlugin = async (plugin) => ({
      name: plugin.name,
      sha: plugin.sourceSha,
      contentSha256: plugin.contentSha256,
    });
    s.runner.retainPlugins = async () => undefined;
    await s.pool.reattachRunner('runner-test');
    expect(s.pool.pushHealthOf('runner-test')?.plugins?.status).toBe('ok');
    await s.pool.stop();
  });

  it('apply() の即時の配布の失敗も、同じ帳面に積んで挑み直す', async () => {
    const s = setup();
    await s.pool.start({ request: '走る' });
    expect(s.pool.pushHealthOf('runner-test')?.plugins?.status).toBe('ok');
    await s.stores.plugins.put(pluginInput('p-all'));
    const real = s.runner.setPlugin?.bind(s.runner);
    let broken = true;
    s.runner.setPlugin = async (plugin) => {
      if (broken) throw new Error('plugin sync failed (test)');
      return real!(plugin);
    };

    const result = await s.service.apply();
    expect(result.runners).toEqual([expect.objectContaining({ ok: false })]);
    expect(s.pool.pushHealthOf('runner-test')?.plugins?.status).toBe('failed');

    broken = false;
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    await vi.waitFor(() => expect(s.pool.pushHealthOf('runner-test')?.plugins?.status).toBe('ok'));
    await s.pool.stop();
  });
});
